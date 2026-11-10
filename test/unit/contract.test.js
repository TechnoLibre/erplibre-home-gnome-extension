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
    const pkg = JSON.parse(text('package.json'));
    for (const command of commands) {
        assert.ok(FLAT.includes(`\`${command}\``), command);
        assert.ok(pkg.scripts.test.includes(command), command);
    }
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
