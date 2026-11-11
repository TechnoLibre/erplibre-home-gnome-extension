// The Odoo configuration of the deck: the closed list of settings Odoo may
// set, the validation of a reply's `config`, and the rewrite of
// streamdeck.conf. The fixtures of test/fixtures/streamdeck_conf/ are
// shared with ERPLibre, whose tests run its own writer on them.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {
    CONFIG_KEYS, CHOICES, PLUGIN_ID_RE, PLUGINS_OFF_MAX, REFUSAL_REASONS,
    validateConfig, readCurrent, rewriteConf, confLines, changedKeys,
    needsRestart,
} from '../../lib/deck-config.js';

const FIXTURES = new URL('../fixtures/streamdeck_conf/', import.meta.url);
const HASH = 'a'.repeat(64);

// The fixtures: `<name>.in.conf`, the file before; `<name>.json`, the
// wire `settings`, the conf `lines` they give and the `current` values
// the file holds; `<name>.out.conf`, the file once `settings` is written.
function fixtures() {
    return readdirSync(FIXTURES).filter(f => f.endsWith('.in.conf'))
        .sort().map(f => {
            const name = f.slice(0, -'.in.conf'.length);
            const bytes = suffix => new Uint8Array(
                readFileSync(new URL(`${name}${suffix}`, FIXTURES)));
            return {name, before: bytes('.in.conf'), after: bytes('.out.conf'),
                ...JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES),
                    'utf8'))};
        });
}

function reply(settings, extra = {}) {
    return {revision: 3, hash: HASH, settings, locked: [], ...extra};
}

// Wire values outside the schema, per key, and values inside it.
const BAD = {
    deck_program: ['Tiler', '/bin/sh', '', null, 1, ['tiler'], 'tiler '],
    plugins_off: ['sound', [''], ['a-b'], ['Sound'], ['9lives'], [1],
        [`a${'b'.repeat(64)}`], Array.from({length: 65}, (_, i) => `p${i}`),
        null, {sound: true}],
    session_refresh_sec: [0.4, 60.1, '2', NaN, Infinity, null, true, -1],
    games: ['On', 'yes', true, null, ''],
};
const GOOD = {
    deck_program: ['tiler', 'controller', 'none'],
    plugins_off: [[], ['sound'], ['a', `a${'b'.repeat(63)}`],
        Array.from({length: 64}, (_, i) => `p${i}`)],
    session_refresh_sec: [0.5, 1, 2.5, 60],
    games: ['on', 'off'],
};

test('the closed list of settings is the four keys of the contract', () => {
    assert.deepEqual(Object.keys(CONFIG_KEYS), ['deck_program', 'plugins_off',
        'session_refresh_sec', 'games']);
    assert.deepEqual(Object.fromEntries(Object.entries(CONFIG_KEYS)
        .map(([k, v]) => [k, [v.line, v.restart]])), {
        deck_program: ['DECK_PROGRAM', true],
        plugins_off: ['DECK_PLUGINS_OFF', true],
        session_refresh_sec: ['DECK_SESSION_REFRESH_SEC', true],
        games: ['GAMES', false],
    });
    assert.deepEqual(CHOICES, ['keep_local', 'take_odoo']);
    assert.deepEqual(REFUSAL_REASONS, ['write_failed', 'restart_failed',
        'unit_missing']);
    assert.equal(PLUGINS_OFF_MAX, 64);
    assert.equal(String(PLUGIN_ID_RE), '/^[a-z][a-z0-9_]{0,63}$/');
});

test('deck-config.js runs under GJS: no import at all', () => {
    const src = readFileSync(
        new URL('../../lib/deck-config.js', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /^\s*import\b|\bimport\s*\(/m);
    assert.doesNotMatch(src, /gi:\/\//);
});

test('each key accepts the values of the schema', () => {
    for (const [key, values] of Object.entries(GOOD)) {
        for (const value of values) {
            const r = validateConfig(reply({[key]: value}));
            assert.equal(r.ok, true, `${key} ${JSON.stringify(value)}`);
            assert.deepEqual(r.settings, {[key]: value});
        }
    }
});

test('a_bad_value_refuses_the_whole_revision', () => {
    const others = {deck_program: 'controller', plugins_off: ['sound'],
        session_refresh_sec: 2, games: 'off'};
    for (const [key, values] of Object.entries(BAD)) {
        for (const value of values) {
            const r = validateConfig(reply({...others, [key]: value}));
            assert.deepEqual(r, {ok: false, reason: `invalid:${key}`,
                revision: 3}, `${key} ${JSON.stringify(value)}`);
        }
    }
    // Nothing of a refused revision reaches the file: the rewrite itself
    // throws on a value outside the schema.
    for (const [key, [value]] of Object.entries(BAD)) {
        const before = 'GAMES=on\n# kept\n';
        assert.throws(() => rewriteConf(before, {[key]: value}), RangeError,
            key);
    }
});

// The frame of a reply's `config`, malformed: no key of the table is at
// fault, so there is no `invalid:<key>` to send, the one refusal reason
// of a revision Odoo receives. The config is ignored as if absent.
const FRAMES = [null, 'x', [],
    reply({games: 'on'}, {revision: -1}), reply({games: 'on'}, {revision: 1.5}),
    reply({games: 'on'}, {revision: '3'}),
    reply({games: 'on'}, {hash: 'A'.repeat(64)}),
    reply({games: 'on'}, {hash: 'a'.repeat(63)}),
    reply(null), reply(['games']),
    reply({games: 'on'}, {locked: 'games'}),
    reply({games: 'on'}, {locked: [1]}),
    reply({games: 'on'}, {ask: 'games'}),
    reply({games: 'on'}, {ask: ['games', 1]}),
    // The frame goes first: a bad value besides changes nothing.
    reply({games: 'yes'}, {hash: 'x'})];

test('a reply outside the shape is ignored, nothing to refuse', () => {
    for (const config of FRAMES) {
        assert.deepEqual(validateConfig(config),
            {ok: false, reason: null, revision: null},
            JSON.stringify(config));
    }
});

test('a key locked or asked out of place refuses as invalid:<key>', () => {
    const settings = {deck_program: 'tiler', games: 'off'};
    assert.deepEqual(validateConfig(reply(settings,
        {locked: ['session_refresh_sec']})),
    {ok: false, reason: 'invalid:session_refresh_sec', revision: 3});
    // The first key at fault in the table's order, whatever Odoo's order.
    assert.deepEqual(validateConfig(reply(settings,
        {locked: ['games', 'plugins_off'], ask: ['games']})),
    {ok: false, reason: 'invalid:plugins_off', revision: 3});
    assert.deepEqual(validateConfig(reply(settings,
        {locked: ['games'], ask: ['games', 'deck_program', 'plugins_off']})),
    {ok: false, reason: 'invalid:plugins_off', revision: 3});
    assert.deepEqual(validateConfig(reply(settings,
        {locked: ['deck_program', 'plugins_off'], ask: ['deck_program']})),
    {ok: false, reason: 'invalid:deck_program', revision: 3});
});

// Odoo answers 400 to a `result.reason` outside the contract's list, and
// the report then never goes through: a refusal names a key of the table.
test('every refusal names a key of the table, as Odoo receives it', () => {
    const named = new RegExp(`^invalid:(${Object.keys(CONFIG_KEYS)
        .join('|')})$`);
    const others = {deck_program: 'controller', games: 'off'};
    const configs = [...FRAMES,
        ...Object.entries(BAD).flatMap(([key, values]) =>
            values.map(value => reply({...others, [key]: value}))),
        ...Object.keys(CONFIG_KEYS).flatMap(key => [
            reply(others, {locked: [key]}), reply(others, {ask: [key]}),
            reply(others, {locked: [key], ask: [key]})])];
    for (const config of configs) {
        const r = validateConfig(config);
        if (r.ok || r.reason === null) continue;
        assert.match(r.reason, named, JSON.stringify(config));
        assert.ok(Number.isSafeInteger(r.revision), JSON.stringify(config));
    }
});

test('a valid reply comes back normalised, unknown keys ignored', () => {
    const r = validateConfig({revision: 0, hash: HASH,
        settings: {games: 'off', key_layouts: {x: 1},
            plugins_off: ['sound', 'timers', 'sound'], deck_program: 'none'},
        locked: ['games', 'key_layouts', 'games'], ask: ['deck_program'],
        extra: true});
    assert.deepEqual(r, {ok: true, revision: 0, hash: HASH,
        settings: {deck_program: 'none', plugins_off: ['sound', 'timers'],
            games: 'off'},
        locked: ['games'], ask: ['deck_program']});
    assert.deepEqual(Object.keys(r.settings),
        ['deck_program', 'plugins_off', 'games']);
    assert.deepEqual(validateConfig(reply({games: 'on'})).ask, []);
    assert.deepEqual(validateConfig(reply({games: 'on'}, {locked: null}))
        .locked, []);
});

test('plugins_off counts its ids once their repeats are dropped', () => {
    // The rule of Odoo's schema too: the bound is on distinct ids.
    const sixtyFour = Array.from({length: 64}, (_, i) => `p${i}`);
    const r = validateConfig(reply({plugins_off: [...sixtyFour, 'p0']}));
    assert.equal(r.ok, true);
    assert.deepEqual(r.settings.plugins_off, sixtyFour);
    assert.deepEqual(CONFIG_KEYS.plugins_off.parse(
        [...sixtyFour, 'p0'].join(',')), sixtyFour);
    assert.deepEqual(validateConfig(reply({plugins_off: [...sixtyFour,
        'p64']})), {ok: false, reason: 'invalid:plugins_off', revision: 3});
    assert.equal(CONFIG_KEYS.plugins_off.parse(
        [...sixtyFour, 'p64'].join(',')), null);
});

test('an_ask_key_outside_the_free_keys_refuses', () => {
    const settings = {deck_program: 'tiler', games: 'off'};
    for (const key of ['session_refresh_sec', 'games']) {
        assert.deepEqual(validateConfig(reply(settings,
            {locked: ['games'], ask: [key]})),
        {ok: false, reason: `invalid:${key}`, revision: 3}, key);
    }
    assert.deepEqual(validateConfig(reply(settings,
        {locked: ['games'], ask: ['deck_program', 'key_layouts']})).ask,
    ['deck_program']);
});

test('readCurrent_matches_the_settings_library', () => {
    const all = fixtures();
    assert.ok(all.length >= 6, `${all.length} fixtures`);
    for (const f of all)
        assert.deepEqual(readCurrent(f.before), f.current, f.name);
    // A text reads as its bytes would.
    assert.deepEqual(readCurrent('GAMES=off\nDECK_PROGRAM=none\r\n'),
        {deck_program: null, plugins_off: null, session_refresh_sec: null,
            games: 'off'});
});

// A key the file lacks is no value of the employee's: the deck runs the
// library's default, but nothing local is there to keep. It reads null,
// which Odoo neither lists in `ask` nor adopts.
test('a_key_the_file_lacks_reads_null', () => {
    const none = {deck_program: null, plugins_off: null,
        session_refresh_sec: null, games: null};
    assert.deepEqual(readCurrent(null), none);
    assert.deepEqual(readCurrent(''), none);
    assert.deepEqual(readCurrent(new Uint8Array(0)), none);
    assert.deepEqual(readCurrent('# GAMES=on\nINVENTED=1\n'), none);
    assert.deepEqual(readCurrent('GAMES=on\n'), {...none, games: 'on'});
    // An empty list is a value: the line is there.
    assert.deepEqual(readCurrent('DECK_PLUGINS_OFF=\n').plugins_off, []);
});

test('readCurrent reads numbers and lists as the shell does', () => {
    const read = (line) => readCurrent(`${line}\n`);
    for (const [text, value] of [['.5', 0.5], ['60', 60], ['  2.50 ', 2.5],
        ['\t1.\t', 1], ['0.5', 0.5]])
        assert.equal(read(`DECK_SESSION_REFRESH_SEC=${text}`)
            .session_refresh_sec, value, text);
    for (const text of ['', '1e1', '+1', '-1', '0.49', '60.01', '1,5',
        ' 1', '0x10'])
        assert.equal(read(`DECK_SESSION_REFRESH_SEC=${text}`)
            .session_refresh_sec, null, text);
    for (const [text, value] of [['', []], [' a , b_2,,a ', ['a', 'b_2']],
        ['a\tb', ['ab']], [',', []]])
        assert.deepEqual(read(`DECK_PLUGINS_OFF=${text}`).plugins_off, value,
            text);
    for (const text of ['A', 'a-b', 'a b', '1a'])
        assert.equal(read(`DECK_PLUGINS_OFF=${text}`).plugins_off, null,
            text);
});

test('rewrite_keeps_every_other_line', () => {
    for (const f of fixtures()) {
        assert.deepEqual(confLines(f.settings), f.lines, f.name);
        assert.deepEqual(Object.keys(confLines(f.settings)),
            Object.keys(f.lines), `${f.name}: order`);
        const out = rewriteConf(f.before, f.settings);
        assert.ok(out instanceof Uint8Array, f.name);
        assert.deepEqual(Buffer.from(out).toString('latin1'),
            Buffer.from(f.after).toString('latin1'), f.name);
        // What the rewrite wrote reads back as the settings.
        const back = readCurrent(out);
        for (const [key, value] of Object.entries(f.settings))
            assert.deepEqual(back[key], value, `${f.name}: ${key}`);
    }
});

test('rewriteConf on a text gives a text, a missing file a new one', () => {
    assert.equal(rewriteConf('# été\nGAMES=on\n', {games: 'off'}),
        '# été\nGAMES=off\n');
    assert.equal(rewriteConf(null, {games: 'off', deck_program: 'none'}),
        'DECK_PROGRAM=none\nGAMES=off\n');
    assert.equal(rewriteConf('GAMES=on\n', {}), 'GAMES=on\n');
    assert.equal(rewriteConf('X=1', {}), 'X=1\n');
});

// Read as empty, a file of another type would come back as the managed
// lines alone, every other line of the employee's lost at the write.
test('a file neither bytes nor text throws, never reads as empty', () => {
    const text = '# keep me\nINVENTED=1\nGAMES=on\n';
    const bytes = new TextEncoder().encode(text);
    for (const input of [bytes.buffer, new DataView(bytes.buffer),
        new Uint16Array(2), undefined, 0, {}, [text],
        {get_data: () => bytes}]) {
        const what = Object.prototype.toString.call(input);
        assert.throws(() => rewriteConf(input, {games: 'off'}), TypeError,
            what);
        assert.throws(() => readCurrent(input), TypeError, what);
    }
    // A Buffer is a Uint8Array.
    assert.equal(Buffer.from(rewriteConf(Buffer.from(bytes), {games: 'off'}))
        .toString(), '# keep me\nINVENTED=1\nGAMES=off\n');
});

test('changedKeys compares values, lists in their order', () => {
    const current = {deck_program: 'tiler', plugins_off: ['a', 'b'],
        session_refresh_sec: 2, games: null};
    assert.deepEqual(changedKeys(current, {deck_program: 'tiler',
        plugins_off: ['a', 'b'], session_refresh_sec: 2.0}), []);
    assert.deepEqual(changedKeys(current, {games: 'on',
        plugins_off: ['b', 'a'], deck_program: 'none'}),
    ['deck_program', 'plugins_off', 'games']);
    assert.deepEqual(changedKeys(null, {games: 'on'}), ['games']);
    assert.deepEqual(changedKeys({plugins_off: null}, {plugins_off: []}),
        ['plugins_off']);
});

test('games_alone_needs_no_restart', () => {
    assert.equal(needsRestart(['games']), false);
    assert.equal(needsRestart([]), false);
    for (const key of ['deck_program', 'plugins_off', 'session_refresh_sec'])
        assert.equal(needsRestart(['games', key]), true, key);
    assert.equal(needsRestart(['key_layouts']), false);
});
