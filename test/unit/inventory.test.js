import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {
    INVENTORY_PROTOCOL, HEARTBEAT_S, POLL_S, TIMEOUT_S, QUEUE_MAX,
    QUEUE_MAX_AGE_DAYS, urlAllowed, workstationFingerprint, parseOsRelease,
    buildState, deckKey, diffDecks, serviceChanged, EventQueue, reportBody,
    parseReply, parseDestinations, serializeDestinations,
} from '../../lib/inventory.js';

const hmac = (key, msg) =>
    createHmac('sha256', key).update(msg).digest('hex');

function counter(prefix = 'u') {
    let n = 0;
    return () => `${prefix}${++n}`;
}

function event(uuid, at = '2026-01-10T12:00:00.000Z', kind = 'plugged') {
    return {uuid, kind, at, serial: null, usb_product_id: '0084',
        usb_path: '1-2', service_state: null};
}

// --- constants and module shape ---

test('inventory constants follow the wire contract', () => {
    assert.equal(INVENTORY_PROTOCOL, '1.0');
    assert.equal(HEARTBEAT_S, 900);
    assert.equal(POLL_S, 10);
    assert.equal(TIMEOUT_S, 10);
    assert.equal(QUEUE_MAX, 1000);
    assert.equal(QUEUE_MAX_AGE_DAYS, 30);
});

test('inventory.js runs under GJS: no gi import, no WHATWG URL, no crypto',
    () => {
        const src = readFileSync(
            new URL('../../lib/inventory.js', import.meta.url), 'utf8');
        assert.doesNotMatch(src, /gi:\/\//);
        assert.doesNotMatch(src, /\bnew URL\b|\bURL\s*\(/);
        assert.doesNotMatch(src, /\bcrypto\.|randomUUID/);
        assert.doesNotMatch(src, /^\s*import\b|\bimport\s*\(/m);
    });

// --- urlAllowed ---

test('urlAllowed accepts HTTPS to any host', () => {
    for (const url of ['https://odoo.example.invalid',
        'https://odoo.example.invalid/',
        'HTTPS://Odoo.Example.Invalid:8443/odoo',
        'https://192.0.2.1', 'https://[2001:db8::1]:443/']) {
        assert.deepEqual(urlAllowed(url), {ok: true, reason: null}, url);
    }
});

test('urlAllowed accepts plain HTTP to loopback forms', () => {
    for (const url of ['http://127.0.0.1:8069', 'http://127.0.0.5',
        'http://127.255.255.254/', 'http://[::1]:8069', 'http://[::1]',
        'http://[0:0:0:0:0:0:0:1]/', 'http://localhost',
        'http://LOCALHOST:8069/', 'http://localhost.:8069']) {
        assert.deepEqual(urlAllowed(url), {ok: true, reason: null}, url);
    }
});

test('urlAllowed refuses plain HTTP off this machine', () => {
    for (const url of ['http://192.0.2.1', 'http://192.0.2.1:8069/',
        'http://localhost.example.invalid', 'http://127.0.0.1.example.invalid',
        'http://odoo.example.invalid', 'http://[2001:db8::1]',
        'http://[::2]', 'http://128.0.0.1', 'http://0.0.0.0',
        'http://127.1', 'http://127.0.0.256', 'http://0x7f.0.0.1',
        'http://0127.0.0.1', 'http://127.0.0.01',
        'http://[::ffff:192.0.2.1]']) {
        assert.deepEqual(urlAllowed(url), {ok: false, reason: 'plain_http'},
            url);
    }
});

test('urlAllowed refuses schemes other than HTTP and HTTPS', () => {
    for (const url of ['ftp://odoo.example.invalid', 'file:///srv/invented',
        'ws://localhost:8069', 'javascript:alert(1)']) {
        assert.equal(urlAllowed(url).ok, false, url);
        assert.equal(urlAllowed(url).reason, 'scheme', url);
    }
});

test('urlAllowed refuses credentials in the URL', () => {
    for (const url of ['https://user:pw@odoo.example.invalid',
        'http://127.0.0.1@192.0.2.1', 'http://user@localhost']) {
        assert.deepEqual(urlAllowed(url), {ok: false, reason: 'credentials'},
            url);
    }
});

test('urlAllowed refuses what is not an absolute URL', () => {
    for (const url of [undefined, null, 42, '', '   ', 'odoo.example.invalid',
        'https://', 'https:///path', 'https://exa mple.invalid',
        ' https://odoo.example.invalid', 'https://odoo.example.invalid\n',
        'https://odoo.example.invalid?db=x', 'https://odoo.example.invalid#x',
        'https://odoo.example.invalid:99999', 'https://odoo.example.invalid:x',
        'https://[::1', 'http://localhost\\.example.invalid',
        'https://odoo.example.invalid/a b',
        'https://odoo.example.invalid/a\\b',
        'https://odoo.example.invalid/\t',
        'http://[0:0:0:0::0:0:0:1]', 'http://[1:2:3:4:5::6:7:8:9]',
        'https://[1:2:3:4:5:6:7:8:9]', 'https://[1::2::3]']) {
        assert.deepEqual(urlAllowed(url), {ok: false, reason: 'invalid'},
            String(url));
    }
});

// --- workstationFingerprint ---

test('workstationFingerprint: HMAC of machine-id keyed by uid, url, db',
    () => {
        const fp = workstationFingerprint({
            machineId: '0123456789abcdef0123456789abcdef\n', uid: 1000,
            url: 'https://odoo.example.invalid/', db: 'lot1_demo',
        }, hmac);
        assert.equal(fp, '409245b72e28c8cc3e5405736e7f880159877eb6'
            + '3867ef332a6fba80d192051e');
    });

test('workstationFingerprint passes key and stripped message to hmac', () => {
    const calls = [];
    workstationFingerprint({machineId: '  abc  \n', uid: '1000',
        url: 'http://localhost:8069//', db: 'd'}, (k, m) => {
        calls.push([k, m]);
        return 'a'.repeat(64);
    });
    assert.deepEqual(calls, [['1000|http://localhost:8069|d', 'abc']]);
});

test('workstationFingerprint differs per destination and per uid', () => {
    const base = {machineId: 'abc', uid: 1000,
        url: 'https://odoo.example.invalid', db: 'a'};
    const fps = new Set([
        workstationFingerprint(base, hmac),
        workstationFingerprint({...base, db: 'b'}, hmac),
        workstationFingerprint({...base, uid: 1001}, hmac),
        workstationFingerprint({...base, url: 'https://other.example.invalid'},
            hmac),
    ]);
    assert.equal(fps.size, 4);
});

test('workstationFingerprint refuses an empty machine-id or a bad digest',
    () => {
        const args = {machineId: ' \n', uid: 1000,
            url: 'https://odoo.example.invalid', db: 'a'};
        assert.throws(() => workstationFingerprint(args, hmac));
        assert.throws(() => workstationFingerprint(
            {...args, machineId: 'abc', uid: -1}, hmac));
        assert.throws(() => workstationFingerprint(
            {...args, machineId: 'abc'}, () => 'ABC'));
        assert.throws(() => workstationFingerprint(
            {...args, machineId: 'abc'}, () => 'A'.repeat(64)));
    });

test('workstationFingerprint refuses an empty or missing url or db', () => {
    const args = {machineId: 'abc', uid: 1000,
        url: 'https://odoo.example.invalid', db: 'a'};
    for (const bad of [{url: ''}, {db: ''}, {url: undefined},
        {db: undefined}, {db: 7}]) {
        assert.throws(() => workstationFingerprint({...args, ...bad}, hmac),
            /url and db/, JSON.stringify(bad));
    }
});

// --- parseOsRelease ---

test('parseOsRelease reads NAME and VERSION_ID, quoted or not', () => {
    const text = [
        '# invented',
        'PRETTY_NAME="Invented Linux 13 (trixie)"',
        'NAME="Invented GNU/Linux"',
        'VERSION_ID="13"',
        'VERSION="13 (trixie)"',
        'ID=invented',
        '',
    ].join('\n');
    assert.deepEqual(parseOsRelease(text),
        {name: 'Invented GNU/Linux', version: '13'});
    assert.deepEqual(parseOsRelease("NAME='Single'\nVERSION_ID=24.04\n"),
        {name: 'Single', version: '24.04'});
    assert.deepEqual(parseOsRelease('NAME="Esc \\"q\\" \\\\ x"\n'),
        {name: 'Esc "q" \\ x', version: null});
});

test('parseOsRelease falls back to VERSION, then null', () => {
    assert.deepEqual(parseOsRelease('NAME=Rolling\nVERSION="n/a"\n'),
        {name: 'Rolling', version: 'n/a'});
    assert.deepEqual(parseOsRelease(''), {name: null, version: null});
    assert.deepEqual(parseOsRelease(null), {name: null, version: null});
    assert.deepEqual(parseOsRelease('garbage line\nNAME=\n'),
        {name: null, version: null});
});

// --- buildState ---

test('buildState produces the wire state', () => {
    const state = buildState({
        hostname: 'ws-invented', os: {name: 'Invented', version: '13'},
        gnomeShell: '48.2', extensionVersion: '1', contractVersion: '1.2',
        erplibre: {branch: 'main', commit: 'abc123'},
        deckProgram: 'invented_program', serviceState: 'active',
        decks: [
            {serial: 'SN-INVENTED-1', usb_product_id: '0084',
                usb_path: '1-2.3', firmware: '1.0.0'},
            {serial: '', usb_product_id: '006D', usb_path: '3-1',
                firmware: ''},
        ],
    });
    assert.deepEqual(state, {
        hostname: 'ws-invented', os: {name: 'Invented', version: '13'},
        gnome_shell: '48.2', extension_version: '1', contract_version: '1.2',
        erplibre: {branch: 'main', commit: 'abc123'},
        deck_program: 'invented_program', service_state: 'active',
        decks: [
            {serial: 'SN-INVENTED-1', usb_product_id: '0084',
                usb_path: '1-2.3', firmware: '1.0.0'},
            {serial: null, usb_product_id: '006d', usb_path: '3-1',
                firmware: null},
        ],
    });
});

test('a serial outside Odoo\'s pattern goes as none, in the state and the events', () => {
    const odd = ['nosn:7:0063:1-4', 'SN INVENTED', 'SN-É', 'x'.repeat(65),
        'SN/INVENTED'];
    for (const serial of odd) {
        const deck = {serial, usb_product_id: '0063', usb_path: '1-4'};
        const state = buildState({hostname: 'h', serviceState: 'active',
            decks: [deck]});
        assert.equal(state.decks[0].serial, null, serial);
        assert.equal(deckKey(deck), 'nosn::0063:1-4', serial);
        const [event] = diffDecks([], [deck], '2026-01-01T00:00:00.000Z',
            () => 'u1');
        assert.equal(event.serial, null, serial);
    }
    for (const serial of ['SN-INVENTED_1.2', 'A'.repeat(64)]) {
        const state = buildState({hostname: 'h', serviceState: 'active',
            decks: [{serial, usb_product_id: '0063', usb_path: '1-4'}]});
        assert.equal(state.decks[0].serial, serial);
    }
});

// Odoo answers 400 bad_request to a text over 256 characters (counted as
// Python does, by code point) or holding a NUL: one such field would hold
// back every report of the destination.
const ODOO_TEXT_MAX = 256;
const fitsOdoo = v => v === null ||
    (Array.from(v).length <= ODOO_TEXT_MAX && !v.includes('\0') &&
        v.isWellFormed());

test('every text of the state and the events fits what Odoo accepts', () => {
    // 255 plain characters, then an astral one across the bound.
    const long = `${'x'.repeat(255)}\u{1F600}${'y'.repeat(300)}`;
    const deck = {serial: null, usb_product_id: '0063',
        usb_path: `1-${'2.'.repeat(200)}3`, firmware: long};
    const state = buildState({hostname: long, os: {name: long,
        version: long}, gnomeShell: long, extensionVersion: long,
    contractVersion: long, erplibre: {branch: long, commit: long},
    deckProgram: long, serviceState: 'active', decks: [deck]});
    const texts = [state.hostname, state.os.name, state.os.version,
        state.gnome_shell, state.extension_version, state.contract_version,
        state.erplibre.branch, state.erplibre.commit, state.deck_program,
        state.decks[0].usb_path, state.decks[0].firmware];
    for (const t of texts) assert.ok(fitsOdoo(t), String(t).slice(0, 20));
    assert.equal(state.deck_program, `${'x'.repeat(255)}\u{1F600}`,
        'cut by code point, the pair kept whole');
    const [ev] = diffDecks([], [deck], '2026-01-01T00:00:00.000Z',
        () => 'u1');
    assert.equal(ev.usb_path, state.decks[0].usb_path,
        'the event names the deck as the state does');
    const nul = buildState({hostname: 'h', serviceState: 'active',
        deckProgram: 'tiler\0x', os: {name: '\0', version: null}});
    assert.equal(nul.deck_program, 'tilerx');
    assert.equal(nul.os.name, null);
});

test('a product id Odoo would refuse goes as none', () => {
    for (const product of ['84', '00840', 'zz84', '0x84']) {
        const state = buildState({hostname: 'h', serviceState: 'active',
            decks: [{serial: 'SN-INVENTED', usb_product_id: product,
                usb_path: '1-2'}]});
        assert.equal(state.decks[0].usb_product_id, null, product);
    }
    const state = buildState({hostname: 'h', serviceState: 'active',
        decks: [{serial: 'SN-INVENTED', usb_product_id: '006D',
            usb_path: '1-2'}]});
    assert.equal(state.decks[0].usb_product_id, '006d');
});

test('a deck with neither a serial nor a USB path is left out', () => {
    // Odoo cannot name such a deck and answers 400 to the whole report.
    const nameless = {serial: 'SN INVENTED', usb_product_id: '0063',
        usb_path: null};
    const named = {serial: null, usb_product_id: '0063', usb_path: '1-4'};
    const state = buildState({hostname: 'h', serviceState: 'active',
        decks: [nameless, named]});
    assert.deepEqual(state.decks.map(d => d.usb_path), ['1-4']);
    assert.deepEqual(diffDecks([], [nameless], 'now', counter()), []);
    assert.deepEqual(diffDecks([nameless], [], 'now', counter()), []);
    const q = new EventQueue();
    assert.equal(q.push({...event('a'), serial: null, usb_path: null}),
        false, 'a deck event naming no deck is not queued');
    assert.equal(q.push({...event('b'), kind: 'service_changed',
        usb_path: null, usb_product_id: null, service_state: 'failed'}),
    true, 'a service event names no deck');
    const kept = EventQueue.fromJSON({events: [
        {...event('c'), usb_path: null}, event('d')], lost: 0});
    assert.deepEqual(kept.pending().map(e => e.uuid), ['d']);
});

test('buildState: missing parts become null, no checkout is null', () => {
    const state = buildState({hostname: 'h', serviceState: 'absent'});
    assert.deepEqual(state, {
        hostname: 'h', os: {name: null, version: null}, gnome_shell: null,
        extension_version: null, contract_version: null, erplibre: null,
        deck_program: null, service_state: 'absent', decks: [],
    });
    assert.equal(buildState({hostname: 'h', serviceState: 'inactive',
        erplibre: {branch: '', commit: ''}}).erplibre, null);
});

test('buildState: a checkout with only a branch or a commit is kept', () => {
    const state = erplibre => buildState({hostname: 'h',
        serviceState: 'active', erplibre}).erplibre;
    assert.deepEqual(state({branch: 'main', commit: ''}),
        {branch: 'main', commit: null});
    assert.deepEqual(state({commit: 'abc123'}),
        {branch: null, commit: 'abc123'});
});

test('buildState refuses a service state outside the contract', () => {
    assert.throws(() => buildState({hostname: 'h', serviceState: 'running'}),
        RangeError);
});

// --- deckKey / diffDecks / serviceChanged ---

test('deckKey is the serial, else the local no-serial form', () => {
    assert.equal(deckKey({serial: 'SN1', usb_product_id: '0084',
        usb_path: '1-2'}), 'SN1');
    assert.equal(deckKey({serial: null, usb_product_id: '0084',
        usb_path: '1-2'}), 'nosn::0084:1-2');
    assert.equal(deckKey({serial: '', usb_product_id: '0084',
        usb_path: '1-2'}), 'nosn::0084:1-2');
});

test('diffDecks emits plugged and unplugged by deck key', () => {
    const a = {serial: 'SN1', usb_product_id: '0084', usb_path: '1-2'};
    const b = {serial: null, usb_product_id: '006d', usb_path: '3-1'};
    const c = {serial: 'SN3', usb_product_id: '0080', usb_path: '1-4'};
    const now = '2026-01-10T12:00:00.000Z';
    const events = diffDecks([a, b], [b, c], now, counter());
    assert.deepEqual(events, [
        {uuid: 'u1', kind: 'unplugged', at: now, serial: 'SN1',
            usb_product_id: '0084', usb_path: '1-2', service_state: null},
        {uuid: 'u2', kind: 'plugged', at: now, serial: 'SN3',
            usb_product_id: '0080', usb_path: '1-4', service_state: null},
    ]);
});

test('diffDecks: a serial deck moved to another port is not an event', () => {
    const before = [{serial: 'SN1', usb_product_id: '0084', usb_path: '1-2'}];
    const after = [{serial: 'SN1', usb_product_id: '0084', usb_path: '1-3'}];
    assert.deepEqual(diffDecks(before, after, 'now', counter()), []);
});

test('diffDecks: a deck without serial on another port is unplug + plug',
    () => {
        const before = [{serial: null, usb_product_id: '0084',
            usb_path: '1-2'}];
        const after = [{serial: null, usb_product_id: '0084',
            usb_path: '1-3'}];
        const events = diffDecks(before, after, 'now', counter());
        assert.deepEqual(events.map(e => [e.kind, e.usb_path]),
            [['unplugged', '1-2'], ['plugged', '1-3']]);
    });

test('diffDecks: identical lists or empty inputs give no event', () => {
    const d = [{serial: 'SN1', usb_product_id: '0084', usb_path: '1-2'}];
    assert.deepEqual(diffDecks(d, d, 'now', counter()), []);
    assert.deepEqual(diffDecks(null, undefined, 'now', counter()), []);
    assert.equal(diffDecks(null, d, 'now', counter())[0].kind, 'plugged');
});

test('serviceChanged emits one event when the service state changes', () => {
    const now = '2026-01-10T12:00:00.000Z';
    assert.deepEqual(serviceChanged('active', 'failed', now, counter()), [
        {uuid: 'u1', kind: 'service_changed', at: now, serial: null,
            usb_product_id: null, usb_path: null, service_state: 'failed'},
    ]);
    assert.deepEqual(serviceChanged('active', 'active', now, counter()), []);
    assert.deepEqual(serviceChanged(null, 'active', now, counter()), []);
    assert.deepEqual(serviceChanged(undefined, 'active', now, counter()), []);
});

// --- EventQueue ---

test('EventQueue keeps events in order and acknowledges only given uuids',
    () => {
        const q = new EventQueue({max: 10, maxAgeDays: 30});
        q.push(event('a'));
        q.push(event('b'));
        q.push(event('c'));
        assert.equal(q.acknowledge(['b', 'zz']), 1);
        assert.deepEqual(q.pending().map(e => e.uuid), ['a', 'c']);
        assert.equal(q.lost, 0);
    });

test('EventQueue ignores a uuid already queued', () => {
    const q = new EventQueue();
    q.push(event('a'));
    q.push(event('a'));
    assert.equal(q.pending().length, 1);
});

test('EventQueue refuses an event without a string date', () => {
    const q = new EventQueue();
    assert.equal(q.push({...event('a'), at: 1767960000000}), false);
    assert.equal(q.push({...event('b'), at: undefined}), false);
    assert.equal(q.push({...event('c'), kind: 'exploded'}), false);
    assert.equal(q.push({...event('d'), uuid: ''}), false);
    assert.deepEqual(q.pending(), []);
});

test('EventQueue pending() is a copy', () => {
    const q = new EventQueue();
    q.push(event('a'));
    q.pending().pop();
    q.pending()[0].uuid = 'mutated';
    assert.deepEqual(q.pending().map(e => e.uuid), ['a']);
});

test('EventQueue bound: beyond 1000 the oldest drop and count as lost', () => {
    const q = new EventQueue();
    for (let i = 0; i < 1003; i++) q.push(event(`e${i}`));
    const pending = q.pending();
    assert.equal(pending.length, 1000);
    assert.equal(pending[0].uuid, 'e3');
    assert.equal(pending[999].uuid, 'e1002');
    assert.equal(q.lost, 3);
});

test('EventQueue bound uses the given max', () => {
    const q = new EventQueue({max: 2});
    q.push(event('a'));
    q.push(event('b'));
    assert.equal(q.lost, 0);
    q.push(event('c'));
    assert.deepEqual(q.pending().map(e => e.uuid), ['b', 'c']);
    assert.equal(q.lost, 1);
});

test('EventQueue lost is a running total that no acknowledge lowers', () => {
    const q = new EventQueue({max: 1});
    q.push(event('a'));
    q.push(event('b'));
    q.push(event('c'));
    assert.equal(q.lost, 2);
    const sent = reportBody({hostname: 'h'}, q);
    const retried = reportBody({hostname: 'h'}, q);
    assert.deepEqual(retried, sent);
    q.acknowledge(['c'], sent.lost_events);
    assert.deepEqual(q.pending(), []);
    assert.equal(q.lost, 2);
    q.push(event('d'));
    q.push(event('e'));
    assert.equal(q.lost, 3);
    assert.equal(reportBody({hostname: 'h'}, q).lost_events, 3);
});

test('EventQueue prune drops events older than 30 days as lost', () => {
    const q = new EventQueue();
    q.push(event('old', '2026-01-01T00:00:00.000Z'));
    q.push(event('edge', '2026-01-02T00:00:00.000Z'));
    q.push(event('new', '2026-01-30T00:00:00.000Z'));
    q.push(event('bad', 'not a date'));
    assert.equal(q.prune('2026-02-01T00:00:00.000Z'), 2);
    assert.deepEqual(q.pending().map(e => e.uuid), ['edge', 'new']);
    assert.equal(q.lost, 2);
});

test('EventQueue prune uses the given age and ignores a bad now', () => {
    const q = new EventQueue({maxAgeDays: 1});
    q.push(event('a', '2026-01-01T00:00:00.000Z'));
    assert.equal(q.prune('garbage'), 0);
    assert.equal(q.pending().length, 1);
    assert.equal(q.prune('2026-01-02T00:00:00.001Z'), 1);
    assert.equal(q.pending().length, 0);
});

test('EventQueue round-trips through JSON', () => {
    const q = new EventQueue({max: 5});
    q.push(event('a'));
    q.push(event('b', '2026-01-11T00:00:00.000Z', 'unplugged'));
    q.acknowledge([]);
    for (let i = 0; i < 5; i++) q.push(event(`x${i}`));
    const back = EventQueue.fromJSON(JSON.parse(JSON.stringify(q)),
        {max: 5});
    assert.deepEqual(back.pending(), q.pending());
    assert.equal(back.lost, q.lost);
    assert.equal(back.lost, 2);
});

test('EventQueue.fromJSON survives a corrupt or foreign file', () => {
    for (const obj of [null, undefined, 42, 'x', [], {events: 'x'},
        {events: [null, 1, {uuid: 3}], lost: -4}]) {
        const q = EventQueue.fromJSON(obj);
        assert.deepEqual(q.pending(), []);
        assert.equal(q.lost, 0);
    }
});

test('EventQueue.fromJSON keeps valid events, applies the bound', () => {
    const obj = {lost: 2, events: [event('a'), {kind: 'plugged'},
        event('b'), event('c'), event('b'),
        {...event('d'), kind: 'exploded'}]};
    const q = EventQueue.fromJSON(obj, {max: 2});
    assert.deepEqual(q.pending().map(e => e.uuid), ['b', 'c']);
    assert.equal(q.lost, 3);
});

// --- reportBody / parseReply ---

test('reportBody carries protocol, state, pending events and lost count',
    () => {
        const q = new EventQueue({max: 1});
        q.push(event('a'));
        q.push(event('b'));
        const state = {hostname: 'h'};
        assert.deepEqual(reportBody(state, q), {protocol: '1.0', state,
            events: [event('b')], lost_events: 1});
    });

test('parseReply accepts a 200 with accepted uuids', () => {
    assert.deepEqual(
        parseReply(200, {protocol: '1.0', accepted: ['a', 'b'],
            heartbeat_s: 600}),
        {ok: true, accepted: ['a', 'b'], heartbeatS: 600, error: null});
    assert.deepEqual(parseReply(200, {protocol: '1.0', accepted: []}),
        {ok: true, accepted: [], heartbeatS: 900, error: null});
});

test('parseReply bounds the heartbeat between a minute and a day', () => {
    assert.equal(parseReply(200, {accepted: [], heartbeat_s: 1}).heartbeatS,
        60);
    assert.equal(parseReply(200, {accepted: [], heartbeat_s: 1e9})
        .heartbeatS, 86400);
    assert.equal(parseReply(200, {accepted: [], heartbeat_s: 'x'})
        .heartbeatS, 900);
    assert.equal(parseReply(200, {accepted: [], heartbeat_s: 600.4})
        .heartbeatS, 600);
    assert.equal(parseReply(200, {accepted: [], heartbeat_s: 600.6})
        .heartbeatS, 601);
});

test('parseReply maps the contract error codes', () => {
    for (const [status, code] of [[400, 'bad_request'],
        [400, 'protocol_unsupported'], [401, 'credentials_refused'],
        [401, 'token_invalid'], [403, 'user_inactive']]) {
        assert.deepEqual(parseReply(status, {protocol: '1.0', error: code}),
            {ok: false, accepted: [], heartbeatS: 900, error: code});
    }
});

test('parseReply: no answer or a server failure is network', () => {
    for (const [status, json] of [[0, null], [null, null], [undefined, null],
        [502, null], [503, {error: 'whatever'}], [500, {}]]) {
        assert.equal(parseReply(status, json).error, 'network',
            String(status));
        assert.equal(parseReply(status, json).ok, false);
    }
});

test('parseReply: an answer outside the contract is bad_reply', () => {
    for (const [status, json] of [[200, null], [200, {}],
        [200, {accepted: 'a'}], [200, {accepted: [1]}], [404, null],
        [401, {error: 'nope'}], [400, 'text'], [302, null],
        [201, {accepted: ['a']}], [204, {accepted: []}]]) {
        assert.deepEqual(parseReply(status, json),
            {ok: false, accepted: [], heartbeatS: 900, error: 'bad_reply'},
            `${status} ${JSON.stringify(json)}`);
    }
});

// --- destinations ---

test('parseDestinations reads valid entries and drops the rest', () => {
    const str = JSON.stringify([
        {id: 'd1', label: 'Local', url: 'http://localhost:8069', db: 'a',
            source: 'local', instanceId: 'i1'},
        {id: 'd2', url: 'https://odoo.example.invalid', db: 'b'},
        {id: 'd1', label: 'dup', url: 'https://x.example.invalid', db: 'c'},
        {id: 'd3', url: '', db: 'c'},
        {id: '', url: 'https://x.example.invalid', db: 'c'},
        {id: 'd4', url: 'https://x.example.invalid'},
        null, 'x',
    ]);
    assert.deepEqual(parseDestinations(str), [
        {id: 'd1', label: 'Local', url: 'http://localhost:8069', db: 'a',
            source: 'local', instanceId: 'i1'},
        {id: 'd2', label: 'https://odoo.example.invalid',
            url: 'https://odoo.example.invalid', db: 'b', source: 'remote',
            instanceId: null},
    ]);
});

test('parseDestinations survives garbage', () => {
    for (const s of [undefined, null, '', 'not json', '{}', '42']) {
        assert.deepEqual(parseDestinations(s), []);
    }
});

test('parseDestinations: a local source needs its instance id', () => {
    const [d] = parseDestinations(JSON.stringify([{id: 'd', url:
        'http://localhost:8069', db: 'a', source: 'local'}]));
    assert.equal(d.source, 'remote');
    assert.equal(d.instanceId, null);
});

test('serializeDestinations keeps only the destination keys', () => {
    const str = serializeDestinations([
        {id: 'd1', label: 'L', url: 'https://odoo.example.invalid', db: 'a',
            source: 'remote', instanceId: null, token: 'SECRET',
            password: 'SECRET', key: 'SECRET'},
    ]);
    assert.doesNotMatch(str, /SECRET|token|password/);
    assert.deepEqual(JSON.parse(str), [{id: 'd1', label: 'L',
        url: 'https://odoo.example.invalid', db: 'a', source: 'remote',
        instanceId: null}]);
    assert.deepEqual(parseDestinations(str), JSON.parse(str));
    assert.equal(serializeDestinations(null), '[]');
});

test('a destination never keeps the user part of its URL', () => {
    const str = serializeDestinations([
        {id: 'd1', url: 'https://user:pw-invented@odoo.example.invalid/odoo',
            db: 'a'},
        {id: 'd2', label: 'Mine user:pw-invented@odoo.example.invalid',
            url: 'https://user:pw-invented@odoo.example.invalid', db: 'b'},
        {id: 'd3', url: 'http://a@b:pw-invented@[::1]:8069', db: 'c'},
        {id: 'd4', url: 'https://user:pw-invented@odoo.example.invalid/a b',
            db: 'd'},
    ]);
    assert.doesNotMatch(str, /pw-invented|user/);
    const dests = JSON.parse(str);
    assert.deepEqual(dests.map(d => [d.url, d.label]), [
        ['https://odoo.example.invalid/odoo',
            'https://odoo.example.invalid/odoo'],
        ['https://odoo.example.invalid', 'Mine odoo.example.invalid'],
        ['http://[::1]:8069', 'http://[::1]:8069'],
        ['https://odoo.example.invalid/a b',
            'https://odoo.example.invalid/a b'],
    ]);
    assert.deepEqual(urlAllowed(dests[0].url), {ok: true, reason: null});
    const [read] = parseDestinations(JSON.stringify([{id: 'd',
        url: 'https://user:pw-invented@odoo.example.invalid', db: 'a'}]));
    assert.equal(read.url, 'https://odoo.example.invalid');
    assert.equal(read.label, 'https://odoo.example.invalid');
});

// --- the preferences' half: destination form, enrollment, state file ---

const {ENROLL_PATH, REPORT_PATH, UNENROLL_PATH, ENROLL_METHODS, ERROR_CODES,
    normalizeUrl, checkDestination, enrollBody, parseEnrollReply,
    parseUnenrollReply, statusFromStateFile} =
    await import('../../lib/inventory.js');

const FP = 'a'.repeat(64);
const TOKEN = 'T'.repeat(43);

test('the routes, methods and error codes are those of the wire contract',
    () => {
        assert.equal(ENROLL_PATH, '/streamdeck/v1/enroll');
        assert.equal(REPORT_PATH, '/streamdeck/v1/report');
        assert.equal(UNENROLL_PATH, '/streamdeck/v1/unenroll');
        assert.deepEqual(ENROLL_METHODS, ['pairing_code', 'api_key',
            'password']);
        assert.deepEqual(ERROR_CODES, ['bad_request', 'protocol_unsupported',
            'credentials_refused', 'user_inactive', 'token_invalid']);
    });

test('normalizeUrl trims, drops trailing slashes, lowercases scheme and host',
    () => {
        assert.equal(normalizeUrl('  HTTPS://Odoo.Example.Invalid/Odoo/ '),
            'https://odoo.example.invalid/Odoo');
        assert.equal(normalizeUrl('http://LOCALHOST:8069///'),
            'http://localhost:8069');
        assert.equal(normalizeUrl('http://[::1]:8069/'), 'http://[::1]:8069');
        assert.equal(normalizeUrl('not a url'), 'not a url');
        assert.equal(normalizeUrl(null), '');
    });

test('checkDestination gives the destination to store, URL normalised', () => {
    assert.deepEqual(checkDestination(
        {url: ' https://Odoo.Example.Invalid/ ', db: ' base_1 ',
            label: '  Head office  '}, []),
    {ok: true, reason: null, url: 'https://odoo.example.invalid',
        db: 'base_1', label: 'Head office'});
    const r = checkDestination({url: 'http://127.0.0.5:8069', db: 'b-2.x'},
        []);
    assert.equal(r.ok, true);
    assert.equal(r.label, '127.0.0.5:8069', 'the host is the default name');
});

test('checkDestination says why a URL is refused, as urlAllowed does', () => {
    const reason = url => checkDestination({url, db: 'base'}, []).reason;
    assert.equal(reason('http://192.0.2.1'), 'plain_http');
    assert.equal(reason('http://localhost.example.invalid'), 'plain_http');
    assert.equal(reason('ftp://odoo.example.invalid'), 'scheme');
    assert.equal(reason('https://u:pw-invented@odoo.example.invalid'),
        'credentials');
    assert.equal(reason('https://odoo.example.invalid/?db=x'), 'invalid');
    assert.equal(reason(''), 'invalid');
    assert.equal(checkDestination({url: 'http://192.0.2.1', db: 'base'}, [])
        .ok, false);
});

test('checkDestination refuses a database name Odoo would refuse', () => {
    for (const db of ['', ' ', 'a', '-base', 'base x', 'base/x', 'bäse',
        'b'.repeat(64), null])
        assert.equal(checkDestination({url: 'https://o.example.invalid', db},
            []).reason, 'db', String(db));
    for (const db of ['ab', 'Base_1', '1.base-x', 'b'.repeat(63)])
        assert.equal(checkDestination({url: 'https://o.example.invalid', db},
            []).ok, true, db);
});

test('checkDestination refuses the same Odoo and database twice', () => {
    const existing = [{id: 'd1', url: 'https://odoo.example.invalid',
        db: 'base', label: 'x', source: 'remote', instanceId: null}];
    assert.equal(checkDestination({url: 'HTTPS://odoo.example.invalid/',
        db: 'base'}, existing).reason, 'duplicate');
    assert.equal(checkDestination({url: 'https://odoo.example.invalid',
        db: 'other'}, existing).ok, true);
    assert.equal(checkDestination({url: 'https://odoo.example.invalid/x',
        db: 'base'}, existing).ok, true);
});

test('checkDestination keeps a label short and on one line', () => {
    const r = checkDestination({url: 'https://o.example.invalid', db: 'ab',
        label: `a\nb\tc${'x'.repeat(200)}`}, []);
    assert.equal(r.label, `a b c${'x'.repeat(75)}`);
    assert.equal(r.label.length, 80);
});

test('enrollBody builds the body of each method, protocol first', () => {
    const facts = {fingerprint: FP, hostname: 'deckhost'};
    assert.deepEqual(enrollBody({method: 'pairing_code', code: ' abcd-efgh '},
        facts), {ok: true, error: null, body: {protocol: '1.0',
        method: 'pairing_code', fingerprint: FP, hostname: 'deckhost',
        code: 'ABCDEFGH'}});
    assert.deepEqual(enrollBody({method: 'api_key', key: ' KEY-INVENTED '},
        facts).body, {protocol: '1.0', method: 'api_key', fingerprint: FP,
        hostname: 'deckhost', key: 'KEY-INVENTED'});
    assert.deepEqual(enrollBody({method: 'password', login: ' someone ',
        password: ' pw invented '}, facts).body, {protocol: '1.0',
        method: 'password', fingerprint: FP, hostname: 'deckhost',
        login: 'someone', password: ' pw invented '});
});

test('enrollBody carries only the secret of the chosen method', () => {
    const all = {code: 'ABCDEFGH', key: 'KEY-INVENTED', login: 'someone',
        password: 'PW-INVENTED'};
    const facts = {fingerprint: FP, hostname: 'h'};
    assert.deepEqual(Object.keys(enrollBody({...all, method: 'pairing_code'},
        facts).body).sort(), ['code', 'fingerprint', 'hostname', 'method',
        'protocol']);
    assert.doesNotMatch(JSON.stringify(enrollBody({...all,
        method: 'api_key'}, facts).body), /PW-INVENTED|ABCDEFGH/);
    assert.doesNotMatch(JSON.stringify(enrollBody({...all,
        method: 'password'}, facts).body), /KEY-INVENTED|ABCDEFGH/);
});

test('enrollBody refuses an empty field, a malformed code, a long value',
    () => {
        const facts = {fingerprint: FP, hostname: 'h'};
        const error = c => enrollBody(c, facts).error;
        assert.equal(error({method: 'pairing_code', code: '  '}), 'missing');
        assert.equal(error({method: 'api_key', key: ''}), 'missing');
        assert.equal(error({method: 'password', login: 'a', password: ''}),
            'missing');
        assert.equal(error({method: 'password', login: ' ', password: 'p'}),
            'missing');
        assert.equal(error({method: 'other', key: 'k'}), 'missing');
        assert.equal(error({}), 'missing');
        for (const code of ['ABCDEFG', 'ABCDEFGHJ', 'ABCDEF0H', 'ABCDEFIH',
            'ABCDEF1H', 'ABCDEFOH', 'ABCD_EFG'])
            assert.equal(error({method: 'pairing_code', code}), 'code_format',
                code);
        assert.equal(error({method: 'api_key', key: 'k'.repeat(4097)}),
            'too_long');
        assert.equal(error({method: 'password', login: 'l'.repeat(257),
            password: 'p'}), 'too_long');
        assert.equal(error({method: 'password', login: 'l',
            password: 'p'.repeat(4097)}), 'too_long');
        assert.equal(enrollBody({method: 'api_key', key: 'k'}, facts).body
            === undefined, false);
        assert.equal(enrollBody({method: 'api_key', key: ''}, facts).body,
            null);
    });

test('enrollBody sends a host name Odoo accepts', () => {
    const body = h => enrollBody({method: 'api_key', key: 'k'},
        {fingerprint: FP, hostname: h}).body.hostname;
    assert.equal(body('h'.repeat(300)), 'h'.repeat(256));
    assert.equal(body(''), 'workstation');
    assert.equal(body(null), 'workstation');
});

test('parseEnrollReply takes the token and the workstation id of a 200', () => {
    assert.deepEqual(parseEnrollReply(200, {protocol: '1.0',
        workstation_id: 7, token: TOKEN}),
    {ok: true, token: TOKEN, workstationId: 7, error: null});
    for (const json of [{workstation_id: 7}, {token: TOKEN},
        {workstation_id: '7', token: TOKEN}, {workstation_id: 0, token: TOKEN},
        {workstation_id: 7, token: 'short'},
        {workstation_id: 7, token: `${'T'.repeat(42)}\n`},
        {workstation_id: 7, token: `${'T'.repeat(40)} x y`}, null, []])
        assert.deepEqual(parseEnrollReply(200, json),
            {ok: false, token: null, workstationId: null, error: 'bad_reply'},
            JSON.stringify(json));
});

test('parseEnrollReply gives the error codes of the contract', () => {
    const error = (s, j) => parseEnrollReply(s, j).error;
    assert.equal(error(401, {error: 'credentials_refused'}),
        'credentials_refused');
    assert.equal(error(403, {error: 'user_inactive'}), 'user_inactive');
    assert.equal(error(400, {error: 'protocol_unsupported'}),
        'protocol_unsupported');
    assert.equal(error(400, {error: 'bad_request'}), 'bad_request');
    assert.equal(error(0, null), 'network');
    assert.equal(error(502, null), 'network');
    assert.equal(error(404, null), 'not_found');
    assert.equal(error(400, {error: 'something_else'}), 'bad_reply');
    assert.equal(error(302, null), 'bad_reply');
    assert.equal(parseEnrollReply(401, {error: 'credentials_refused'}).token,
        null);
});

test('parseUnenrollReply: a token Odoo no longer accepts is revoked too', () => {
    assert.deepEqual(parseUnenrollReply(200, {protocol: '1.0'}),
        {ok: true, revoked: true, error: null});
    assert.deepEqual(parseUnenrollReply(401, {error: 'token_invalid'}),
        {ok: false, revoked: true, error: 'token_invalid'});
    assert.deepEqual(parseUnenrollReply(403, {error: 'user_inactive'}),
        {ok: false, revoked: true, error: 'user_inactive'});
    for (const [s, j, e] of [[0, null, 'network'], [500, null, 'network'],
        [404, null, 'not_found'], [400, {error: 'protocol_unsupported'},
            'protocol_unsupported'], [200, 'x', 'bad_reply']])
        assert.deepEqual(parseUnenrollReply(s, j),
            {ok: false, revoked: false, error: e}, `${s}`);
});

test('statusFromStateFile reads the status the service saved', () => {
    const dest = {id: 'd1', url: 'https://odoo.example.invalid/', db: 'base'};
    const text = JSON.stringify({
        destination: {url: 'https://odoo.example.invalid', db: 'base'},
        queue: {events: [], lost: 0},
        status: {state: 'offline', pending: 3,
            lastReport: '2026-01-10T12:00:00.000Z', error: 'network'},
    });
    assert.deepEqual(statusFromStateFile(text, dest), {state: 'offline',
        pending: 3, lastReport: '2026-01-10T12:00:00.000Z', error: 'network'});
});

test('statusFromStateFile ignores a file of another Odoo, or garbage', () => {
    const dest = {id: 'd1', url: 'https://odoo.example.invalid', db: 'base'};
    const file = (destination, status) =>
        JSON.stringify({destination, status});
    const ok = {state: 'ok', pending: 0, lastReport: null, error: null};
    for (const text of [
        file({url: 'https://odoo.example.invalid', db: 'other'}, ok),
        file({url: 'https://other.example.invalid', db: 'base'}, ok),
        file(undefined, ok),
        '{', '', null, '[]',
        file({url: 'https://odoo.example.invalid', db: 'base'},
            {state: 'party', pending: 0}),
    ])
        assert.equal(statusFromStateFile(text, dest), null, String(text));
    assert.deepEqual(statusFromStateFile(file({url:
        'https://odoo.example.invalid', db: 'base'}, {state: 'revoked',
        pending: -2, lastReport: 5, error: 7}), dest),
    {state: 'revoked', pending: 0, lastReport: null, error: null});
});
