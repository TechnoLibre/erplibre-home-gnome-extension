// The preferences' half of the inventory: lib/inventory-prefs.js (the
// destinations, the enrollment, the status read from the state file) on
// the fakes of gjs-fake.js, then the page prefs.js builds from it, on
// recording Adw and Gtk widgets this file installs.
import {test, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fake, settle, answer, makeSettings} from './gjs-fake.js';

// ------------------------------------------- recording Adw and Gtk widgets

// Every widget built, in order. A widget keeps its constructor props, its
// children, its signal handlers, and the state the page changes.
let made = [];

function widgetClass(kind) {
    return class {
        constructor(props = {}) {
            this.kind = kind;
            this.props = {...props};
            this.children = [];
            this.handlers = [];
            this.strings = [];
            this.text = props.text ?? '';
            this.visible = props.visible ?? true;
            this.sensitive = props.sensitive ?? true;
            this.selected = props.selected ?? 0;
            this.model = props.model ?? null;
            made.push(this);
        }
        add(c) { this.children.push(c); }
        add_row(c) { this.children.push(c); }
        add_suffix(c) { this.children.push(c); }
        add_prefix(c) { this.children.push(c); }
        remove(c) { this.children = this.children.filter(x => x !== c); }
        append(s) { this.strings.push(s); }
        get_string(i) { return this.strings[i] ?? null; }
        get_n_items() { return this.strings.length; }
        connect(signal, cb) {
            this.handlers.push({signal, cb});
            return this.handlers.length;
        }
        disconnect(id) { this.handlers[id - 1] = {signal: null, cb: null}; }
        emit(signal, ...args) {
            for (const h of [...this.handlers])
                if (h.signal === signal) h.cb(this, ...args);
        }
        get_text() { return this.text; }
        set_text(t) { this.text = t; }
        set_visible(v) { this.visible = v; }
        set_sensitive(v) { this.sensitive = v; }
        set_title(t) { this.props.title = t; }
        set_subtitle(t) { this.props.subtitle = t; }
        set_label(t) { this.props.label = t; }
        set_description(t) { this.props.description = t; }
        get_selected() { return this.selected; }
        set_selected(i) {
            this.selected = i;
            this.emit('notify::selected');
        }
        set_model(m) { this.model = m; }
        set_activatable_widget() {}
        add_css_class() {}
    };
}

function widgetModule(prefix) {
    return new Proxy({}, {
        get: (t, k) => (typeof k === 'string'
            ? (t[k] ??= widgetClass(`${prefix}.${k}`)) : undefined),
    });
}

globalThis.__gjsFake.gi.Adw = widgetModule('Adw');
globalThis.__gjsFake.gi.Gtk = widgetModule('Gtk');

const inv = await import('../../lib/inventory-prefs.js');
const {ENROLL_PATH, UNENROLL_PATH, ERROR_CODES, POLL_S} =
    await import('../../lib/inventory.js');
const {default: Prefs} = await import('../../prefs.js');
const {setGettext} = await import('../../lib/i18n.js');

const URL_ = 'https://odoo.example.invalid';
const TOKEN = 'TOKEN-INVENTED-0123456789abcdefghijklmnopqr';
const MACHINE_ID = '0123456789abcdef0123456789abcdef';

let settings;

beforeEach(() => {
    fake.reset();
    settings = makeSettings();
    fake.settings = settings;
    made = [];
    setGettext(null);
});

function machineIdFile(text = `${MACHINE_ID}\n`) {
    const p = path.join(fake.root, 'machine-id');
    fs.writeFileSync(p, text);
    return p;
}

function model(deps = {}) {
    return new inv.InventoryPrefs({settings,
        deps: {machineIdPaths: [machineIdFile()], ...deps}});
}

function setDestinations(list) {
    settings.set_string('inventory-destinations', JSON.stringify(list));
}

function dest(over = {}) {
    return {id: 'd1', label: 'Head office', url: URL_, db: 'base',
        source: 'remote', instanceId: null, ...over};
}

function stored() {
    return JSON.parse(settings.get_string('inventory-destinations'));
}

function stateFile(id) {
    return path.join(fake.env.XDG_STATE_HOME, 'erplibre-home', 'inventory',
        `${id}.json`);
}

function writeState(id, destination, status) {
    fs.mkdirSync(path.dirname(stateFile(id)), {recursive: true});
    fs.writeFileSync(stateFile(id), JSON.stringify({destination,
        queue: {events: [], lost: 0}, status}));
}

/** Answers the GET /web/login of the next call, then its POST. */
async function reply(status, json) {
    await settle();
    const login = fake.http.at(-1);
    assert.equal(login.method, 'GET');
    answer(login, {status: 303});
    await settle();
    const post = fake.http.at(-1);
    assert.equal(post.method, 'POST');
    answer(post, {status, body: json === undefined ? ''
        : JSON.stringify(json)});
    await settle();
    return post;
}

function keyring() {
    return [...fake.secrets.values()];
}

// ------------------------------------------------------------ destinations

test('a destination added by URL is stored normalised, with an id of its own',
    () => {
        const m = model();
        const r = m.add({url: ' HTTPS://Odoo.Example.Invalid/ ', db: 'base',
            label: 'Head office'});
        assert.equal(r.ok, true);
        assert.equal(r.reason, null);
        const [d] = stored();
        assert.deepEqual({...d, id: 'x'}, {id: 'x', label: 'Head office',
            url: URL_, db: 'base', source: 'remote', instanceId: null});
        assert.match(d.id, /^[A-Za-z0-9_-]{1,64}$/);
        assert.deepEqual(r.dest, d);
        assert.equal(m.add({url: URL_, db: 'other'}).ok, true);
        const ids = stored().map(x => x.id);
        assert.equal(new Set(ids).size, 2, 'each destination has its own id');
    });

test('a refused destination says why and changes nothing', () => {
    const m = model();
    for (const [form, reason] of [
        [{url: 'http://192.0.2.1:8069', db: 'base'}, 'plain_http'],
        [{url: 'http://localhost.example.invalid', db: 'base'},
            'plain_http'],
        [{url: 'https://u:pw-invented@odoo.example.invalid', db: 'base'},
            'credentials'],
        [{url: URL_, db: 'x y'}, 'db'],
    ]) {
        const r = m.add(form);
        assert.deepEqual([r.ok, r.reason, r.dest], [false, reason, null],
            form.url);
    }
    assert.equal(settings.get_string('inventory-destinations'), '[]');
    m.add({url: URL_, db: 'base'});
    assert.equal(m.add({url: `${URL_}/`, db: 'base'}).reason, 'duplicate');
    assert.equal(stored().length, 1);
});

test('a destination added from an instance takes its URL and name', () => {
    settings.set_string('instances', JSON.stringify([
        {id: 'i1', name: 'Local test', url: 'http://localhost:8069/'},
        {id: 'i2', name: 'Lab', url: 'http://192.0.2.7:8069'},
        {id: 'i3', name: 'No URL'},
    ]));
    const m = model();
    assert.deepEqual(m.instances(), [
        {id: 'i1', name: 'Local test', url: 'http://localhost:8069/'},
        {id: 'i2', name: 'Lab', url: 'http://192.0.2.7:8069'},
    ]);
    const r = m.add({instanceId: 'i1', db: 'base', url: 'https://ignored'});
    assert.equal(r.ok, true);
    assert.deepEqual({...stored()[0], id: 'x'}, {id: 'x', label: 'Local test',
        url: 'http://localhost:8069', db: 'base', source: 'local',
        instanceId: 'i1'});
    assert.equal(m.add({instanceId: 'i2', db: 'base'}).reason, 'plain_http');
    assert.equal(m.add({instanceId: 'gone', db: 'base'}).reason, 'unknown');
});

// ------------------------------------------------------------- enrollment

test('enrolling sends the fingerprint and stores the token in the keyring',
    async () => {
        setDestinations([dest()]);
        fake.uid = 1234;
        const m = model();
        const p = m.enroll('d1', {method: 'pairing_code', code: 'abcd-efgh'});
        const post = await reply(200, {protocol: '1.0', workstation_id: 7,
            token: TOKEN});
        assert.deepEqual(await p, {ok: true, error: null, workstationId: 7});
        assert.equal(fake.http[0].uri, `${URL_}/web/login?db=base`);
        assert.equal(post.uri, `${URL_}${ENROLL_PATH}`);
        assert.equal(post.headers.Authorization, undefined);
        const fingerprint = createHmac('sha256', `1234|${URL_}|base`)
            .update(MACHINE_ID).digest('hex');
        assert.deepEqual(JSON.parse(post.body), {protocol: '1.0',
            method: 'pairing_code', fingerprint, hostname: 'deckhost',
            code: 'ABCDEFGH'});
        const [item] = keyring();
        assert.equal(item.password, TOKEN);
        assert.deepEqual(item.attrs, {destination: 'd1', url: URL_,
            db: 'base'});
        assert.match(item.label, /Head office/);
        assert.doesNotMatch(settings.get_string('inventory-destinations'),
            /TOKEN-INVENTED/);
    });

test('the API key and the password methods send their own secret', async () => {
    setDestinations([dest()]);
    const m = model();
    let p = m.enroll('d1', {method: 'api_key', key: 'KEY-INVENTED',
        code: 'ABCDEFGH'});
    let post = await reply(200, {workstation_id: 7, token: TOKEN});
    assert.equal((await p).ok, true);
    assert.deepEqual(Object.keys(JSON.parse(post.body)).sort(),
        ['fingerprint', 'hostname', 'key', 'method', 'protocol']);
    p = m.enroll('d1', {method: 'password', login: 'someone',
        password: 'PW-INVENTED'});
    post = await reply(200, {workstation_id: 7, token: `${TOKEN}2`});
    assert.equal((await p).ok, true);
    assert.equal(JSON.parse(post.body).password, 'PW-INVENTED');
    assert.equal(keyring().length, 1, 'the second token replaced the first');
    assert.equal(keyring()[0].password, `${TOKEN}2`);
});

test('a refused URL, a bad form or no machine-id sends nothing', async () => {
    setDestinations([dest({id: 'p', url: 'http://192.0.2.1'}), dest()]);
    let m = model();
    assert.deepEqual(await m.enroll('p', {method: 'api_key', key: 'k'}),
        {ok: false, error: 'plain_http', workstationId: null});
    assert.equal((await m.enroll('d1', {method: 'pairing_code',
        code: 'ABC'})).error, 'code_format');
    assert.equal((await m.enroll('d1', {method: 'api_key', key: ''}))
        .error, 'missing');
    assert.equal((await m.enroll('nope', {method: 'api_key', key: 'k'}))
        .error, 'unknown');
    m = new inv.InventoryPrefs({settings, deps: {machineIdPaths:
        [path.join(fake.root, 'absent')]}});
    assert.equal((await m.enroll('d1', {method: 'api_key', key: 'k'}))
        .error, 'machine_id');
    m = new inv.InventoryPrefs({settings, deps: {machineIdPaths:
        [machineIdFile('  \n')]}});
    assert.equal((await m.enroll('d1', {method: 'api_key', key: 'k'}))
        .error, 'machine_id');
    assert.deepEqual(fake.http, []);
    assert.equal(keyring().length, 0);
});

test('an absent or blank machine-id file gives way to the next one',
    async () => {
        setDestinations([dest()]);
        const blank = path.join(fake.root, 'blank-machine-id');
        fs.writeFileSync(blank, ' \n');
        const m = new inv.InventoryPrefs({settings, deps: {machineIdPaths:
            [path.join(fake.root, 'absent'), blank, machineIdFile()]}});
        const p = m.enroll('d1', {method: 'api_key', key: 'k'});
        const post = await reply(200, {workstation_id: 7, token: TOKEN});
        assert.equal((await p).ok, true);
        assert.equal(JSON.parse(post.body).fingerprint,
            createHmac('sha256', `1000|${URL_}|base`).update(MACHINE_ID)
                .digest('hex'));
        assert.deepEqual(inv.MACHINE_ID_PATHS,
            ['/etc/machine-id', '/var/lib/dbus/machine-id']);
    });

test('a refused enrollment keeps the token the destination already had',
    async () => {
        setDestinations([dest()]);
        fake.secrets.set('kept', {schema:
            'ca.technolibre.erplibre-home.inventory', attrs: {destination:
            'd1', url: URL_, db: 'base'}, password: 'OLD-TOKEN-INVENTED',
        label: 'l', collection: 'default'});
        const m = model();
        for (const [status, json, error] of [
            [401, {error: 'credentials_refused'}, 'credentials_refused'],
            [403, {error: 'user_inactive'}, 'user_inactive'],
            [400, {error: 'protocol_unsupported'}, 'protocol_unsupported'],
            [404, undefined, 'not_found'],
            [502, undefined, 'network'],
            [200, {workstation_id: 7}, 'bad_reply'],
        ]) {
            const p = m.enroll('d1', {method: 'api_key', key: 'k'});
            await reply(status, json);
            assert.deepEqual(await p, {ok: false, error, workstationId: null},
                String(status));
        }
        assert.deepEqual(keyring().map(i => i.password),
            ['OLD-TOKEN-INVENTED']);
    });

test('a keyring that fails is said, not taken for success', async () => {
    setDestinations([dest()]);
    const m = model();
    const p = m.enroll('d1', {method: 'api_key', key: 'k'});
    await settle();
    fake.secretError = 'collection is locked';
    await reply(200, {workstation_id: 7, token: TOKEN});
    assert.deepEqual(await p, {ok: false, error: 'keyring',
        workstationId: null});
});

test('an Odoo that never answers ends the enrollment at its deadline',
    async () => {
        setDestinations([dest()]);
        const m = model();
        const p = m.enroll('d1', {method: 'api_key', key: 'k'});
        await settle();
        const deadline = fake.timeouts.filter(t => !t.removed);
        assert.equal(deadline.length, 1);
        assert.equal(deadline[0].ms, inv.CALL_DEADLINE_S * 1000);
        const login = fake.http[0];
        deadline[0].fn();
        assert.equal(login.cancellable.is_cancelled(), true);
        answer(login, {error: 'Operation was cancelled'});
        assert.deepEqual(await p, {ok: false, error: 'network',
            workstationId: null});
        assert.equal(keyring().length, 0);
    });

test('the deadline is removed once Odoo answers', async () => {
    setDestinations([dest()]);
    const m = model();
    const p = m.enroll('d1', {method: 'api_key', key: 'k'});
    await reply(200, {workstation_id: 7, token: TOKEN});
    await p;
    assert.deepEqual(fake.timeouts.filter(t => !t.removed), []);
});

test('one call at a time per destination', async () => {
    setDestinations([dest(), dest({id: 'd2', db: 'other'})]);
    const m = model();
    const first = m.enroll('d1', {method: 'api_key', key: 'k'});
    await settle();
    assert.equal(m.busy('d1'), true);
    assert.equal((await m.enroll('d1', {method: 'api_key', key: 'k'}))
        .error, 'busy');
    assert.equal((await m.unenroll('d1')).error, 'busy');
    assert.equal(m.busy('d2'), false);
    await reply(200, {workstation_id: 7, token: TOKEN});
    await first;
    assert.equal(m.busy('d1'), false);
});

test('enrolling writes no secret to the console', async () => {
    setDestinations([dest()]);
    const said = [];
    const saved = {};
    for (const k of ['log', 'warn', 'error', 'info', 'debug']) {
        saved[k] = console[k];
        console[k] = (...a) => said.push(a);
    }
    try {
        const m = model();
        let p = m.enroll('d1', {method: 'password', login: 'someone',
            password: 'PW-INVENTED'});
        await reply(200, {workstation_id: 7, token: TOKEN});
        await p;
        fake.secretError = 'boom TOKEN-INVENTED';
        p = m.enroll('d1', {method: 'api_key', key: 'KEY-INVENTED'});
        await reply(200, {workstation_id: 7, token: TOKEN});
        assert.equal((await p).error, 'keyring');
    } finally {
        Object.assign(console, saved);
    }
    assert.doesNotMatch(JSON.stringify(said),
        /PW-INVENTED|KEY-INVENTED|TOKEN-INVENTED/);
});

// ------------------------------------------------------------ unenrollment

function seedToken(id = 'd1', token = TOKEN, url = URL_, db = 'base') {
    fake.secrets.set(`seed-${id}`, {schema:
        'ca.technolibre.erplibre-home.inventory', attrs: {destination: id,
        url, db}, password: token, label: 'l', collection: 'default'});
}

test('unenrolling revokes the token in Odoo, then forgets it', async () => {
    setDestinations([dest()]);
    seedToken();
    const m = model();
    const p = m.unenroll('d1');
    const post = await reply(200, {protocol: '1.0'});
    assert.deepEqual(await p, {ok: true, revoked: true, error: null});
    assert.equal(post.uri, `${URL_}${UNENROLL_PATH}`);
    assert.equal(post.headers.Authorization, `Bearer ${TOKEN}`);
    assert.deepEqual(JSON.parse(post.body), {protocol: '1.0'});
    assert.equal(keyring().length, 0);
});

test('the token is forgotten even when Odoo does not confirm', async () => {
    setDestinations([dest()]);
    const m = model();
    for (const [status, json, result] of [
        [401, {error: 'token_invalid'},
            {ok: true, revoked: true, error: null}],
        [502, undefined, {ok: true, revoked: false, error: 'network'}],
    ]) {
        seedToken();
        const p = m.unenroll('d1');
        await reply(status, json);
        assert.deepEqual(await p, result, String(status));
        assert.equal(keyring().length, 0);
    }
});

test('unenrolling with no token calls nobody', async () => {
    setDestinations([dest()]);
    seedToken('d1', TOKEN, URL_, 'another_db');
    const m = model();
    assert.deepEqual(await m.unenroll('d1'),
        {ok: true, revoked: false, error: null});
    assert.deepEqual(fake.http, []);
    assert.equal(keyring().length, 0, 'a token of a former Odoo goes too');
});

test('removing a destination unenrolls it and deletes its state file',
    async () => {
        setDestinations([dest(), dest({id: 'd2', db: 'other'})]);
        seedToken();
        writeState('d1', {url: URL_, db: 'base'}, {state: 'ok', pending: 0});
        writeState('d2', {url: URL_, db: 'other'}, {state: 'ok', pending: 0});
        const m = model();
        const p = m.remove('d1');
        await reply(200, {protocol: '1.0'});
        assert.deepEqual(await p, {ok: true, revoked: true, error: null,
            removed: true});
        assert.deepEqual(stored().map(d => d.id), ['d2']);
        assert.equal(fs.existsSync(stateFile('d1')), false);
        assert.equal(fs.existsSync(stateFile('d2')), true);
        assert.equal(keyring().length, 0);
        assert.deepEqual(await m.remove('d1'),
            {ok: false, revoked: false, error: 'unknown', removed: false});
    });

test('a destination is removed even when its keyring fails', async () => {
    setDestinations([dest()]);
    fake.secretError = 'collection is locked';
    const m = model();
    const r = await m.remove('d1');
    assert.deepEqual(r, {ok: false, revoked: false, error: 'keyring',
        removed: true}, 'not ok: a token may remain in the keyring');
    assert.deepEqual(stored(), []);
});

// ------------------------------------------------------------------ status

test('the status comes from the keyring and the state file', async () => {
    setDestinations([dest()]);
    const m = model();
    assert.deepEqual(await m.status('d1'), {state: 'unenrolled', pending: 0,
        lastReport: null, error: null, enrolled: false});
    seedToken();
    assert.deepEqual(await m.status('d1'), {state: 'waiting', pending: 0,
        lastReport: null, error: null, enrolled: true});
    writeState('d1', {url: URL_, db: 'base'}, {state: 'offline', pending: 4,
        lastReport: '2026-01-10T12:00:00.000Z', error: 'network'});
    assert.deepEqual(await m.status('d1'), {state: 'offline', pending: 4,
        lastReport: '2026-01-10T12:00:00.000Z', error: 'network',
        enrolled: true});
    writeState('d1', {url: URL_, db: 'other'}, {state: 'ok', pending: 0});
    assert.equal((await m.status('d1')).state, 'waiting',
        'the file of another database is not read');
});

test('a destination enrolled again waits for its next report', async () => {
    setDestinations([dest()]);
    writeState('d1', {url: URL_, db: 'base'}, {state: 'revoked', pending: 0,
        lastReport: '2026-01-10T12:00:00.000Z', error: 'token_invalid'});
    let now = Date.parse('2026-01-11T08:00:00.000Z');
    const m = model({now: () => now});
    const p = m.enroll('d1', {method: 'api_key', key: 'k'});
    await reply(200, {workstation_id: 7, token: TOKEN});
    await p;
    assert.equal((await m.status('d1')).state, 'waiting');
    now += 60000;
    writeState('d1', {url: URL_, db: 'base'}, {state: 'ok', pending: 0,
        lastReport: '2026-01-11T08:00:30.000Z', error: null});
    assert.equal((await m.status('d1')).state, 'ok');
});

test('a refused URL or a failing keyring shows in the status', async () => {
    setDestinations([dest({url: 'http://192.0.2.1'})]);
    const m = model();
    assert.deepEqual(await m.status('d1'), {state: 'refused', pending: 0,
        lastReport: null, error: 'plain_http', enrolled: false});
    setDestinations([dest()]);
    fake.secretError = 'locked';
    assert.deepEqual(await m.status('d1'), {state: 'offline', pending: 0,
        lastReport: null, error: 'keyring', enrolled: false});
    assert.equal(await m.status('gone'), null);
});

// ---------------------------------------------------------------- messages

const CODES = [...ERROR_CODES, 'invalid', 'scheme', 'credentials',
    'plain_http', 'db', 'duplicate', 'unknown', 'missing', 'code_format',
    'too_long', 'network', 'not_found', 'bad_reply', 'keyring', 'machine_id',
    'busy'];

test('every code the page can meet has its own sentence', () => {
    const seen = new Set();
    for (const code of CODES) {
        const text = inv.messageFor(code);
        assert.equal(typeof text, 'string');
        assert.ok(text.length > 10, code);
        assert.ok(!seen.has(text), `${code}: same sentence as another`);
        seen.add(text);
    }
    assert.match(inv.messageFor('no_such_code'), /no_such_code/);
});

test('each status reads as a title and a detail', () => {
    const at = '2026-01-10T12:00:00.000Z';
    const t = s => inv.statusText({pending: 0, lastReport: null, error: null,
        enrolled: true, ...s});
    assert.equal(t({state: 'unenrolled', enrolled: false}).title,
        'Not enrolled');
    assert.equal(t({state: 'waiting'}).title,
        'Enrolled, waiting for the first report');
    assert.equal(t({state: 'ok', lastReport: at}).title, 'Up to date');
    assert.match(t({state: 'ok', lastReport: at}).subtitle, /2026/);
    assert.equal(t({state: 'offline', pending: 3, error: 'network'}).title,
        'Offline (3 pending)');
    assert.equal(t({state: 'offline', error: 'network'}).subtitle,
        inv.messageFor('network'));
    assert.equal(t({state: 'revoked', error: 'token_invalid'}).title,
        'Enrollment revoked');
    assert.equal(t({state: 'refused', error: 'plain_http'}).subtitle,
        inv.messageFor('plain_http'));
});

// -------------------------------------------------------------- the page

function texts(w) {
    return [w.props.title, w.props.label, w.props.subtitle,
        w.props.description].filter(Boolean);
}

/** The widgets under `w`, depth first, `w` included. */
function tree(w) {
    return [w, ...w.children.flatMap(tree)];
}

function find(root, kind, text) {
    const found = tree(root).filter(w => w.kind === kind &&
        (text === undefined || texts(w).includes(text)));
    assert.equal(found.length, 1, `${kind} "${text}": ${found.length}`);
    return found[0];
}

/** The visible widgets of `root` that show a text containing `part`. */
function showing(root, part) {
    return tree(root).filter(w => w.visible &&
        texts(w).some(t => t.includes(part)));
}

function page(m = model()) {
    return new Prefs({uuid: 'erplibre-home@technolibre.ca'})
        ._buildInventoryPage(settings, m);
}

test('the page is titled Odoo inventory and lists the destinations', () => {
    setDestinations([dest(), dest({id: 'd2', label: 'Lab & test',
        db: 'other'})]);
    const p = page();
    assert.equal(p.kind, 'Adw.PreferencesPage');
    assert.equal(p.props.title, 'Odoo inventory');
    const rows = tree(p).filter(w => w.kind === 'Adw.ExpanderRow');
    assert.deepEqual(rows.map(r => r.props.title),
        ['Head office', 'Lab & test']);
    assert.deepEqual(rows.map(r => r.props.use_markup), [false, false],
        'a name with & shows as typed');
    assert.equal(rows[1].props.subtitle, `${URL_} · other`);
    setDestinations([dest()]);
    assert.equal(tree(p).filter(w => w.kind === 'Adw.ExpanderRow').length, 1,
        'the list follows the settings');
    setDestinations([dest(), dest({id: 'd2', label: 'Lab & test',
        db: 'other'})]);
    setDestinations([dest({id: 'd2', label: 'Lab & test', db: 'other'}),
        dest()]);
    assert.deepEqual(tree(p).filter(w => w.kind === 'Adw.ExpanderRow')
        .map(r => r.props.title), ['Lab & test', 'Head office'],
    'and its order');
});

test('an empty list says how to add a destination', () => {
    const p = page();
    const hint = 'No destination yet: add one below.';
    assert.equal(showing(p, hint).length, 1);
    setDestinations([dest()]);
    assert.equal(showing(p, hint).length, 0);
    setDestinations([]);
    assert.equal(showing(p, hint).length, 1);
});

test('prefs.js shows the inventory page after the device page', () => {
    const src = fs.readFileSync(new URL('../../prefs.js', import.meta.url),
        'utf8');
    assert.match(src, /window\.add\(this\._buildDevicePage\(settings\)\);\n\s*window\.add\(this\._buildInventoryPage\(settings\)\);/);
});

test('adding by URL from the page explains a refusal', () => {
    const p = page();
    const urlRow = find(p, 'Adw.EntryRow', 'URL (https://…)');
    const dbRow = find(p, 'Adw.EntryRow', 'Database');
    const add = find(p, 'Gtk.Button', 'Add');
    urlRow.set_text('http://192.0.2.1:8069');
    dbRow.set_text('base');
    add.emit('clicked');
    assert.deepEqual(stored(), []);
    assert.ok(tree(p).some(w => texts(w).includes(
        inv.messageFor('plain_http')) && w.visible));
    urlRow.set_text(URL_);
    add.emit('clicked');
    assert.equal(stored().length, 1);
    assert.equal(urlRow.get_text(), '');
    assert.equal(dbRow.get_text(), '');
});

test('adding from an instance fills the URL from it', () => {
    settings.set_string('instances', JSON.stringify([
        {id: 'i1', name: 'Local test', url: 'http://localhost:8069'}]));
    const p = page();
    const source = find(p, 'Adw.ComboRow', 'Odoo instance');
    assert.deepEqual(source.model.strings, ['Other, by URL', 'Local test']);
    source.set_selected(1);
    const urlRow = find(p, 'Adw.EntryRow', 'URL (https://…)');
    assert.equal(urlRow.get_text(), 'http://localhost:8069');
    assert.equal(urlRow.sensitive, false);
    find(p, 'Adw.EntryRow', 'Database').set_text('base');
    find(p, 'Gtk.Button', 'Add').emit('clicked');
    assert.deepEqual(stored().map(d => [d.source, d.instanceId, d.label]),
        [['local', 'i1', 'Local test']]);
});

test('the secrets are hidden entries, emptied once the call is over',
    async () => {
        setDestinations([dest()]);
        const p = page();
        const row = find(p, 'Adw.ExpanderRow', 'Head office');
        const method = find(row, 'Adw.ComboRow', 'Enrollment method');
        assert.deepEqual(method.model.strings,
            ['Pairing code', 'API key', 'Login and password']);
        const code = find(row, 'Adw.EntryRow', 'Pairing code');
        const key = find(row, 'Adw.PasswordEntryRow', 'API key');
        const login = find(row, 'Adw.EntryRow', 'Login');
        const password = find(row, 'Adw.PasswordEntryRow', 'Password');
        assert.deepEqual([code, key, login, password].map(w => w.visible),
            [true, false, false, false]);
        method.set_selected(2);
        assert.deepEqual([code, key, login, password].map(w => w.visible),
            [false, false, true, true]);
        login.set_text('someone');
        password.set_text('PW-INVENTED');
        key.set_text('KEY-INVENTED');
        code.set_text('ABCDEFGH');
        const enroll = find(row, 'Gtk.Button', 'Enroll');
        enroll.emit('clicked');
        await settle();
        assert.equal(enroll.sensitive, false, 'no second click meanwhile');
        const post = await reply(401, {error: 'credentials_refused'});
        assert.equal(JSON.parse(post.body).password, 'PW-INVENTED');
        await settle();
        assert.deepEqual([code.get_text(), key.get_text(),
            password.get_text()], ['', '', '']);
        assert.equal(login.get_text(), 'someone');
        assert.equal(enroll.sensitive, true);
        assert.ok(tree(row).some(w => texts(w).includes(
            inv.messageFor('credentials_refused'))));
    });

test('enrolling from the page shows the new status', async () => {
    setDestinations([dest()]);
    const p = page();
    const row = find(p, 'Adw.ExpanderRow', 'Head office');
    find(row, 'Adw.EntryRow', 'Pairing code').set_text('ABCDEFGH');
    find(row, 'Gtk.Button', 'Enroll').emit('clicked');
    await reply(200, {workstation_id: 7, token: TOKEN});
    await settle();
    assert.equal(keyring().length, 1);
    assert.ok(tree(row).some(w => texts(w).includes(
        'Enrolled, waiting for the first report')));
});

test('unenroll and remove are buttons of each destination', async () => {
    setDestinations([dest()]);
    seedToken();
    const p = page();
    const row = find(p, 'Adw.ExpanderRow', 'Head office');
    find(row, 'Gtk.Button', 'Unenroll').emit('clicked');
    await reply(200, {protocol: '1.0'});
    await settle();
    assert.equal(keyring().length, 0);
    const remove = find(row, 'Gtk.Button', 'Remove');
    remove.emit('clicked');
    await settle();
    assert.equal(stored().length, 1, 'the first click asks to confirm');
    assert.equal(remove.props.label, 'Confirm removal');
    remove.emit('clicked');
    await settle(40);
    assert.deepEqual(stored(), []);
});

test('a removal says on the page what became of the token, once its row '
    + 'is gone', async () => {
    setDestinations([dest(), dest({id: 'd2', label: 'Branch', db: 'other'})]);
    seedToken();
    const p = page();
    const row = find(p, 'Adw.ExpanderRow', 'Head office');
    const remove = find(row, 'Gtk.Button', 'Remove');
    remove.emit('clicked');
    remove.emit('clicked');
    await reply(502);
    await settle(40);
    assert.deepEqual(stored().map(d => d.id), ['d2']);
    assert.equal(keyring().length, 0);
    assert.deepEqual(tree(p).filter(w => w.kind === 'Adw.ExpanderRow')
        .map(r => r.props.title), ['Branch']);
    const said = showing(p, 'revoke this workstation in Odoo');
    assert.equal(said.length, 1, 'the page says Odoo did not confirm');
    assert.ok(texts(said[0]).includes('Head office'), 'and of which Odoo');
    assert.ok(texts(said[0]).some(t => t.includes(
        inv.messageFor('network'))));
});

test('a removal whose keyring fails says the token may remain', async () => {
    setDestinations([dest()]);
    fake.secretError = 'collection is locked';
    const p = page();
    const remove = find(p, 'Gtk.Button', 'Remove');
    remove.emit('clicked');
    remove.emit('clicked');
    await settle(40);
    assert.deepEqual(stored(), []);
    const said = showing(p, inv.messageFor('keyring'));
    assert.equal(said.length, 1);
    assert.ok(texts(said[0]).includes('Head office'));
    assert.ok(!texts(said[0]).some(t => t.includes('forgotten')),
        'a token the keyring kept is not said forgotten');
    assert.ok(texts(said[0]).some(t => t.includes('may remain')));
});

test('a removal Odoo confirmed but the keyring kept says only to delete '
    + 'the token', async () => {
    setDestinations([dest()]);
    seedToken();
    const p = page(model({clearToken: async () => {
        throw new Error('collection is locked');
    }}));
    const remove = find(p, 'Gtk.Button', 'Remove');
    remove.emit('clicked');
    remove.emit('clicked');
    await reply(200, {protocol: '1.0'});
    await settle(40);
    const [said] = showing(p, 'may remain');
    assert.ok(said, 'the token may remain in the keyring');
    assert.ok(!texts(said).some(t => t.includes('revoke it in Odoo')),
        'Odoo revoked it already');
});

test('a call in progress keeps its row and its result when the list '
    + 'changes', async () => {
    setDestinations([dest()]);
    const m = model();
    const p = page(m);
    const row = find(p, 'Adw.ExpanderRow', 'Head office');
    find(row, 'Adw.EntryRow', 'Pairing code').set_text('ABCDEFGH');
    find(row, 'Gtk.Button', 'Enroll').emit('clicked');
    await settle();
    assert.equal(m.add({url: 'https://branch.example.invalid', db: 'base',
        label: 'Branch'}).ok, true);
    const now = find(p, 'Adw.ExpanderRow', 'Head office');
    assert.equal(find(now, 'Gtk.Button', 'Enroll').sensitive, false,
        'the call is still running');
    p.emit('unmap');
    p.emit('map');
    await reply(401, {error: 'credentials_refused'});
    await settle();
    const after = find(p, 'Adw.ExpanderRow', 'Head office');
    assert.equal(find(after, 'Gtk.Button', 'Enroll').sensitive, true);
    assert.equal(showing(after, inv.messageFor('credentials_refused')).length,
        1, 'the result shows in the row of its destination');
    assert.deepEqual(tree(p).filter(w => w.kind === 'Adw.ExpanderRow')
        .map(r => r.props.title), ['Head office', 'Branch']);
});

test('once hidden the page holds no settings handler, shown it holds one '
    + 'of each', () => {
    const count = () => settings.handlers.length;
    const before = count();
    const p = page();
    p.emit('unmap');
    assert.equal(count(), before, 'unmap disconnects every handler');
    for (let i = 0; i < 3; i++) {
        p.emit('map');
        const signals = settings.handlers.slice(before).map(h => h.signal)
            .sort();
        assert.deepEqual(signals, ['changed::instances',
            'changed::inventory-destinations']);
        p.emit('unmap');
        assert.equal(count(), before);
    }
});

test('every row of the page shows its text as typed, without markup',
    async () => {
        setDestinations([dest({label: 'Lab & <test>'})]);
        settings.set_string('instances', JSON.stringify([
            {id: 'i1', name: 'Local & test', url: 'http://localhost:8069'}]));
        const p = page();
        const rowsNow = () => tree(p).filter(w => /^Adw\..*Row$/.test(w.kind));
        const rows = new Set(rowsNow());
        const remove = find(p, 'Gtk.Button', 'Remove');
        remove.emit('clicked');
        remove.emit('clicked');
        await settle(40);
        for (const w of rowsNow()) rows.add(w);
        assert.ok(rows.size > 12, `${rows.size} rows`);
        assert.ok(showing(p, 'Destination removed.').length, 'the notice');
        for (const w of rows) {
            assert.equal(w.props.use_markup, false,
                `${w.kind} "${texts(w).join(' / ')}"`);
        }
    });

test('the statuses refresh every POLL_S while the page is shown', async () => {
    setDestinations([dest()]);
    const p = page();
    assert.deepEqual(fake.timeouts.filter(t => !t.removed), []);
    p.emit('map');
    const timers = fake.timeouts.filter(t => !t.removed);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, POLL_S * 1000);
    await settle();
    const row = find(p, 'Adw.ExpanderRow', 'Head office');
    seedToken();
    assert.equal(timers[0].fn(), true);
    await settle();
    assert.ok(tree(row).some(w => texts(w).includes(
        'Enrolled, waiting for the first report')));
    p.emit('unmap');
    assert.deepEqual(fake.timeouts.filter(t => !t.removed), []);
    const before = settings.handlers.filter(h =>
        h.signal === 'changed::inventory-destinations').length;
    assert.equal(before, 0, 'no settings handler left once hidden');
});

// ------------------------------------------------------------ translations

/** msgid -> msgstr of a .po or .pot file, continuation lines joined. */
function catalog(rel) {
    const text = fs.readFileSync(new URL(`../../${rel}`, import.meta.url),
        'utf8');
    const out = new Map();
    const str = s => [...s.matchAll(/"((?:[^"\\]|\\.)*)"/g)]
        .map(m => JSON.parse(`"${m[1]}"`)).join('');
    const re = /^msgid ((?:"(?:[^"\\]|\\.)*"\s*\n?)+)msgstr ((?:"(?:[^"\\]|\\.)*"\s*\n?)+)/gm;
    for (const m of text.matchAll(re)) out.set(str(m[1]), str(m[2]));
    return out;
}

/** The `_('…')` strings of `src`, adjacent literals joined by `+`. */
function msgids(src) {
    const re = /\b_\(\s*((?:'(?:[^'\\]|\\.)*'\s*\+?\s*)+)\)/g;
    return [...src.matchAll(re)].map(m => [...m[1].matchAll(
        /'((?:[^'\\]|\\.)*)'/g)].map(x => x[1].replace(/\\'/g, '\''))
        .join(''));
}

test('every string of the inventory page has its French translation', () => {
    const lib = fs.readFileSync(new URL('../../lib/inventory-prefs.js',
        import.meta.url), 'utf8');
    const prefs = fs.readFileSync(new URL('../../prefs.js', import.meta.url),
        'utf8');
    const start = prefs.indexOf('    _buildInventoryPage(');
    assert.ok(start > 0);
    const end = prefs.indexOf('\n    _build', start + 10);
    const ids = new Set([...msgids(lib),
        ...msgids(prefs.slice(start, end > 0 ? end : undefined))]);
    assert.ok(ids.size > 30, `${ids.size} strings`);
    const fr = catalog('po/fr.po');
    const en = catalog('po/en.po');
    const pot = catalog('po/erplibre-home.pot');
    for (const id of ids) {
        assert.ok(fr.get(id), `fr: ${id}`);
        assert.equal(en.get(id), id, `en: ${id}`);
        assert.ok(pot.has(id), `pot: ${id}`);
    }
    assert.equal(fr.get('Odoo inventory'), 'Inventaire Odoo');
});
