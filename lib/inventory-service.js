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
 * nothing. The keyring is read again at each tick (POLL_S), so a token
 * the preferences clear shows within one tick; a token still missing
 * POLL_S later ends that enrollment, and its queue goes with it: those
 * events never reach the next enrollment, possibly another employee's.
 * The URL policy (`urlAllowed`) is checked before anything is looked up
 * or sent.
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
 * What the service last saw, `<stateDir>/erplibre-home/inventory-seen.json`
 * (mode 0600, `{decks, service}`), outlives a stop: the extension is
 * disabled at each screen lock, logout or GNOME Shell restart. The first
 * scan and the first deck service reading after a start are compared with
 * it, so a deck unplugged or plugged meanwhile, or a deck service that
 * changed, is an event dated at the start.
 *
 * Nothing waits synchronously on a process, a file or the network: GNOME
 * Shell keeps running whatever Odoo does. The readings of the workstation
 * (facts, deck service) are cut at TIMEOUT_S too, their processes killed:
 * a report then goes with the facts last read, a poll is abandoned, and
 * neither holds the next one.
 *
 * The Odoo configuration (CONTRACT.md, « Odoo configuration »): only the
 * destination whose id the `inventory-pilot` key holds sends the local
 * values of streamdeck.conf, read again at each of its reports, and only
 * its replies' `config` is kept; every other destination sends `{"pilot":
 * false}` and its `config` is dropped. A revision is announced once, by
 * the `announce` signal, and applied only by `applyConfig`, which the
 * employee's click calls (notification, deck menu, or the preferences
 * through the `inventory-apply-request` key). `keepLocal` answers a
 * first-pilot `ask` without touching the file. A revision whose values
 * the file already holds is applied at once, silently, unless the deck
 * unit still owes a restart for one of them. Each result of a click, and
 * each choice, goes in a report sent at once; a result a reply decides
 * goes at once too, but not twice in a row (`_onConfig`). One
 * application runs at a time, every step of it bounded by TIMEOUT_S.
 * What the pilot keeps of its configuration lives in its state file,
 * under `config`, so that a start after a screen lock announces nothing
 * twice; `pilot.json` names the pilot's label, its last revision and its
 * locked keys for ERPLibre.
 *
 * Key layouts (CONTRACT.md, « Key layouts »): the catalog of the deck
 * program (`--catalog` of the checkout, read at the first facts and again
 * when the checkout's commit changes, bounded by TIMEOUT_S) goes in each
 * `state`; a revision's `key_layouts` is checked against it when it comes
 * and at the click, and written to keymap.json with streamdeck.conf, both
 * or neither, before the one restart they need.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {HEARTBEAT_S, POLL_S, TIMEOUT_S, QUEUE_MAX, QUEUE_MAX_AGE_DAYS,
    urlAllowed, parseOsRelease, buildState, diffDecks, serviceChanged,
    EventQueue, reportBody, parseReply, parseDestinations, REPORT_PATH,
    configBody, settleConfig} from './inventory.js';
import {CHOICES, PLUGIN_ID_RE, WIRE_KEYS, KEYMAP_KEY, validateConfig,
    rewriteConf, changedKeys, needsRestart, readLocal, keymapText,
    parseCatalog, validateKeyLayouts} from './deck-config.js';
import {STREAMDECK_PYTHON_REL} from './project-root.js';
import {DECK_UNIT, parseUnitShow, restartDeckArgv} from './deck-service.js';
import {captureOutput} from './spawn.js';
import {UsbWatch, readText} from './usb-watch.js';
import {lookupToken} from './secret-store.js';
import {newSession, postJson} from './odoo-http.js';

// Version of CONTRACT.md this code implements, reported in each `state`.
export const CONTRACT_VERSION = '1.4';
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
// Deck plugin directories: the checkout's, then the user's under the
// configuration directory.
const PLUGINS_REL = 'script/stream_deck/erplibre_streamdeck/plugins';
const USER_PLUGINS_REL = 'erplibre-home/deck-plugins';
const CONF_REL = 'erplibre-home/streamdeck.conf';
// The deck program, run as a directory, and keymap.json under the home
// directory: the literal ~/.config the deck program reads it from.
const DECK_PROGRAM_REL = 'script/stream_deck/erplibre_streamdeck';
const KEYMAP_REL = '.config/erplibre-home/keymap.json';
const KEYMAP_MODE = 0o644;
// What `inventory-apply-request` holds: `<destination id>:<revision>`,
// then `:keep_local` to keep the local values.
const APPLY_REQUEST_RE = /^([A-Za-z0-9_-]{1,64}):([0-9]{1,15})(:keep_local)?$/;

/**
 * The text of the GSettings key `key`, or '' when the compiled schema
 * does not hold it: Gio.Settings aborts the process on an unknown key, and
 * the schema installed may predate this code.
 */
export function settingString(settings, key) {
    const schema = settings?.settings_schema;
    if (schema && typeof schema.has_key === 'function' && !schema.has_key(key))
        return '';
    return settings.get_string(key);
}

/** Sets the GSettings key `key` when the compiled schema holds it. */
export function setSettingString(settings, key, value) {
    const schema = settings?.settings_schema;
    if (schema && typeof schema.has_key === 'function' && !schema.has_key(key))
        return false;
    return settings.set_string(key, value);
}

/** The argv that prints the catalog of the deck program of checkout `root`. */
export function catalogArgv(root) {
    return [`${root}/${STREAMDECK_PYTHON_REL}`, `${root}/${DECK_PROGRAM_REL}`,
        '--catalog'];
}

/** keymap.json under the home directory `homeDir`. */
export function keymapFilePath(homeDir) {
    return `${String(homeDir).replace(/\/+$/, '')}/${KEYMAP_REL}`;
}

/**
 * What `--catalog` printed for the checkout holding the extension at
 * `extensionPath`, or null outside a checkout or when it fails, exits
 * non-zero or `cancellable` is cancelled (the program is then killed).
 */
export async function readCatalog({extensionPath = null,
    cancellable = null} = {}) {
    const root = await _checkoutRoot(extensionPath, cancellable);
    return root === null ? null
        : captureOutput(catalogArgv(root), cancellable);
}

/** `$stateDir/erplibre-home/pilot.json`, or null for a relative `stateDir`. */
export function pilotFilePath(stateDir) {
    if (typeof stateDir !== 'string' || !stateDir.startsWith('/')) return null;
    return `${stateDir.replace(/\/+$/, '')}/erplibre-home/pilot.json`;
}

function _revision(v) {
    return Number.isSafeInteger(v) && v >= 0 ? v : null;
}

/**
 * What a destination keeps of its Odoo configuration, from `saved` (the
 * `config` of its state file; anything else gives the empty state):
 * `revisionApplied`, the revision last applied; `offer`, the last valid
 * `config` received (`validateConfig`'s fields) with `keys`, those of its
 * settings the file did not hold then; `announced`, the revision last
 * announced; `answered`, the revision whose `ask` the employee answered
 * by keeping the local values, which waits on nothing while Odoo still
 * asks it; `refused`, `{revision, reason}` of the last
 * revision refused as out of the schema; `restartOwed`, the restarting
 * keys written to the file that the deck unit has not been restarted for
 * (`restart_failed`, `unit_missing`); `result` and `choice`, what the
 * next report still has to carry. Each field is null when absent or out
 * of shape.
 */
export function configStateFrom(saved) {
    const s = saved !== null && typeof saved === 'object' &&
        !Array.isArray(saved) ? saved : {};
    let offer = null;
    const v = s.offer ? validateConfig(s.offer) : null;
    if (v?.ok) {
        const keys = Array.isArray(s.offer.keys) ? s.offer.keys : [];
        offer = {revision: v.revision, hash: v.hash, settings: v.settings,
            locked: v.locked, ask: v.ask,
            keys: Object.keys(v.settings).filter(k => keys.includes(k))};
    }
    const r = s.refused;
    const refused = r && _revision(r.revision) !== null &&
        typeof r.reason === 'string' ? {revision: r.revision, reason: r.reason}
        : null;
    return {
        revisionApplied: _revision(s.revisionApplied),
        offer,
        announced: _revision(s.announced),
        answered: _revision(s.answered),
        refused,
        restartOwed: _restartKeys(s.restartOwed),
        result: configBody({pilot: true, result: s.result}).result,
        choice: CHOICES.includes(s.choice) ? s.choice : null,
    };
}

/** The restarting keys of `keys` in the table's order, or null for none. */
function _restartKeys(keys) {
    const list = Array.isArray(keys) ? keys : [];
    const kept = WIRE_KEYS.filter(k => list.includes(k) &&
        needsRestart([k]));
    return kept.length ? kept : null;
}

/**
 * The keys an application of `settings` deals with: those whose value
 * the files (`current`, as `readLocal` gives it) do not hold, and those
 * of `owed` (`restartOwed`) the settings still name, in the order of
 * WIRE_KEYS.
 */
function _offerKeys(current, settings, owed) {
    const changed = changedKeys(current, settings);
    return WIRE_KEYS.filter(k => changed.includes(k) ||
        ((owed ?? []).includes(k) && Object.hasOwn(settings, k)));
}

function _emptyConfig(cfg) {
    return Object.values(cfg).every(v => v === null);
}

/**
 * The revision `cfg` (as `configStateFrom` gives it) waits on the
 * employee for, `{revision, keys, ask}`, or null: none received, the one
 * received already applied, or its question answered by keeping the
 * local values and still asked. The answered revision that comes back
 * without `ask` (Odoo adopted nothing, so its hash and revision stay)
 * waits again, for a plain apply of what it still offers.
 */
export function pendingOf(cfg) {
    const o = cfg?.offer;
    if (!o || o.revision === cfg.revisionApplied ||
        (o.revision === cfg.answered && o.ask.length))
        return null;
    return {revision: o.revision, keys: [...o.keys], ask: [...o.ask]};
}

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

/**
 * The file of what the service last saw under `stateDir` (an absolute
 * path), or null when `stateDir` is not absolute. Its name cannot be the
 * state file of a destination, which lives one directory below.
 */
export function seenFilePath(stateDir) {
    if (typeof stateDir !== 'string' || !stateDir.startsWith('/')) return null;
    const dir = stateDir.replace(/\/+$/, '');
    return `${dir}/erplibre-home/inventory-seen.json`;
}

/** `{decks, service}` from the text of the seen file; nulls when unread. */
function _parseSeen(text) {
    let saved = null;
    try {
        saved = JSON.parse(text);
    } catch (_e) {}
    const decks = Array.isArray(saved?.decks)
        ? saved.decks.filter(d => d !== null && typeof d === 'object') : null;
    const service = SERVICE_STATES.includes(saved?.service)
        ? saved.service : null;
    return {decks, service};
}

/** What the seen file keeps of a deck: what names it to `diffDecks`. */
function _seenDeck(d) {
    return {serial: d?.serial ?? null,
        usb_product_id: d?.usb_product_id ?? null,
        usb_path: d?.usb_path ?? null};
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

/**
 * The `systemctl --user show` reading of the deck unit, as a wire state;
 * `unreadable` when systemctl fails (no user manager reached): `absent`
 * for the inventory, null for a caller that must not guess.
 */
export async function readServiceState(cancellable = null,
    unreadable = 'absent') {
    const out = await captureOutput(['systemctl', '--user', 'show',
        '-p', 'LoadState', '-p', 'ActiveState', '-p', 'SubState', DECK_UNIT],
    cancellable);
    return out === null ? unreadable : serviceStateFrom(parseUnitShow(out));
}

/**
 * The root of the ERPLibre checkout holding the extension at
 * `extensionPath`, or null outside a checkout. The checkout is where the
 * extension's extension.js lives, links followed, as CONTRACT.md states.
 */
async function _checkoutRoot(extensionPath, cancellable) {
    if (typeof extensionPath !== 'string' || extensionPath === '') return null;
    const real = (await captureOutput(['realpath', '-e', '--',
        `${extensionPath}/extension.js`], cancellable))?.trim() ?? '';
    const dir = real.replace(/\/extension\.js$/, '');
    if (dir === real || !dir.endsWith(EXTENSION_SUFFIX)) return null;
    const root = dir.slice(0, -EXTENSION_SUFFIX.length);
    return root === '' ? null : root;
}

/** `{branch, commit}` of the checkout `root`, branch null when detached. */
async function _checkout(root, cancellable) {
    const git = async (...args) => (await captureOutput(
        ['git', '-C', root, 'rev-parse', ...args], cancellable))?.trim() || null;
    const branch = await git('--abbrev-ref', 'HEAD');
    const commit = await git('HEAD');
    return {branch: branch === 'HEAD' ? null : branch, commit};
}

/**
 * `[{name, regular}]` of the entries of directory `dir`, `regular` for a
 * regular file (links followed); `[]` when it cannot be listed.
 */
function _listDir(dir, cancellable) {
    const call = (start, finish) => new Promise((resolve, reject) => {
        start((src, res) => {
            try {
                resolve(finish(src, res));
            } catch (e) {
                reject(e);
            }
        });
    });
    return (async () => {
        const out = [];
        const en = await call(cb => Gio.File.new_for_path(dir)
            .enumerate_children_async('standard::name,standard::type',
                Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT,
                cancellable, cb), (f, res) => f.enumerate_children_finish(res));
        for (;;) {
            const infos = await call(cb => en.next_files_async(64,
                GLib.PRIORITY_DEFAULT, cancellable, cb),
            (e, res) => en.next_files_finish(res));
            if (!infos.length) break;
            for (const info of infos) {
                out.push({name: info.get_name(),
                    regular: info.get_file_type() === Gio.FileType.REGULAR});
            }
        }
        en.close_async(GLib.PRIORITY_DEFAULT, null, () => {});
        return out;
    })().catch(() => []);
}

/**
 * The ids of the deck plugins in `dirs`, sorted, once each: the regular
 * files `<id>.py` whose id matches PLUGIN_ID_RE (a name starting with `_`
 * never does). Nothing is read or imported.
 */
export async function deckPluginIds(dirs, cancellable = null) {
    const ids = new Set();
    for (const dir of dirs) {
        for (const {name, regular} of await _listDir(dir, cancellable)) {
            const id = name.endsWith('.py') ? name.slice(0, -3) : '';
            if (regular && PLUGIN_ID_RE.test(id)) ids.add(id);
        }
    }
    return [...ids].sort();
}

/**
 * The facts of the workstation a report carries besides the decks:
 * `{hostname, os, erplibre, deckProgram, deckPlugins}`. `osRelease` lists
 * the os-release files tried in order; `configDir` holds
 * erplibre-home/streamdeck.conf and the user's deck plugins. Outside a
 * checkout `erplibre` is null and `deckPlugins` `[]`.
 */
export async function collectFacts({extensionPath = null,
    osRelease = OS_RELEASE, configDir = GLib.get_user_config_dir(),
    cancellable = null} = {}) {
    let osText = null;
    for (const p of osRelease) {
        osText = await readText(p, cancellable);
        if (osText !== null) break;
    }
    const conf = await readText(`${configDir}/${CONF_REL}`, cancellable);
    const root = await _checkoutRoot(extensionPath, cancellable);
    return {
        hostname: GLib.get_host_name(),
        os: parseOsRelease(osText ?? ''),
        erplibre: root === null ? null : await _checkout(root, cancellable),
        deckProgram: deckProgramFrom(conf),
        deckPlugins: root === null ? [] : await deckPluginIds([
            `${root}/${PLUGINS_REL}`, `${configDir}/${USER_PLUGINS_REL}`],
        cancellable),
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

function _deleteFile(path) {
    return new Promise(resolve => {
        Gio.File.new_for_path(path).delete_async(GLib.PRIORITY_DEFAULT, null,
            (f, res) => {
                try {
                    f.delete_finish(res);
                } catch (_e) {}
                resolve();
            });
    });
}

/**
 * The bytes of the file at `path` (a Uint8Array, one byte per byte), or
 * null when it does not exist; rejects on any other error.
 */
function _readBytes(path, cancellable) {
    return new Promise((resolve, reject) => {
        Gio.File.new_for_path(path).load_contents_async(cancellable,
            (f, res) => {
                try {
                    const [, bytes] = f.load_contents_finish(res);
                    resolve(bytes);
                } catch (e) {
                    const missing = e?.matches?.(Gio.IOErrorEnum,
                        Gio.IOErrorEnum.NOT_FOUND);
                    if (missing) resolve(null);
                    else reject(e);
                }
            });
    });
}

/**
 * Runs the asynchronous Gio.File method `start` of `file` with `args`,
 * resolves to what `finish` gives, rejects with its error.
 */
function _gio(file, start, finish, ...args) {
    return new Promise((resolve, reject) => {
        file[start](...args, (f, res) => {
            try {
                resolve(f[finish](res));
            } catch (e) {
                reject(e);
            }
        });
    });
}

// Symbolic links followed at most, as the kernel's own limit.
const LINKS_MAX = 40;

/**
 * `{path, mode}` of the file `path` names once its symbolic links are
 * followed (relative targets against the link's directory); `mode` is
 * null when that file does not exist.
 */
async function _linkTarget(path, cancellable) {
    let p = path;
    for (let hops = 0; hops <= LINKS_MAX; hops++) {
        let info;
        try {
            info = await _gio(Gio.File.new_for_path(p), 'query_info_async',
                'query_info_finish',
                'standard::is-symlink,standard::symlink-target,unix::mode',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_DEFAULT,
                cancellable);
        } catch (e) {
            if (e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                return {path: p, mode: null};
            throw e;
        }
        if (!info.get_is_symlink())
            return {path: p, mode: info.get_attribute_uint32('unix::mode')
                & 0o7777};
        const target = info.get_symlink_target();
        p = target.startsWith('/') ? target
            : `${p.slice(0, p.lastIndexOf('/'))}/${target}`;
    }
    throw new Error(`${path}: too many symbolic links`);
}

/**
 * Replaces the file at `path` with `bytes` in one atomic replacement: a
 * temporary file of its directory, given its mode (or `forcedMode`),
 * renamed over it.
 * GIO's own replace writes IN PLACE a link's target, a file of several
 * names, or a file whose directory is not writable, and a failure midway
 * then leaves it cut short; here a link is followed and its target
 * replaced (the link stays), a file of several names is split from the
 * others, and a directory not writable fails before the file is touched.
 * A missing file is made with the default mode, its directory too; the
 * temporary file is removed on a failure.
 */
async function _replaceKeepingMode(path, bytes, cancellable,
    forcedMode = null) {
    const found = await _linkTarget(path, cancellable);
    const target = found.path;
    const mode = forcedMode ?? found.mode;
    await _ensureDir(target.slice(0, target.lastIndexOf('/')));
    const tmpPath = `${target}.erplibre-home.tmp`;
    const tmp = Gio.File.new_for_path(tmpPath);
    try {
        // Private until its mode is set: never more open than the file.
        await _gio(tmp, 'replace_contents_bytes_async',
            'replace_contents_finish', new GLib.Bytes(bytes), null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION |
            (mode === null ? 0 : Gio.FileCreateFlags.PRIVATE), cancellable);
        if (mode !== null) {
            const info = new Gio.FileInfo();
            info.set_attribute_uint32('unix::mode', mode);
            await _gio(tmp, 'set_attributes_async', 'set_attributes_finish',
                info, Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                GLib.PRIORITY_DEFAULT, cancellable);
        }
        await _gio(tmp, 'move_async', 'move_finish',
            Gio.File.new_for_path(target), Gio.FileCopyFlags.OVERWRITE |
            Gio.FileCopyFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_DEFAULT,
            cancellable, null);
    } catch (e) {
        await _deleteFile(tmpPath);
        throw e;
    }
}

/** The URL and database of `dest`, as a token and a state file name them. */
function _issuedFor(dest) {
    return {url: String(dest.url).replace(/\/+$/, ''), db: dest.db};
}

function _defaultDeps(extensionPath, configDir, homeDir) {
    const conf = `${configDir}/${CONF_REL}`;
    const keymap = keymapFilePath(homeDir);
    return {
        usbWatch: onChange => new UsbWatch({onChange}),
        lookupToken,
        newSession,
        postJson,
        collectFacts: cancellable => collectFacts({extensionPath, configDir,
            cancellable}),
        readServiceState,
        readConf: cancellable => _readBytes(conf, cancellable),
        writeConf: (bytes, cancellable) =>
            _replaceKeepingMode(conf, bytes, cancellable),
        removeConf: _cancellable => _deleteFile(conf),
        readKeymap: cancellable => _readBytes(keymap, cancellable),
        // ~/.config made first: _replaceKeepingMode makes one level only.
        writeKeymap: async (bytes, cancellable) => {
            await _ensureDir(keymap.slice(0, keymap.lastIndexOf('/',
                keymap.lastIndexOf('/') - 1)));
            await _replaceKeepingMode(keymap, bytes, cancellable,
                KEYMAP_MODE);
        },
        readCatalog: cancellable => readCatalog({extensionPath, cancellable}),
        restartUnit: async cancellable => (await captureOutput(
            restartDeckArgv({unitExists: true}), cancellable)) !== null,
        now: () => new Date().toISOString(),
        clockMs: () => GLib.get_monotonic_time() / 1000,
        newUuid: () => GLib.uuid_string_random(),
    };
}

/**
 * The service. `settings` is the extension's Gio.Settings,
 * `extensionVersion` and `shellVersion` go into each `state`, `stateDir`
 * is the user state directory, `extensionPath` the extension directory
 * (to find the ERPLibre checkout), `configDir` the user configuration
 * directory holding erplibre-home/streamdeck.conf, `homeDir` the home
 * directory holding .config/erplibre-home/keymap.json. `deps` replaces
 * the parts that reach the system, for the tests.
 *
 * `decks()` is the deck list of the last scan; `status(destId)` and
 * `statuses()` say how each destination is doing; `connect('changed',
 * cb)` runs `cb()` after a scan that changed the decks, after any status
 * change and when the pending configuration changes; `connect('announce',
 * cb)` runs `cb(pending)` once per revision of the pilot that waits on the
 * employee, `pending` as `pendingConfig()` gives it.
 */
export class InventoryService {
    constructor({settings, extensionVersion, stateDir, shellVersion = null,
        extensionPath = null, configDir = GLib.get_user_config_dir(),
        homeDir = GLib.get_home_dir(), deps = {}} = {}) {
        this._settings = settings;
        this._extensionVersion = extensionVersion ?? null;
        this._stateDir = stateDir;
        this._shellVersion = shellVersion;
        this._deps = {..._defaultDeps(extensionPath, configDir, homeDir),
            ...deps};
        this._records = new Map();
        this._decks = null;
        this._service = null;
        this._facts = null;
        this._factsAt = null;
        this._factsPromise = null;
        // The catalog of the deck program (catalogFrom's), null when none
        // was read; the checkout commit it was read for, undefined before
        // the first reading.
        this._catalog = null;
        this._catalogCommit = undefined;
        this._polling = false;
        // Resolves to the seen file's `{decks, service}`, updated in place
        // as the service sees more; set by start().
        this._seen = null;
        this._seenText = null;
        this._seenWriting = Promise.resolve();
        this._readings = new Set();
        this._handlers = new Map();
        this._nextHandler = 0;
        this._settingsIds = [];
        this._tickId = 0;
        this._usb = null;
        this._started = false;
        this._stopped = false;
        // One application of a configuration at a time, in click order.
        this._applying = Promise.resolve();
        // The text last given to pilot.json, null once removed; undefined
        // before the first sync.
        this._pilotText = undefined;
        this._pilotWriting = Promise.resolve();
    }

    start() {
        if (this._started) return;
        this._started = true;
        this._seen = this._loadSeen();
        this._settingsIds = [
            this._settings.connect('changed::inventory-destinations',
                () => this._syncDestinations()),
            this._settings.connect('changed::inventory-pilot',
                () => this._onPilotChanged()),
            this._settings.connect('changed::inventory-apply-request',
                () => this._onApplyRequest()),
        ];
        this._syncDestinations();
        this._syncPilotFile();
        this._onApplyRequest();
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
        for (const id of this._settingsIds) this._settings.disconnect(id);
        this._settingsIds = [];
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
        if (!['changed', 'announce'].includes(signal) ||
            typeof cb !== 'function')
            return 0;
        const id = ++this._nextHandler;
        this._handlers.set(id, {signal, cb});
        return id;
    }

    disconnect(id) {
        this._handlers.delete(id);
    }

    _emit(signal = 'changed', ...args) {
        for (const h of [...this._handlers.values()]) {
            if (h.signal !== signal) continue;
            try {
                h.cb(...args);
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
            noTokenSince: 0,
            checking: false,
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
            // The next report was asked by a result its reply decided.
            chained: false,
            closed: false,
            dirReady: false,
            writing: Promise.resolve(),
            cfg: configStateFrom(null),
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
        rec.cfg = configStateFrom(saved?.config);
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
            ...(_emptyConfig(rec.cfg) ? {} : {config: rec.cfg}),
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

    // ------------------------------------------------ what was seen

    async _loadSeen() {
        const path = seenFilePath(this._stateDir);
        const text = path ? await readText(path) : null;
        this._seenText = text;
        return _parseSeen(text);
    }

    /**
     * Runs `fn(seen)` once the seen file is read, in call order, unless
     * the service stopped by then.
     */
    _afterSeen(fn) {
        this._seen.then(seen => {
            if (!this._stopped) fn(seen);
        });
    }

    /** Writes `seen` to its file when it differs from what the file holds. */
    _saveSeen(seen) {
        const path = seenFilePath(this._stateDir);
        const text = JSON.stringify({
            decks: seen.decks === null ? null : seen.decks.map(_seenDeck),
            service: seen.service});
        if (!path || text === this._seenText) return;
        this._seenText = text;
        this._seenWriting = this._seenWriting.then(async () => {
            await _ensureDir(path.slice(0, path.lastIndexOf('/')));
            await _writePrivate(path, text);
        }).catch(e => {
            this._seenText = null;
            console.log(`[ERPLibreHome] inventory seen file: ${e.message}`);
        });
    }

    // ------------------------------------------------- scans and events

    /**
     * A USB scan. The first one of a start is compared with the decks of
     * the seen file (none on a first start ever), the others with the
     * scan before; the events are dated when the scan came.
     */
    _onDecks(decks) {
        if (this._stopped) return;
        const prev = this._decks;
        const next = Array.isArray(decks) ? decks.map(d => ({...d})) : [];
        this._decks = next;
        this._emit();
        const at = this._deps.now();
        this._afterSeen(seen => {
            const before = prev ?? seen.decks;
            seen.decks = next;
            this._saveSeen(seen);
            const events = before === null ? []
                : diffDecks(before, next, at, this._deps.newUuid);
            if (events.length) this._queueEvents(events);
            else if (prev === null)
                for (const rec of this._records.values()) this._report(rec);
        });
    }

    /**
     * A reading of the deck service. The first one of a start is compared
     * with the seen file, the others with the reading before.
     */
    _observeService(next) {
        const prev = this._service;
        this._service = next;
        if (prev === next) return;
        const at = this._deps.now();
        this._afterSeen(seen => {
            const before = prev ?? seen.service;
            seen.service = next;
            this._saveSeen(seen);
            this._queueEvents(serviceChanged(before, next, at,
                this._deps.newUuid));
        });
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
        // A token stored or replaced by the preferences is picked up here,
        // and one they cleared is seen.
        for (const rec of recs) {
            if (rec.noToken || rec.state === 'revoked') this._report(rec);
            else this._checkToken(rec);
        }
    }

    /** Looks the token of `rec` up, between reports; none ends `_noToken`. */
    async _checkToken(rec) {
        if (rec.inFlight || rec.checking) return;
        rec.checking = true;
        try {
            await rec.loaded;
            const token = await this._deps.lookupToken(rec.dest.id,
                _issuedFor(rec.dest));
            if (!token && !this._stopped && !rec.closed && !rec.inFlight)
                this._noToken(rec);
        } catch (_e) {
            // A keyring error is not "no token": the next report says it.
        } finally {
            rec.checking = false;
        }
    }

    /**
     * The keyring holds no token for `rec`: it is `unenrolled` and queues
     * nothing. Still none POLL_S after the first look that found none,
     * the enrollment is over and its queue is dropped. A look between the
     * two calls that replace a token (lib/secret-store.js storeToken)
     * finds none for an instant only, and keeps the queue; a locked
     * keyring rejects the lookup instead. The state file is written at
     * the first look that finds none and when the queue is dropped, not
     * at every tick.
     */
    _noToken(rec) {
        const now = this._deps.clockMs();
        let changed = rec.state !== 'unenrolled' || rec.error !== null;
        if (!rec.noToken) {
            rec.noToken = true;
            rec.noTokenSince = now;
            changed = true;
        } else if (now - rec.noTokenSince >= POLL_S * 1000 &&
            (rec.queue.pending().length > 0 || rec.queue.lost > 0)) {
            rec.queue = new EventQueue({max: QUEUE_MAX,
                maxAgeDays: QUEUE_MAX_AGE_DAYS});
            changed = true;
        }
        if (changed) this._setStatus(rec, 'unenrolled', null);
    }

    async _pollService() {
        if (this._polling) return;
        this._polling = true;
        try {
            const next = await this._bounded(
                c => this._deps.readServiceState(c), null);
            if (this._stopped || !SERVICE_STATES.includes(next)) return;
            this._observeService(next);
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
                    return this._syncCatalog();
                }),
                this._service !== null ? null : this._bounded(
                    c => this._deps.readServiceState(c), null).then(s => {
                    if (this._service === null && SERVICE_STATES.includes(s))
                        this._observeService(s);
                }),
            ]).finally(() => {
                this._factsPromise = null;
            });
            await this._factsPromise;
        }
        return {...this._facts, serviceState: this._service ?? 'absent'};
    }

    /**
     * Reads the catalog again when the checkout commit of the facts is not
     * the one it was read for: once per commit, whether the reading gives
     * a catalog or not (none outside a checkout, or past TIMEOUT_S).
     */
    async _syncCatalog() {
        const commit = this._facts?.erplibre?.commit ?? null;
        if (commit === this._catalogCommit) return;
        this._catalogCommit = commit;
        const text = await this._bounded(c => this._deps.readCatalog(c),
            null);
        this._catalog = parseCatalog(text);
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
        const chained = rec.chained;
        rec.chained = false;
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
            this._noToken(rec);
            return null;
        }
        rec.noToken = false;
        if (token === rec.revokedToken) return null;

        const facts = await this._currentFacts();
        if (gone()) return null;
        // The pilot's local values, read for this report only: a report
        // that follows an application must not carry the values before it.
        // A streamdeck.conf that cannot be read (undefined, unlike a
        // missing one, null) tells no local value: the report then carries
        // no config, which Odoo takes as nothing to change, and its reply's
        // is not taken. A keymap.json that cannot be read holds no layout.
        const pilot = this._isPilot(rec);
        const conf = pilot
            ? await this._bounded(c => this._deps.readConf(c), undefined)
            : undefined;
        const readable = pilot && conf !== undefined;
        const keymap = readable
            ? await this._bounded(c => this._deps.readKeymap(c), undefined)
            : undefined;
        const current = readable ? readLocal(conf, keymap) : null;
        if (gone()) return null;
        const serviceState = facts.serviceState;
        const state = buildState({hostname: facts.hostname, os: facts.os,
            gnomeShell: this._shellVersion,
            extensionVersion: this._extensionVersion,
            contractVersion: CONTRACT_VERSION, erplibre: facts.erplibre,
            deckProgram: serviceState === 'absent' ? null : facts.deckProgram,
            serviceState, decks: this._decks ?? [],
            deckPlugins: facts.deckPlugins, deckCatalog: this._catalog});
        if (rec.queue.prune(this._deps.now()) > 0) this._save(rec);
        let config = {pilot: false};
        if (pilot) {
            config = readable ? configBody({pilot: true,
                revisionApplied: rec.cfg.revisionApplied,
                current, result: rec.cfg.result,
                choice: rec.cfg.choice}) : null;
        }
        const body = reportBody(state, rec.queue, config);
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
            const left = settleConfig(
                {result: rec.cfg.result, choice: rec.cfg.choice}, config);
            rec.cfg.result = left.result;
            rec.cfg.choice = left.choice;
            // A reply of the pilot only: another Odoo configures nothing.
            if (readable && this._isPilot(rec))
                this._onConfig(rec, r.config, current, chained);
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

    // ------------------------------------------------ Odoo configuration

    _isPilot(rec) {
        return !rec.closed && rec.allowed.ok &&
            rec.dest.id === settingString(this._settings, 'inventory-pilot');
    }

    /** The record of the pilot destination, or null when there is none. */
    _pilotRecord() {
        const rec = this._records.get(
            settingString(this._settings, 'inventory-pilot'));
        return rec && this._isPilot(rec) ? rec : null;
    }

    /**
     * The revision of the pilot that waits on the employee:
     * `{destinationId, label, revision, keys, ask}`, `keys` the settings
     * the file did not hold when it came, `ask` the keys Odoo asks to keep
     * or replace (`[]` for a plain apply); null when none waits.
     */
    pendingConfig() {
        const rec = this._pilotRecord();
        const p = rec ? pendingOf(rec.cfg) : null;
        return p && {destinationId: rec.dest.id, label: rec.dest.label, ...p};
    }

    _onPilotChanged() {
        if (this._stopped) return;
        for (const rec of this._records.values()) this._report(rec);
        this._syncPilotFile();
        this._emit();
    }

    /**
     * A request of the preferences in `inventory-apply-request`: the key
     * is emptied at once, so that the same click can come again, then the
     * request is carried out as a click would be. A value of another form
     * is dropped.
     */
    _onApplyRequest() {
        if (this._stopped) return;
        const value = settingString(this._settings, 'inventory-apply-request');
        if (value === '') return;
        setSettingString(this._settings, 'inventory-apply-request', '');
        const m = APPLY_REQUEST_RE.exec(value);
        if (!m) return;
        const revision = Number(m[2]);
        (m[3] ? this.keepLocal(m[1], revision)
            : this.applyConfig(m[1], revision)).catch(e =>
            console.log(`[ERPLibreHome] inventory config: ${e.message}`));
    }

    /**
     * The refusal reason of the key layouts of `settings` (`invalid:
     * key_layouts`), or null when it sets none or the deck can lay them
     * out: the catalog last read, and the plugins turned off by
     * `settings`, else by the file (`current`, as `readLocal` gives it).
     */
    _layoutsRefused(settings, current) {
        if (!Object.hasOwn(settings, KEYMAP_KEY)) return null;
        const off = settings.plugins_off ?? current?.plugins_off ?? [];
        return validateKeyLayouts(settings[KEYMAP_KEY], this._catalog, off)
            .reason;
    }

    /**
     * The `config` of a reply of the pilot (`validateConfig`'s result, null
     * when absent), `current` the local values its report read (as
     * `readLocal` gives them). None, or one of another shape, withdraws
     * what was offered. One out of the schema, or whose key layouts the
     * deck cannot lay out (`_layoutsRefused`), refuses its revision once,
     * at once, and offers nothing. A valid one becomes the offer: already
     * applied, or answered and still asking, it waits on nothing; held by
     * the files already, asking nothing and owing no restart, it is
     * applied at once, silently; otherwise it is announced, once. A
     * restart still owed (`restartOwed`) keeps its keys in the offer, so
     * that a revision refused after its write is not reported applied
     * because the files hold its values.
     *
     * `chained` tells that the report of this reply was itself sent at
     * once for a result a reply decided; a result decided now then waits
     * for the next report instead, so that an Odoo moving its revision at
     * each reply gets two reports per heartbeat at most, not a loop.
     */
    _onConfig(rec, reply, current, chained = false) {
        const cfg = rec.cfg;
        const decided = (revision, status, reason) => {
            rec.chained = !chained;
            this._finishConfig(rec, revision, [], status, reason, !chained);
        };
        if (reply === null || (!reply.ok && reply.reason === null)) {
            cfg.offer = null;
            this._syncPilotFile();
            this._emit();
            return;
        }
        const refused = reply.ok
            ? this._layoutsRefused(reply.settings, current) : null;
        if (refused !== null)
            reply = {ok: false, reason: refused, revision: reply.revision};
        if (!reply.ok) {
            cfg.offer = null;
            this._syncPilotFile();
            if (cfg.refused?.revision !== reply.revision) {
                cfg.refused = {revision: reply.revision, reason: reply.reason};
                decided(reply.revision, 'refused', reply.reason);
            }
            return;
        }
        const {revision, ask} = reply;
        const keys = _offerKeys(current, reply.settings, cfg.restartOwed);
        cfg.offer = {revision, hash: reply.hash, settings: reply.settings,
            locked: reply.locked, ask, keys};
        this._syncPilotFile();
        if (revision === cfg.revisionApplied ||
            (revision === cfg.answered && ask.length))
            return;
        if (!ask.length && !keys.length) {
            decided(revision, 'applied', null);
            return;
        }
        if (cfg.announced !== revision) {
            cfg.announced = revision;
            this._save(rec);
            this._emit('announce', this.pendingConfig());
        }
        this._emit();
    }

    /**
     * Records the result of `revision` for the next report, sent at once
     * unless `atOnce` is false, and writes its journal line: the
     * destination, the revision, the keys that changed and the result,
     * never a value of the keyring.
     */
    _finishConfig(rec, revision, keys, status, reason, atOnce = true) {
        const result = {revision, status, reason, at: this._deps.now()};
        rec.cfg.result = result;
        if (status === 'applied') rec.cfg.revisionApplied = revision;
        console.log(`[ERPLibreHome] inventory config: ${rec.dest.label} `
            + `revision ${revision} keys ${keys.join(',') || '-'} ${status}`
            + `${reason ? ` ${reason}` : ''}`);
        this._save(rec);
        this._emit();
        if (atOnce) this._report(rec);
        return result;
    }

    /** Runs `work()` after the applications asked before it. */
    _serial(work) {
        const run = this._applying.then(work);
        this._applying = run.catch(() => null);
        return run;
    }

    /**
     * The employee's click on revision `revision` of `destId` (on a
     * revision that asks, « Use Odoo's settings »). Resolves to the result
     * `{revision, status, reason, at}` reported to Odoo at once, or to null
     * when `destId` is not the pilot or that revision does not wait.
     */
    applyConfig(destId, revision) {
        return this._serial(async () => {
            const rec = this._records.get(destId);
            if (!rec || !this._isPilot(rec)) return null;
            await rec.loaded;
            const offer = rec.cfg.offer;
            if (this._stopped || !this._isPilot(rec) ||
                pendingOf(rec.cfg)?.revision !== revision)
                return null;
            return this._applyOffer(rec, offer);
        });
    }

    /**
     * « Keep my settings » on revision `revision` of `destId`: nothing is
     * written, the choice `keep_local` goes in a report sent at once.
     * Resolves to true, or to false when that revision of the pilot does
     * not wait or asks nothing.
     */
    keepLocal(destId, revision) {
        return this._serial(async () => {
            const rec = this._records.get(destId);
            if (!rec || !this._isPilot(rec)) return false;
            await rec.loaded;
            const pending = pendingOf(rec.cfg);
            if (this._stopped || !this._isPilot(rec) ||
                pending?.revision !== revision || !pending.ask.length)
                return false;
            rec.cfg.answered = revision;
            // Announced again if it comes back without ask.
            rec.cfg.announced = null;
            rec.cfg.choice = 'keep_local';
            console.log(`[ERPLibreHome] inventory config: ${rec.dest.label} `
                + `revision ${revision} keys ${pending.ask.join(',')} kept`);
            this._save(rec);
            this._emit();
            this._report(rec);
            return true;
        });
    }

    /**
     * Applies `offer` to streamdeck.conf and keymap.json. Its values were
     * checked whole when it came (`validateConfig`, from the reply or the
     * state file), and `rewriteConf` and `keymapText` throw before
     * building anything on a value outside the schema; its key layouts are
     * checked again against the catalog now held (`_layoutsRefused`),
     * which a new commit of the checkout may have changed: a layout the
     * deck cannot lay out refuses `invalid:key_layouts`, nothing written.
     * Both files are read again; streamdeck.conf is rewritten in one atomic
     * replacement when one of its keys changes, then keymap.json, mode
     * 0644, when the layouts change; when keymap.json cannot be written,
     * streamdeck.conf is put back as it was read (removed when it did not
     * exist) and the revision refused `write_failed`. Then the deck unit
     * is restarted, once, when a key that needs it changed and the unit is
     * active. A missing unit refuses a changed program, the files written
     * all the same; an inactive or failed one is not started; a state that
     * cannot be read refuses `restart_failed`. A refusal after the write
     * leaves its restarting keys owed (`restartOwed`): the next click
     * restarts for them though the files hold their values; a restart
     * done, or a unit found not running, clears them. Each step is bounded
     * by TIMEOUT_S, past which it counts as failed.
     */
    async _applyOffer(rec, offer) {
        const done = (keys, status, reason) => {
            if (status === 'applied' && offer.ask.length)
                rec.cfg.choice = 'take_odoo';
            return this._finishConfig(rec, offer.revision, keys, status,
                reason);
        };
        const owe = (keys, reason) => {
            rec.cfg.restartOwed = _restartKeys(keys);
            return done(keys, 'refused', reason);
        };
        const write = (fn, bytes) => this._bounded(
            c => Promise.resolve(fn(bytes, c)).then(() => true), false);
        const before = await this._bounded(c => this._deps.readConf(c),
            undefined);
        if (before === undefined) return done([], 'refused', 'write_failed');
        const keymap = await this._bounded(c => this._deps.readKeymap(c),
            undefined);
        const current = readLocal(before, keymap);
        const keys = _offerKeys(current, offer.settings,
            rec.cfg.restartOwed);
        const refused = this._layoutsRefused(offer.settings, current);
        if (refused !== null) return done(keys, 'refused', refused);
        const changed = changedKeys(current, offer.settings);
        const confWritten = changed.some(k => k !== KEYMAP_KEY);
        if (confWritten) {
            // A missing file (null) gives a text of the managed lines only.
            let after = rewriteConf(before, offer.settings);
            if (typeof after === 'string')
                after = new TextEncoder().encode(after);
            if (!await write(this._deps.writeConf, after))
                return done(keys, 'refused', 'write_failed');
            this._factsAt = null;
        }
        if (changed.includes(KEYMAP_KEY)) {
            const text = keymapText(offer.revision,
                offer.settings[KEYMAP_KEY]);
            if (!await write(this._deps.writeKeymap,
                new TextEncoder().encode(text))) {
                // Both files or neither: the conf goes back as it was read.
                const putBack = before === null
                    ? (_bytes, c) => this._deps.removeConf(c)
                    : this._deps.writeConf;
                if (confWritten && !await write(putBack, before)) {
                    console.log('[ERPLibreHome] inventory config: '
                        + 'streamdeck.conf not put back');
                }
                return done(keys, 'refused', 'write_failed');
            }
        }
        if (needsRestart(keys)) {
            // A state not read (systemctl failed, or past TIMEOUT_S) is
            // null: restarting could start a stopped unit, skipping it
            // could leave the old values running, so it refuses.
            const unit = await this._bounded(
                c => this._deps.readServiceState(c, null), null);
            if (unit === null) return owe(keys, 'restart_failed');
            if (unit === 'active') {
                const restarted = await this._bounded(
                    c => this._deps.restartUnit(c), false);
                if (!restarted) return owe(keys, 'restart_failed');
            } else if (unit === 'absent' && keys.includes('deck_program')) {
                return owe(keys, 'unit_missing');
            }
        }
        rec.cfg.restartOwed = null;
        return done(keys, 'applied', null);
    }

    /**
     * Brings pilot.json in line with the pilot: its label, the revision it
     * sent last and its locked keys, mode 0600; removed when no destination
     * is the pilot or its Odoo sends no configuration. Waits for the
     * pilot's state file, so that a start does not remove it in passing.
     */
    _syncPilotFile() {
        const rec = this._pilotRecord();
        (rec?.loaded ?? Promise.resolve()).then(() => {
            if (this._stopped) return;
            const now = this._pilotRecord();
            const offer = now?.cfg.offer ?? null;
            const text = offer ? JSON.stringify({destination: now.dest.label,
                revision: offer.revision, locked: offer.locked}) : null;
            const path = pilotFilePath(this._stateDir);
            if (text === this._pilotText || !path) return;
            this._pilotText = text;
            this._pilotWriting = this._pilotWriting.then(async () => {
                if (text === null) {
                    await _deleteFile(path);
                    return;
                }
                await _ensureDir(path.slice(0, path.lastIndexOf('/')));
                await _writePrivate(path, text);
            }).catch(e => {
                this._pilotText = undefined;
                console.log(
                    `[ERPLibreHome] inventory pilot file: ${e.message}`);
            });
        });
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
