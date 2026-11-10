/**
 * The Odoo inventory as the preferences see it: the destinations of the
 * `inventory-destinations` key, their enrollment, and the status the
 * background service (lib/inventory-service.js) keeps in its state file.
 * prefs.js builds its page on this module and holds no logic of its own.
 *
 * Enrolling a destination posts its URL policy-checked enrollment body
 * (lib/inventory.js `enrollBody`) to `/streamdeck/v1/enroll`, then stores
 * the token Odoo returns in the GNOME keyring, bound to the destination's
 * URL and database (lib/secret-store.js); the service finds it at its next
 * tick. The pairing code, the API key and the password only go into that
 * one body: nothing here keeps, logs or writes them, and the token goes
 * nowhere but the keyring.
 *
 * Unenrolling asks Odoo to revoke the token, then forgets it on the
 * workstation whatever Odoo answered: a workstation that leaves an Odoo
 * keeps no way back in. Removing a destination unenrolls it, removes it
 * from the settings and deletes its state file.
 *
 * Every call to Odoo goes through lib/odoo-http.js on a session of its
 * own and ends after CALL_DEADLINE_S at most; one call at a time per
 * destination. This code runs in the preferences process, never in GNOME
 * Shell, and blocks nothing there either: every read, write and call is
 * asynchronous.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {_} from './i18n.js';
import {TIMEOUT_S, ENROLL_PATH, UNENROLL_PATH, INVENTORY_PROTOCOL,
    urlAllowed, workstationFingerprint, parseDestinations,
    serializeDestinations, checkDestination, enrollBody, parseEnrollReply,
    parseUnenrollReply, statusFromStateFile} from './inventory.js';
import {lookupToken, storeToken, clearToken} from './secret-store.js';
import {newSession, postJson} from './odoo-http.js';
import {readText} from './usb-watch.js';
import {parseList} from './settings.js';
import {stateFilePath} from './inventory-service.js';

// The whole of one call (database choice, then the POST), past which it
// is cancelled and counts as `network`. Soup's TIMEOUT_S bounds each
// stall of the connection, not a server that trickles its answer.
export const CALL_DEADLINE_S = 2 * TIMEOUT_S;
// Where the machine-id is read, in order (machine-id(5)).
export const MACHINE_ID_PATHS = ['/etc/machine-id',
    '/var/lib/dbus/machine-id'];

function _hmacSha256Hex(key, msg) {
    return GLib.compute_hmac_for_string(GLib.ChecksumType.SHA256,
        new TextEncoder().encode(key), msg, -1);
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

function _defaultDeps() {
    return {
        postJson, newSession, lookupToken, storeToken, clearToken, readText,
        deleteFile: _deleteFile,
        machineIdPaths: MACHINE_ID_PATHS,
        uid: () => new Gio.Credentials().get_unix_user(),
        hostname: () => GLib.get_host_name(),
        hmac: _hmacSha256Hex,
        uuid: () => GLib.uuid_string_random(),
        now: () => Date.now(),
    };
}

/**
 * The model of the preferences page. `settings` is the extension's
 * Gio.Settings, `stateDir` the directory the service writes its state
 * files under (GLib.get_user_state_dir() in both processes); `deps`
 * replaces the system calls, for the tests.
 */
export class InventoryPrefs {
    constructor({settings, stateDir = GLib.get_user_state_dir(),
        deps = {}} = {}) {
        this._settings = settings;
        this._stateDir = stateDir;
        this._deps = {..._defaultDeps(), ...deps};
        this._busy = new Set();
        // Destination id -> time of an enrollment made here: the state
        // file says nothing of the new token before the service reports.
        this._enrolledAt = new Map();
    }

    destinations() {
        return parseDestinations(
            this._settings.get_string('inventory-destinations'));
    }

    /** `[{id, name, url}]`: the entries of `instances` that have a URL. */
    instances() {
        return parseList(this._settings.get_string('instances'))
            .filter(i => typeof i?.id === 'string' && i.id !== '' &&
                typeof i.url === 'string' && i.url !== '')
            .map(i => ({id: i.id, name: typeof i.name === 'string' &&
                i.name !== '' ? i.name : i.url, url: i.url}));
    }

    busy(destId) {
        return this._busy.has(destId);
    }

    /**
     * Stores a new destination from the form `{instanceId, url, db,
     * label}`: with `instanceId`, the URL is that instance's and the
     * label defaults to its name. Returns `{ok, reason, dest}`; `reason`
     * is a code of `checkDestination`, or `unknown` for an instance that
     * no longer exists.
     */
    add({instanceId = null, url, db, label} = {}) {
        let source = 'remote';
        if (instanceId) {
            const instance = this.instances().find(i => i.id === instanceId);
            if (!instance) return {ok: false, reason: 'unknown', dest: null};
            url = instance.url;
            label = label || instance.name;
            source = 'local';
        }
        const dests = this.destinations();
        const r = checkDestination({url, db, label}, dests);
        if (!r.ok) return {ok: false, reason: r.reason, dest: null};
        const dest = {id: this._deps.uuid(), label: r.label, url: r.url,
            db: r.db, source, instanceId: source === 'local'
                ? instanceId : null};
        this._settings.set_string('inventory-destinations',
            serializeDestinations([...dests, dest]));
        return {ok: true, reason: null, dest};
    }

    _find(destId) {
        return this.destinations().find(d => d.id === destId) ?? null;
    }

    async _fingerprint(dest) {
        for (const p of this._deps.machineIdPaths) {
            const text = await this._deps.readText(p);
            if (text === null || text.trim() === '') continue;
            return workstationFingerprint({machineId: text,
                uid: this._deps.uid(), url: dest.url, db: dest.db},
            this._deps.hmac);
        }
        throw new Error('no machine-id');
    }

    /**
     * POSTs `body` to `path` of `dest`, bounded by CALL_DEADLINE_S;
     * resolves to `{status, json}` like postJson, status 0 past the
     * deadline.
     */
    async _call(dest, path, body, token) {
        const cancellable = new Gio.Cancellable();
        const id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
            CALL_DEADLINE_S, () => {
                cancellable.cancel();
                return GLib.SOURCE_REMOVE;
            });
        const session = this._deps.newSession();
        try {
            return await this._deps.postJson(session, dest.url, dest.db,
                path, body, token, {cancellable});
        } finally {
            if (!cancellable.is_cancelled()) GLib.source_remove(id);
            session.abort?.();
        }
    }

    async _exclusive(destId, work, failed) {
        if (this._busy.has(destId)) return failed('busy');
        this._busy.add(destId);
        try {
            return await work();
        } finally {
            this._busy.delete(destId);
        }
    }

    /**
     * Enrolls destination `destId` with `credentials` (`{method, code,
     * key, login, password}`). Resolves to `{ok, error, workstationId}`;
     * `error` is a code `messageFor` explains. The token a destination
     * already holds stays until Odoo returns a new one.
     */
    enroll(destId, credentials) {
        const failed = error => ({ok: false, error, workstationId: null});
        return this._exclusive(destId, async () => {
            const dest = this._find(destId);
            if (!dest) return failed('unknown');
            const allowed = urlAllowed(dest.url);
            if (!allowed.ok) return failed(allowed.reason);
            let fingerprint;
            try {
                fingerprint = await this._fingerprint(dest);
            } catch (_e) {
                return failed('machine_id');
            }
            const built = enrollBody(credentials, {fingerprint,
                hostname: this._deps.hostname()});
            if (!built.ok) return failed(built.error);
            const reply = await this._call(dest, ENROLL_PATH, built.body,
                null);
            const r = parseEnrollReply(reply.status, reply.json);
            if (!r.ok) return failed(r.error);
            try {
                await this._deps.storeToken(dest.id,
                    _('ERPLibre Home inventory: {label}')
                        .replace('{label}', dest.label),
                    r.token, {url: dest.url, db: dest.db});
            } catch (_e) {
                return failed('keyring');
            }
            this._enrolledAt.set(dest.id, this._deps.now());
            return {ok: true, error: null, workstationId: r.workstationId};
        }, failed);
    }

    /**
     * Revokes the token of `destId` in Odoo, then removes it from the
     * keyring whatever the answer. Resolves to `{ok, revoked, error}`:
     * `revoked` when Odoo confirmed that the token no longer works,
     * `error` when it could not (`network`…) or the keyring failed; `ok`
     * once no token is left on the workstation.
     */
    unenroll(destId) {
        const failed = error => ({ok: false, revoked: false, error});
        return this._exclusive(destId, async () => {
            const dest = this._find(destId);
            if (!dest) return failed('unknown');
            return this._unenroll(dest);
        }, failed);
    }

    async _unenroll(dest) {
        let token;
        try {
            token = urlAllowed(dest.url).ok
                ? await this._deps.lookupToken(dest.id,
                    {url: dest.url, db: dest.db})
                : null;
        } catch (_e) {
            return {ok: false, revoked: false, error: 'keyring'};
        }
        let revoked = false;
        let error = null;
        if (token) {
            const reply = await this._call(dest, UNENROLL_PATH,
                {protocol: INVENTORY_PROTOCOL}, token);
            const r = parseUnenrollReply(reply.status, reply.json);
            revoked = r.revoked;
            error = r.revoked ? null : r.error;
        }
        try {
            await this._deps.clearToken(dest.id);
        } catch (_e) {
            return {ok: false, revoked, error: 'keyring'};
        }
        this._enrolledAt.delete(dest.id);
        return {ok: true, revoked, error};
    }

    /**
     * Unenrolls `destId` as `unenroll` does, then removes it from the
     * settings and deletes its state file, even when Odoo or the keyring
     * failed. Resolves to the `{ok, revoked, error}` of the unenrollment
     * plus `removed`: `ok` false with `removed` true means that the
     * destination is gone but the keyring may still hold its token.
     */
    remove(destId) {
        const failed = error => ({ok: false, revoked: false, error,
            removed: false});
        return this._exclusive(destId, async () => {
            const dest = this._find(destId);
            if (!dest) return failed('unknown');
            const r = await this._unenroll(dest);
            this._settings.set_string('inventory-destinations',
                serializeDestinations(this.destinations()
                    .filter(d => d.id !== destId)));
            const path = stateFilePath(this._stateDir, destId);
            if (path) await this._deps.deleteFile(path);
            return {...r, removed: true};
        }, failed);
    }

    /**
     * `{state, pending, lastReport, error, enrolled}` of `destId`, null
     * for an unknown id. `state` is `refused` for a URL the policy
     * refuses, `unenrolled` without a token, `waiting` with a token the
     * service has not reported with yet, else the state file's;
     * `offline` with error `keyring` when the keyring cannot be read.
     */
    async status(destId) {
        const dest = this._find(destId);
        if (!dest) return null;
        const none = {state: 'unenrolled', pending: 0, lastReport: null,
            error: null, enrolled: false};
        const allowed = urlAllowed(dest.url);
        if (!allowed.ok)
            return {...none, state: 'refused', error: allowed.reason};
        let token;
        try {
            token = await this._deps.lookupToken(dest.id,
                {url: dest.url, db: dest.db});
        } catch (_e) {
            return {...none, state: 'offline', error: 'keyring'};
        }
        if (!token) return none;
        const path = stateFilePath(this._stateDir, dest.id);
        const saved = path
            ? statusFromStateFile(await this._deps.readText(path), dest)
            : null;
        const waiting = {...none, state: 'waiting', enrolled: true};
        if (!saved || saved.state === 'unenrolled') return waiting;
        const enrolledAt = this._enrolledAt.get(dest.id);
        if (enrolledAt !== undefined && !(Date.parse(saved.lastReport) >=
            enrolledAt))
            return {...waiting, pending: saved.pending};
        return {...saved, enrolled: true};
    }
}

/** The sentence the page shows for an error or refusal `code`. */
export function messageFor(code) {
    switch (code) {
    case 'invalid':
        return _('Not a valid address: give an http or https URL, without '
            + 'a query or a fragment.');
    case 'scheme':
        return _('Only http and https addresses are accepted.');
    case 'credentials':
        return _('Remove the user name and password from the address: the '
            + 'settings would keep them.');
    case 'plain_http':
        return _('Plain HTTP is accepted only to this machine: use https.');
    case 'db':
        return _('Not a database name Odoo accepts.');
    case 'duplicate':
        return _('This Odoo and database already are a destination.');
    case 'unknown':
        return _('This destination or instance no longer exists.');
    case 'missing':
        return _('Fill in every field of the chosen method.');
    case 'code_format':
        return _('A pairing code has 8 letters and digits.');
    case 'too_long':
        return _('A value is longer than Odoo accepts.');
    case 'bad_request':
        return _('Odoo refused the request as malformed.');
    case 'protocol_unsupported':
        return _('This Odoo speaks another version of the inventory '
            + 'protocol: update the extension or the Odoo module.');
    case 'credentials_refused':
        return _('Odoo refused these credentials: wrong, expired or '
            + 'already used.');
    case 'user_inactive':
        return _('This Odoo user is archived or may not use Stream Deck.');
    case 'token_invalid':
        return _('Odoo no longer accepts the enrollment of this '
            + 'workstation.');
    case 'network':
        return _('Odoo did not answer.');
    case 'not_found':
        return _('Odoo has no inventory route here: check the database and '
            + 'that the Stream Deck module is installed.');
    case 'bad_reply':
        return _('Odoo gave an unexpected answer.');
    case 'keyring':
        return _('The GNOME keyring could not be used.');
    case 'machine_id':
        return _('This machine has no readable /etc/machine-id.');
    case 'busy':
        return _('A call to this Odoo is already in progress.');
    default:
        return _('Error: {code}').replace('{code}', String(code));
    }
}

function _when(iso) {
    const t = Date.parse(iso);
    return Number.isNaN(t) ? null : new Date(t).toLocaleString();
}

/** `{title, subtitle}` of a `status` result, for the destination's row. */
export function statusText(status) {
    const s = status ?? {};
    const last = _when(s.lastReport);
    const lastLine = last
        ? _('Last report: {time}').replace('{time}', last) : '';
    switch (s.state) {
    case 'waiting':
        return {title: _('Enrolled, waiting for the first report'),
            subtitle: _('The extension reports within a few seconds.')};
    case 'ok':
        return {title: _('Up to date'), subtitle: lastLine};
    case 'offline':
        return {title: _('Offline ({n} pending)')
            .replace('{n}', String(s.pending ?? 0)),
        subtitle: messageFor(s.error ?? 'network')};
    case 'revoked':
        return {title: _('Enrollment revoked'),
            subtitle: `${messageFor(s.error ?? 'token_invalid')} ${
                _('Enroll again to resume the reports.')}`};
    case 'refused':
        return {title: _('Refused'),
            subtitle: messageFor(s.error ?? 'bad_reply')};
    default:
        return {title: _('Not enrolled'),
            subtitle: _('Enroll with a pairing code, an API key, or a login '
                + 'and password.')};
    }
}
