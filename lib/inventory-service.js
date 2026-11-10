/**
 * The background inventory service: watches the Stream Decks and the deck
 * service of this workstation, and reports them to each Odoo destination
 * of the `inventory-destinations` key, whether or not the device
 * indicator is shown.
 *
 * Per destination: one report in flight at most; a report at the first
 * USB scan, at each change (deck plugged or unplugged, deck service state
 * changed), and every `heartbeat_s` the last reply asked for. Events wait
 * in a bounded queue (lib/inventory.js EventQueue) until Odoo acknowledges
 * their uuid, so an Odoo that is down or slow loses nothing within the
 * bounds, and a resent report duplicates nothing. A call that takes more
 * than TIMEOUT_S is cancelled and counts as offline; the next try comes
 * after RETRY_MIN_S, doubling up to the heartbeat. A 401 `token_invalid`
 * or a 403 `user_inactive` stops the reports until the keyring holds
 * another token; a destination without a token is `unenrolled` and queues
 * nothing. The URL policy (`urlAllowed`) is checked before anything is
 * looked up or sent.
 *
 * A destination is its id, URL and database together: the token is
 * looked up for the three (lib/secret-store.js), so a URL or a database
 * edited under the same id makes the destination `unenrolled`, and the
 * queue of the former pair is not carried over.
 *
 * State file per destination, `<stateDir>/erplibre-home/inventory/<id>.json`,
 * mode 0600: `{destination: {url, db}, queue, status}`, read back at start
 * when it names the same URL and database; the token never goes there, it
 * stays in the keyring.
 *
 * Nothing waits synchronously on a process, a file or the network: GNOME
 * Shell keeps running whatever Odoo does. The readings of the workstation
 * (facts, deck service) are cut at TIMEOUT_S too, their processes killed:
 * a report then goes with the facts last read, a poll is abandoned, and
 * neither holds the next one.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {HEARTBEAT_S, POLL_S, TIMEOUT_S, QUEUE_MAX, QUEUE_MAX_AGE_DAYS,
    urlAllowed, parseOsRelease, buildState, diffDecks, serviceChanged,
    EventQueue, reportBody, parseReply, parseDestinations, REPORT_PATH}
    from './inventory.js';
import {DECK_UNIT, parseUnitShow} from './deck-service.js';
import {captureOutput} from './spawn.js';
import {UsbWatch, readText} from './usb-watch.js';
import {lookupToken} from './secret-store.js';
import {newSession, postJson} from './odoo-http.js';

// Version of CONTRACT.md this code implements, reported in each `state`.
export const CONTRACT_VERSION = '1.2';
// First retry after a failed report; each further failure doubles it, up
// to the heartbeat.
export const RETRY_MIN_S = 60;

// The facts of the workstation (system, checkout, deck program) are read
// again for a report when older than this, on a monotonic clock;
// destinations reporting together share one reading.
const FACTS_MAX_AGE_MS = 60 * 1000;

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SERVICE_STATES = ['active', 'failed', 'inactive', 'absent'];
const STATUS_STATES = ['unenrolled', 'ok', 'offline', 'revoked', 'refused'];
const RESTART_SUBSTATES = ['auto-restart', 'auto-restart-queued'];
const EXTENSION_SUFFIX = '/script/gnome-extension/erplibre_home';
const OS_RELEASE = ['/etc/os-release', '/usr/lib/os-release'];

/**
 * The state file of destination `destId` under `stateDir` (an absolute
 * path), or null when `destId` is not 1–64 letters, digits, `_` or `-`
 * (it becomes a file name) or `stateDir` is not absolute.
 */
export function stateFilePath(stateDir, destId) {
    if (typeof stateDir !== 'string' || !stateDir.startsWith('/')) return null;
    if (typeof destId !== 'string' || !ID_RE.test(destId)) return null;
    return `${stateDir.replace(/\/+$/, '')}/erplibre-home/inventory/${destId}.json`;
}

/** Seconds before the next try after `failures` failed reports in a row. */
export function retryDelayS(failures, heartbeatS) {
    const n = Math.max(0, Math.min(30, (failures | 0) - 1));
    return Math.min(heartbeatS, RETRY_MIN_S * 2 ** n);
}

/**
 * The wire `service_state` from `systemctl show` properties: `absent`
 * without the unit, `failed` for a failed unit or one waiting to restart
 * after a failure, `active` while it runs or starts, `inactive` otherwise.
 */
export function serviceStateFrom(props) {
    const load = props?.LoadState ?? '';
    const active = props?.ActiveState ?? '';
    if (load === '' || load === 'not-found' || active === '') return 'absent';
    if (active === 'failed') return 'failed';
    if (active === 'activating' && RESTART_SUBSTATES.includes(props.SubState))
        return 'failed';
    if (['active', 'reloading', 'activating'].includes(active)) return 'active';
    return 'inactive';
}

/**
 * The deck program named by the text of streamdeck.conf, as the deck
 * entry point reads it: the last line starting with `DECK_PROGRAM=`,
 * `tiler` without such a line or without the file (null text); an empty
 * value is null.
 */
export function deckProgramFrom(text) {
    let value = 'tiler';
    for (const line of String(text ?? '').split('\n')) {
        if (line.startsWith('DECK_PROGRAM='))
            value = line.slice('DECK_PROGRAM='.length);
    }
    return value === '' ? null : value;
}

/**
 * What the deck menu says of the inventory, from the statuses of the
 * destinations: null when none is enrolled; otherwise the worst kind
 * (`revoked`, then `refused`, then `offline`, else `ok`) with the events
 * waiting in all enrolled destinations.
 */
export function inventorySummary(statuses) {
    const enrolled = (Array.isArray(statuses) ? statuses : [])
        .filter(s => s && STATUS_STATES.includes(s.state) &&
            s.state !== 'unenrolled');
    if (!enrolled.length) return null;
    const pending = enrolled.reduce((n, s) => n + (s.pending | 0), 0);
    for (const kind of ['revoked', 'refused', 'offline'])
        if (enrolled.some(s => s.state === kind)) return {kind, pending};
    return {kind: 'ok', pending};
}

/** The `systemctl --user show` reading of the deck unit, as a wire state. */
export async function readServiceState(cancellable = null) {
    const out = await captureOutput(['systemctl', '--user', 'show',
        '-p', 'LoadState', '-p', 'ActiveState', '-p', 'SubState', DECK_UNIT],
    cancellable);
    return serviceStateFrom(parseUnitShow(out ?? ''));
}

/**
 * The ERPLibre checkout holding the extension at `extensionPath`, as
 * `{branch, commit}` (branch null on a detached HEAD), or null outside a
 * checkout. The checkout is where the extension's extension.js lives,
 * links followed, as CONTRACT.md states.
 */
async function _checkout(extensionPath, cancellable) {
    if (typeof extensionPath !== 'string' || extensionPath === '') return null;
    const real = (await captureOutput(['realpath', '-e', '--',
        `${extensionPath}/extension.js`], cancellable))?.trim() ?? '';
    const dir = real.replace(/\/extension\.js$/, '');
    if (dir === real || !dir.endsWith(EXTENSION_SUFFIX)) return null;
    const root = dir.slice(0, -EXTENSION_SUFFIX.length);
    if (root === '') return null;
    const git = async (...args) => (await captureOutput(
        ['git', '-C', root, 'rev-parse', ...args], cancellable))?.trim() || null;
    const branch = await git('--abbrev-ref', 'HEAD');
    const commit = await git('HEAD');
    return {branch: branch === 'HEAD' ? null : branch, commit};
}

/**
 * The facts of the workstation a report carries besides the decks:
 * `{hostname, os, erplibre, deckProgram}`. `osRelease` lists the
 * os-release files tried in order; `configDir` holds
 * erplibre-home/streamdeck.conf.
 */
export async function collectFacts({extensionPath = null,
    osRelease = OS_RELEASE, configDir = GLib.get_user_config_dir(),
    cancellable = null} = {}) {
    let osText = null;
    for (const p of osRelease) {
        osText = await readText(p, cancellable);
        if (osText !== null) break;
    }
    const conf = await readText(
        `${configDir}/erplibre-home/streamdeck.conf`, cancellable);
    return {
        hostname: GLib.get_host_name(),
        os: parseOsRelease(osText ?? ''),
        erplibre: await _checkout(extensionPath, cancellable),
        deckProgram: deckProgramFrom(conf),
    };
}

function _ensureDir(path) {
    return new Promise(resolve => {
        Gio.File.new_for_path(path).make_directory_async(
            GLib.PRIORITY_DEFAULT, null, (f, res) => {
                try {
                    f.make_directory_finish(res);
                } catch (_e) {}
                resolve();
            });
    });
}

/** Replaces the file at `path` with `text`, mode 0600, atomically. */
function _writePrivate(path, text) {
    return new Promise((resolve, reject) => {
        Gio.File.new_for_path(path).replace_contents_bytes_async(
            new GLib.Bytes(new TextEncoder().encode(text)), null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION |
            Gio.FileCreateFlags.PRIVATE, null, (f, res) => {
                try {
                    f.replace_contents_finish(res);
                    resolve();
                } catch (e) {
                    reject(e);
                }
            });
    });
}

/** The URL and database of `dest`, as a token and a state file name them. */
function _issuedFor(dest) {
    return {url: String(dest.url).replace(/\/+$/, ''), db: dest.db};
}

function _defaultDeps(extensionPath) {
    return {
        usbWatch: onChange => new UsbWatch({onChange}),
        lookupToken,
        newSession,
        postJson,
        collectFacts: cancellable => collectFacts({extensionPath, cancellable}),
        readServiceState,
        now: () => new Date().toISOString(),
        clockMs: () => GLib.get_monotonic_time() / 1000,
        newUuid: () => GLib.uuid_string_random(),
    };
}

/**
 * The service. `settings` is the extension's Gio.Settings,
 * `extensionVersion` and `shellVersion` go into each `state`, `stateDir`
 * is the user state directory, `extensionPath` the extension directory
 * (to find the ERPLibre checkout). `deps` replaces the parts that reach
 * the system, for the tests.
 *
 * `decks()` is the deck list of the last scan; `status(destId)` and
 * `statuses()` say how each destination is doing; `connect('changed',
 * cb)` runs `cb()` after a scan that changed the decks and after any
 * status change.
 */
export class InventoryService {
    constructor({settings, extensionVersion, stateDir, shellVersion = null,
        extensionPath = null, deps = {}} = {}) {
        this._settings = settings;
        this._extensionVersion = extensionVersion ?? null;
        this._stateDir = stateDir;
        this._shellVersion = shellVersion;
        this._deps = {..._defaultDeps(extensionPath), ...deps};
        this._records = new Map();
        this._decks = null;
        this._service = null;
        this._facts = null;
        this._factsAt = null;
        this._factsPromise = null;
        this._polling = false;
        this._readings = new Set();
        this._handlers = new Map();
        this._nextHandler = 0;
        this._settingsId = 0;
        this._tickId = 0;
        this._usb = null;
        this._started = false;
        this._stopped = false;
    }

    start() {
        if (this._started) return;
        this._started = true;
        this._settingsId = this._settings.connect(
            'changed::inventory-destinations',
            () => this._syncDestinations());
        this._syncDestinations();
        this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, POLL_S,
            () => {
                this._tick();
                return GLib.SOURCE_CONTINUE;
            });
        // Without a working USB watch the reports still go, with no deck.
        try {
            this._usb = this._deps.usbWatch(decks => this._onDecks(decks));
            this._usb.start();
        } catch (e) {
            console.log(`[ERPLibreHome] inventory usb: ${e.message}`);
            this._usb = null;
            this._onDecks([]);
        }
    }

    /** Cancels the calls in flight and every timer; a stopped service stays so. */
    stop() {
        if (this._stopped) return;
        this._stopped = true;
        if (this._settingsId) this._settings.disconnect(this._settingsId);
        this._settingsId = 0;
        if (this._tickId) GLib.source_remove(this._tickId);
        this._tickId = 0;
        try {
            this._usb?.stop();
        } catch (_e) {}
        this._usb = null;
        for (const reading of [...this._readings]) reading.abandon();
        for (const rec of this._records.values()) this._close(rec);
        this._handlers.clear();
    }

    decks() {
        return (this._decks ?? []).map(d => ({...d}));
    }

    rescan() {
        this._usb?.rescan();
    }

    status(destId) {
        const rec = this._records.get(destId);
        if (!rec || rec.closed)
            return {state: 'unenrolled', pending: 0, lastReport: null,
                error: null};
        return {state: rec.state, pending: rec.queue.pending().length,
            lastReport: rec.lastReport, error: rec.error};
    }

    /** `[{id, label, ...status(id)}]`, in the order of the settings. */
    statuses() {
        return [...this._records.values()].filter(r => !r.closed).map(r =>
            ({id: r.dest.id, label: r.dest.label, ...this.status(r.dest.id)}));
    }

    connect(signal, cb) {
        if (signal !== 'changed' || typeof cb !== 'function') return 0;
        const id = ++this._nextHandler;
        this._handlers.set(id, cb);
        return id;
    }

    disconnect(id) {
        this._handlers.delete(id);
    }

    _emit() {
        for (const cb of [...this._handlers.values()]) {
            try {
                cb();
            } catch (e) {
                console.log(`[ERPLibreHome] inventory listener: ${e.message}`);
            }
        }
    }

    // ------------------------------------------------------- destinations

    _syncDestinations() {
        if (this._stopped) return;
        const dests = parseDestinations(
            this._settings.get_string('inventory-destinations'));
        const next = new Map();
        const added = [];
        for (const d of dests) {
            const old = this._records.get(d.id);
            if (old && old.dest.url === d.url && old.dest.db === d.db) {
                old.dest = d;
                next.set(d.id, old);
            } else {
                const rec = this._newRecord(d);
                next.set(d.id, rec);
                added.push(rec);
            }
        }
        for (const [id, rec] of this._records)
            if (next.get(id) !== rec) this._close(rec);
        this._records = next;
        if (this._decks !== null)
            for (const rec of added) this._report(rec);
        this._emit();
    }

    _newRecord(dest) {
        let allowed = urlAllowed(dest.url);
        if (allowed.ok && !ID_RE.test(dest.id))
            allowed = {ok: false, reason: 'invalid'};
        const rec = {
            dest, allowed,
            path: allowed.ok ? stateFilePath(this._stateDir, dest.id) : null,
            queue: new EventQueue({max: QUEUE_MAX,
                maxAgeDays: QUEUE_MAX_AGE_DAYS}),
            state: allowed.ok ? 'unenrolled' : 'refused',
            error: allowed.ok ? null : allowed.reason,
            lastReport: null,
            noToken: false,
            revokedToken: null,
            failures: 0,
            heartbeatS: HEARTBEAT_S,
            session: null,
            timerId: 0,
            deadlineId: 0,
            cancellable: null,
            abort: null,
            inFlight: false,
            again: false,
            closed: false,
            dirReady: false,
            writing: Promise.resolve(),
        };
        rec.loaded = allowed.ok ? this._load(rec) : Promise.resolve();
        return rec;
    }

    _close(rec) {
        rec.closed = true;
        if (rec.timerId) GLib.source_remove(rec.timerId);
        rec.timerId = 0;
        if (rec.deadlineId) GLib.source_remove(rec.deadlineId);
        rec.deadlineId = 0;
        rec.cancellable?.cancel();
        rec.abort?.();
    }

    async _load(rec) {
        if (!rec.path) return;
        const text = await readText(rec.path);
        if (rec.closed || text === null) return;
        let saved;
        try {
            saved = JSON.parse(text);
        } catch (_e) {
            return;
        }
        const issued = _issuedFor(rec.dest);
        if (saved?.destination?.url !== issued.url ||
            saved?.destination?.db !== issued.db)
            return;
        rec.queue = EventQueue.fromJSON(saved?.queue,
            {max: QUEUE_MAX, maxAgeDays: QUEUE_MAX_AGE_DAYS});
        const st = saved?.status ?? {};
        if (STATUS_STATES.includes(st.state)) rec.state = st.state;
        if (typeof st.lastReport === 'string') rec.lastReport = st.lastReport;
        if (typeof st.error === 'string') rec.error = st.error;
        this._emit();
    }

    _save(rec) {
        if (!rec.path || rec.closed) return;
        const text = JSON.stringify({
            destination: _issuedFor(rec.dest),
            queue: rec.queue.toJSON(),
            status: {state: rec.state, pending: rec.queue.pending().length,
                lastReport: rec.lastReport, error: rec.error},
        });
        const path = rec.path;
        rec.writing = rec.writing.then(async () => {
            if (!rec.dirReady) {
                const dir = path.slice(0, path.lastIndexOf('/'));
                await _ensureDir(dir.slice(0, dir.lastIndexOf('/')));
                await _ensureDir(dir);
                rec.dirReady = true;
            }
            await _writePrivate(path, text);
        }).catch(e => {
            rec.dirReady = false;
            console.log(`[ERPLibreHome] inventory state file: ${e.message}`);
        });
    }

    _setStatus(rec, state, error) {
        rec.state = state;
        rec.error = error;
        this._save(rec);
        this._emit();
    }

    // ------------------------------------------------- scans and events

    _onDecks(decks) {
        if (this._stopped) return;
        const prev = this._decks;
        this._decks = Array.isArray(decks) ? decks.map(d => ({...d})) : [];
        this._emit();
        if (prev === null) {
            for (const rec of this._records.values()) this._report(rec);
            return;
        }
        this._queueEvents(diffDecks(prev, this._decks, this._deps.now(),
            this._deps.newUuid));
    }

    /** Queues `events` in each destination that may send, then reports. */
    _queueEvents(events) {
        if (!events.length) return;
        for (const rec of this._records.values()) {
            if (rec.closed || !rec.allowed.ok) continue;
            rec.loaded.then(() => {
                if (rec.closed || this._stopped || rec.noToken) return;
                for (const e of events) rec.queue.push({...e});
                rec.queue.prune(this._deps.now());
                this._save(rec);
                this._emit();
                this._report(rec);
            });
        }
    }

    _tick() {
        if (this._stopped) return;
        const recs = [...this._records.values()]
            .filter(r => !r.closed && r.allowed.ok);
        if (!recs.length) return;
        this._pollService();
        // A token stored or replaced by the preferences is picked up here.
        for (const rec of recs)
            if (rec.noToken || rec.state === 'revoked') this._report(rec);
    }

    async _pollService() {
        if (this._polling) return;
        this._polling = true;
        try {
            const next = await this._bounded(
                c => this._deps.readServiceState(c), null);
            if (this._stopped || !SERVICE_STATES.includes(next)) return;
            const prev = this._service;
            this._service = next;
            this._queueEvents(serviceChanged(prev, next, this._deps.now(),
                this._deps.newUuid));
        } catch (_e) {
        } finally {
            this._polling = false;
        }
    }

    /**
     * The facts and the deck service state for a report. A reading that
     * failed or timed out leaves the facts last read (none at first) and
     * is tried again at the next report.
     */
    async _currentFacts() {
        const fresh = this._factsAt !== null &&
            this._deps.clockMs() - this._factsAt < FACTS_MAX_AGE_MS;
        if (!fresh || this._service === null) {
            this._factsPromise ??= Promise.all([
                fresh ? null : this._bounded(
                    c => this._deps.collectFacts(c), null).then(facts => {
                    if (facts === null || typeof facts !== 'object') return;
                    this._facts = facts;
                    this._factsAt = this._deps.clockMs();
                }),
                this._service !== null ? null : this._bounded(
                    c => this._deps.readServiceState(c), null).then(s => {
                    if (this._service === null && SERVICE_STATES.includes(s))
                        this._service = s;
                }),
            ]).finally(() => {
                this._factsPromise = null;
            });
            await this._factsPromise;
        }
        return {...this._facts, serviceState: this._service ?? 'absent'};
    }

    /**
     * What `read(cancellable)` resolves to, or `fallback` when it rejects,
     * when TIMEOUT_S has passed or when the service stops; in the last two
     * cases the cancellable is cancelled, which kills the processes the
     * reading started (lib/spawn.js captureOutput).
     */
    _bounded(read, fallback) {
        return new Promise(resolve => {
            const cancellable = new Gio.Cancellable();
            let timerId = 0;
            const reading = {};
            const finish = value => {
                if (!this._readings.delete(reading)) return;
                if (timerId) GLib.source_remove(timerId);
                timerId = 0;
                resolve(value);
            };
            reading.abandon = () => {
                cancellable.cancel();
                finish(fallback);
            };
            this._readings.add(reading);
            timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
                TIMEOUT_S * 1000, () => {
                    timerId = 0;
                    reading.abandon();
                    return GLib.SOURCE_REMOVE;
                });
            Promise.resolve().then(() => read(cancellable))
                .then(finish, () => finish(fallback));
        });
    }

    // ------------------------------------------------------------ reports

    async _report(rec) {
        if (this._stopped || rec.closed || !rec.allowed.ok ||
            this._decks === null)
            return;
        if (rec.inFlight) {
            rec.again = true;
            return;
        }
        rec.inFlight = true;
        rec.again = false;
        if (rec.timerId) GLib.source_remove(rec.timerId);
        rec.timerId = 0;
        let next = null;
        try {
            next = await this._reportOnce(rec);
        } catch (e) {
            console.log(`[ERPLibreHome] inventory report: ${e.message}`);
            rec.failures++;
            next = retryDelayS(rec.failures, rec.heartbeatS);
        } finally {
            rec.inFlight = false;
            rec.cancellable = null;
            rec.abort = null;
        }
        if (this._stopped || rec.closed) return;
        if (rec.again) {
            this._report(rec);
            return;
        }
        if (next !== null) {
            rec.timerId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, next,
                () => {
                    rec.timerId = 0;
                    this._report(rec);
                    return GLib.SOURCE_REMOVE;
                });
        }
    }

    /**
     * One report to `rec`; resolves to the seconds before the next one,
     * or null when only a change, the tick or a new token brings one.
     */
    async _reportOnce(rec) {
        const gone = () => this._stopped || rec.closed;
        await rec.loaded;
        if (gone()) return null;
        let token;
        try {
            token = await this._deps.lookupToken(rec.dest.id,
                _issuedFor(rec.dest));
        } catch (_e) {
            if (gone()) return null;
            rec.failures++;
            this._setStatus(rec, 'offline', 'keyring');
            return retryDelayS(rec.failures, rec.heartbeatS);
        }
        if (gone()) return null;
        if (!token) {
            rec.noToken = true;
            this._setStatus(rec, 'unenrolled', null);
            return null;
        }
        rec.noToken = false;
        if (token === rec.revokedToken) return null;

        const facts = await this._currentFacts();
        if (gone()) return null;
        const serviceState = facts.serviceState;
        const state = buildState({hostname: facts.hostname, os: facts.os,
            gnomeShell: this._shellVersion,
            extensionVersion: this._extensionVersion,
            contractVersion: CONTRACT_VERSION, erplibre: facts.erplibre,
            deckProgram: serviceState === 'absent' ? null : facts.deckProgram,
            serviceState, decks: this._decks ?? []});
        if (rec.queue.prune(this._deps.now()) > 0) this._save(rec);
        const body = reportBody(state, rec.queue);
        rec.session ??= this._deps.newSession();
        const cancellable = new Gio.Cancellable();
        rec.cancellable = cancellable;
        const reply = await this._withDeadline(rec,
            this._deps.postJson(rec.session, rec.dest.url, rec.dest.db,
                REPORT_PATH, body, token, {cancellable}),
            cancellable);
        if (gone()) return null;

        const r = parseReply(reply.status, reply.json);
        if (r.ok) {
            rec.queue.acknowledge(r.accepted);
            rec.failures = 0;
            rec.heartbeatS = r.heartbeatS;
            rec.revokedToken = null;
            rec.lastReport = this._deps.now();
            this._setStatus(rec, 'ok', null);
            return r.heartbeatS;
        }
        if (r.error === 'token_invalid' || r.error === 'user_inactive') {
            rec.revokedToken = token;
            this._setStatus(rec, 'revoked', r.error);
            return null;
        }
        rec.failures++;
        this._setStatus(rec, r.error === 'network' ? 'offline' : 'refused',
            r.error);
        return retryDelayS(rec.failures, rec.heartbeatS);
    }

    /**
     * `call`'s outcome, or `{status: 0}` once TIMEOUT_S has passed (the
     * call is then cancelled) or the destination is closed; a rejection
     * counts as `{status: 0}` too.
     */
    _withDeadline(rec, call, cancellable) {
        return new Promise(resolve => {
            let done = false;
            const finish = value => {
                if (done) return;
                done = true;
                if (rec.deadlineId) GLib.source_remove(rec.deadlineId);
                rec.deadlineId = 0;
                resolve(value);
            };
            const failed = () => finish({status: 0, json: null});
            rec.abort = failed;
            rec.deadlineId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
                TIMEOUT_S * 1000, () => {
                    rec.deadlineId = 0;
                    cancellable.cancel();
                    failed();
                    return GLib.SOURCE_REMOVE;
                });
            Promise.resolve(call).then(finish, failed);
        });
    }
}
