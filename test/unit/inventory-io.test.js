// The GJS halves of the inventory that talk to the system: the USB watch
// (lib/usb-watch.js), the Odoo client (lib/odoo-http.js) and the keyring
// (lib/secret-store.js), run on the fakes of gjs-fake.js.
import {test, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fake, settle, answer, udevDevice} from './gjs-fake.js';

const usb = await import('../../lib/usb-watch.js');
const http = await import('../../lib/odoo-http.js');
const secrets = await import('../../lib/secret-store.js');
const {TIMEOUT_S, POLL_S} = await import('../../lib/inventory.js');

beforeEach(() => fake.reset());

/** Runs a fake GLib source as the main loop would; drops a one-shot. */
function fire(t) {
    assert.equal(t.removed, false, 'the source is still attached');
    if (!t.fn()) t.removed = true;
}

function live() {
    return fake.timeouts.filter(t => !t.removed);
}

// ------------------------------------------------------------ usb-watch

test('usbMinor is the minor of the USB device node, as the kernel sets it',
    () => {
        assert.equal(usb.usbMinor('001', '001'), 0);
        assert.equal(usb.usbMinor('2', '5'), 132);
        assert.equal(usb.usbMinor('003', '010'), 265);
        for (const [b, d] of [['0', '1'], ['1', '0'], ['x', '1'], ['1', ''],
            [null, '1'], ['1', '129']])
            assert.equal(usb.usbMinor(b, d), null, `${b}:${d}`);
    });

test('usbPathFromLink keeps the port path of a device link, nothing else',
    () => {
        assert.equal(usb.usbPathFromLink(
            '../../devices/pci0000:00/0000:00:0d.0/usb2/2-1'), '2-1');
        assert.equal(usb.usbPathFromLink(
            '../../devices/pci0000:00/0000:00:14.0/usb1/1-2/1-2.3'), '1-2.3');
        for (const t of ['../../devices/pci0000:00/0000:00:0d.0/usb2',
            '../../devices/x/1-2:1.0', '', null, '1-2/'])
            assert.equal(usb.usbPathFromLink(t), null, String(t));
    });

test('deckRecord gives the wire fields and those the menu shows', () => {
    const d = usb.deckRecord({usbPath: '1-2.3', productId: '0084',
        serial: ' SN-INVENTED-1\n', product: 'Stream Deck +',
        manufacturer: 'Elgato', bus: '1', device: '7'});
    assert.deepEqual(d, {serial: 'SN-INVENTED-1', usb_product_id: '0084',
        usb_path: '1-2.3', firmware: null, product: 'Stream Deck +',
        vendor_id: '0fd9', product_id: '0084', vendor_name: 'Elgato',
        bus: '001', device: '007'});
    const bare = usb.deckRecord({usbPath: 'nope', productId: '006D',
        serial: '', bus: '', device: null});
    assert.equal(bare.serial, null);
    assert.equal(bare.usb_path, null);
    assert.equal(bare.usb_product_id, '006d');
    assert.equal(bare.bus, '');
    assert.equal(bare.vendor_name, 'Elgato');
});

const ELGATO = (name, product, serial) => udevDevice(name, {
    idVendor: '0fd9', idProduct: product, serial, product: 'Stream Deck',
    manufacturer: 'Elgato', busnum: name.split('-')[0], devnum: '9'});

test('with GUdev, the watch lists Elgato devices and rescans on uevents',
    async () => {
        fake.udevDevices = [
            ELGATO('1-2', '0084', 'SN-INVENTED-1'),
            udevDevice('1-3', {idVendor: '046d', idProduct: 'c52b'}),
            udevDevice('1-2:1.0', {idVendor: '0fd9'}, 'usb_interface'),
            ELGATO('3-1.4', '006d', null),
        ];
        const seen = [];
        const w = new usb.UsbWatch({onChange: d => seen.push(d)});
        w.start();
        await settle();
        assert.equal(fake.udevClients.length, 1);
        assert.deepEqual(fake.udevClients[0].props.subsystems,
            ['usb/usb_device']);
        assert.equal(seen.length, 1);
        assert.deepEqual(seen[0].map(d => [d.serial, d.usb_path,
            d.usb_product_id]),
        [['SN-INVENTED-1', '1-2', '0084'], [null, '3-1.4', '006d']]);
        assert.deepEqual(w.decks(), seen[0]);
        // No poll with GUdev: the uevents drive the scans.
        assert.equal(live().length, 0);
        assert.equal(fake.spawned.length, 0);

        // A removal: one settle timer for a burst of uevents.
        fake.udevDevices = fake.udevDevices.slice(0, 3);
        fake.udevEmit('unbind', fake.udevDevices[0]);
        fake.udevEmit('remove', fake.udevDevices[0]);
        assert.equal(live().length, 1);
        fire(live()[0]);
        await settle();
        assert.equal(seen.length, 2);
        assert.deepEqual(seen[1].map(d => d.usb_path), ['1-2']);

        // A scan that finds the same decks says nothing.
        fake.udevEmit('change', fake.udevDevices[0]);
        fire(live()[0]);
        await settle();
        assert.equal(seen.length, 2);

        w.stop();
        assert.equal(fake.udevClients[0].handlers.length, 0);
        assert.equal(live().length, 0);
    });

test('the GUdev watch asks lsusb for a serial sysfs does not give', async () => {
    fake.udevDevices = [udevDevice('1-2', {idVendor: '0fd9',
        idProduct: '0084', busnum: '1', devnum: '9'})];
    fake.programs = ['lsusb'];
    fake.onSpawn = argv => (argv[0] === 'lsusb' ? {stdout:
        'Bus 001 Device 009: ID 0fd9:0084 Elgato Systems GmbH Stream Deck +\n' +
        '  iSerial                 3 SN-FROM-LSUSB\n'} : {});
    const seen = [];
    new usb.UsbWatch({onChange: d => seen.push(d)}).start();
    await settle();
    assert.deepEqual(fake.spawned.map(s => s.argv),
        [['lsusb', '-s', '001:009', '-v']]);
    assert.equal(seen[0][0].serial, 'SN-FROM-LSUSB');
});

/** A fake sysfs: /dev/char/189:<minor> links to devices/…/<path>. */
function sysfs(devs) {
    const root = path.join(fake.root, 'sys');
    fs.mkdirSync(path.join(root, 'dev/char'), {recursive: true});
    for (const {minor, usbPath, serial} of devs) {
        const dir = path.join(root, 'devices/pci0000:00/usb1', usbPath);
        fs.mkdirSync(dir, {recursive: true});
        if (serial !== undefined)
            fs.writeFileSync(path.join(dir, 'serial'), `${serial}\n`);
        fs.symlinkSync(`../../devices/pci0000:00/usb1/${usbPath}`,
            path.join(root, `dev/char/189:${minor}`));
    }
    return root;
}

const LSUSB_TWO =
    'Bus 001 Device 002: ID 0fd9:0084 Elgato Systems GmbH Stream Deck +\n' +
    '  iProduct                2 Stream Deck +\n' +
    '  iSerial                 3 SN-LSUSB-A\n' +
    'Bus 001 Device 003: ID 0fd9:006d Elgato Systems GmbH Stream Deck\n' +
    '  iSerial                 3 SN-LSUSB-B\n';

test('without GUdev, the watch polls lsusb asynchronously every POLL_S',
    async () => {
        fake.udevMissing = true;
        fake.programs = ['lsusb'];
        let out = LSUSB_TWO;
        fake.onSpawn = () => ({stdout: out});
        const sysfsRoot = sysfs([
            {minor: 1, usbPath: '1-2', serial: 'SN-SYSFS-A'},
            {minor: 2, usbPath: '1-4.1'},
        ]);
        const seen = [];
        const w = new usb.UsbWatch({onChange: d => seen.push(d), sysfsRoot});
        w.start();
        await settle();
        assert.deepEqual(fake.spawned.map(s => s.argv),
            [['lsusb', '-d', '0fd9:', '-v']]);
        // sysfs serial first, lsusb's when sysfs has none.
        assert.deepEqual(seen[0].map(d => [d.serial, d.usb_path]),
            [['SN-SYSFS-A', '1-2'], ['SN-LSUSB-B', '1-4.1']]);
        const poll = live();
        assert.equal(poll.length, 1);
        assert.equal(poll[0].ms, POLL_S * 1000);

        out = LSUSB_TWO.split('\n').slice(0, 3).join('\n');
        fire(poll[0]);
        await settle();
        assert.equal(seen.length, 2);
        assert.deepEqual(seen[1].map(d => d.usb_path), ['1-2']);
        assert.ok(!fake.spawned.some(s => s.argv[0] === '__sync__'));
        w.stop();
        assert.equal(live().length, 0);
    });

test('without GUdev nor lsusb, the watch reports no deck once', async () => {
    fake.udevMissing = true;
    const seen = [];
    new usb.UsbWatch({onChange: d => seen.push(d)}).start();
    await settle();
    assert.deepEqual(seen, [[]]);
    assert.equal(live().length, 0);
});

test('a scan that fails still gives a first, empty list', async () => {
    const seen = [];
    const w = new usb.UsbWatch({onChange: d => seen.push(d)});
    w._udevClient = async () => ({
        query_by_subsystem() { throw new Error('sysfs gone'); },
        connect: () => 1, disconnect() {}});
    const said = [];
    const log = console.log;
    console.log = (...a) => said.push(a.join(' '));
    try {
        w.start();
        await settle();
    } finally {
        console.log = log;
    }
    assert.deepEqual(seen, [[]]);
    assert.ok(said.some(l => l.includes('sysfs gone')));
    w.stop();
});

test('rescan scans again at once, and a stopped watch says nothing',
    async () => {
        fake.udevDevices = [ELGATO('1-2', '0084', 'SN-INVENTED-1')];
        const seen = [];
        const w = new usb.UsbWatch({onChange: d => seen.push(d)});
        w.start();
        await settle();
        const queries = fake.udevClients[0].queries;
        w.rescan();
        await settle();
        assert.equal(fake.udevClients[0].queries, queries + 1);
        fake.udevDevices = [];
        w.stop();
        w.rescan();
        await settle();
        assert.equal(seen.length, 1);
    });

// ------------------------------------------------------------ odoo-http

const URL_ = 'https://odoo.example.invalid/';

test('newSession bounds every call by TIMEOUT_S and keeps cookies', () => {
    const s = http.newSession();
    assert.equal(s.props.timeout, TIMEOUT_S);
    assert.equal(s.props.idle_timeout, TIMEOUT_S);
    assert.equal(s.features.length, 1);
    assert.equal(s.features[0].constructor.name, 'CookieJar');
});

test('postJson selects the database, then posts the JSON body', async () => {
    const session = http.newSession();
    const cancellable = {};
    const p = http.postJson(session, URL_, 'base x&y', '/streamdeck/v1/report',
        {protocol: '1.0', n: 1}, 'TOKEN-INVENTED', {cancellable});
    await settle();
    assert.equal(fake.http.length, 1);
    const [login] = fake.http;
    assert.equal(login.method, 'GET');
    assert.equal(login.uri,
        'https://odoo.example.invalid/web/login?db=base%20x%26y');
    assert.equal(login.flags, 2, 'no redirect followed');
    assert.equal(login.cancellable, cancellable);
    assert.equal(login.headers.Authorization, undefined);
    answer(login, {status: 303});
    await settle();
    const post = fake.http[1];
    assert.equal(post.method, 'POST');
    assert.equal(post.uri,
        'https://odoo.example.invalid/streamdeck/v1/report');
    assert.equal(post.flags, 2, 'no redirect followed');
    assert.equal(post.session, session);
    assert.equal(post.cancellable, cancellable);
    assert.equal(post.contentType, 'application/json');
    assert.equal(post.body, '{"protocol":"1.0","n":1}');
    assert.equal(post.headers.Authorization, 'Bearer TOKEN-INVENTED');
    assert.equal(post.headers.Accept, 'application/json');
    answer(post, {status: 200, body: '{"accepted":["u1"]}'});
    assert.deepEqual(await p, {status: 200, json: {accepted: ['u1']}});
});

test('postJson without a token sends no Authorization header', async () => {
    const p = http.postJson(http.newSession(), URL_, 'b', '/streamdeck/v1/enroll',
        {}, null);
    await settle();
    answer(fake.http[0]);
    await settle();
    assert.equal(fake.http[1].headers.Authorization, undefined);
    answer(fake.http[1], {status: 401, body: '{"error":"credentials_refused"}'});
    assert.deepEqual(await p,
        {status: 401, json: {error: 'credentials_refused'}});
});

test('postJson gives status 0 when either call fails, json null when not JSON',
    async () => {
        let p = http.postJson(http.newSession(), URL_, 'b', '/x', {}, 'T');
        await settle();
        answer(fake.http[0], {error: 'Connection refused'});
        assert.deepEqual(await p, {status: 0, json: null});
        assert.equal(fake.http.length, 1, 'no POST after a failed GET');

        p = http.postJson(http.newSession(), URL_, 'b', '/x', {}, 'T');
        await settle();
        answer(fake.http[1]);
        await settle();
        answer(fake.http[2], {error: 'timed out'});
        assert.deepEqual(await p, {status: 0, json: null});

        p = http.postJson(http.newSession(), URL_, 'b', '/x', {}, 'T');
        await settle();
        answer(fake.http[3]);
        await settle();
        answer(fake.http[4], {status: 502, body: '<html>Bad gateway</html>'});
        assert.deepEqual(await p, {status: 502, json: null});
    });

test('postJson never writes to the console', async () => {
    const said = [];
    const saved = {};
    for (const k of ['log', 'warn', 'error', 'info', 'debug']) {
        saved[k] = console[k];
        console[k] = (...a) => said.push(a);
    }
    try {
        const p = http.postJson(http.newSession(), URL_, 'b', '/x',
            {password: 'PW-INVENTED'}, 'TOKEN-INVENTED');
        await settle();
        answer(fake.http[0]);
        await settle();
        answer(fake.http[1], {error: 'boom TOKEN-INVENTED'});
        await p;
    } finally {
        Object.assign(console, saved);
    }
    assert.deepEqual(said, []);
});

// --------------------------------------------------------- secret-store

const AT_ONE = {url: 'https://odoo.example.invalid', db: 'base1'};
const AT_TWO = {url: 'https://other.example.invalid', db: 'other'};

test('tokens live in the keyring under the inventory schema', async () => {
    assert.equal(await secrets.lookupToken('d1', AT_ONE), null);
    await secrets.storeToken('d1', 'ERPLibre Home inventory: Odoo', 'TOK-1',
        AT_ONE);
    assert.equal(await secrets.lookupToken('d1', AT_ONE), 'TOK-1');
    assert.equal(await secrets.lookupToken('d2', AT_ONE), null);
    const [item] = [...fake.secrets.values()];
    assert.equal(item.schema, 'ca.technolibre.erplibre-home.inventory');
    assert.equal(secrets.SECRET_SCHEMA, item.schema);
    assert.deepEqual(item.attrs, {destination: 'd1',
        url: 'https://odoo.example.invalid', db: 'base1'});
    assert.equal(item.label, 'ERPLibre Home inventory: Odoo');
    assert.equal(item.collection, 'default');
    await secrets.storeToken('d1', 'ERPLibre Home inventory: Odoo', 'TOK-2',
        AT_ONE);
    assert.equal(fake.secrets.size, 1, 'a new token replaces the old one');
    assert.equal(await secrets.lookupToken('d1', AT_ONE), 'TOK-2');
    await secrets.clearToken('d1');
    assert.equal(await secrets.lookupToken('d1', AT_ONE), null);
    // An empty password is no token.
    await secrets.storeToken('d3', 'l', '', AT_ONE);
    assert.equal(await secrets.lookupToken('d3', AT_ONE), null);
});

test('a token is found only for the URL and database it was issued for',
    async () => {
        await secrets.storeToken('d1', 'l', 'TOK-1', AT_ONE);
        assert.equal(await secrets.lookupToken('d1', AT_TWO), null);
        assert.equal(await secrets.lookupToken('d1',
            {...AT_ONE, db: 'other'}), null);
        assert.equal(await secrets.lookupToken('d1',
            {...AT_ONE, url: 'https://other.example.invalid'}), null);
        // The fingerprint ignores a trailing slash; so does the binding.
        assert.equal(await secrets.lookupToken('d1',
            {...AT_ONE, url: 'https://odoo.example.invalid/'}), 'TOK-1');
        // A destination keeps one token: enrolling it elsewhere drops the
        // token of its former Odoo, and clearing it drops every one.
        await secrets.storeToken('d1', 'l', 'TOK-2', AT_TWO);
        assert.equal(fake.secrets.size, 1);
        assert.equal(await secrets.lookupToken('d1', AT_ONE), null);
        assert.equal(await secrets.lookupToken('d1', AT_TWO), 'TOK-2');
        await secrets.clearToken('d1');
        assert.equal(fake.secrets.size, 0);
    });

test('a token is never looked up or stored without its URL and database',
    async () => {
        await secrets.storeToken('d1', 'l', 'TOK-1', AT_ONE);
        await assert.rejects(secrets.lookupToken('d1'), TypeError);
        await assert.rejects(secrets.lookupToken('d1', {url: AT_ONE.url}),
            TypeError);
        await assert.rejects(secrets.storeToken('d1', 'l', 'TOK-2'),
            TypeError);
        for (const id of [undefined, null, ''])
            await assert.rejects(secrets.clearToken(id), TypeError);
        assert.equal(await secrets.lookupToken('d1', AT_ONE), 'TOK-1');
    });

test('a keyring error rejects instead of answering "no token"', async () => {
    fake.secretError = 'collection is locked';
    await assert.rejects(secrets.lookupToken('d1', AT_ONE), /locked/);
    await assert.rejects(secrets.storeToken('d1', 'l', 't', AT_ONE),
        /locked/);
    await assert.rejects(secrets.clearToken('d1'), /locked/);
});
