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
        'https://odoo.example.invalid/\t']) {
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

test('EventQueue acknowledge subtracts the lost count it reported', () => {
    const q = new EventQueue({max: 1});
    q.push(event('a'));
    q.push(event('b'));
    q.push(event('c'));
    assert.equal(q.lost, 2);
    const body = reportBody({hostname: 'h'}, q);
    q.push(event('d'));
    assert.equal(q.lost, 3);
    q.acknowledge(['c'], body.lost_events);
    assert.equal(q.lost, 1);
    q.acknowledge([], 99);
    assert.equal(q.lost, 0);
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
        [401, {error: 'nope'}], [400, 'text'], [302, null]]) {
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
