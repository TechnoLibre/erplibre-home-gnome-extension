// The extension's half of CONTRACT.md: every value the contract states is
// read from CONTRACT.md itself and compared with the file that holds it,
// so neither the document nor the code can change alone. ERPLibre's tests
// hold the other half (the version it records, the D-Bus calls it makes).

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, readdirSync, rmSync, statSync}
    from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {DECK_UNIT, CONTROLLER_REL, DECK_ENTRY_REL, deckLockPath}
    from '../../lib/deck-service.js';
import {projectRootFrom, STREAMDECK_PYTHON_REL, GALLERY_SERVER_REL}
    from '../../lib/project-root.js';
import {GALLERY_ACTION_HEADER} from '../../lib/gallery-launch.js';
import {INVENTORY_PROTOCOL, HEARTBEAT_S, TIMEOUT_S, POLL_S, QUEUE_MAX,
    QUEUE_MAX_AGE_DAYS, ENROLL_PATH, REPORT_PATH, UNENROLL_PATH,
    ENROLL_METHODS, ERROR_CODES, buildState, diffDecks,
    workstationFingerprint, configBody} from '../../lib/inventory.js';
import {CONFIG_KEYS, DECK_PROGRAMS, GAMES_VALUES, SESSION_REFRESH_RANGE,
    PLUGINS_OFF_MAX, PLUGIN_ID_RE, DECK_PLUGINS_MAX, REFUSAL_REASONS,
    CHOICES, validateConfig, KEYMAP_FORMAT, KEYMAP_MODELS_MAX, LABEL_MAX,
    ICON_RE, CATALOG_MAX, LAYOUT_DEPTH_MAX, keymapText, validateKeyLayouts}
    from '../../lib/deck-config.js';
import {createHmac} from 'node:crypto';

const ROOT = new URL('../../', import.meta.url);

function text(rel) {
    return readFileSync(new URL(rel, ROOT), 'utf8');
}

const CONTRACT = text('CONTRACT.md');
// CONTRACT.md with every run of white space as one space: a value the
// text wraps onto the next line still reads as one phrase.
const FLAT = CONTRACT.replace(/\s+/g, ' ');
const METADATA = JSON.parse(text('metadata.json'));
const EXTENSION_JS = text('extension.js');

// The text of the CONTRACT.md section whose `## ` heading is `title`.
function section(title) {
    const parts = CONTRACT.split(/^## /m);
    const found = parts.filter((p) => p.startsWith(`${title}\n`));
    assert.equal(found.length, 1, `section "${title}"`);
    return found[0];
}

// The value of a "- `key`: `value`" line of CONTRACT.md.
function listedValue(key) {
    const re = new RegExp(`^\\s*- \`${key}\`: \`([^\`]+)\``, 'gm');
    const found = [...CONTRACT.matchAll(re)].map((m) => m[1]);
    assert.equal(found.length, 1, `${key}: ${found.length} lines`);
    return found[0];
}

// Method name -> {in, out} for each `<method>` of the exported interface.
function introspectedMethods() {
    const iface = EXTENSION_JS.match(
        /<interface name="[^"]+">([\s\S]*?)<\/interface>/);
    assert.ok(iface, 'interface XML in extension.js');
    const methods = new Map();
    const re = /<method name="(\w+)"\s*\/?>([\s\S]*?)(?=<method |$)/g;
    for (const [, name, body] of iface[1].matchAll(re)) {
        const args = (dir) => [...body.matchAll(
            new RegExp(`<arg type="([^"]+)" direction="${dir}"`, 'g'))]
            .map((m) => m[1]).join('');
        methods.set(name, {in: args('in'), out: args('out')});
    }
    return methods;
}

// Record -> Map(key -> type word) from the records table of item 6.
function contractRecords() {
    const records = new Map();
    const re = /^\s*\| `([^`]+)` \| `(\w+)` \| (text|integer|number)\b/gm;
    for (const [, record, key, type] of CONTRACT.matchAll(re)) {
        if (!records.has(record))
            records.set(record, new Map());
        records.get(record).set(key, type);
    }
    return records;
}

// The keys of the first object literal that follows `anchor` in `src`,
// one key per line: `{\n pid,\n url: x,\n}` gives ['pid', 'url']. The
// literal ends at its matching brace, past the `${}` of its templates.
function literalKeys(src, anchor) {
    const at = src.indexOf(anchor);
    assert.ok(at >= 0, anchor);
    const start = src.indexOf('{', at);
    let depth = 0;
    let end = start;
    do {
        if (src[end] === '{')
            depth++;
        else if (src[end] === '}')
            depth--;
        end++;
    } while (depth > 0 && end < src.length);
    const body = src.slice(start + 1, end - 1);
    return [...body.matchAll(/^\s*(\w+)\s*[:,]/gm)].map((m) => m[1]);
}

// Rows of the D-Bus table: [method, in, out].
function contractMethods() {
    const rows = [...section('What ERPLibre relies on').matchAll(
        /^\s*\| `(\w+)` \|\s*`?([a-z]*)`?\s*\| `([a-z]+)` \|$/gm)];
    return rows.map((m) => [m[1], m[2], m[3]]);
}

test('the contract states one MAJOR.MINOR version, listed in Versioning', () => {
    const found = [...CONTRACT.matchAll(
        /^\*\*Contract version: (\d+\.\d+)\*\*$/gm)].map((m) => m[1]);
    assert.equal(found.length, 1);
    assert.ok(section('Versioning').includes(`- **${found[0]}:**`));
});

test('metadata.json carries the identity the contract states', () => {
    for (const key of ['uuid', 'gettext-domain', 'settings-schema'])
        assert.equal(METADATA[key], listedValue(key), key);
    assert.ok(Array.isArray(METADATA['shell-version']));
    assert.ok(METADATA['shell-version'].length > 0);
    for (const major of METADATA['shell-version'])
        assert.match(major, /^\d+$/);
});

test('the one schema file has the id and path the contract states', () => {
    const schemaId = listedValue('settings-schema');
    const files = readdirSync(new URL('schemas/', ROOT))
        .filter((f) => f.endsWith('.gschema.xml'));
    assert.deepEqual(files, [`${schemaId}.gschema.xml`]);
    assert.ok(CONTRACT.includes(`\`${files[0]}\``));
    const xml = text(`schemas/${files[0]}`);
    const schemas = [...xml.matchAll(/<schema\b[^>]*>/g)].map((m) => m[0]);
    assert.equal(schemas.length, 1);
    assert.ok(schemas[0].includes(`id="${schemaId}"`));
    const path = schemas[0].match(/path="([^"]+)"/)[1];
    assert.ok(CONTRACT.includes(`\`${path}\``), path);
    const domain = listedValue('gettext-domain');
    assert.ok(CONTRACT.includes(`LC_MESSAGES/${domain}.mo`));
    assert.ok(statSync(new URL(`po/${domain}.pot`, ROOT)).isFile());
});

test('the tools the contract names exist, the run ones executable', () => {
    const run = ['tools/migrate_legacy.py', 'tools/enable_next_login.py',
        'hooks/install_claude_hooks.py', 'po/compile_locales.py',
        'dev_nested.sh', 'test/e2e_nested.sh'];
    for (const rel of run) {
        assert.ok(CONTRACT.includes(`\`${rel}`), rel);
        const mode = statSync(new URL(rel, ROOT)).mode;
        assert.ok(mode & 0o100, `${rel} executable`);
        if (rel.endsWith('.py'))
            assert.ok(text(rel).startsWith('#!/usr/bin/env python3\n'), rel);
    }
    const strv = text('tools/gsettings_strv.py');
    assert.ok(CONTRACT.includes('`tools/gsettings_strv.py`'));
    for (const name of ['parse_strv', 'format_strv'])
        assert.match(strv, new RegExp(`^def ${name}\\(`, 'm'), name);
});

test('extension.js exports the object and interface the contract states', () => {
    const exported = [...EXTENSION_JS.matchAll(
        /\.export\(\s*[^,]+,\s*'([^']+)'\)/g)].map((m) => m[1]);
    assert.equal(exported.length, 1);
    assert.ok(FLAT.includes(`object \`${exported[0]}\``));
    const iface = EXTENSION_JS.match(/<interface name="([^"]+)">/)[1];
    assert.ok(FLAT.includes(`interface \`${iface}\``));
});

test('each D-Bus method of the contract has its arguments', () => {
    const rows = contractMethods();
    assert.ok(rows.length >= 20, `${rows.length} rows`);
    const methods = introspectedMethods();
    for (const [name, argsIn, argsOut] of rows) {
        assert.ok(methods.has(name), name);
        assert.deepEqual(methods.get(name), {in: argsIn, out: argsOut}, name);
    }
});

test('hot reload copies carry the prefix the contract states', () => {
    const prefix = EXTENSION_JS.match(
        /const RELOAD_UUID_PREFIX = '([^']+)'/)[1];
    const uuidHost = METADATA.uuid.split('@')[1];
    assert.ok(CONTRACT.includes(`\`${prefix}*@${uuidHost}\``));
});

test('the deck lock path is the one the contract states', () => {
    assert.equal(deckLockPath('/run/user/1'),
        '/run/user/1/erplibre-home/deck.lock');
    assert.ok(CONTRACT.includes('`$XDG_RUNTIME_DIR/erplibre-home/deck.lock`'));
});

test('the ERPLibre paths the extension uses are those the contract states', () => {
    assert.equal(projectRootFrom(
        '/opt/x/script/gnome-extension/erplibre_home', () => null), '/opt/x');
    assert.ok(CONTRACT.includes('`/script/gnome-extension/erplibre_home`'));
    for (const rel of [STREAMDECK_PYTHON_REL, CONTROLLER_REL, DECK_ENTRY_REL,
        DECK_UNIT, GALLERY_SERVER_REL, GALLERY_ACTION_HEADER])
        assert.ok(CONTRACT.includes(`\`${rel}`), rel);
});

test('the device indicator reads the pid file the contract states', () => {
    const found = [...text('indicators/device.js').matchAll(
        /^const PIDFILE = `\$\{GLib\.get_user_cache_dir\(\)\}\/([^`]+)`;$/gm)]
        .map((m) => m[1]);
    assert.equal(found.length, 1, 'one PIDFILE under the cache directory');
    assert.ok(CONTRACT.includes(`\`$XDG_CACHE_HOME/${found[0]}\``),
        found[0]);
});

test('the test commands the contract states are those npm test runs', () => {
    const commands = ['node --test test/unit/*.test.js',
        'python3 -m unittest discover -s test/python'];
    // npm test starts test/run_suites.py, which runs its COMMAND: the
    // node suite, then the Python suite.
    const pkg = JSON.parse(text('package.json'));
    assert.equal(pkg.scripts.test, 'python3 test/run_suites.py');
    const runner = text('test/run_suites.py');
    for (const command of commands) {
        assert.ok(FLAT.includes(`\`${command}\``), command);
        assert.ok(runner.includes(`"${command}"`), command);
    }
    assert.ok(runner.includes(
        'COMMAND = f"{NODE_COMMAND} && {PYTHON_COMMAND}"'));
    assert.ok(readdirSync(new URL('test/python/', ROOT))
        .some((f) => /^test_\w+\.py$/.test(f)));
});

test('the records table covers the three shared files', () => {
    const records = contractRecords();
    assert.deepEqual([...records.keys()].sort(),
        ['claude/*.json', 'mpv/*.json', 'todo_terminals.json']);
});

test('the Claude hook writes every key of the claude record, typed', () => {
    const state = mkdtempSync(join(tmpdir(), 'contract-hook-'));
    try {
        // Stop asks nothing of D-Bus; the dead bus address keeps any
        // other path of the hook off the session bus all the same.
        const done = spawnSync('python3',
            [fileURLToPath(new URL('hooks/erplibre-home-hook.py', ROOT))], {
                input: JSON.stringify({hook_event_name: 'Stop',
                    session_id: 'contract-test', cwd: '/x'}),
                env: {...process.env, XDG_STATE_HOME: state,
                    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent'},
                encoding: 'utf8',
                timeout: 20000,
            });
        assert.equal(done.status, 0, done.stderr);
        const record = JSON.parse(readFileSync(
            join(state, 'erplibre-home/claude/contract-test.json'), 'utf8'));
        assert.equal(record.session_id, 'contract-test');
        for (const [key, type] of contractRecords().get('claude/*.json')) {
            assert.ok(key in record, key);
            if (type === 'text')
                assert.equal(typeof record[key], 'string', key);
            else
                assert.ok(Number.isInteger(record[key]), key);
        }
        assert.ok(record.ts_stop > 0);
    } finally {
        rmSync(state, {recursive: true, force: true});
    }
});

test('the film indicator writes every key of the mpv record', () => {
    const keys = literalKeys(text('indicators/media.js'), 'const entry = {');
    for (const key of contractRecords().get('mpv/*.json').keys())
        assert.ok(keys.includes(key), key);
});

test('the TODO indicator adds entries with the keys of the record', () => {
    const keys = literalKeys(text('indicators/erplibre.js'), 'entries.push(');
    assert.deepEqual(keys.sort(),
        [...contractRecords().get('todo_terminals.json').keys()].sort());
});

test('the journal lines the contract states are those extension.js writes', () => {
    assert.ok(EXTENSION_JS.includes("console.log('[ERPLibreHome] enabled');"));
    assert.ok(EXTENSION_JS.includes(
        'console.log(`[ERPLibreHome] mount ${id} failed: ${e.message}`);'));
    assert.ok(FLAT.includes('`[ERPLibreHome] enabled`'));
    assert.ok(FLAT.includes('`[ERPLibreHome] mount <id> failed: <reason>`'));
});

test('the controller menu reaches the gallery the contract states', () => {
    const src = text('indicators/controller.js');
    const port = src.match(/^const GALLERY_PORT = (\d+);$/m)[1];
    assert.match(src, /^const GALLERY_URL = `http:\/\/localhost:\$\{GALLERY_PORT\}`;$/m);
    assert.ok(FLAT.includes(`\`http://localhost:${port}\``), port);
    assert.ok(src.includes(
        "get_request_headers().append(GALLERY_ACTION_HEADER, '1')"));
    assert.ok(FLAT.includes(`\`${GALLERY_ACTION_HEADER}: 1\``));
});

// The Odoo inventory: the extension's side of the wire protocol that the
// Odoo module erplibre_streamdeck serves. The constants are read from
// lib/inventory.js; the GJS modules (keyring, state file) are read as text,
// since importing them needs the fakes of gjs-fake.js.

test('the contract is at 1.4 since Odoo lays out the home keys', () => {
    assert.ok(CONTRACT.includes('**Contract version: 1.4**'));
    for (const v of ['1\\.4', '1\\.3', '1\\.2']) {
        assert.match(section('Versioning'),
            new RegExp(`^- \\*\\*${v}:\\*\\* `, 'm'));
    }
    const service = text('lib/inventory-service.js');
    assert.ok(service.includes("export const CONTRACT_VERSION = '1.4';"));
});

test('the extension relies on the Odoo routes of the inventory section', () => {
    const relies = section('What the extension relies on').replace(/\s+/g, ' ');
    assert.ok(relies.includes('`erplibre_streamdeck`'));
    for (const route of [ENROLL_PATH, REPORT_PATH, UNENROLL_PATH])
        assert.ok(relies.includes(`\`${route}\``), route);
    assert.ok(relies.includes('[Odoo inventory](#odoo-inventory)'));
    // What the reports read of the Stream Deck level.
    assert.ok(relies.includes('`$XDG_CONFIG_HOME/erplibre-home/streamdeck.conf`'));
    assert.ok(relies.includes('`DECK_PROGRAM=`'));
    assert.ok(relies.includes('`systemctl --user show`'));
});

test('the inventory section states the protocol, routes, codes and bounds',
    () => {
        const inv = section('Odoo inventory').replace(/\s+/g, ' ');
        assert.ok(inv.includes(`\`"protocol": "${INVENTORY_PROTOCOL}"\``));
        for (const route of [ENROLL_PATH, REPORT_PATH, UNENROLL_PATH])
            assert.ok(inv.includes(`\`POST ${route}\``), route);
        for (const code of ERROR_CODES)
            assert.ok(inv.includes(`\`${code}\``), code);
        for (const method of ENROLL_METHODS)
            assert.ok(inv.includes(`\`${method}\``), method);
        assert.ok(inv.includes(`every ${HEARTBEAT_S} s`));
        assert.ok(inv.includes(`after ${TIMEOUT_S} s`));
        assert.ok(inv.includes(`${QUEUE_MAX} events or ${QUEUE_MAX_AGE_DAYS} days`));
        assert.ok(inv.includes('`GET <url>/web/login?db=<db>`'));
        assert.ok(inv.includes('`Authorization: Bearer <token>`'));
    });

test('the inventory section names every key of the state and the events',
    () => {
        const inv = section('Odoo inventory');
        const state = buildState({serviceState: 'active',
            decks: [{usb_path: '1-2'}]});
        const [event] = diffDecks([], [{serial: 'SN-INVENTED'}], 'now',
            () => 'u1');
        for (const key of [...Object.keys(state), ...Object.keys(state.os),
            ...Object.keys(state.decks[0]), ...Object.keys(event),
            'events', 'lost_events', 'accepted', 'heartbeat_s',
            'workstation_id', 'token', 'fingerprint', 'hostname', 'error'])
            assert.ok(inv.includes(`\`${key}\``), key);
    });

test('the inventory section states where the workstation keeps its part',
    () => {
        const inv = section('Odoo inventory').replace(/\s+/g, ' ');
        const secret = text('lib/secret-store.js');
        const schema = secret.match(/^export const SECRET_SCHEMA = '([^']+)';$/m)[1];
        assert.ok(inv.includes(`\`${schema}\``), schema);
        for (const attribute of ['destination', 'url', 'db'])
            assert.ok(inv.includes(`\`${attribute}\``), attribute);
        const service = text('lib/inventory-service.js');
        assert.ok(service.includes(
            '/erplibre-home/inventory/${destId}.json`;'));
        assert.ok(inv.includes(
            '`$XDG_STATE_HOME/erplibre-home/inventory/<id>.json`'));
        assert.ok(service.includes(
            '/erplibre-home/inventory-seen.json`;'));
        assert.ok(inv.includes(
            '`$XDG_STATE_HOME/erplibre-home/inventory-seen.json`'));
        assert.ok(inv.includes('compares the decks and the deck service '
            + 'with those it last saw, and reports a difference as events '
            + 'dated at that start'));
        assert.ok(inv.includes('A destination whose token leaves the '
            + 'keyring queues nothing more; still without one '
            + `${POLL_S} s later, it drops the events it held, which never `
            + 'reach a later enrollment'));
        assert.ok(inv.includes('`inventory-destinations`'));
        assert.ok(text('schemas/org.gnome.shell.extensions.erplibre-home'
            + '.gschema.xml').includes('<key name="inventory-destinations"'));
    });

// The "- `start`…" item of section `title`, white space folded: the
// statements below are checked where they belong, not anywhere in the
// section, since several routes share a code or a key.
function item(title, start) {
    const found = section(title).split(/\n(?=- |\n)/)
        .filter((b) => b.startsWith(`- ${start}`));
    assert.equal(found.length, 1, `item ${start}: ${found.length}`);
    return found[0].replace(/\s+/g, ' ');
}

// What Odoo's routes do with each name, as the wire contract fixes it: a
// changed sentence here is a protocol change, made on both sides at once.
const WIRE_FACTS = [
    [`\`POST ${ENROLL_PATH}\``, [
        'body `protocol`, `method`, `fingerprint`, `hostname`',
        '`code` for `pairing_code`', '`key` for `api_key`',
        '`login` and `password` for `password`',
        'Reply 200: `workstation_id`, `token`',
        '400 `bad_request` or `protocol_unsupported`',
        '401 `credentials_refused` (wrong, expired or used)',
        '403 `user_inactive`',
        'The same user and fingerprint enrolling again keep their '
            + 'workstation, whose token is replaced']],
    [`\`POST ${REPORT_PATH}\``, [
        'header `Authorization: Bearer <token>`',
        'body `protocol`, `state`, `events`, `lost_events`',
        'Reply 200: `accepted`, the uuids of the events stored or already '
            + 'known, and `heartbeat_s`',
        '401 `token_invalid` (unknown or revoked token)',
        '403 `user_inactive`', '400 `bad_request` or `protocol_unsupported`']],
    [`\`POST ${UNENROLL_PATH}\``, [
        'the same header, body `protocol`',
        'reply 200 once the token is revoked']],
    ['`state`', ['`usb_product_id` (4 lowercase hex digits)',
        'A deck of the workstation that `decks` does not list becomes '
            + 'disconnected',
        'Every text holds at most 256 characters, counted by code point, '
            + 'and no NUL character',
        'A deck with neither a `serial` nor a `usb_path` cannot be named '
            + 'and is left out of `decks` and of the events']],
    ['`events`', ['`at` (ISO 8601 in UTC, when the extension saw it)',
        'Odoo keeps one event per uuid']],
    ['`lost_events`', ['the running total of events the destination\'s '
        + 'queue dropped unsent', 'Odoo keeps the largest total it received']],
    ['`fingerprint`', ['the HMAC-SHA256, keyed by `<uid>|<url>|<db>` (the '
        + 'URL without its trailing slashes), of the stripped content of '
        + '`/etc/machine-id`, in 64 lowercase hex characters']],
    ['`token`', ['base64url of 32 random bytes, 43 characters; Odoo keeps '
        + 'only its SHA-256']],
];

test('the inventory section states what the wire contract fixes, where it '
    + 'applies', () => {
    for (const [start, facts] of WIRE_FACTS) {
        const text = item('Odoo inventory', start);
        for (const fact of facts)
            assert.ok(text.includes(fact), `${start}: ${fact}`);
    }
    const inv = section('Odoo inventory').replace(/\s+/g, ' ');
    assert.ok(inv.includes('Odoo answers an unknown MAJOR with 400 '
        + '`protocol_unsupported`, accepts a newer MINOR and ignores the '
        + 'keys it does not know'));
});

test('the fingerprint and the token are what the inventory section says',
    () => {
        const text = item('Odoo inventory', '`fingerprint`');
        const template = text.match(/keyed by `([^`]+)`/)[1];
        const key = template.replace('<uid>', '1000')
            .replace('<url>', 'https://odoo.example.invalid')
            .replace('<db>', 'base');
        const hmac = (k, m) => createHmac('sha256', k).update(m)
            .digest('hex');
        assert.equal(workstationFingerprint({machineId: ' 0123abcd\n',
            uid: 1000, url: 'https://odoo.example.invalid//', db: 'base'},
        hmac), hmac(key, '0123abcd'));
        assert.equal(Buffer.alloc(32).toString('base64url').length, 43);
    });

// The Odoo configuration (contract 1.3, protocol 1.1): the closed list of
// settings, the shapes of `config` both ways and the first-pilot rule.

// Rows of the configuration table: [wire key, conf line, values, restart].
function configRows() {
    return [...section('Odoo inventory').matchAll(
        /^\| `(\w+)` \| `([A-Z_]+)` \| (.+) \| (yes|no) \|$/gm)]
        .map((m) => [m[1], m[2], m[3], m[4]]);
}

test('the configuration table is the closed list of deck-config.js', () => {
    const rows = configRows();
    assert.deepEqual(rows.map((r) => r[0]), Object.keys(CONFIG_KEYS));
    for (const [key, line, values, restart] of rows) {
        assert.equal(CONFIG_KEYS[key].line, line, key);
        assert.equal(CONFIG_KEYS[key].restart, restart === 'yes', key);
        const listed = [...values.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
        if (key === 'deck_program')
            assert.deepEqual(listed, DECK_PROGRAMS);
        else if (key === 'games')
            assert.deepEqual(listed, GAMES_VALUES);
        else if (key === 'plugins_off')
            assert.equal(values, `a list of at most ${PLUGINS_OFF_MAX} ids `
                + `\`${PLUGIN_ID_RE.source.slice(1, -1)}\`, written joined `
                + 'by `,`');
        else
            assert.equal(values, `a number from ${SESSION_REFRESH_RANGE[0]} `
                + `to ${SESSION_REFRESH_RANGE[1]}`);
    }
    const inv = section('Odoo inventory').replace(/\s+/g, ' ');
    assert.ok(inv.includes('and nothing else: no path, no environment '
        + 'variable, no command, no plugin to turn on'));
});

test('the contract states the config shapes of the body and the reply', () => {
    const body = item('Odoo inventory', '`config`');
    assert.ok(body.includes('`{"pilot": false}` from a destination that is '
        + 'not the pilot'));
    const pilot = configBody({pilot: true, revisionApplied: 1,
        current: {}, result: {revision: 1, status: 'applied', at: 'x'},
        choice: CHOICES[0]});
    for (const key of Object.keys(pilot))
        assert.ok(body.includes(`"${key}": `), key);
    for (const key of Object.keys(pilot.result))
        assert.ok(body.includes(`"${key}": `), `result.${key}`);
    assert.ok(body.includes('"choice": "keep_local", "take_odoo" or null'));
    assert.ok(body.includes('`choice` is the employee\'s answer to an '
        + '`ask`, sent once, in the report that follows it'));
    assert.ok(body.includes('a key the file lacks, or a value outside the '
        + 'table, as null'));
    assert.ok(body.includes('A pilot that cannot read `streamdeck.conf`, '
        + 'though it exists, sends no `config` in that report'));
    const reply = item('Odoo inventory', 'Reply `config`');
    const valid = validateConfig({revision: 1, hash: 'a'.repeat(64),
        settings: {games: 'on'}, locked: [], ask: []});
    for (const key of Object.keys(valid).filter((k) => k !== 'ok'))
        assert.ok(reply.includes(`"${key}": `), key);
    assert.ok(reply.includes('`ask`, omitted when empty'));
    assert.ok(reply.includes('A key of `locked` outside `settings`, or of '
        + '`ask` outside `settings` or in `locked`, refuses the revision '
        + 'with `invalid:<key>`'));
    assert.ok(reply.includes('A `config` of another shape is ignored, as '
        + 'if absent: nothing is announced, written or reported'));
    const route = item('Odoo inventory', `\`POST ${REPORT_PATH}\``);
    assert.ok(route.includes('body `protocol`, `state`, `events`, '
        + '`lost_events`, `config`'));
    assert.ok(route.includes('`config` for the pilot of a workstation'));
    const state = item('Odoo inventory', '`state`');
    assert.ok(state.includes(`\`deck_plugins\`, the ids of the deck plugins `
        + `found on disk, sorted, at most ${DECK_PLUGINS_MAX} of the pattern `
        + `\`${PLUGIN_ID_RE.source.slice(1, -1)}\``));
});

test('the contract states the first-pilot rule and the apply rules', () => {
    const first = item('Odoo inventory', 'First pilot');
    for (const fact of ['Odoo lists in `ask` the free keys whose local '
        + 'value is not null and differs from its own, unless the '
        + 'organisation forces the choice',
    'the extension asks the employee to keep their settings or use '
        + 'Odoo\'s, and sends the answer as `choice`',
    '« Keep my settings » writes nothing',
    'The revision answered that way comes back without `ask` when Odoo '
        + 'adopted nothing, and is then announced again for what it still '
        + 'offers',
    'Locked keys are offered for the usual confirmation in every case'])
        assert.ok(first.includes(fact), fact);
    const click = item('Odoo inventory', 'Nothing is applied');
    assert.ok(click.includes('without the employee\'s click'));
    assert.ok(click.includes('`inventory-apply-request`, '
        + '`"<destination id>:<revision>"` to apply, or '
        + '`"<destination id>:<revision>:keep_local"`'));
    const apply = item('Odoo inventory', 'Applying');
    for (const fact of ['one outside the table refuses the whole revision '
        + 'with `invalid:<key>`, and nothing is written',
    'rewritten in one atomic replacement',
    'every other line stays byte for byte',
    '`games` alone restarts nothing',
    'reported `applied` without a notification nor a restart'])
        assert.ok(apply.includes(fact), fact);
    const reasons = item('Odoo inventory', '`result.reason`');
    for (const reason of ['invalid:<key>', ...REFUSAL_REASONS])
        assert.ok(reasons.includes(`\`${reason}\``), reason);
    assert.ok(reasons.includes('at most 256 characters'));
    assert.ok(reasons.includes('`invalid:<key>`, `<key>` a wire key of the '
        + 'table,'));
    assert.ok(reasons.includes('and nothing else'));
    const inv = section('Odoo inventory').replace(/\s+/g, ' ');
    assert.ok(inv.includes('the GSettings key `inventory-pilot` holds, none '
        + 'by default'));
});

test('ERPLibre finds the pilot file and the shared fixtures the contract '
    + 'states', () => {
    const relies = section('What ERPLibre relies on').replace(/\s+/g, ' ');
    assert.ok(relies.includes('`$XDG_STATE_HOME/erplibre-home/pilot.json`, '
        + 'mode 0600'));
    assert.ok(relies.includes('`{"destination": <label>, "revision": '
        + '<integer>, "locked": [<wire key>]}`'));
    assert.ok(relies.includes('A missing file, or one that does not parse, '
        + 'means that no Odoo pilots the workstation'));
    assert.ok(relies.includes('`test/fixtures/streamdeck_conf/`'));
    for (const part of ['`<name>.in.conf`', '`<name>.json`', '`settings`',
        '`lines`', '`current`', '`<name>.out.conf`'])
        assert.ok(relies.includes(part), part);
    const dir = new URL('test/fixtures/streamdeck_conf/', ROOT);
    const names = readdirSync(dir);
    const cases = names.filter((f) => f.endsWith('.in.conf'));
    assert.ok(cases.length > 0);
    for (const f of cases) {
        const name = f.slice(0, -'.in.conf'.length);
        assert.ok(names.includes(`${name}.out.conf`), name);
        assert.deepEqual(Object.keys(JSON.parse(text(
            `test/fixtures/streamdeck_conf/${name}.json`))),
        ['settings', 'lines', 'current'], name);
    }
    const reads = section('What the extension relies on')
        .replace(/\s+/g, ' ');
    for (const key of Object.values(CONFIG_KEYS))
        assert.ok(reads.includes(`\`${key.line}=\``), key.line);
    assert.ok(reads.includes('`systemctl --user restart`'));
    assert.ok(reads.includes('`$XDG_CONFIG_HOME/erplibre-home/deck-plugins/`'));
});

// The key layouts (contract 1.4, protocol 1.2): keymap.json, the catalog
// the deck program prints, and their place on the wire.

test('the contract states keymap.json as deck-config.js writes it', () => {
    const relies = section('What ERPLibre relies on').replace(/\s+/g, ' ');
    const id = PLUGIN_ID_RE.source.slice(1, -1);
    for (const fact of ['`~/.config/erplibre-home/keymap.json`',
        'mode 0644, written by the extension only, in one atomic '
            + 'replacement',
        `\`{"format": ${KEYMAP_FORMAT}, "revision": <integer>, "layouts": `
            + '{<model>: {"keys": [<entry>]}}}`',
        `4 lowercase hex digits, ${KEYMAP_MODELS_MAX} models at most`,
        '`{"key": <integer>, "action": <action>, "icon": <icon>, '
            + '"label": <text>}`',
        '`icon` and `label` optional and never null, and no other key',
        'at most as many entries as the model has keys',
        `\`plugin:<id>\` (the home key of that plugin, \`<id>\` of the `
            + `pattern \`${id}\`)`,
        '`tiles` (a key of the dashboard) or `empty` (a black key)',
        'each `plugin:<id>` once in a layout',
        `at most ${LABEL_MAX} characters, counted by code point, none of `
            + 'the Unicode categories Cc or Cs',
        '`test/fixtures/keymap/<name>.json`'])
        assert.ok(relies.includes(fact), fact);
    // What the extension writes is the shape stated.
    const layouts = {'0084': {keys: [{key: 0, action: 'tiles'}]}};
    assert.deepEqual(Object.keys(JSON.parse(keymapText(3, layouts))),
        ['format', 'revision', 'layouts']);
    const dir = new URL('test/fixtures/keymap/', ROOT);
    const names = readdirSync(dir);
    assert.ok(names.length > 0);
    for (const f of names) {
        const fx = JSON.parse(text(`test/fixtures/keymap/${f}`));
        assert.deepEqual(Object.keys(fx), ['catalog', 'plugins_off',
            'layouts', 'valid'], f);
        for (const part of ['`catalog`', '`plugins_off`', '`layouts`',
            '`valid`'])
            assert.ok(relies.includes(part), part);
        assert.equal(validateKeyLayouts(fx.layouts, fx.catalog,
            fx.plugins_off).ok, fx.valid, f);
    }
});

test('the contract states the catalog the deck program prints', () => {
    const reads = section('What the extension relies on')
        .replace(/\s+/g, ' ');
    for (const fact of [
        '`.venv.streamdeck/bin/python script/stream_deck/erplibre_streamdeck '
            + '--catalog`',
        'prints the catalog of the deck program as JSON and exits 0, '
            + 'without opening a deck nor taking the deck lock',
        `\`{"format": ${KEYMAP_FORMAT}, "actions": [<action>], "icons": `
            + '[<icon>], "models": {<model>: {"cols": <integer>, "rows": '
            + '<integer>, "keys": <integer>}}}`',
        `icon names of the pattern \`${ICON_RE.source.slice(1, -1)}\``,
        'at its start and when the checkout\'s commit changes',
        `abandons it after ${TIMEOUT_S} s`])
        assert.ok(reads.includes(fact), fact);
    const service = text('lib/inventory-service.js');
    assert.ok(service.includes("'script/stream_deck/erplibre_streamdeck'"));
    assert.ok(service.includes("'--catalog'"));
});

test('the inventory section states the key layouts on the wire', () => {
    const state = item('Odoo inventory', '`state`');
    assert.ok(state.includes('`deck_catalog`, the catalog the deck program '
        + `printed, left out when there is none or past ${CATALOG_MAX / 1024}`
        + ' KiB of JSON'));
    const body = item('Odoo inventory', '`config`');
    for (const fact of ['`current.key_layouts` holds, for each model of '
        + '`keymap.json` (16 at most, in order), the sha256 of its layout',
    '`json.dumps(layout, sort_keys=True, separators=(",", ":"))`',
    'null for a layout that is not an object or that nests lists and '
        + `objects more than ${LAYOUT_DEPTH_MAX} levels deep`,
    'null without a `keymap.json` of format 1'])
        assert.ok(body.includes(fact), fact);
    assert.match(section('Odoo inventory'),
        /^\| `key_layouts` \| `keymap\.json`.+ \| yes \|$/m);
    const reply = item('Odoo inventory', 'Reply `config`');
    assert.ok(reply.includes('`settings.key_layouts`'));
    const layouts = item('Odoo inventory', 'Key layouts');
    for (const fact of ['refuses the revision with `invalid:key_layouts`',
        'no catalog read refuses every layout',
        '`streamdeck.conf` is put back as it was',
        'restarts the unit once',
        'when it comes and again at the click',
        'unless the revision is applied already, or answered by keeping '
            + 'the local values and still asked: it writes nothing'])
        assert.ok(layouts.includes(fact), fact);
});
