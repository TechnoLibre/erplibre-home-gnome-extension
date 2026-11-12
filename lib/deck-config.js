/**
 * The Stream Deck configuration an Odoo pilots: the closed list of
 * settings it may set (CONTRACT.md, « Odoo configuration »), the
 * validation of the `config` of a reply, the reading of the local values
 * in streamdeck.conf and the rewrite of that file; then the key layouts
 * of keymap.json (« Key layouts »): their format, the catalog of the deck
 * program they are checked against, the text written and the hash of
 * each layout the report carries.
 *
 * Pure and without any import, like inventory.js: it runs under GJS in
 * GNOME Shell and under node in the tests.
 *
 * The file is handled as bytes. A Uint8Array is read one byte per
 * character (Latin-1), so that bytes outside UTF-8 compare and come back
 * unchanged, as `script/install/erplibre_home_settings.sh` reads them
 * under LC_ALL=C and as ERPLibre's `write_settings` keeps them. A string
 * is read as it is. Lines split on `\n` only: a `\r` stays in its line.
 */

export const DECK_PROGRAMS = ['tiler', 'controller', 'none'];
export const GAMES_VALUES = ['on', 'off'];
// Inclusive bounds of DECK_SESSION_REFRESH_SEC, in seconds.
export const SESSION_REFRESH_RANGE = [0.5, 60];
// A deck plugin id, as the deck program names its plugin files.
export const PLUGIN_ID_RE = /^[a-z][a-z0-9_]{0,63}$/;
export const PLUGINS_OFF_MAX = 64;
// Bound of `state.deck_plugins`.
export const DECK_PLUGINS_MAX = 128;
// The employee's answers to a first-pilot `ask`.
export const CHOICES = ['keep_local', 'take_odoo'];
// Refusal reasons of a result besides `invalid:<key>`.
export const REFUSAL_REASONS = ['write_failed', 'restart_failed',
    'unit_missing'];
export const REASON_MAX = 256;

const HASH_RE = /^[0-9a-f]{64}$/;
// White space as the shell's [[:space:]] reads it under LC_ALL=C: a
// non-breaking space or any other byte above 0x7f is not white space.
const SPACES_RE = /[ \t\n\v\f\r]/g;
const EDGE_SPACES_RE = /^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g;
const NUMBER_RE = /^([0-9]+\.?[0-9]*|\.[0-9]+)$/;

/** `v` once, in order, when it is a list of plugin ids; else undefined. */
function _pluginsOff(v) {
    if (!Array.isArray(v)) return undefined;
    if (!v.every(id => typeof id === 'string' && PLUGIN_ID_RE.test(id)))
        return undefined;
    const ids = [...new Set(v)];
    return ids.length <= PLUGINS_OFF_MAX ? ids : undefined;
}

function _sessionRefresh(v) {
    return typeof v === 'number' && v >= SESSION_REFRESH_RANGE[0] &&
        v <= SESSION_REFRESH_RANGE[1] ? v : undefined;
}

function _oneOf(values) {
    return v => (values.includes(v) ? v : undefined);
}

/**
 * The closed list of settings, in the order of the contract's table.
 * Per wire key: `line`, its key in streamdeck.conf; `restart`, whether a
 * change restarts the deck unit; `valid(v)`, the normalised wire value
 * (a list of plugins without its repeats) or undefined outside the
 * schema; `text(v)`, the text of its line; `parse(text)`, the value a
 * line's text gives, null outside the schema.
 */
export const CONFIG_KEYS = Object.freeze({
    deck_program: Object.freeze({
        line: 'DECK_PROGRAM', restart: true,
        valid: _oneOf(DECK_PROGRAMS), text: v => v,
        parse: t => (DECK_PROGRAMS.includes(t) ? t : null),
    }),
    plugins_off: Object.freeze({
        line: 'DECK_PLUGINS_OFF', restart: true,
        valid: _pluginsOff, text: v => v.join(','),
        // As deck_plugins_off of the shell: cut at commas, every white
        // space removed, empty parts skipped.
        parse: t => _pluginsOff(t.split(',').map(p => p.replace(SPACES_RE, ''))
            .filter(p => p !== '')) ?? null,
    }),
    session_refresh_sec: Object.freeze({
        line: 'DECK_SESSION_REFRESH_SEC', restart: true,
        valid: _sessionRefresh, text: v => String(v),
        parse: t => {
            const s = t.replace(EDGE_SPACES_RE, '');
            return NUMBER_RE.test(s) ? _sessionRefresh(Number(s)) ?? null
                : null;
        },
    }),
    games: Object.freeze({
        line: 'GAMES', restart: false,
        valid: _oneOf(GAMES_VALUES), text: v => v,
        parse: t => (GAMES_VALUES.includes(t) ? t : null),
    }),
});

const KEYS = Object.keys(CONFIG_KEYS);

// The wire key that sets keymap.json rather than a line of the conf.
export const KEYMAP_KEY = 'key_layouts';
// Every key Odoo may set, in the contract's order: the lines of the conf,
// then the key layouts.
export const WIRE_KEYS = Object.freeze([...KEYS, KEYMAP_KEY]);

// keymap.json and the catalog of `--catalog` share this format.
export const KEYMAP_FORMAT = 1;
export const KEYMAP_MODELS_MAX = 16;
// A label's bound, in code points.
export const LABEL_MAX = 16;
// Bound of `state.deck_catalog`, as JSON text: every character of a
// catalog `catalogFrom` keeps is ASCII, so it counts bytes.
export const CATALOG_MAX = 32 * 1024;
export const PRODUCT_ID_RE = /^[0-9a-f]{4}$/;
export const ACTION_RE = /^(plugin:[a-z][a-z0-9_]{0,63}|tiles|empty)$/;
export const ICON_RE = /^[a-z][a-z0-9_]{0,63}$/;
// Entries of a layout before the catalog bounds them by the model's key
// count, far above any deck's; and the bounds of a model's geometry.
const LAYOUT_ENTRIES_MAX = 256;
const GEOMETRY_MAX = 256;
// Texts longer than this are not parsed: keymap.json, `--catalog`.
const KEYMAP_TEXT_MAX = 256 * 1024;
// Levels of lists and objects a layout of keymap.json may nest and still
// hash: the format nests 3. Past it the layout hashes as null, since
// hashing walks it by recursion and 256 KiB nest deeper than a stack.
export const LAYOUT_DEPTH_MAX = 8;
const ENTRY_KEYS = ['key', 'action', 'icon', 'label'];
// A label holds no control character (C0, DEL, C1) and no lone
// surrogate, which UTF-8 cannot write back as Odoo sent it.
const LABEL_FORBIDDEN_RE = /[\p{Cc}\p{Cs}]/u;

/**
 * The known strings of `list` once each, in order; `[]` for undefined
 * and, when `nullable`, for null; undefined when it is not a list of
 * strings.
 */
function _keyList(list, nullable) {
    if (list === undefined || (nullable && list === null)) return [];
    if (!Array.isArray(list) || !list.every(k => typeof k === 'string'))
        return undefined;
    return [...new Set(list)].filter(k => WIRE_KEYS.includes(k));
}

function _plain(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Whether `e` is an entry of a layout, by the format alone. */
function _entry(e) {
    if (!_plain(e) || !Object.keys(e).every(k => ENTRY_KEYS.includes(k)))
        return false;
    if (!Number.isSafeInteger(e.key) || e.key < 0) return false;
    if (typeof e.action !== 'string' || !ACTION_RE.test(e.action))
        return false;
    if (Object.hasOwn(e, 'icon') &&
        (typeof e.icon !== 'string' || !ICON_RE.test(e.icon)))
        return false;
    return !Object.hasOwn(e, 'label') || (typeof e.label === 'string' &&
        Array.from(e.label).length <= LABEL_MAX &&
        !LABEL_FORBIDDEN_RE.test(e.label));
}

/**
 * Whether `layouts` (a reply's `settings.key_layouts`) follows the format
 * of keymap.json, before any catalog: at most KEYMAP_MODELS_MAX models of
 * PRODUCT_ID_RE, each `{keys: [entry]}` and nothing else, every `key`
 * once.
 */
function _layoutsShape(layouts) {
    if (!_plain(layouts)) return false;
    const models = Object.keys(layouts);
    if (models.length > KEYMAP_MODELS_MAX) return false;
    return models.every(model => {
        const layout = layouts[model];
        if (!PRODUCT_ID_RE.test(model) || !_plain(layout) ||
            Object.keys(layout).join() !== 'keys' ||
            !Array.isArray(layout.keys) ||
            layout.keys.length > LAYOUT_ENTRIES_MAX ||
            !layout.keys.every(_entry))
            return false;
        return new Set(layout.keys.map(e => e.key)).size ===
            layout.keys.length;
    });
}

/**
 * The `config` of a reply, checked against the contract before anything
 * of it is announced or written.
 *
 * Returns `{ok: true, revision, hash, settings, locked, ask}`: `settings`
 * holds the known keys in the order of WIRE_KEYS, each normalised by its
 * `valid`, and `key_layouts` as sent once it follows the format of
 * keymap.json (the catalog is checked by `validateKeyLayouts`, where the
 * service holds one); `locked` and `ask` the known keys once each, `ask`
 * `[]` when absent, `locked` `[]` when absent or null. A key unknown to
 * the table is ignored wherever it appears.
 *
 * A revision Odoo cannot have meant gives `{ok: false, reason:
 * "invalid:<key>", revision}`, `<key>` the first of the table at fault:
 * its value is outside the schema, or it is locked without a value, or
 * asked without a value or while locked. It is the only refusal reason
 * of a revision, the one the contract lets Odoo receive.
 *
 * A `config` of another shape (not an object, `revision` not a
 * non-negative integer, `hash` not 64 lowercase hex digits, `settings`
 * not an object, `locked` or `ask` not a list of strings) names no key:
 * it gives `{ok: false, reason: null, revision: null}`, to be ignored as
 * if the reply carried none. Nothing is then announced, written or
 * reported.
 */
export function validateConfig(config) {
    const ignored = {ok: false, reason: null, revision: null};
    if (config === null || typeof config !== 'object' || Array.isArray(config))
        return ignored;
    const {revision, hash, settings: raw} = config;
    const locked = _keyList(config.locked, true);
    const ask = _keyList(config.ask, false);
    if (!Number.isSafeInteger(revision) || revision < 0 ||
        typeof hash !== 'string' || !HASH_RE.test(hash) ||
        raw === null || typeof raw !== 'object' || Array.isArray(raw) ||
        locked === undefined || ask === undefined)
        return ignored;
    const settings = {};
    const refuse = key => ({ok: false, reason: `invalid:${key}`, revision});
    for (const key of KEYS) {
        if (!Object.hasOwn(raw, key)) continue;
        const value = CONFIG_KEYS[key].valid(raw[key]);
        if (value === undefined) return refuse(key);
        settings[key] = value;
    }
    if (Object.hasOwn(raw, KEYMAP_KEY)) {
        if (!_layoutsShape(raw[KEYMAP_KEY])) return refuse(KEYMAP_KEY);
        settings[KEYMAP_KEY] = raw[KEYMAP_KEY];
    }
    const astray = WIRE_KEYS.find(k => ask.includes(k)
        ? !(k in settings) || locked.includes(k)
        : locked.includes(k) && !(k in settings));
    if (astray !== undefined) return refuse(astray);
    return {ok: true, revision, hash, settings, locked, ask};
}

/**
 * The text of `input`, one character per byte for a Uint8Array, empty
 * for null (no file). Throws a TypeError on any other type: read as
 * empty, it would rewrite the file with the managed lines alone.
 */
function _chars(input) {
    if (input === null) return '';
    if (typeof input === 'string') return input;
    if (input instanceof Uint8Array) {
        let out = '';
        // Chunks keep the argument list of fromCharCode bounded.
        for (let i = 0; i < input.length; i += 0x8000)
            out += String.fromCharCode(...input.subarray(i, i + 0x8000));
        return out;
    }
    throw new TypeError('streamdeck.conf: a Uint8Array, a string or null');
}

/** The bytes of a text `_chars` gave, every character below 0x100. */
function _bytes(chars) {
    const out = new Uint8Array(chars.length);
    for (let i = 0; i < chars.length; i++) out[i] = chars.charCodeAt(i);
    return out;
}

/**
 * The local value of each key of the table, as the deck reads
 * streamdeck.conf (`confText`, bytes or text; null for no file): the
 * last line starting with `<LINE>=` gives the value. Null stands for no
 * local value: a file without such a line, where the deck runs the
 * settings library's default that nobody set, or a value outside the
 * schema, which Odoo refuses to receive. It is the `current` of a
 * report, whose nulls Odoo neither lists in `ask` nor adopts. Throws a
 * TypeError when `confText` is of another type.
 */
export function readCurrent(confText) {
    const last = {};
    for (const line of _chars(confText).split('\n')) {
        for (const key of KEYS) {
            const prefix = `${CONFIG_KEYS[key].line}=`;
            if (line.startsWith(prefix)) last[key] = line.slice(prefix.length);
        }
    }
    const current = {};
    for (const key of KEYS) {
        const def = CONFIG_KEYS[key];
        current[key] = key in last ? def.parse(last[key]) : null;
    }
    return current;
}

/**
 * The text of each `<LINE>=` line that `settings` (wire values) gives,
 * in the table's order. Keys unknown to the table are left out. Throws
 * a RangeError on a value outside the schema: nothing invalid is ever
 * written.
 */
export function confLines(settings) {
    const lines = {};
    for (const key of KEYS) {
        if (!settings || !Object.hasOwn(settings, key)) continue;
        const def = CONFIG_KEYS[key];
        const value = def.valid(settings[key]);
        if (value === undefined)
            throw new RangeError(`invalid:${key}`);
        lines[def.line] = def.text(value);
    }
    return lines;
}

/**
 * `confText` with the keys of `settings` written, by the rule of
 * ERPLibre's `settings_text`: every line whose part before its first
 * `=` is the key's line takes the new value (all of them, when the file
 * repeats a key), a key without a line is added at the end in the table's
 * order, every other line is kept byte for byte, and the result ends with
 * `\n`. A Uint8Array gives a Uint8Array, a text a text, null an empty
 * file. Throws as `confLines` does, before anything is built, and a
 * TypeError when `confText` is of another type (a GLib.Bytes gives its
 * Uint8Array by `get_data()`).
 */
export function rewriteConf(confText, settings) {
    const lines = confLines(settings);
    const chars = _chars(confText);
    const parts = chars.split('\n');
    if (parts[parts.length - 1] === '') parts.pop();
    const seen = new Set();
    const out = parts.map(line => {
        const eq = line.indexOf('=');
        const name = eq < 0 ? null : line.slice(0, eq);
        if (name === null || !Object.hasOwn(lines, name)) return line;
        seen.add(name);
        return `${name}=${lines[name]}`;
    });
    for (const [name, value] of Object.entries(lines))
        if (!seen.has(name)) out.push(`${name}=${value}`);
    const text = out.map(line => `${line}\n`).join('');
    return confText instanceof Uint8Array ? _bytes(text) : text;
}

function _same(a, b) {
    if (Array.isArray(a) || Array.isArray(b)) {
        return Array.isArray(a) && Array.isArray(b) &&
            a.length === b.length && a.every((v, i) => v === b[i]);
    }
    return a === b;
}

/** Whether the hashes `a` and `b` (as `layoutHashes` gives) are equal. */
function _sameHashes(a, b) {
    if (!_plain(a) || !_plain(b)) return a === b;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length &&
        keys.every(k => Object.hasOwn(b, k) && a[k] === b[k]);
}

/**
 * The keys of `settings` whose value `current` (from `readLocal`, or
 * `readCurrent` for the lines of the conf) does not hold, in the order of
 * WIRE_KEYS. Lists compare in their order: the file ends holding Odoo's
 * list exactly, so the next report shows no drift. The layouts compare
 * by their hashes: keymap.json holds them when it has the same models,
 * each of the same hash.
 */
export function changedKeys(current, settings) {
    return WIRE_KEYS.filter(k => settings && Object.hasOwn(settings, k) &&
        (k === KEYMAP_KEY
            ? !_sameHashes(current?.[k], _hashesOf(settings[k]))
            : !_same(current?.[k], settings[k])));
}

/**
 * Whether changing `keys` restarts the deck unit: a line whose table says
 * so, or the key layouts, which the deck program reads at its start.
 */
export function needsRestart(keys) {
    return (Array.isArray(keys) ? keys : [])
        .some(k => CONFIG_KEYS[k]?.restart === true || k === KEYMAP_KEY);
}

// ---------------------------------------------------------------------
// Key layouts: keymap.json and the catalog of the deck program

/**
 * `v` as Python's `json.dumps(v, sort_keys=True, separators=(",", ":"))`
 * writes it: keys sorted, no white space, every character outside
 * printable ASCII escaped as `\uXXXX` in lowercase hex (a code point past
 * U+FFFF as its two surrogates), `"` and `\` escaped, and the short forms
 * `\b \f \n \r \t`. An integer is its digits; another number, which no
 * layout holds, is JavaScript's own text.
 */
export function canonicalJson(v) {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'boolean' || typeof v === 'number')
        return Number.isFinite(v) || typeof v === 'boolean' ? String(v)
            : 'null';
    if (typeof v === 'string') {
        const short = {'"': '\\"', '\\': '\\\\', '\b': '\\b', '\f': '\\f',
            '\n': '\\n', '\r': '\\r', '\t': '\\t'};
        let out = '"';
        for (let i = 0; i < v.length; i++) {
            const c = v[i];
            const code = v.charCodeAt(i);
            if (Object.hasOwn(short, c)) out += short[c];
            else if (code < 0x20 || code > 0x7e)
                out += `\\u${code.toString(16).padStart(4, '0')}`;
            else out += c;
        }
        return `${out}"`;
    }
    if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
    // Python sorts by code point; every key a layout holds is ASCII.
    return `{${Object.keys(v).sort().map(k =>
        `${canonicalJson(k)}:${canonicalJson(v[k])}`).join(',')}}`;
}

// The 64 round constants of SHA-256.
const SHA256_K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);

/**
 * The SHA-256, in lowercase hex, of `text` read one byte per character
 * (every character below 0x100): the canonical JSON is ASCII, so these
 * are its UTF-8 bytes. Neither GJS nor this pure module has a digest of
 * its own.
 */
export function sha256Hex(text) {
    const n = text.length;
    const total = Math.ceil((n + 9) / 64) * 64;
    const bytes = new Uint8Array(total);
    for (let i = 0; i < n; i++) bytes[i] = text.charCodeAt(i) & 0xff;
    bytes[n] = 0x80;
    const bits = n * 8;
    const view = new DataView(bytes.buffer);
    view.setUint32(total - 8, Math.floor(bits / 0x100000000));
    view.setUint32(total - 4, bits >>> 0);
    const hv = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372,
        0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const w = new Uint32Array(64);
    const rotr = (x, r) => (x >>> r) | (x << (32 - r));
    for (let off = 0; off < total; off += 64) {
        for (let t = 0; t < 16; t++) w[t] = view.getUint32(off + t * 4);
        for (let t = 16; t < 64; t++) {
            const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^
                (w[t - 15] >>> 3);
            const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^
                (w[t - 2] >>> 10);
            w[t] = w[t - 16] + s0 + w[t - 7] + s1;
        }
        let [a, b, c, d, e, f, g, h] = hv;
        for (let t = 0; t < 64; t++) {
            const t1 = h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) +
                ((e & f) ^ (~e & g)) + SHA256_K[t] + w[t];
            const t2 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) +
                ((a & b) ^ (a & c) ^ (b & c));
            h = g;
            g = f;
            f = e;
            e = (d + t1) >>> 0;
            d = c;
            c = b;
            b = a;
            a = (t1 + t2) >>> 0;
        }
        hv[0] += a; hv[1] += b; hv[2] += c; hv[3] += d;
        hv[4] += e; hv[5] += f; hv[6] += g; hv[7] += h;
    }
    return [...hv].map(x => x.toString(16).padStart(8, '0')).join('');
}

/** The hash of one layout: the SHA-256 of its canonical JSON. */
export function layoutHash(layout) {
    return sha256Hex(canonicalJson(layout));
}

/** `{model: hash}` of the layouts Odoo sends, as `layoutHashes` reads. */
function _hashesOf(layouts) {
    return Object.fromEntries(Object.keys(layouts).sort()
        .map(m => [m, layoutHash(layouts[m])]));
}

/**
 * The text of `input` (bytes or text) when short enough to parse, else
 * null: bytes must be UTF-8.
 */
function _text(input) {
    let text = input;
    if (input instanceof Uint8Array) {
        if (input.length > KEYMAP_TEXT_MAX) return null;
        try {
            text = new TextDecoder('utf-8', {fatal: true}).decode(input);
        } catch (_e) {
            return null;
        }
    }
    return typeof text === 'string' && text.length <= KEYMAP_TEXT_MAX
        ? text : null;
}

function _json(input) {
    const text = _text(input);
    if (text === null) return undefined;
    try {
        return JSON.parse(text);
    } catch (_e) {
        return undefined;
    }
}

/**
 * Whether the object `value` nests at most `max` levels of lists and
 * objects, itself the first. Walks level by level, without recursion.
 */
function _nestedWithin(value, max) {
    let level = [value];
    for (let depth = 1; level.length; depth++) {
        if (depth > max) return false;
        const next = [];
        for (const v of level) {
            for (const c of Array.isArray(v) ? v : Object.values(v))
                if (c !== null && typeof c === 'object') next.push(c);
        }
        level = next;
    }
    return true;
}

/**
 * The hash of each layout keymap.json holds (`fileText`, its bytes or its
 * text): `{model: hash}` for the first KEYMAP_MODELS_MAX names of
 * PRODUCT_ID_RE in sorted order, a layout that is not an object, or
 * nests more than LAYOUT_DEPTH_MAX levels, as null.
 * Null without a file (null or undefined), past 256 KiB, outside UTF-8,
 * or without `format` 1 and an object of `layouts`. It is the
 * `current.key_layouts` of a report.
 */
export function layoutHashes(fileText) {
    const data = _json(fileText ?? null);
    if (!_plain(data) || data.format !== KEYMAP_FORMAT ||
        !_plain(data.layouts))
        return null;
    const hashes = {};
    for (const model of Object.keys(data.layouts)
        .filter(m => PRODUCT_ID_RE.test(m)).sort()
        .slice(0, KEYMAP_MODELS_MAX)) {
        const layout = data.layouts[model];
        hashes[model] = _plain(layout) &&
            _nestedWithin(layout, LAYOUT_DEPTH_MAX) ? layoutHash(layout)
            : null;
    }
    return hashes;
}

/**
 * The local value of every wire key: the lines of streamdeck.conf as
 * `readCurrent` reads `confText`, and `key_layouts` the hashes of
 * keymap.json (`keymapText`; null or undefined when there is none, or it
 * cannot be read).
 */
export function readLocal(confText, keymapText) {
    return {...readCurrent(confText), [KEYMAP_KEY]: layoutHashes(keymapText)};
}

/**
 * The text of keymap.json for `layouts` (a reply's `settings.key_layouts`)
 * of revision `revision`. Throws a RangeError when `layouts` does not
 * follow the format, or `revision` is not a non-negative integer: nothing
 * invalid is ever written.
 */
export function keymapText(revision, layouts) {
    if (!Number.isSafeInteger(revision) || revision < 0 ||
        !_layoutsShape(layouts))
        throw new RangeError(`invalid:${KEYMAP_KEY}`);
    return `${JSON.stringify({format: KEYMAP_FORMAT, revision, layouts},
        null, 2)}\n`;
}

/**
 * The catalog of the deck program as the extension keeps it, from `value`
 * (what `--catalog` printed, parsed): `{format, actions, icons, models}`,
 * each action of ACTION_RE and icon of ICON_RE once, in order, each model
 * of PRODUCT_ID_RE with its `cols`, `rows` and `keys` (integers from 0 to
 * 256). An item of another form, which a newer program may print, is left
 * out; another `format`, or a part that is not a list or an object, gives
 * null.
 */
export function catalogFrom(value) {
    if (!_plain(value) || value.format !== KEYMAP_FORMAT ||
        !Array.isArray(value.actions) || !Array.isArray(value.icons) ||
        !_plain(value.models))
        return null;
    const kept = (list, re) => [...new Set(list.filter(v =>
        typeof v === 'string' && re.test(v)))];
    const size = n => Number.isSafeInteger(n) && n >= 0 && n <= GEOMETRY_MAX;
    const models = {};
    for (const [model, g] of Object.entries(value.models)) {
        if (PRODUCT_ID_RE.test(model) && _plain(g) && size(g.cols) &&
            size(g.rows) && size(g.keys))
            models[model] = {cols: g.cols, rows: g.rows, keys: g.keys};
    }
    return {format: KEYMAP_FORMAT, actions: kept(value.actions, ACTION_RE),
        icons: kept(value.icons, ICON_RE), models};
}

/** `catalogFrom` of the text `--catalog` printed; null when it is none. */
export function parseCatalog(text) {
    const value = typeof text === 'string' ? _json(text) : undefined;
    return value === undefined ? null : catalogFrom(value);
}

/**
 * Whether the deck can lay out `layouts` (a reply's
 * `settings.key_layouts`): the format of keymap.json, then for each model
 * the `catalog` (as `catalogFrom` reads it) knows its geometry, no key
 * passes its key count, and it lists every action and icon;
 * `pluginsOff`, the plugins turned off, names no plugin of an action.
 * Returns `{ok: true, reason: null}`, or `{ok: false, reason:
 * "invalid:key_layouts"}`; without a catalog every layout refuses, an
 * empty one too, since nothing tells this checkout lays out keys.
 */
export function validateKeyLayouts(layouts, catalog, pluginsOff = []) {
    const refused = {ok: false, reason: `invalid:${KEYMAP_KEY}`};
    const cat = catalogFrom(catalog);
    if (cat === null || !_layoutsShape(layouts)) return refused;
    const off = Array.isArray(pluginsOff) ? pluginsOff : [];
    // Every key once and below the model's count: no more entries than
    // its keys.
    for (const [model, {keys}] of Object.entries(layouts)) {
        const geo = cat.models[model];
        if (!geo) return refused;
        for (const e of keys) {
            if (e.key >= geo.keys || !cat.actions.includes(e.action) ||
                (e.action.startsWith('plugin:') &&
                    off.includes(e.action.slice('plugin:'.length))) ||
                (Object.hasOwn(e, 'icon') && !cat.icons.includes(e.icon)))
                return refused;
        }
    }
    return {ok: true, reason: null};
}
