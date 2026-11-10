/**
 * Stream Deck inventory for Odoo: the pure half of what the extension
 * pushes to each enrolled Odoo instance — URL policy, workstation
 * fingerprint, wire `state`, deck events, the bounded offline queue,
 * the report body and its reply, the destinations stored in GSettings.
 *
 * No import at all: the module runs under GJS in GNOME Shell and under
 * node in the tests. GJS has neither the WHATWG `URL` nor `crypto`, so
 * URLs are parsed here, the HMAC is a function the caller passes, and
 * so is the uuid generator. The wire format is described in
 * CONTRACT.md; the field names below are the wire's own.
 */

// Version of the report protocol, separate from the extension contract.
// Odoo refuses an unknown MAJOR and accepts a newer MINOR.
export const INVENTORY_PROTOCOL = '1.0';
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
const ERROR_CODES = ['bad_request', 'protocol_unsupported',
    'credentials_refused', 'user_inactive', 'token_invalid'];

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
 * A deck as the wire carries it: `{serial, usb_product_id, usb_path,
 * firmware}`, empty strings as null, the product id in lowercase hex.
 */
function _wireDeck(d) {
    const product = _text(d?.usb_product_id);
    return {
        serial: _text(d?.serial),
        usb_product_id: product === null ? null : product.toLowerCase(),
        usb_path: _text(d?.usb_path),
        firmware: _text(d?.firmware),
    };
}

/**
 * The wire `state` of a report, from what the service collected.
 * `erplibre` is null when there is no checkout (or neither branch nor
 * commit is known); with only one of them known, the other is null.
 * Throws a RangeError when `serviceState` is not one
 * of the contract's four values: the caller maps its own states first.
 */
export function buildState({hostname, os, gnomeShell, extensionVersion,
    contractVersion, erplibre, deckProgram, serviceState, decks} = {}) {
    if (!SERVICE_STATES.includes(serviceState))
        throw new RangeError(`service state ${serviceState} not in contract`);
    const branch = _text(erplibre?.branch);
    const commit = _text(erplibre?.commit);
    return {
        hostname: _text(hostname),
        os: {name: _text(os?.name), version: _text(os?.version)},
        gnome_shell: _text(gnomeShell),
        extension_version: _text(extensionVersion),
        contract_version: _text(contractVersion),
        erplibre: branch === null && commit === null ? null : {branch, commit},
        deck_program: _text(deckProgram),
        service_state: serviceState,
        decks: Array.isArray(decks) ? decks.map(_wireDeck) : [],
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
 */
export function diffDecks(prevDecks, nextDecks, nowIso, newUuid) {
    const index = list => new Map(
        (Array.isArray(list) ? list : []).map(d => [deckKey(d), d]));
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

function _validEvent(e) {
    return e !== null && typeof e === 'object' &&
        typeof e.uuid === 'string' && e.uuid !== '' &&
        EVENT_KINDS.includes(e.kind) && typeof e.at === 'string';
}

// ---------------------------------------------------------------------
// Offline queue

/**
 * The events of one destination that Odoo has not acknowledged yet,
 * oldest first, with the count of events dropped unsent (`lost`).
 *
 * Invariants: at most `max` events, the oldest dropping first; no event
 * older than `maxAgeDays` once `prune` ran; one event per uuid. Each
 * drop adds one to `lost`, which goes out with the next report and is
 * subtracted once Odoo acknowledged that report.
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
     * Removes the events whose uuid is in `uuids` (Odoo's `accepted`) and
     * subtracts `lostReported`, the `lost_events` of the body Odoo
     * acknowledged, from `lost`. Drops made while that report was in
     * flight stay counted. Returns the number of events removed.
     */
    acknowledge(uuids, lostReported = 0) {
        const done = new Set(Array.isArray(uuids) ? uuids : []);
        const before = this._events.length;
        this._events = this._events.filter(e => !done.has(e.uuid));
        const n = Number.isInteger(lostReported) && lostReported > 0
            ? lostReported : 0;
        this._lost = Math.max(0, this._lost - n);
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
 * The body of `POST /streamdeck/v1/report`: the state, every queued
 * event and the lost count. After a 200, the caller passes the reply's
 * `accepted` and this body's `lost_events` to `queue.acknowledge`.
 */
export function reportBody(state, queue) {
    return {protocol: INVENTORY_PROTOCOL, state, events: queue.pending(),
        lost_events: queue.lost};
}

/**
 * `{ok, accepted, heartbeatS, error}` from the HTTP status and the
 * parsed JSON body (null when absent or not JSON) of a report.
 *
 * Only a 200 with an `accepted` list of strings is ok; `heartbeatS` is
 * the reply's `heartbeat_s` rounded to whole seconds and bounded to
 * [60, 86400], else HEARTBEAT_S. A
 * 4xx carrying one of the contract's codes in `error` gives that code.
 * No answer (status 0 or missing) or a 5xx gives `network`: retry
 * later, as when offline. Anything else gives `bad_reply`.
 */
export function parseReply(status, json) {
    const fail = error => ({ok: false, accepted: [], heartbeatS: HEARTBEAT_S,
        error});
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
        return {ok: true, accepted: [...accepted], heartbeatS, error: null};
    }
    if (status >= 400 && status < 500 && ERROR_CODES.includes(body?.error))
        return fail(body.error);
    return fail('bad_reply');
}

// ---------------------------------------------------------------------
// Destinations (GSettings key `inventory-destinations`, a JSON array)

const DEST_KEYS = ['id', 'label', 'url', 'db', 'source', 'instanceId'];

/**
 * A destination with exactly the keys of DEST_KEYS, or null when `id`,
 * `url` or `db` is missing. `source` is `local` only with an
 * `instanceId` (the id of an entry of the `instances` key); otherwise
 * `remote` with a null `instanceId`. `label` defaults to the URL. The
 * URL is not checked against `urlAllowed` here: the preferences show a
 * refused one, the service does not send to it.
 */
function _destination(d) {
    if (d === null || typeof d !== 'object') return null;
    const id = _text(d.id);
    const url = _text(d.url);
    const db = _text(d.db);
    if (typeof id !== 'string' || typeof url !== 'string' ||
        typeof db !== 'string')
        return null;
    const instanceId = typeof d.instanceId === 'string' && d.instanceId !== ''
        ? d.instanceId : null;
    const local = d.source === 'local' && instanceId !== null;
    return {id, label: typeof d.label === 'string' && d.label !== ''
        ? d.label : url, url, db, source: local ? 'local' : 'remote',
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
 * GSettings.
 */
export function serializeDestinations(dests) {
    const out = [];
    for (const raw of Array.isArray(dests) ? dests : []) {
        const d = _destination(raw);
        if (d) out.push(Object.fromEntries(DEST_KEYS.map(k => [k, d[k]])));
    }
    return JSON.stringify(out);
}
