/**
 * The Stream Deck configuration an Odoo pilots: the closed list of
 * settings it may set (CONTRACT.md, « Odoo configuration »), the
 * validation of the `config` of a reply, the reading of the local values
 * in streamdeck.conf and the rewrite of that file.
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

/**
 * The known strings of `list` once each, in order; `[]` for undefined
 * and, when `nullable`, for null; undefined when it is not a list of
 * strings.
 */
function _keyList(list, nullable) {
    if (list === undefined || (nullable && list === null)) return [];
    if (!Array.isArray(list) || !list.every(k => typeof k === 'string'))
        return undefined;
    return [...new Set(list)].filter(k => KEYS.includes(k));
}

/**
 * The `config` of a reply, checked against the contract before anything
 * of it is announced or written.
 *
 * Returns `{ok: true, revision, hash, settings, locked, ask}`: `settings`
 * holds the known keys in the table's order, each normalised by its
 * `valid`; `locked` and `ask` the known keys once each, `ask` `[]` when
 * absent, `locked` `[]` when absent or null. A key unknown to the table
 * is ignored wherever it appears.
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
    const astray = KEYS.find(k => ask.includes(k)
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

/**
 * The keys of `settings` whose value `current` (from `readCurrent`) does
 * not hold, in the table's order. Lists compare in their order: the file
 * ends holding Odoo's list exactly, so the next report shows no drift.
 */
export function changedKeys(current, settings) {
    return KEYS.filter(k => settings && Object.hasOwn(settings, k) &&
        !_same(current?.[k], settings[k]));
}

/** Whether changing `keys` restarts the deck unit. */
export function needsRestart(keys) {
    return (Array.isArray(keys) ? keys : [])
        .some(k => CONFIG_KEYS[k]?.restart === true);
}
