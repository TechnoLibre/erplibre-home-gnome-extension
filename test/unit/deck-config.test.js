// The Odoo configuration of the deck: the closed list of settings Odoo may
// set, the validation of a reply's `config`, and the rewrite of
// streamdeck.conf. The fixtures of test/fixtures/streamdeck_conf/ are
// shared with ERPLibre, whose tests run its own writer on them.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {
    CONFIG_KEYS, CHOICES, PLUGIN_ID_RE, PLUGINS_OFF_MAX, REFUSAL_REASONS,
    validateConfig, readCurrent, rewriteConf, confLines, changedKeys,
    needsRestart, WIRE_KEYS, KEYMAP_KEY, KEYMAP_FORMAT, KEYMAP_MODELS_MAX,
    LABEL_MAX, CATALOG_MAX, validateKeyLayouts, keymapText, layoutHashes,
    layoutHash, canonicalJson, sha256Hex, catalogFrom, parseCatalog,
    readLocal,
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
    const named = new RegExp(`^invalid:(${WIRE_KEYS.join('|')})$`);
    const others = {deck_program: 'controller', games: 'off'};
    const configs = [...FRAMES,
        ...Object.entries(BAD).flatMap(([key, values]) =>
            values.map(value => reply({...others, [key]: value}))),
        ...WIRE_KEYS.flatMap(key => [
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
        settings: {games: 'off', brightness: {x: 1},
            plugins_off: ['sound', 'timers', 'sound'], deck_program: 'none'},
        locked: ['games', 'brightness', 'games'], ask: ['deck_program'],
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
        {locked: ['games'], ask: ['deck_program', 'brightness']})).ask,
    ['deck_program']);
    assert.deepEqual(validateConfig(reply(settings,
        {ask: ['deck_program', 'key_layouts']})),
    {ok: false, reason: 'invalid:key_layouts', revision: 3},
    'a known key since 1.2');
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
    assert.equal(needsRestart(['key_layouts']), true, 'read at the start');
    assert.equal(needsRestart(['brightness']), false, 'unknown');
});

// ---------------------------------------------------------------------
// Key layouts (contract 1.4, protocol 1.2): keymap.json, written from the
// reply's `settings.key_layouts` once each layout passes the format rules
// and the catalog the deck program printed. The fixtures of
// test/fixtures/keymap/ are shared with ERPLibre, whose loader gives the
// same verdict on them.

const KEYMAP_FIXTURES = new URL('../fixtures/keymap/', import.meta.url);

function keymapFixtures() {
    return readdirSync(KEYMAP_FIXTURES).filter(f => f.endsWith('.json'))
        .sort().map(f => ({name: f.slice(0, -'.json'.length),
            ...JSON.parse(readFileSync(new URL(f, KEYMAP_FIXTURES), 'utf8'))}));
}

const CATALOG = {format: 1,
    actions: ['plugin:sound', 'plugin:timers', 'tiles', 'empty'],
    icons: ['sound', 'tile', 'timer'],
    models: {'006d': {cols: 5, rows: 3, keys: 15},
        '0084': {cols: 4, rows: 2, keys: 8}}};
const LAYOUTS = {'0084': {keys: [
    {key: 0, action: 'plugin:timers', icon: 'timer', label: 'Minuteries'},
    {key: 1, action: 'tiles'}, {key: 2, action: 'empty'}]}};
const REFUSED = {ok: false, reason: 'invalid:key_layouts'};

test('key_layouts is the fifth wire key, after the lines of the conf', () => {
    assert.equal(KEYMAP_KEY, 'key_layouts');
    assert.deepEqual(WIRE_KEYS, [...Object.keys(CONFIG_KEYS), 'key_layouts']);
    assert.equal(KEYMAP_FORMAT, 1);
    assert.equal(KEYMAP_MODELS_MAX, 16);
    assert.equal(LABEL_MAX, 16);
    assert.equal(CATALOG_MAX, 32 * 1024);
});

test('the shared keymap fixtures give their verdict', () => {
    const all = keymapFixtures();
    assert.ok(all.some(f => f.valid) && all.some(f => !f.valid));
    for (const f of all) {
        assert.deepEqual(Object.keys(f), ['name', 'catalog', 'plugins_off',
            'layouts', 'valid'], f.name);
        assert.deepEqual(validateKeyLayouts(f.layouts, f.catalog,
            f.plugins_off), f.valid ? {ok: true, reason: null} : REFUSED,
        f.name);
    }
});

// Review Focus 1 of the plan, as the wire brings it: each refuses the
// whole revision with invalid:key_layouts, before anything is written.
test('every_hostile_layout_refuses_invalid_key_layouts', () => {
    const one = keys => ({'0084': {keys}});
    const hostile = {
        'not an object': 'garbage',
        'a list': [LAYOUTS],
        'null': null,
        'unknown format of a layout': {'0084': {format: 2, keys: []}},
        'key out of range': one([{key: 8, action: 'tiles'}]),
        'duplicate key': one([{key: 0, action: 'tiles'},
            {key: 0, action: 'tiles'}]),
        'unknown icon': one([{key: 0, action: 'tiles', icon: 'nope'}]),
        'plugin missing': one([{key: 0, action: 'plugin:nothere'}]),
        '10 000 entries': one(Array.from({length: 10000}, (_, i) =>
            ({key: i, action: 'empty'}))),
        'label with a control char': one([{key: 0, action: 'tiles',
            label: 'a\nb'}]),
        'label with a lone surrogate': one([{key: 0, action: 'tiles',
            label: 'a\ud800'}]),
    };
    for (const [what, layouts] of Object.entries(hostile)) {
        assert.deepEqual(validateKeyLayouts(layouts, CATALOG), REFUSED, what);
        const r = validateConfig({revision: 4, hash: HASH,
            settings: {games: 'on', key_layouts: layouts}});
        if (r.ok) {
            // Only the catalog knows it: the service refuses it then.
            assert.ok(['unknown icon', 'plugin missing', 'key out of range']
                .includes(what), what);
        } else {
            assert.deepEqual(r, {ok: false, reason: 'invalid:key_layouts',
                revision: 4}, what);
            assert.throws(() => keymapText(4, layouts), RangeError, what);
        }
    }
    assert.deepEqual(validateKeyLayouts(LAYOUTS, CATALOG, ['timers']),
        REFUSED, 'plugin turned off');
    assert.deepEqual(validateKeyLayouts(LAYOUTS, CATALOG, ['sound']),
        {ok: true, reason: null});
});

test('a_layout_action_outside_the_catalog_refuses', () => {
    // A checkout older than the layout: no timers plugin in its catalog.
    const older = {...CATALOG, actions: ['plugin:sound', 'tiles', 'empty']};
    assert.deepEqual(validateKeyLayouts(LAYOUTS, older), REFUSED);
    for (const catalog of [null, undefined, {}, {...CATALOG, format: 2},
        'x'])
        assert.deepEqual(validateKeyLayouts(LAYOUTS, catalog), REFUSED,
            JSON.stringify(catalog));
    assert.deepEqual(validateKeyLayouts({}, null), REFUSED,
        'no catalog read, nothing to write against');
    const noTiles = {...CATALOG, actions: ['plugin:timers', 'empty']};
    assert.deepEqual(validateKeyLayouts(LAYOUTS, noTiles), REFUSED);
});

test('a valid key_layouts comes back in the settings as sent', () => {
    const r = validateConfig({revision: 2, hash: HASH,
        settings: {key_layouts: LAYOUTS, games: 'on'},
        locked: ['key_layouts'], ask: []});
    assert.equal(r.ok, true);
    assert.deepEqual(Object.keys(r.settings), ['games', 'key_layouts']);
    assert.deepEqual(r.settings.key_layouts, LAYOUTS);
    assert.deepEqual(r.locked, ['key_layouts']);
    assert.deepEqual(validateConfig({revision: 2, hash: HASH,
        settings: {games: 'on'}, locked: ['key_layouts']}),
    {ok: false, reason: 'invalid:key_layouts', revision: 2});
});

test('keymapText writes format 1, the revision and the layouts', () => {
    const text = keymapText(7, LAYOUTS);
    assert.ok(text.endsWith('\n'));
    assert.deepEqual(JSON.parse(text), {format: 1, revision: 7,
        layouts: LAYOUTS});
    assert.throws(() => keymapText(-1, LAYOUTS), RangeError);
    assert.deepEqual(JSON.parse(keymapText(0, {})).layouts, {});
});

test('the layout hash is Python\'s json.dumps canonical form, sha256', () => {
    const layout = {keys: [{label: 'Café ☕ "q" \\ \u007f\u0085'
        + '\u{1F3AE}\t', key: 3, action: 'tiles', icon: 'timer'},
    {key: 0, action: 'empty'}]};
    assert.equal(canonicalJson(layout), '{"keys":[{"action":"tiles",'
        + '"icon":"timer","key":3,"label":"Caf\\u00e9 \\u2615 \\"q\\" \\\\ '
        + '\\u007f\\u0085\\ud83c\\udfae\\t"},{"action":"empty","key":0}]}');
    assert.equal(canonicalJson([true, false, null, -2, 'a\u0001\b\f\n\r']),
        '[true,false,null,-2,"a\\u0001\\b\\f\\n\\r"]');
    assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb924'
        + '27ae41e4649b934ca495991b7852b855');
    assert.equal(sha256Hex('a'.repeat(1000)), createHash('sha256')
        .update('a'.repeat(1000)).digest('hex'));
    assert.equal(layoutHash(layout), createHash('sha256')
        .update(canonicalJson(layout)).digest('hex'));
    const py = spawnSync('python3', ['-c', 'import hashlib, json, sys\n'
        + 'for l in json.load(sys.stdin):\n'
        + '    print(hashlib.sha256(json.dumps(l, sort_keys=True,'
        + ' separators=(",", ":")).encode()).hexdigest())'],
    {input: JSON.stringify([layout, LAYOUTS['0084']]), encoding: 'utf8',
        env: {...process.env, PYTHONIOENCODING: 'utf-8'}});
    if (py.status !== 0) return;
    assert.deepEqual(py.stdout.trim().split('\n'),
        [layoutHash(layout), layoutHash(LAYOUTS['0084'])]);
});

test('layoutHashes reads keymap.json, null when it holds no format 1', () => {
    const bytes = new TextEncoder().encode(keymapText(3, LAYOUTS));
    assert.deepEqual(layoutHashes(bytes),
        {'0084': layoutHash(LAYOUTS['0084'])});
    assert.deepEqual(layoutHashes(keymapText(3, LAYOUTS)),
        layoutHashes(bytes), 'a text reads as its bytes');
    for (const file of [null, undefined, '', 'not json', '[]', '{}',
        '{"format": 2, "layouts": {}}', '{"format": 1, "layouts": []}',
        '{"format": "1", "layouts": {}}', new Uint8Array([0x7b, 0xff]),
        `{"format": 1, "layouts": {}, "x": "${'y'.repeat(300 * 1024)}"}`])
        assert.equal(layoutHashes(file), null, String(file).slice(0, 40));
    // A layout of another shape has no hash; a name of another form, or
    // past the sixteenth model, is not read.
    const odd = JSON.stringify({format: 1, layouts: {'0084': [],
        '006d': {keys: 'x'}, 'ABCD': {keys: []},
        ...Object.fromEntries(Array.from({length: 20}, (_, i) =>
            [(0x200 + i).toString(16).padStart(4, '0'), {keys: []}]))}});
    const hashes = layoutHashes(odd);
    assert.equal(Object.keys(hashes).length, 16);
    assert.equal(hashes['0084'], null);
    assert.equal(hashes['006d'], layoutHash({keys: 'x'}));
    assert.equal(hashes['020d'], layoutHash({keys: []}));
    assert.equal(hashes['020e'], undefined, 'past the sixteenth in order');
    assert.equal(hashes.ABCD, undefined);
    const two = JSON.stringify({format: 1, layouts: {'0084': [],
        '006d': {keys: []}}});
    assert.deepEqual(layoutHashes(two), {'006d': layoutHash({keys: []}),
        '0084': null});
});

test('a layout nested past the bound hashes as null, never throws', () => {
    // 100 000 levels fit in 256 KiB: hashed as they come, they would
    // exhaust the stack of GJS and node alike, and with it every report.
    const n = 100000;
    const deep = `{"format": 1, "layouts": {"0084": {"keys": `
        + `${'['.repeat(n)}${']'.repeat(n)}}, "006d": {"keys": []}}}`;
    assert.ok(deep.length < 256 * 1024);
    assert.deepEqual(layoutHashes(deep), {'006d': layoutHash({keys: []}),
        '0084': null});
    assert.deepEqual(readLocal('', deep).key_layouts['0084'], null);
    // The format nests 3 levels; up to 8 a layout of another shape still
    // hashes, past it gives null.
    const nested = depth => {
        let v = 1;
        for (let i = 1; i < depth; i++) v = [v];
        return {keys: v};
    };
    const at = depth => layoutHashes(JSON.stringify({format: 1,
        layouts: {'0084': nested(depth)}}))['0084'];
    assert.equal(at(8), layoutHash(nested(8)));
    assert.equal(at(9), null);
});

test('readLocal adds the layout hashes to the values of the conf', () => {
    const local = readLocal('GAMES=off\n', keymapText(1, LAYOUTS));
    assert.deepEqual(local, {...readCurrent('GAMES=off\n'),
        key_layouts: {'0084': layoutHash(LAYOUTS['0084'])}});
    assert.equal(readLocal(null, null).key_layouts, null);
    assert.equal(readLocal(null, undefined).key_layouts, null,
        'a keymap that cannot be read holds nothing');
});

test('changedKeys compares the layouts by their hashes', () => {
    const held = {...readCurrent('GAMES=on\n'),
        key_layouts: {'0084': layoutHash(LAYOUTS['0084'])}};
    assert.deepEqual(changedKeys(held, {games: 'on', key_layouts: LAYOUTS}),
        []);
    // Another order of the same layout's keys is another layout.
    const swapped = {'0084': {keys: [...LAYOUTS['0084'].keys].reverse()}};
    assert.deepEqual(changedKeys(held, {key_layouts: swapped}),
        ['key_layouts']);
    assert.deepEqual(changedKeys(held, {key_layouts: {}}), ['key_layouts'],
        'a model the file holds and Odoo no longer sends');
    assert.deepEqual(changedKeys({...held, key_layouts: null},
        {key_layouts: {}}), ['key_layouts'], 'no file is not an empty one');
    assert.deepEqual(changedKeys(held, {key_layouts: {...LAYOUTS,
        '006d': {keys: []}}}), ['key_layouts']);
});

test('catalogFrom keeps what the extension can check, else null', () => {
    assert.deepEqual(catalogFrom(CATALOG), CATALOG);
    assert.deepEqual(parseCatalog(`${JSON.stringify(CATALOG)}\n`), CATALOG);
    for (const bad of [null, 'x', [], {...CATALOG, format: 2},
        {...CATALOG, actions: 'tiles'}, {...CATALOG, icons: null},
        {...CATALOG, models: []}])
        assert.equal(catalogFrom(bad), null, JSON.stringify(bad));
    for (const text of [null, '', 'not json', '{"format": 1}',
        `${' '.repeat(300 * 1024)}{}`])
        assert.equal(parseCatalog(text), null, String(text).slice(0, 20));
    // What a newer program may add: an item of another form is left out,
    // the rest is kept.
    assert.deepEqual(catalogFrom({...CATALOG,
        actions: [...CATALOG.actions, 'page:x', 1, 'tiles'],
        icons: [...CATALOG.icons, 'Bad Icon'],
        models: {...CATALOG.models, '0080': {cols: 4, rows: 2},
            'ABCD': {cols: 1, rows: 1, keys: 1},
            '0090': {cols: 3, rows: 1, keys: 3, dials: 4}},
        extra: true}), {...CATALOG, models: {...CATALOG.models,
        '0090': {cols: 3, rows: 1, keys: 3}}});
});
