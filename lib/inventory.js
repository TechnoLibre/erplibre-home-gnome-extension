/**
 * Stream Deck inventory for Odoo: the pure half of what the extension
 * pushes to each enrolled Odoo instance — URL policy, workstation
 * fingerprint, wire `state`, deck events, the bounded offline queue,
 * the report body and its reply, the destinations stored in GSettings,
 * and what the preferences check before they enroll a destination.
 *
 * Its one import is deck-config.js, pure too: the module runs under GJS
 * in GNOME Shell and under node in the tests. GJS has neither the WHATWG
 * `URL` nor `crypto`, so URLs are parsed here, the HMAC is a function the
 * caller passes, and so is the uuid generator. The wire format is
 * described in CONTRACT.md; the field names below are the wire's own.
 */

import {CONFIG_KEYS, CHOICES, PLUGIN_ID_RE, DECK_PLUGINS_MAX, REASON_MAX,
    validateConfig} from './deck-config.js';

// Version of the report protocol, separate from the extension contract.
// Odoo refuses an unknown MAJOR and accepts a newer MINOR.
export const INVENTORY_PROTOCOL = '1.1';
// The routes of the Odoo module, under the destination's URL.
export const ENROLL_PATH = '/streamdeck/v1/enroll';
export const REPORT_PATH = '/streamdeck/v1/report';
export const UNENROLL_PATH = '/streamdeck/v1/unenroll';
export const ENROLL_METHODS = ['pairing_code', 'api_key', 'password'];
// Seconds between two reports when nothing changes.
export const HEARTBEAT_S = 900;
// Seconds between two USB polls when GUdev is unavailable.
export const POLL_S = 10;
// Seconds an HTTP call to Odoo may take before it counts as offline.
export const TIMEOUT_S = 10;
// Offline queue bounds, per destination: the oldest events drop first.
export const QUEUE_MAX = 1000;
export const QUEUE_MAX_AGE_DAYS = 30;

// Bounds applied to the heartbeat an Odoo reply asks for, so that a
// reply can neither make the workstation hammer the server nor go
// silent for days.
const HEARTBEAT_MIN_S = 60;
const HEARTBEAT_MAX_S = 86400;

const DAY_MS = 86400 * 1000;

const SERVICE_STATES = ['active', 'failed', 'inactive', 'absent'];
const EVENT_KINDS = ['plugged', 'unplugged', 'service_changed'];
// The `error` codes an Odoo reply may carry, as the wire contract lists.
export const ERROR_CODES = ['bad_request', 'protocol_unsupported',
    'credentials_refused', 'user_inactive', 'token_invalid'];
// The states of a destination the service writes in its state file.
const STATUS_STATES = ['unenrolled', 'ok', 'offline', 'revoked', 'refused'];

// Bounds Odoo applies to every text of a body, counted by code point as
// Python does: a longer value is a 400 `bad_request`.
const MAX_TEXT = 256;
const MAX_SECRET = 4096;
// A pairing code once spaces and hyphens are removed: 8 characters of the
// alphabet Odoo draws from, which has neither 0, 1, I nor O.
const PAIRING_RE = /^[A-HJ-NP-Z2-9]{8}$/;
// A token: base64url, at least the 43 characters of 32 random bytes; the
// bound keeps it a plain header value whatever the server sends.
const TOKEN_RE = /^[A-Za-z0-9_-]{43,512}$/;
// A database name Odoo accepts; PostgreSQL cuts names at 63 bytes.
const DB_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]+$/;
const DB_MAX = 63;
const LABEL_MAX = 80;

// ---------------------------------------------------------------------
// URL policy

/**
 * Whether the extension may send credentials and tokens to `url`.
 *
 * HTTPS to any host; plain HTTP only to this machine: `localhost`, an
 * IPv4 address in 127.0.0.0/8 written as four decimal octets, or the
 * IPv6 `::1` in brackets. Returns `{ok, reason}`, `reason` null when
 * allowed, otherwise one code for the preferences to explain:
 *  - `invalid`: not an absolute http(s) URL with a host, or it has
 *    whitespace, a backslash, a query, a fragment or a bad port — the
 *    client appends route paths to it;
 *  - `scheme`: neither `http` nor `https`;
 *  - `credentials`: a user part (`user:pw@`), which GSettings would keep;
 *  - `plain_http`: HTTP to a host that is not loopback.
 *
 * Anything this parser does not recognise as loopback is refused over
 * HTTP: `127.1`, octets with a leading zero (which inet_aton reads in
 * octal), hex forms, or IPv4-mapped IPv6 addresses.
 */
export function urlAllowed(url) {
    const refuse = reason => ({ok: false, reason});
    if (typeof url !== 'string' || url === '') return refuse('invalid');
    if (/[\s\x00-\x1f\x7f\\]/.test(url)) return refuse('invalid');
    const s = url.match(/^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/);
    if (!s) return refuse('invalid');
    const scheme = s[1].toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') return refuse('scheme');
    const a = s[2].match(/^\/\/([^/?#]*)(.*)$/);
    if (!a) return refuse('invalid');
    const [, authority, rest] = a;
    if (/[?#]/.test(rest)) return refuse('invalid');
    if (authority.includes('@')) return refuse('credentials');
    const host = _parseAuthority(authority);
    if (!host) return refuse('invalid');
    if (scheme === 'https') return {ok: true, reason: null};
    return host.loopback ? {ok: true, reason: null} : refuse('plain_http');
}

/**
 * `{loopback}` for a valid `host[:port]` or `[ipv6][:port]`, null
 * otherwise. The port, when written, is 1–65535.
 */
function _parseAuthority(authority) {
    let host, port, loopback;
    const v6 = authority.match(/^\[([^\]]*)\](?::(.*))?$/);
    if (v6) {
        const groups = _ipv6Groups(v6[1]);
        if (groups === null) return null;
        port = v6[2];
        loopback = Array.isArray(groups) &&
            groups.slice(0, 7).every(g => g === 0) && groups[7] === 1;
    } else {
        const m = authority.match(/^([^:]*)(?::(.*))?$/);
        if (!m) return null;
        [, host, port] = m;
        if (!/^[A-Za-z0-9._-]+$/.test(host)) return null;
        loopback = _ipv4Loopback(host) ||
            ['localhost', 'localhost.'].includes(host.toLowerCase());
    }
    if (port !== undefined) {
        if (!/^\d{1,5}$/.test(port)) return null;
        const n = Number(port);
        if (n < 1 || n > 65535) return null;
    }
    return {loopback};
}

/** True for `127.a.b.c`, four decimal octets 0–255 without leading zero. */
function _ipv4Loopback(host) {
    const octets = host.split('.');
    if (octets.length !== 4) return false;
    for (const o of octets) {
        if (!/^(0|[1-9]\d{0,2})$/.test(o) || Number(o) > 255) return false;
    }
    return octets[0] === '127';
}

/**
 * The eight 16-bit groups of an IPv6 address, `'other'` for a valid
 * form with an embedded IPv4 tail (never loopback here), null when it
 * is not an IPv6 address. A zone (`%…`) is not accepted.
 */
function _ipv6Groups(text) {
    if (!/^[0-9A-Fa-f:.]+$/.test(text)) return null;
    if (text.includes('.')) return text.includes(':') ? 'other' : null;
    const halves = text.split('::');
    if (halves.length > 2) return null;
    const split = h => (h === '' ? [] : h.split(':'));
    const head = split(halves[0]);
    const tail = halves.length === 2 ? split(halves[1]) : [];
    const all = [...head, ...tail];
    if (!all.every(g => /^[0-9A-Fa-f]{1,4}$/.test(g))) return null;
    if (halves.length === 1 && all.length !== 8) return null;
    if (halves.length === 2 && all.length > 7) return null;
    const zeros = new Array(8 - all.length).fill('0');
    return [...head, ...zeros, ...tail].map(g => parseInt(g, 16));
}

// ---------------------------------------------------------------------
// Workstation fingerprint

/**
 * The workstation id one destination sees: HMAC-SHA256 of the stripped
 * content of /etc/machine-id, keyed by `"<uid>|<url>|<db>"` with the
 * URL's trailing slashes removed. Two destinations, or two Linux users,
 * get unrelated values, and the machine-id never leaves the machine.
 *
 * `hmacSha256Hex(key, msg)` returns the lowercase hex digest. Throws on
 * an empty machine-id (every such workstation would collide), a uid that
 * is not a non-negative integer, an empty url or db, or a digest that is
 * not 64 lowercase hex characters.
 */
export function workstationFingerprint({machineId, uid, url, db},
    hmacSha256Hex) {
    const msg = String(machineId ?? '').trim();
    if (msg === '') throw new Error('machine-id is empty');
    const uidText = String(uid ?? '');
    if (!/^\d+$/.test(uidText)) throw new Error('uid is not an integer');
    if (typeof url !== 'string' || url === '' ||
        typeof db !== 'string' || db === '')
        throw new Error('url and db are required');
    const key = `${uidText}|${url.replace(/\/+$/, '')}|${db}`;
    const digest = hmacSha256Hex(key, msg);
    if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest))
        throw new Error('HMAC digest is not 64 lowercase hex characters');
    return digest;
}

// ---------------------------------------------------------------------
// System and wire state

/**
 * `{name, version}` from the text of /etc/os-release: `NAME`, and
 * `VERSION_ID` or else `VERSION`; a missing or empty value is null.
 * Values may be bare, single-quoted, or double-quoted with backslash
 * escapes, as os-release(5) allows.
 */
export function parseOsRelease(text) {
    const values = {};
    if (typeof text === 'string') {
        for (const line of text.split('\n')) {
            const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
            if (!m) continue;
            let v = m[2].trim();
            if (v.length >= 2 && v.startsWith('"') && v.endsWith('"'))
                v = v.slice(1, -1).replace(/\\(["\\$`])/g, '$1');
            else if (v.length >= 2 && v.startsWith("'") && v.endsWith("'"))
                v = v.slice(1, -1);
            values[m[1]] = v;
        }
    }
    const pick = (...keys) => {
        for (const k of keys) if (values[k]) return values[k];
        return null;
    };
    return {name: pick('NAME'), version: pick('VERSION_ID', 'VERSION')};
}

/** A non-empty string, or null; numbers become their decimal text. */
function _text(v) {
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    return typeof v === 'string' && v !== '' ? v : null;
}

/**
 * `v` as a text Odoo stores: `_text(v)` without its NUL characters (the
 * database refuses them, so Odoo answers 400), cut to MAX_TEXT code
 * points; null when nothing is left. The cut never splits a surrogate
 * pair, whose lone half Odoo refuses too.
 */
function _odooText(v) {
    const t = _text(v);
    if (t === null) return null;
    const cut = Array.from(t.replace(/\0/g, '')).slice(0, MAX_TEXT).join('');
    return cut === '' ? null : cut;
}

// The serials and USB product ids Odoo accepts. It answers 400
// `bad_request` to any other, and a refused report holds back every
// event of the destination, so such a value goes as null instead.
const SERIAL_RE = /^[A-Za-z0-9._-]{1,64}$/;
const PRODUCT_RE = /^[0-9a-f]{4}$/;

/** `v` as a serial Odoo accepts, else null: the deck goes without one. */
function _serial(v) {
    const t = _text(v);
    return t !== null && SERIAL_RE.test(t) ? t : null;
}

/**
 * A deck as the wire carries it: `{serial, usb_product_id, usb_path,
 * firmware}`, empty strings as null, the product id in lowercase hex, a
 * serial outside SERIAL_RE or a product id outside PRODUCT_RE as null,
 * the path and the firmware as `_odooText` gives them.
 */
function _wireDeck(d) {
    const product = _text(d?.usb_product_id)?.toLowerCase() ?? null;
    return {
        serial: _serial(d?.serial),
        usb_product_id: product !== null && PRODUCT_RE.test(product)
            ? product : null,
        usb_path: _odooText(d?.usb_path),
        firmware: _odooText(d?.firmware),
    };
}

/**
 * Whether Odoo can name the deck `w` (a `_wireDeck`): by its serial, or
 * else by its USB path. Odoo answers 400 to a deck with neither, so such
 * a deck is in neither the state nor the events.
 */
function _named(w) {
    return w.serial !== null || w.usb_path !== null;
}

/**
 * The ids of `plugins` that Odoo accepts as `deck_plugins`: those of
 * PLUGIN_ID_RE, once each, sorted, the first DECK_PLUGINS_MAX of them;
 * `[]` when `plugins` is not a list.
 */
function _deckPlugins(plugins) {
    if (!Array.isArray(plugins)) return [];
    const ids = plugins.filter(p => typeof p === 'string' &&
        PLUGIN_ID_RE.test(p));
    return [...new Set(ids)].sort().slice(0, DECK_PLUGINS_MAX);
}

/**
 * The wire `state` of a report, from what the service collected. Every
 * text is as `_odooText` gives it, and `decks` holds only the decks Odoo
 * can name (`_named`); `deck_plugins` is as `_deckPlugins` gives it.
 * `erplibre` is null when there is no checkout (or neither branch nor
 * commit is known); with only one of them known, the other is null.
 * Throws a RangeError when `serviceState` is not one of the contract's
 * four values: the caller maps its own states first.
 */
export function buildState({hostname, os, gnomeShell, extensionVersion,
    contractVersion, erplibre, deckProgram, serviceState, decks,
    deckPlugins} = {}) {
    if (!SERVICE_STATES.includes(serviceState))
        throw new RangeError(`service state ${serviceState} not in contract`);
    const branch = _odooText(erplibre?.branch);
    const commit = _odooText(erplibre?.commit);
    return {
        hostname: _odooText(hostname),
        os: {name: _odooText(os?.name), version: _odooText(os?.version)},
        gnome_shell: _odooText(gnomeShell),
        extension_version: _odooText(extensionVersion),
        contract_version: _odooText(contractVersion),
        erplibre: branch === null && commit === null ? null : {branch, commit},
        deck_program: _odooText(deckProgram),
        service_state: serviceState,
        decks: Array.isArray(decks) ? decks.map(_wireDeck).filter(_named) : [],
        deck_plugins: _deckPlugins(deckPlugins),
    };
}

// ---------------------------------------------------------------------
// Events

/**
 * The local identity of a deck: its serial, or for a deck without one
 * `nosn::<product>:<path>`. Odoo builds its own key for the latter by
 * adding the workstation id; this one only compares two scans of the
 * same workstation.
 */
export function deckKey(deck) {
    const d = _wireDeck(deck);
    return d.serial ?? `nosn::${d.usb_product_id}:${d.usb_path}`;
}

function _event(kind, at, uuid, deck, serviceState) {
    const d = deck ? _wireDeck(deck) : {};
    return {uuid, kind, at, serial: d.serial ?? null,
        usb_product_id: d.usb_product_id ?? null,
        usb_path: d.usb_path ?? null, service_state: serviceState ?? null};
}

/**
 * The events between two scans: `unplugged` for each deck key of
 * `prevDecks` missing from `nextDecks` (in `prevDecks` order), then
 * `plugged` for each new key (in `nextDecks` order), all dated `nowIso`
 * with a uuid from `newUuid()`. A deck with a serial that changes port
 * is the same deck; one without a serial that changes port is a new one.
 * A deck Odoo cannot name (`_named`) gives no event.
 */
export function diffDecks(prevDecks, nextDecks, nowIso, newUuid) {
    const index = list => new Map((Array.isArray(list) ? list : [])
        .filter(d => _named(_wireDeck(d))).map(d => [deckKey(d), d]));
    const prev = index(prevDecks);
    const next = index(nextDecks);
    const events = [];
    for (const [k, d] of prev) {
        if (!next.has(k))
            events.push(_event('unplugged', nowIso, newUuid(), d));
    }
    for (const [k, d] of next) {
        if (!prev.has(k))
            events.push(_event('plugged', nowIso, newUuid(), d));
    }
    return events;
}

/**
 * One `service_changed` event when the deck service went from `prev` to
 * a different `next`, none otherwise. A null or undefined `prev` is the
 * first observation since start: the state goes out in the report's
 * `state`, not as an event.
 */
export function serviceChanged(prev, next, nowIso, newUuid) {
    if (prev === null || prev === undefined || prev === next) return [];
    return [_event('service_changed', nowIso, newUuid(), null, next)];
}

/**
 * Whether `e` is an event Odoo can take: a uuid, a kind, a date, and for
 * a plugged or unplugged deck its serial or its USB path.
 */
function _validEvent(e) {
    if (e === null || typeof e !== 'object' || typeof e.uuid !== 'string' ||
        e.uuid === '' || !EVENT_KINDS.includes(e.kind) ||
        typeof e.at !== 'string')
        return false;
    if (e.kind === 'service_changed') return true;
    return _text(e.serial) !== null || _text(e.usb_path) !== null;
}

// ---------------------------------------------------------------------
// Offline queue

/**
 * The events of one destination that Odoo has not acknowledged yet,
 * oldest first, with the count of events dropped unsent (`lost`).
 *
 * Invariants: at most `max` events, the oldest dropping first; no event
 * older than `maxAgeDays` once `prune` ran; one event per uuid. Each
 * drop adds one to `lost`, the running total since the queue was
 * created: it never decreases, the state file keeps it, and every
 * report carries it whole as `lost_events`. Odoo keeps the largest
 * total it received, so a report sent again after a lost reply, or
 * arriving after a newer one, changes nothing there.
 */
export class EventQueue {
    constructor({max = QUEUE_MAX, maxAgeDays = QUEUE_MAX_AGE_DAYS} = {}) {
        this._max = max;
        this._maxAgeDays = maxAgeDays;
        this._events = [];
        this._lost = 0;
    }

    get lost() {
        return this._lost;
    }

    /** Queues a copy of `event`; false when invalid or already queued. */
    push(event) {
        if (!_validEvent(event)) return false;
        if (this._events.some(e => e.uuid === event.uuid)) return false;
        this._events.push({...event});
        while (this._events.length > this._max) {
            this._events.shift();
            this._lost++;
        }
        return true;
    }

    /**
     * Removes the events whose uuid is in `uuids` (Odoo's `accepted`);
     * `lost` is left as is. Returns the number of events removed.
     */
    acknowledge(uuids) {
        const done = new Set(Array.isArray(uuids) ? uuids : []);
        const before = this._events.length;
        this._events = this._events.filter(e => !done.has(e.uuid));
        return before - this._events.length;
    }

    /** Copies of the queued events, oldest first. */
    pending() {
        return this._events.map(e => ({...e}));
    }

    /**
     * Drops, as lost, the events dated more than `maxAgeDays` before
     * `nowIso` and those whose date does not parse. A `nowIso` that does
     * not parse drops nothing. Returns the number dropped.
     */
    prune(nowIso) {
        const now = Date.parse(nowIso);
        if (Number.isNaN(now)) return 0;
        const cutoff = now - this._maxAgeDays * DAY_MS;
        const before = this._events.length;
        this._events = this._events.filter(e => {
            const at = Date.parse(e.at);
            return !Number.isNaN(at) && at >= cutoff;
        });
        const dropped = before - this._events.length;
        this._lost += dropped;
        return dropped;
    }

    /** What the state file keeps: the events and the lost count. */
    toJSON() {
        return {events: this.pending(), lost: this._lost};
    }

    /**
     * A queue from what `toJSON` wrote. Never throws: a corrupt or
     * foreign object gives an empty queue, invalid or duplicate events
     * are skipped, and the bound of `options` applies to what is left.
     */
    static fromJSON(obj, options = {}) {
        const q = new EventQueue(options);
        if (obj === null || typeof obj !== 'object' || Array.isArray(obj))
            return q;
        if (Number.isInteger(obj.lost) && obj.lost > 0) q._lost = obj.lost;
        if (Array.isArray(obj.events))
            for (const e of obj.events) q.push(e);
        return q;
    }
}

// ---------------------------------------------------------------------
// Report

/**
 * `result` as the body carries it, or null when it is not one:
 * `{revision, status, reason, at}`, `reason` null for `applied` and cut
 * to REASON_MAX code points for `refused`.
 */
function _configResult(result) {
    const r = _object(result);
    if (!r || !Number.isSafeInteger(r.revision) || r.revision < 0 ||
        !['applied', 'refused'].includes(r.status) ||
        typeof r.at !== 'string' || r.at === '')
        return null;
    const reason = r.status === 'refused' && typeof r.reason === 'string'
        ? Array.from(r.reason).slice(0, REASON_MAX).join('') : null;
    return {revision: r.revision, status: r.status, reason, at: r.at};
}

/**
 * The `config` of a report body. `{pilot: false}` and nothing else unless
 * `pilot` is true; for the pilot, `revision_applied` (null when not a
 * non-negative integer), `current` with every key of CONFIG_KEYS (a value
 * outside the schema as null, Odoo answering 400 to it), `result` as
 * `_configResult` gives it and `choice` (one of CHOICES, else null).
 */
export function configBody({pilot, revisionApplied, current, result,
    choice} = {}) {
    if (pilot !== true) return {pilot: false};
    const values = {};
    for (const [key, def] of Object.entries(CONFIG_KEYS))
        values[key] = def.valid(current?.[key]) ?? null;
    return {
        pilot: true,
        revision_applied: Number.isSafeInteger(revisionApplied) &&
            revisionApplied >= 0 ? revisionApplied : null,
        current: values,
        result: _configResult(result),
        choice: CHOICES.includes(choice) ? choice : null,
    };
}

/**
 * What remains to send of `pending` (`{result, choice}`) once Odoo
 * answered 200 to a report whose body `config` was `sent`: a result or a
 * choice equal to the one sent is cleared, one set since stays for the
 * next report. A body without a pilot `config` settles nothing.
 */
export function settleConfig(pending, sent) {
    const p = pending ?? {};
    if (sent?.pilot !== true) return {result: p.result ?? null,
        choice: p.choice ?? null};
    const r = _configResult(p.result);
    const s = sent.result;
    const resultSent = r !== null && s !== null && s !== undefined &&
        r.revision === s.revision && r.status === s.status && r.at === s.at;
    return {
        result: resultSent ? null : p.result ?? null,
        choice: p.choice === sent.choice ? null : p.choice ?? null,
    };
}

/**
 * The body of `POST /streamdeck/v1/report`: the state, every queued
 * event, the running total of lost events and `config` (as `configBody`
 * builds it; `{pilot: false}` when not given). After a 200, the caller
 * passes the reply's `accepted` to `queue.acknowledge`; a retry sends
 * the same body again.
 */
export function reportBody(state, queue, config = {pilot: false}) {
    return {protocol: INVENTORY_PROTOCOL, state, events: queue.pending(),
        lost_events: queue.lost, config};
}

/**
 * `{ok, accepted, heartbeatS, error, config}` from the HTTP status and
 * the parsed JSON body (null when absent or not JSON) of a report.
 *
 * Only a 200 with an `accepted` list of strings is ok; `heartbeatS` is
 * the reply's `heartbeat_s` rounded to whole seconds and bounded to
 * [60, 86400], else HEARTBEAT_S. A 4xx carrying one of the contract's
 * codes in `error` gives that code.
 * No answer (status 0 or missing) or a 5xx gives `network`: retry
 * later, as when offline. Anything else gives `bad_reply`.
 * `config` is null unless an ok reply carries one; then it is what
 * `validateConfig` gives, a refusal included: a bad configuration
 * refuses its revision, or is ignored when of another shape (`reason`
 * and `revision` null), never the report and its events.
 */
export function parseReply(status, json) {
    const fail = error => ({ok: false, accepted: [], heartbeatS: HEARTBEAT_S,
        error, config: null});
    const body = json !== null && typeof json === 'object' &&
        !Array.isArray(json) ? json : null;
    if (typeof status !== 'number' || status === 0 || status >= 500)
        return fail('network');
    if (status === 200) {
        const accepted = body?.accepted;
        if (!Array.isArray(accepted) ||
            !accepted.every(u => typeof u === 'string'))
            return fail('bad_reply');
        let heartbeatS = HEARTBEAT_S;
        if (Number.isFinite(body.heartbeat_s)) {
            heartbeatS = Math.min(HEARTBEAT_MAX_S,
                Math.max(HEARTBEAT_MIN_S, Math.round(body.heartbeat_s)));
        }
        const config = body.config === undefined || body.config === null
            ? null : validateConfig(body.config);
        return {ok: true, accepted: [...accepted], heartbeatS, error: null,
            config};
    }
    if (status >= 400 && status < 500 && ERROR_CODES.includes(body?.error))
        return fail(body.error);
    return fail('bad_reply');
}

// ---------------------------------------------------------------------
// Destinations (GSettings key `inventory-destinations`, a JSON array)

const DEST_KEYS = ['id', 'label', 'url', 'db', 'source', 'instanceId'];

/**
 * The user part of `url` with its `@` (everything up to the last `@`
 * of the authority), or null when there is none. Any scheme and any
 * authority are read, valid or not, so that a URL that `urlAllowed`
 * refuses for another reason still loses its password.
 */
function _userPart(url) {
    const m = url.match(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*@)/);
    return m ? m[1] : null;
}

/**
 * A destination with exactly the keys of DEST_KEYS, or null when `id`,
 * `url` or `db` is missing. `source` is `local` only with an
 * `instanceId` (the id of an entry of the `instances` key); otherwise
 * `remote` with a null `instanceId`. `label` defaults to the URL.
 *
 * The user part `user:pw@` is removed from the URL and from the label:
 * GSettings is readable by every process of the session, so a password
 * typed into the URL never reaches it. The URL is otherwise not checked
 * against `urlAllowed` here: the preferences show a refused one, the
 * service does not send to it.
 */
function _destination(d) {
    if (d === null || typeof d !== 'object') return null;
    const id = _text(d.id);
    let url = _text(d.url);
    const db = _text(d.db);
    if (typeof id !== 'string' || typeof url !== 'string' ||
        typeof db !== 'string')
        return null;
    let label = typeof d.label === 'string' && d.label !== '' ? d.label : url;
    const userPart = _userPart(url);
    if (userPart !== null) {
        url = url.replace(userPart, '');
        label = label.split(userPart).join('');
    }
    const instanceId = typeof d.instanceId === 'string' && d.instanceId !== ''
        ? d.instanceId : null;
    const local = d.source === 'local' && instanceId !== null;
    return {id, label: label === '' ? url : label, url, db,
        source: local ? 'local' : 'remote',
        instanceId: local ? instanceId : null};
}

/**
 * The destinations stored in `str`; garbage gives `[]`, invalid entries
 * are skipped, and of two entries with the same id the first stays.
 */
export function parseDestinations(str) {
    let list;
    try {
        list = JSON.parse(str);
    } catch (_e) {
        return [];
    }
    if (!Array.isArray(list)) return [];
    const out = [];
    const seen = new Set();
    for (const raw of list) {
        const d = _destination(raw);
        if (!d || seen.has(d.id)) continue;
        seen.add(d.id);
        out.push(d);
    }
    return out;
}

/**
 * The JSON text for GSettings. Only DEST_KEYS are written, so a token,
 * key or password set on a destination object by mistake never reaches
 * GSettings, and `_destination` removes the user part of the URL.
 */
export function serializeDestinations(dests) {
    const out = [];
    for (const raw of Array.isArray(dests) ? dests : []) {
        const d = _destination(raw);
        if (d) out.push(Object.fromEntries(DEST_KEYS.map(k => [k, d[k]])));
    }
    return JSON.stringify(out);
}

// ---------------------------------------------------------------------
// Preferences: adding and enrolling a destination

/**
 * `url` as a destination keeps it: white space around it and trailing
 * slashes removed, scheme and authority in lowercase (they are not case
 * sensitive; the path is). The fingerprint key and the keyring binding
 * use this form, so the same Odoo typed twice gives the same workstation.
 * A value that is not a URL is only trimmed; a non-string gives ''.
 */
export function normalizeUrl(url) {
    if (typeof url !== 'string') return '';
    let u = url.trim();
    const m = u.match(/^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([\s\S]*)$/);
    if (m) u = `${m[1].toLowerCase()}://${m[2].toLowerCase()}${m[3]}`;
    return u.replace(/\/+$/, '');
}

/** One line of at most `max` characters: control characters become spaces. */
function _oneLine(text, max) {
    return String(text ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim()
        .slice(0, max);
}

/**
 * Whether the preferences may store the destination of a form
 * `{url, db, label}` next to the `existing` ones. Returns `{ok, reason,
 * url, db, label}`: on success the normalised URL, the database and the
 * label to store (the URL's authority when none is given); otherwise the
 * fields are null and `reason` is a code of `urlAllowed`, `db` (not a
 * name Odoo accepts) or `duplicate` (that Odoo and database already are
 * a destination: both would share one fingerprint, and each enrollment
 * would revoke the other's token).
 */
export function checkDestination({url, db, label} = {}, existing = []) {
    const fail = reason => ({ok: false, reason, url: null, db: null,
        label: null});
    const u = normalizeUrl(url);
    const allowed = urlAllowed(u);
    if (!allowed.ok) return fail(allowed.reason);
    const name = typeof db === 'string' ? db.trim() : '';
    if (!DB_RE.test(name) || name.length > DB_MAX) return fail('db');
    if ((Array.isArray(existing) ? existing : []).some(d =>
        normalizeUrl(d?.url) === u && d?.db === name))
        return fail('duplicate');
    const authority = u.match(/^[a-z]+:\/\/([^/]*)/)[1];
    return {ok: true, reason: null, url: u, db: name,
        label: _oneLine(label, LABEL_MAX) || authority};
}

/**
 * The body of `POST /streamdeck/v1/enroll` for `credentials` (`{method,
 * code, key, login, password}`), `fingerprint` and `hostname`. Only the
 * secret of `method` goes in it. Returns `{ok, body, error}`; `error` is
 * `missing` (unknown method, or an empty field of the method),
 * `code_format` (a pairing code that is not 8 characters of Odoo's
 * alphabet once spaces and hyphens are removed) or `too_long` (a value
 * past Odoo's bounds), and `body` is null then.
 *
 * The code is sent in uppercase without spaces nor hyphens, the key and
 * the login trimmed, the password as typed. An empty host name becomes
 * `workstation`, a long one is cut to what Odoo accepts.
 */
export function enrollBody(credentials, {fingerprint, hostname} = {}) {
    const c = credentials ?? {};
    const fail = error => ({ok: false, body: null, error});
    const body = {protocol: INVENTORY_PROTOCOL, method: c.method,
        fingerprint, hostname: _odooText(hostname) ?? 'workstation'};
    if (c.method === 'pairing_code') {
        const code = String(c.code ?? '').replace(/[\s-]/g, '').toUpperCase();
        if (code === '') return fail('missing');
        if (!PAIRING_RE.test(code)) return fail('code_format');
        body.code = code;
    } else if (c.method === 'api_key') {
        const key = String(c.key ?? '').trim();
        if (key === '') return fail('missing');
        if (key.length > MAX_SECRET) return fail('too_long');
        body.key = key;
    } else if (c.method === 'password') {
        const login = String(c.login ?? '').trim();
        const password = typeof c.password === 'string' ? c.password : '';
        if (login === '' || password === '') return fail('missing');
        if (login.length > MAX_TEXT || password.length > MAX_SECRET)
            return fail('too_long');
        body.login = login;
        body.password = password;
    } else {
        return fail('missing');
    }
    return {ok: true, body, error: null};
}

/**
 * The error of a reply that is not a success: `network` without an
 * answer or on a 5xx (Odoo down, or a proxy in front of it), `not_found`
 * on a 404 (no such route: the module is missing, or the database does
 * not exist), the contract's code of a 4xx, `bad_reply` otherwise.
 */
function _replyError(status, body) {
    if (typeof status !== 'number' || status === 0 || status >= 500)
        return 'network';
    if (status === 404) return 'not_found';
    if (status >= 400 && status < 500 && ERROR_CODES.includes(body?.error))
        return body.error;
    return 'bad_reply';
}

function _object(json) {
    return json !== null && typeof json === 'object' && !Array.isArray(json)
        ? json : null;
}

/**
 * `{ok, token, workstationId, error}` from the status and the parsed body
 * of an enrollment. Only a 200 carrying a base64url `token` of 43 to 512
 * characters and a positive integer `workstation_id` is ok.
 */
export function parseEnrollReply(status, json) {
    const body = _object(json);
    if (status === 200 && typeof body?.token === 'string' &&
        TOKEN_RE.test(body.token) && Number.isInteger(body.workstation_id) &&
        body.workstation_id > 0)
        return {ok: true, token: body.token,
            workstationId: body.workstation_id, error: null};
    return {ok: false, token: null, workstationId: null,
        error: status === 200 ? 'bad_reply' : _replyError(status, body)};
}

/**
 * `{ok, revoked, error}` from the status and the parsed body of an
 * unenrollment. `revoked` says that Odoo no longer accepts the token:
 * on a 200, and on the 401 `token_invalid` or 403 `user_inactive` of a
 * token already revoked or of an archived employee.
 */
export function parseUnenrollReply(status, json) {
    const body = _object(json);
    if (status === 200 && body) return {ok: true, revoked: true, error: null};
    const error = status === 200 ? 'bad_reply' : _replyError(status, body);
    return {ok: false,
        revoked: error === 'token_invalid' || error === 'user_inactive',
        error};
}

/**
 * `{state, pending, lastReport, error}` from the text of the state file
 * the service keeps for `dest`, or null when the text is not such a file
 * or names another URL or database (the file of a destination edited
 * since). A field of another type reads as 0 or null.
 */
export function statusFromStateFile(text, dest) {
    let saved;
    try {
        saved = _object(JSON.parse(text));
    } catch (_e) {
        return null;
    }
    const url = String(dest?.url ?? '').replace(/\/+$/, '');
    if (!saved || saved.destination?.url !== url ||
        saved.destination?.db !== dest?.db)
        return null;
    const st = _object(saved.status);
    if (!st || !STATUS_STATES.includes(st.state)) return null;
    return {state: st.state,
        pending: Number.isInteger(st.pending) && st.pending > 0
            ? st.pending : 0,
        lastReport: typeof st.lastReport === 'string' ? st.lastReport : null,
        error: typeof st.error === 'string' ? st.error : null};
}
