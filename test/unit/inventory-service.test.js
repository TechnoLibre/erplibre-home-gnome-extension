// The background inventory service (lib/inventory-service.js), driven by
// fakes: a USB watch the test feeds, a keyring map, an Odoo whose replies
// the test gives, the GLib sources and files of gjs-fake.js.
import {test, beforeEach, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fake, makeSettings, settle} from './gjs-fake.js';

const svc = await import('../../lib/inventory-service.js');
const {InventoryService} = svc;
const {TIMEOUT_S, HEARTBEAT_S, POLL_S, INVENTORY_PROTOCOL,
    QUEUE_MAX_AGE_DAYS} = await import('../../lib/inventory.js');
const {DeviceIndicator} = await import('../../indicators/device.js');

const TOKEN = 'TOKEN-INVENTED-0123456789abcdefghijklmnopqrs';
const D1 = {id: 'd1', label: 'Odoo one', url: 'https://odoo.example.invalid',
    db: 'base1', source: 'remote', instanceId: null};
const D2 = {id: 'd2', label: 'Odoo two', url: 'https://two.example.invalid/',
    db: 'base2', source: 'remote', instanceId: null};
const DECK_A = {serial: 'SN-INVENTED-A', usb_product_id: '0084',
    usb_path: '1-2', firmware: null, product: 'Stream Deck +'};
const DECK_B = {serial: null, usb_product_id: '006d', usb_path: '1-4.1',
    firmware: null, product: 'Stream Deck'};
const FACTS = {hostname: 'host-invented', os: {name: 'Debian GNU/Linux',
    version: '13'}, erplibre: {branch: 'main', commit: 'abc123'},
deckProgram: 'tiler'};

let h = null;

beforeEach(() => fake.reset());
afterEach(() => {
    try { h?.service.stop(); } catch (_e) {}
    h = null;
});

/**
 * A service on fakes. `h.calls` holds each Odoo call {url, db, path, body,
 * token, cancellable, reply(status, json)}; `h.usb.emit(decks)` is a scan.
 */
function harness({dests = [D1], tokens = {d1: TOKEN}, start = true,
    pilot = null} = {}) {
    const settings = makeSettings({
        'inventory-destinations': JSON.stringify(dests),
        ...pilot === null ? {} : {'inventory-pilot': pilot}});
    // A token given as a string was issued for the destination of that id
    // in `dests` (or D1, D2); `{token, url, db}` names where it was issued.
    const issued = Object.fromEntries([D1, D2, ...dests].map(d =>
        [d.id, {url: d.url, db: d.db}]));
    const strip = u => String(u).replace(/\/+$/, '');
    let n = 0;
    h = {
        settings,
        tokens: {...tokens},
        calls: [],
        lookups: 0,
        serviceState: 'active',
        serviceReads: [],
        serviceHang: false,
        facts: {...FACTS},
        factsReads: [],
        factsHang: false,
        clockMs: 0,
        now: '2026-03-01T10:00:00.000Z',
        usb: {started: 0, stopped: 0, rescans: 0, cb: null,
            emit(decks) { this.cb(decks.map(d => ({...d}))); }},
    };
    const deps = {
        usbWatch: onChange => {
            h.usb.cb = onChange;
            return {start: () => h.usb.started++, stop: () => h.usb.stopped++,
                rescan: () => h.usb.rescans++};
        },
        lookupToken: async (id, at) => {
            h.lookups++;
            if (h.keyringError) throw new Error('locked');
            const t = h.tokens[id];
            if (t === undefined || t === null) return null;
            const e = typeof t === 'string' ? {token: t, ...issued[id]} : t;
            return at && strip(at.url) === strip(e.url) && at.db === e.db
                ? e.token : null;
        },
        newSession: () => ({session: true}),
        postJson: (session, url, db, p, body, token, {cancellable} = {}) =>
            new Promise(resolve => h.calls.push({session, url, db, path: p,
                body, token, cancellable,
                reply: (status, json) => resolve({status, json})})),
        collectFacts: cancellable => {
            h.factsReads.push(cancellable);
            return h.factsHang ? new Promise(() => {})
                : Promise.resolve({...h.facts});
        },
        // `h.serviceUnreadable`: systemctl failed, the caller's
        // `unreadable` comes back, as from the real reading.
        readServiceState: (cancellable, unreadable = 'absent') => {
            h.serviceReads.push(cancellable);
            if (h.serviceUnreadable) return Promise.resolve(unreadable);
            return h.serviceHang ? new Promise(() => {})
                : Promise.resolve(h.serviceState);
        },
        clockMs: () => h.clockMs,
        now: () => h.now,
        newUuid: () => `uuid-${++n}`,
    };
    h.service = new InventoryService({settings, extensionVersion: '7',
        stateDir: fake.env.XDG_STATE_HOME, shellVersion: '48.1', deps});
    if (start) h.service.start();
    return h;
}

const ok = (accepted = [], extra = {}) =>
    [200, {protocol: '1.0', accepted, heartbeat_s: 900, ...extra}];

/** Replies to call `i` and lets the service handle it. */
async function reply(i, [status, json]) {
    h.calls[i].reply(status, json);
    await settle();
}

/** Runs a fake GLib source as the main loop would; drops a one-shot. */
function fire(t) {
    assert.equal(t.removed, false, 'the source is still attached');
    if (!t.fn()) t.removed = true;
}

const live = () => fake.timeouts.filter(t => !t.removed);
const liveMs = ms => live().filter(t => t.ms === ms);

function stateFile(id = 'd1') {
    return path.join(fake.env.XDG_STATE_HOME, 'erplibre-home', 'inventory',
        `${id}.json`);
}

function readState(id = 'd1') {
    return JSON.parse(fs.readFileSync(stateFile(id), 'utf8'));
}

/** Starts the harness and settles the first report as accepted. */
async function enrolledAndReported(decks = [DECK_A], opts = {}) {
    harness(opts);
    h.usb.emit(decks);
    await settle();
    assert.equal(h.calls.length, 1);
    await reply(0, ok());
    return h;
}

// ------------------------------------------------------------- reports

test('the first scan sends the full state, without events', async () => {
    harness();
    assert.equal(h.usb.started, 1);
    await settle();
    assert.equal(h.calls.length, 0, 'nothing before the first scan');
    h.usb.emit([DECK_A, DECK_B]);
    await settle();
    assert.equal(h.calls.length, 1);
    const c = h.calls[0];
    assert.equal(c.url, D1.url);
    assert.equal(c.db, 'base1');
    assert.equal(c.path, '/streamdeck/v1/report');
    assert.equal(c.token, TOKEN);
    assert.deepEqual(c.body, {
        protocol: INVENTORY_PROTOCOL,
        state: {
            hostname: 'host-invented',
            os: {name: 'Debian GNU/Linux', version: '13'},
            gnome_shell: '48.1',
            extension_version: '7',
            contract_version: svc.CONTRACT_VERSION,
            erplibre: {branch: 'main', commit: 'abc123'},
            deck_program: 'tiler',
            service_state: 'active',
            decks: [
                {serial: 'SN-INVENTED-A', usb_product_id: '0084',
                    usb_path: '1-2', firmware: null},
                {serial: null, usb_product_id: '006d', usb_path: '1-4.1',
                    firmware: null},
            ],
            deck_plugins: [],
        },
        events: [],
        lost_events: 0,
        config: {pilot: false},
    });
    await reply(0, ok());
    assert.deepEqual(h.service.status('d1'), {state: 'ok', pending: 0,
        lastReport: h.now, error: null});
});

test('the contract version reported is the one CONTRACT.md states', () => {
    const text = fs.readFileSync(
        new URL('../../CONTRACT.md', import.meta.url), 'utf8');
    const m = text.match(/\*\*Contract version: (\d+\.\d+)\*\*/);
    assert.ok(m);
    assert.equal(svc.CONTRACT_VERSION, m[1]);
});

test('a plugged deck is queued, sent, and dropped once accepted',
    async () => {
        await enrolledAndReported([DECK_A]);
        h.now = '2026-03-01T10:05:00.000Z';
        h.usb.emit([DECK_A, DECK_B]);
        await settle();
        assert.equal(h.calls.length, 2);
        const [ev] = h.calls[1].body.events;
        assert.deepEqual(ev, {uuid: 'uuid-1', kind: 'plugged',
            at: '2026-03-01T10:05:00.000Z', serial: null,
            usb_product_id: '006d', usb_path: '1-4.1', service_state: null});
        assert.equal(h.service.status('d1').pending, 1);
        assert.equal(readState().queue.events.length, 1,
            'queued on disk before the reply');
        await reply(1, ok(['uuid-1']));
        assert.equal(h.service.status('d1').pending, 0);
        assert.equal(readState().queue.events.length, 0);
    });

test('only the uuids Odoo accepted leave the queue', async () => {
    await enrolledAndReported([]);
    h.usb.emit([DECK_A, DECK_B]);
    await settle();
    await reply(1, ok(['uuid-2']));
    assert.equal(h.service.status('d1').pending, 1);
    assert.deepEqual(readState().queue.events.map(e => e.uuid), ['uuid-1']);
});

test('the heartbeat sends the state again after heartbeat_s', async () => {
    await enrolledAndReported();
    assert.equal(liveMs(HEARTBEAT_S * 1000).length, 1);
    fire(liveMs(HEARTBEAT_S * 1000)[0]);
    await settle();
    assert.equal(h.calls.length, 2);
    assert.deepEqual(h.calls[1].body.events, []);
    // Odoo may ask for another period; the next timer follows it.
    await reply(1, ok([], {heartbeat_s: 120}));
    assert.equal(liveMs(HEARTBEAT_S * 1000).length, 0);
    assert.equal(liveMs(120 * 1000).length, 1);
});

test('one report in flight per destination; changes meanwhile follow it',
    async () => {
        await enrolledAndReported([]);
        h.usb.emit([DECK_A]);
        await settle();
        assert.equal(h.calls.length, 2);
        h.usb.emit([DECK_A, DECK_B]);
        await settle();
        h.usb.emit([DECK_B]);
        await settle();
        assert.equal(h.calls.length, 2, 'no second call while one runs');
        await reply(1, ok(['uuid-1']));
        assert.equal(h.calls.length, 3, 'one call for what came meanwhile');
        assert.deepEqual(h.calls[2].body.events.map(e => [e.uuid, e.kind]),
            [['uuid-2', 'plugged'], ['uuid-3', 'unplugged']]);
        assert.deepEqual(h.calls[2].body.state.decks.map(d => d.usb_path),
            ['1-4.1']);
    });

test('two destinations each get their own report and queue', async () => {
    harness({dests: [D1, D2], tokens: {d1: TOKEN, d2: 'TOKEN-TWO'}});
    h.usb.emit([]);
    await settle();
    assert.deepEqual(h.calls.map(c => [c.db, c.token]),
        [['base1', TOKEN], ['base2', 'TOKEN-TWO']]);
    assert.equal(h.factsReads.length, 1, 'one reading for both');
    await reply(0, ok());
    h.usb.emit([DECK_A]);
    await settle();
    assert.equal(h.calls.length, 3, 'd2 still in flight, d1 reports');
    assert.equal(h.calls[2].db, 'base1');
    assert.equal(h.service.status('d2').pending, 1);
});

test('destinations reporting together share one reading in progress',
    async () => {
        harness({dests: [D1, D2], tokens: {d1: TOKEN, d2: 'TOKEN-TWO'}});
        h.factsHang = true;
        h.usb.emit([]);
        await settle();
        assert.equal(h.factsReads.length, 1);
        const tens = liveMs(TIMEOUT_S * 1000);
        fire(tens[tens.length - 1]);
        await settle();
        assert.equal(h.calls.length, 2);
    });

// ------------------------------------------------- offline and refused

test('a call over TIMEOUT_S is offline: cancelled, events kept, retried',
    async () => {
        await enrolledAndReported([]);
        h.usb.emit([DECK_A]);
        await settle();
        // The newest TIMEOUT_S source is the deadline of this call; the
        // older one is the tick (POLL_S has the same length).
        const tens = liveMs(TIMEOUT_S * 1000);
        const call = h.calls[1];
        assert.ok(call.cancellable);
        assert.equal(call.cancellable.is_cancelled(), false);
        fire(tens[tens.length - 1]);
        await settle();
        assert.equal(call.cancellable.is_cancelled(), true);
        const st = h.service.status('d1');
        assert.equal(st.state, 'offline');
        assert.equal(st.pending, 1);
        assert.equal(st.error, 'network');
        assert.equal(readState().queue.events.length, 1);
        assert.equal(readState().status.state, 'offline');
        // The late answer of the abandoned call changes nothing.
        call.reply(...ok(['uuid-1']));
        await settle();
        assert.equal(h.service.status('d1').pending, 1);
        // Retry after RETRY_MIN_S, same events.
        const retry = liveMs(svc.RETRY_MIN_S * 1000);
        assert.equal(retry.length, 1);
        fire(retry[0]);
        await settle();
        assert.equal(h.calls.length, 3);
        assert.deepEqual(h.calls[2].body.events, call.body.events);
        await reply(2, ok(['uuid-1']));
        assert.equal(h.service.status('d1').state, 'ok');
        assert.equal(h.service.status('d1').pending, 0);
    });

test('a network error or a 5xx is offline too, and the events wait',
    async () => {
        await enrolledAndReported([]);
        h.usb.emit([DECK_A]);
        await settle();
        await reply(1, [0, null]);
        assert.equal(h.service.status('d1').state, 'offline');
        h.usb.emit([]);
        await settle();
        await reply(2, [503, null]);
        assert.equal(h.service.status('d1').state, 'offline');
        assert.equal(h.service.status('d1').pending, 2);
    });

test('a report accepted after failures starts the back-off over',
    async () => {
        await enrolledAndReported([]);
        h.usb.emit([DECK_A]);
        await settle();
        let i = 1;
        for (const s of [1, 2, 4]) {
            await reply(i++, [503, null]);
            const [retry] = liveMs(svc.RETRY_MIN_S * s * 1000);
            assert.ok(retry, `retry after ${svc.RETRY_MIN_S * s} s`);
            fire(retry);
            await settle();
        }
        await reply(i++, ok(['uuid-1']));
        h.usb.emit([]);
        await settle();
        await reply(i++, [503, null]);
        assert.equal(liveMs(svc.RETRY_MIN_S * 1000).length, 1);
        assert.equal(liveMs(svc.RETRY_MIN_S * 8 * 1000).length, 0);
    });

test('retryDelayS doubles from RETRY_MIN_S up to the heartbeat', () => {
    assert.equal(svc.retryDelayS(1, 900), svc.RETRY_MIN_S);
    assert.equal(svc.retryDelayS(2, 900), svc.RETRY_MIN_S * 2);
    assert.equal(svc.retryDelayS(3, 900), svc.RETRY_MIN_S * 4);
    assert.equal(svc.retryDelayS(40, 900), 900);
    assert.equal(svc.retryDelayS(0, 900), svc.RETRY_MIN_S);
    assert.equal(svc.retryDelayS(3, 100), 100);
});

for (const [status, error] of [[401, 'token_invalid'], [403, 'user_inactive']])
    test(`a ${status} ${error} is revoked: nothing more is sent`, async () => {
        await enrolledAndReported([]);
        h.usb.emit([DECK_A]);
        await settle();
        await reply(1, [status, {protocol: '1.0', error}]);
        assert.deepEqual(h.service.status('d1'), {state: 'revoked',
            pending: 1, lastReport: '2026-03-01T10:00:00.000Z', error});
        assert.equal(liveMs(HEARTBEAT_S * 1000).length, 0);
        h.usb.emit([]);
        await settle();
        for (const t of liveMs(POLL_S * 1000)) fire(t);
        await settle();
        assert.equal(h.calls.length, 2, 'no call with a revoked token');
        // A new enrollment (another token in the keyring) resumes.
        h.tokens.d1 = 'TOKEN-NEW';
        for (const t of liveMs(POLL_S * 1000)) fire(t);
        await settle();
        assert.equal(h.calls.length, 3);
        assert.equal(h.calls[2].token, 'TOKEN-NEW');
    });

test('another 4xx or a bad reply is refused, retried later', async () => {
    await enrolledAndReported([]);
    h.usb.emit([DECK_A]);
    await settle();
    await reply(1, [400, {error: 'protocol_unsupported'}]);
    assert.equal(h.service.status('d1').state, 'refused');
    assert.equal(h.service.status('d1').error, 'protocol_unsupported');
    assert.equal(liveMs(svc.RETRY_MIN_S * 1000).length, 1);
    fire(liveMs(svc.RETRY_MIN_S * 1000)[0]);
    await settle();
    await reply(2, [404, null]);
    assert.equal(h.service.status('d1').error, 'bad_reply');
    assert.equal(liveMs(svc.RETRY_MIN_S * 2000).length, 1);
});

test('a URL the policy refuses is never called', async () => {
    harness({dests: [{...D1, url: 'http://192.0.2.1:8069'}]});
    h.usb.emit([DECK_A]);
    await settle();
    h.usb.emit([]);
    await settle();
    for (const t of liveMs(POLL_S * 1000)) fire(t);
    await settle();
    assert.equal(h.calls.length, 0);
    assert.equal(h.lookups, 0, 'not even the keyring is asked');
    assert.deepEqual(h.service.status('d1'), {state: 'refused', pending: 0,
        lastReport: null, error: 'plain_http'});
});

test('an id that is not a plain file name is refused, nothing written',
    async () => {
        harness({dests: [{...D1, id: '../escape'}],
            tokens: {'../escape': TOKEN}});
        h.usb.emit([DECK_A]);
        await settle();
        assert.equal(h.calls.length, 0);
        assert.equal(h.service.status('../escape').error, 'invalid');
        assert.equal(fs.existsSync(path.join(fake.env.XDG_STATE_HOME,
            'erplibre-home', 'escape.json')), false);
    });

test('stateFilePath accepts plain ids only', () => {
    assert.equal(svc.stateFilePath('/s', 'd-1_A'),
        '/s/erplibre-home/inventory/d-1_A.json');
    for (const id of ['', '.', '..', 'a/b', '../a', 'a b', 'x'.repeat(65),
        null])
        assert.equal(svc.stateFilePath('/s', id), null, String(id));
    assert.equal(svc.stateFilePath('relative', 'd1'), null);
    assert.equal(svc.stateFilePath('', 'd1'), null);
});

// ------------------------------------------------------- enrollment

test('without a token: unenrolled, no call, no queue, picked up later',
    async () => {
        harness({tokens: {}});
        h.usb.emit([]);
        await settle();
        assert.equal(h.calls.length, 0);
        assert.equal(h.service.status('d1').state, 'unenrolled');
        h.usb.emit([DECK_A]);
        await settle();
        assert.equal(h.service.status('d1').pending, 0);
        h.tokens.d1 = TOKEN;
        const [tick] = liveMs(POLL_S * 1000);
        fire(tick);
        await settle();
        assert.equal(h.calls.length, 1);
        assert.deepEqual(h.calls[0].body.events, []);
        assert.deepEqual(h.calls[0].body.state.decks.map(d => d.serial),
            ['SN-INVENTED-A']);
    });

test('a token cleared from the keyring makes the destination unenrolled',
    async () => {
        await enrolledAndReported();
        delete h.tokens.d1;
        fire(liveMs(HEARTBEAT_S * 1000)[0]);
        await settle();
        assert.equal(h.calls.length, 1);
        assert.equal(h.service.status('d1').state, 'unenrolled');
    });

test('a token cleared by the preferences is seen at the next tick',
    async () => {
        // The preferences clear the keyring; nothing tells the service,
        // which must not show « up to date » until the heartbeat.
        await enrolledAndReported();
        delete h.tokens.d1;
        const [tick] = liveMs(POLL_S * 1000);
        fire(tick);
        await settle();
        assert.equal(h.calls.length, 1, 'nothing sent');
        assert.equal(h.service.status('d1').state, 'unenrolled');
    });

test('the events of an unenrolled destination never reach its next '
    + 'enrollment', async () => {
    await enrolledAndReported([]);
    h.usb.emit([DECK_A]);
    await settle();
    await reply(1, [0, null]);
    assert.equal(h.service.status('d1').pending, 1);
    delete h.tokens.d1;
    const [tick] = liveMs(POLL_S * 1000);
    fire(tick);
    await settle();
    assert.equal(h.service.status('d1').state, 'unenrolled');
    h.usb.emit([]);
    await settle();
    h.clockMs += POLL_S * 1000;
    fire(tick);
    await settle();
    assert.equal(h.service.status('d1').pending, 0);
    assert.deepEqual(readState().queue, {events: [], lost: 0});
    // Another employee enrolls this destination: a fresh queue goes.
    h.tokens.d1 = 'TOKEN-INVENTED-OTHER-0123456789abcdefghijklmn';
    fire(tick);
    await settle();
    assert.equal(h.calls.length, 3);
    assert.deepEqual(h.calls[2].body.events, []);
    assert.equal(h.calls[2].body.lost_events, 0);
});

test('a token missing for one look only keeps the queue', async () => {
    // Storing a token clears the old one first: a look in between finds
    // none for an instant.
    await enrolledAndReported([]);
    h.usb.emit([DECK_A]);
    await settle();
    await reply(1, [0, null]);
    delete h.tokens.d1;
    const [tick] = liveMs(POLL_S * 1000);
    fire(tick);
    await settle();
    // A second look at the same instant, by the retry, finds none either.
    fire(liveMs(svc.RETRY_MIN_S * 1000)[0]);
    await settle();
    assert.equal(h.service.status('d1').pending, 1);
    h.tokens.d1 = TOKEN;
    h.clockMs += POLL_S * 1000;
    fire(tick);
    await settle();
    assert.equal(h.calls.length, 3);
    assert.deepEqual(h.calls[2].body.events.map(e => e.serial),
        ['SN-INVENTED-A']);
});

test('a keyring error at the tick is not taken for a missing token',
    async () => {
        await enrolledAndReported([]);
        h.keyringError = true;
        const [tick] = liveMs(POLL_S * 1000);
        fire(tick);
        await settle();
        assert.equal(h.service.status('d1').state, 'ok');
        // Still enrolled: a change is queued and reported.
        h.usb.emit([DECK_A]);
        await settle();
        assert.equal(h.service.status('d1').pending, 1);
        assert.equal(h.service.status('d1').error, 'keyring');
    });

test('a keyring error keeps the events and tries again', async () => {
    await enrolledAndReported([]);
    h.keyringError = true;
    h.usb.emit([DECK_A]);
    await settle();
    assert.equal(h.calls.length, 1);
    assert.equal(h.service.status('d1').state, 'offline');
    assert.equal(h.service.status('d1').error, 'keyring');
    assert.equal(h.service.status('d1').pending, 1);
    h.keyringError = false;
    fire(liveMs(svc.RETRY_MIN_S * 1000)[0]);
    await settle();
    assert.equal(h.calls.length, 2);
});

// --------------------------------------------------------- state file

test('the state file is private, holds the queue, never the token',
    async () => {
        await enrolledAndReported([]);
        h.usb.emit([DECK_A]);
        await settle();
        await reply(1, [0, null]);
        const file = stateFile();
        assert.equal(fs.statSync(file).mode & 0o777, 0o600);
        const text = fs.readFileSync(file, 'utf8');
        assert.ok(!text.includes(TOKEN));
        assert.ok(!text.includes('TOKEN'));
        const saved = JSON.parse(text);
        assert.deepEqual(Object.keys(saved).sort(),
            ['destination', 'queue', 'status']);
        assert.deepEqual(saved.destination,
            {url: 'https://odoo.example.invalid', db: 'base1'});
        assert.deepEqual(saved.status, {state: 'offline', pending: 1,
            lastReport: '2026-03-01T10:00:00.000Z', error: 'network'});
        assert.equal(saved.queue.events[0].serial, 'SN-INVENTED-A');
        // Nothing of the token in GSettings either.
        assert.ok(!h.settings.get_string('inventory-destinations')
            .includes('TOKEN'));
    });

test('a restarted service sends what the state file kept', async () => {
    await enrolledAndReported([]);
    h.usb.emit([DECK_A]);
    await settle();
    await reply(1, [0, null]);
    h.service.stop();
    harness();
    await settle();
    assert.equal(h.service.status('d1').state, 'offline');
    assert.equal(h.service.status('d1').pending, 1);
    h.usb.emit([DECK_A]);
    await settle();
    assert.deepEqual(h.calls[0].body.events.map(e => e.serial),
        ['SN-INVENTED-A']);
});

// ------------------------------------- while the service was stopped
// The service stops at each screen lock, logout or GNOME Shell restart:
// what changed meanwhile is an event of the start, dated then.

/** Replies ok to every call, accepting its events, until none is left. */
async function drain() {
    const events = [];
    for (let i = 0; i < h.calls.length; i++) {
        events.push(...h.calls[i].body.events);
        await reply(i, ok(h.calls[i].body.events.map(e => e.uuid)));
    }
    return events;
}

test('a deck unplugged while the service was stopped is an event at start',
    async () => {
        await enrolledAndReported([DECK_A, DECK_B]);
        h.service.stop();
        await settle();
        harness();
        h.now = '2026-03-01T11:00:00.000Z';
        h.usb.emit([DECK_A]);
        await settle();
        assert.deepEqual(await drain(), [{uuid: 'uuid-1', kind: 'unplugged',
            at: '2026-03-01T11:00:00.000Z', serial: null,
            usb_product_id: '006d', usb_path: '1-4.1', service_state: null}]);
        assert.equal(h.service.status('d1').pending, 0);
    });

test('a deck plugged while the service was stopped is an event at start',
    async () => {
        await enrolledAndReported([DECK_A]);
        h.service.stop();
        await settle();
        harness();
        h.usb.emit([DECK_B, DECK_A]);
        await settle();
        assert.deepEqual((await drain()).map(e => [e.kind, e.usb_path]),
            [['plugged', '1-4.1']]);
    });

test('a deck service changed while the service was stopped is an event '
    + 'at start', async () => {
    await enrolledAndReported([]);
    h.service.stop();
    await settle();
    harness();
    h.serviceState = 'failed';
    h.usb.emit([]);
    await settle();
    assert.deepEqual((await drain()).map(e => [e.kind, e.service_state]),
        [['service_changed', 'failed']]);
});

test('the same decks and service after a stop give no event', async () => {
    await enrolledAndReported([DECK_A]);
    h.service.stop();
    await settle();
    harness();
    h.usb.emit([DECK_A]);
    await settle();
    assert.deepEqual(await drain(), []);
});

test('what the service last saw is kept in a private file of its own',
    async () => {
        await enrolledAndReported([DECK_A]);
        await settle();
        const file = svc.seenFilePath(fake.env.XDG_STATE_HOME);
        assert.equal(file, path.join(fake.env.XDG_STATE_HOME,
            'erplibre-home', 'inventory-seen.json'));
        assert.equal(fs.statSync(file).mode & 0o777, 0o600);
        const text = fs.readFileSync(file, 'utf8');
        assert.ok(!text.includes('TOKEN'));
        assert.deepEqual(JSON.parse(text), {decks: [{serial: 'SN-INVENTED-A',
            usb_product_id: '0084', usb_path: '1-2'}], service: 'active'});
        assert.equal(svc.seenFilePath('relative'), null);
    });

test('a corrupt file of what was seen is a first start', async () => {
    fs.mkdirSync(path.join(fake.env.XDG_STATE_HOME, 'erplibre-home'),
        {recursive: true});
    fs.writeFileSync(svc.seenFilePath(fake.env.XDG_STATE_HOME), '{not');
    harness();
    h.usb.emit([DECK_A]);
    await settle();
    assert.deepEqual(await drain(), []);
});

test('a corrupt state file gives an empty queue', async () => {
    fs.mkdirSync(path.dirname(stateFile()), {recursive: true});
    fs.writeFileSync(stateFile(), '{not json');
    harness();
    h.usb.emit([]);
    await settle();
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].body.lost_events, 0);
});

// ------------------------------------------- reads of the workstation

test('facts that never come do not hold the reports past TIMEOUT_S',
    async () => {
        harness();
        h.factsHang = true;
        h.usb.emit([DECK_A]);
        await settle();
        assert.equal(h.calls.length, 0, 'waits for the facts first');
        assert.equal(h.factsReads.length, 1);
        // The newest TIMEOUT_S source is the deadline of the reading; the
        // older one is the tick (POLL_S has the same length).
        const tens = liveMs(TIMEOUT_S * 1000);
        assert.equal(tens.length, 2);
        fire(tens[tens.length - 1]);
        await settle();
        assert.equal(h.factsReads[0].is_cancelled(), true);
        assert.equal(h.calls.length, 1, 'the report goes without them');
        assert.deepEqual(h.calls[0].body.state.decks.map(d => d.serial),
            ['SN-INVENTED-A']);
        assert.equal(h.calls[0].body.state.erplibre, null);
        await reply(0, ok());
        assert.equal(h.service.status('d1').state, 'ok');
        // A reading that timed out is not kept: the next report reads again.
        h.factsHang = false;
        fire(liveMs(HEARTBEAT_S * 1000)[0]);
        await settle();
        assert.equal(h.factsReads.length, 2);
        assert.deepEqual(h.calls[1].body.state.erplibre,
            {branch: 'main', commit: 'abc123'});
    });

test('a deck service reading that never comes does not hold the reports',
    async () => {
        harness();
        h.serviceHang = true;
        h.usb.emit([]);
        await settle();
        assert.equal(h.calls.length, 0);
        const tens = liveMs(TIMEOUT_S * 1000);
        fire(tens[tens.length - 1]);
        await settle();
        assert.equal(h.serviceReads[0].is_cancelled(), true);
        assert.equal(h.calls.length, 1);
        assert.equal(h.calls[0].body.state.service_state, 'absent');
    });

test('a deck service poll that never returns is abandoned after TIMEOUT_S',
    async () => {
        await enrolledAndReported([]);
        const reads = h.serviceReads.length;
        h.serviceHang = true;
        const [tick] = liveMs(POLL_S * 1000);
        fire(tick);
        await settle();
        assert.equal(h.serviceReads.length, reads + 1);
        // One poll at a time: the ticks meanwhile start none.
        fire(tick);
        fire(tick);
        await settle();
        assert.equal(h.serviceReads.length, reads + 1);
        const deadline = live().filter(t => t !== tick &&
            t.ms === TIMEOUT_S * 1000);
        assert.equal(deadline.length, 1);
        fire(deadline[0]);
        await settle();
        assert.equal(h.serviceReads[reads].is_cancelled(), true);
        // The next tick polls again, and a change is still seen.
        h.serviceHang = false;
        h.serviceState = 'failed';
        fire(tick);
        await settle();
        assert.equal(h.serviceReads.length, reads + 2);
        assert.deepEqual(h.calls[1].body.events.map(e => e.service_state),
            ['failed']);
    });

test('stop() cancels a reading in progress and its deadline', async () => {
    harness();
    h.factsHang = true;
    h.usb.emit([]);
    await settle();
    assert.ok(live().length >= 2, 'tick and deadline');
    h.service.stop();
    assert.equal(h.factsReads[0].is_cancelled(), true);
    assert.deepEqual(live(), []);
    await settle();
    assert.equal(h.calls.length, 0);
});

// ----------------------------------------------------- queue bounds

/** The ISO time `days` days after the harness's first `now`. */
const later = days => new Date(Date.parse('2026-03-01T10:00:00.000Z') +
    days * 24 * 3600 * 1000).toISOString();

test('a new event drops, as lost, the queued ones past the age bound',
    async () => {
        await enrolledAndReported([]);
        h.usb.emit([DECK_A]);
        await settle();
        // The call for uuid-1 stays in flight: only the queuing prunes.
        h.now = later(QUEUE_MAX_AGE_DAYS + 5);
        h.usb.emit([]);
        await settle();
        assert.equal(h.calls.length, 2);
        assert.equal(h.service.status('d1').pending, 1);
        assert.deepEqual(readState().queue.events.map(e => e.uuid),
            ['uuid-2']);
        assert.equal(readState().queue.lost, 1);
    });

test('a report drops, as lost, the queued events past the age bound',
    async () => {
        await enrolledAndReported([]);
        h.usb.emit([DECK_A]);
        await settle();
        await reply(1, [0, null]);
        h.now = later(QUEUE_MAX_AGE_DAYS + 5);
        fire(liveMs(svc.RETRY_MIN_S * 1000)[0]);
        await settle();
        assert.deepEqual(h.calls[2].body.events, []);
        assert.equal(h.calls[2].body.lost_events, 1);
        assert.equal(readState().queue.events.length, 0);
        assert.equal(readState().queue.lost, 1);
    });

test('the facts are read again for a report once a minute old', async () => {
    await enrolledAndReported([]);
    assert.equal(h.factsReads.length, 1);
    h.facts = {...FACTS, erplibre: {branch: 'main', commit: 'def456'}};
    h.clockMs = 59 * 1000;
    fire(liveMs(HEARTBEAT_S * 1000)[0]);
    await settle();
    assert.equal(h.factsReads.length, 1, 'one reading serves the minute');
    assert.equal(h.calls[1].body.state.erplibre.commit, 'abc123');
    await reply(1, ok());
    h.clockMs = 61 * 1000;
    fire(liveMs(HEARTBEAT_S * 1000)[0]);
    await settle();
    assert.equal(h.factsReads.length, 2);
    assert.equal(h.calls[2].body.state.erplibre.commit, 'def456');
});

// ------------------------------------------------- service and decks

test('a USB watch that cannot start leaves the service reporting no deck',
    async () => {
        harness({start: false});
        h.service._deps.usbWatch = () => ({
            start() { throw new Error('no usb'); }, stop() {}, rescan() {}});
        const log = console.log;
        console.log = () => {};
        try {
            h.service.start();
        } finally {
            console.log = log;
        }
        await settle();
        assert.equal(h.calls.length, 1);
        assert.deepEqual(h.calls[0].body.state.decks, []);
    });

test('the deck service is polled; a change is a service_changed event',
    async () => {
        await enrolledAndReported([]);
        const [tick] = liveMs(POLL_S * 1000);
        fire(tick);
        await settle();
        assert.equal(h.calls.length, 1, 'same state, no event');
        h.serviceState = 'failed';
        fire(tick);
        await settle();
        assert.equal(h.calls.length, 2);
        assert.deepEqual(h.calls[1].body.events.map(e =>
            [e.kind, e.service_state]), [['service_changed', 'failed']]);
        assert.equal(h.calls[1].body.state.service_state, 'failed');
    });

test('without a deck service, no deck program is reported', async () => {
    harness();
    h.serviceState = 'absent';
    h.usb.emit([]);
    await settle();
    assert.equal(h.calls[0].body.state.service_state, 'absent');
    assert.equal(h.calls[0].body.state.deck_program, null);
});

test('decks() and the changed signal follow the scans and statuses',
    async () => {
        harness();
        const seen = [];
        const id = h.service.connect('changed', () => seen.push(1));
        assert.deepEqual(h.service.decks(), []);
        h.usb.emit([DECK_A]);
        await settle();
        assert.deepEqual(h.service.decks().map(d => d.serial),
            ['SN-INVENTED-A']);
        assert.equal(h.service.decks()[0].product, 'Stream Deck +');
        const afterScan = seen.length;
        assert.ok(afterScan >= 1);
        await reply(0, ok());
        assert.ok(seen.length > afterScan, 'a status change is signalled');
        h.service.disconnect(id);
        const n = seen.length;
        h.usb.emit([]);
        await settle();
        assert.equal(seen.length, n);
        h.service.decks().push('x');
        assert.equal(h.service.decks().length, 0, 'decks() is a copy');
        h.service.rescan();
        assert.equal(h.usb.rescans, 1);
    });

test('statuses() lists every destination with its label', async () => {
    harness({dests: [D1, D2], tokens: {d1: TOKEN}});
    h.usb.emit([]);
    await settle();
    await reply(0, ok());
    assert.deepEqual(h.service.statuses().map(s => [s.id, s.label, s.state]),
        [['d1', 'Odoo one', 'ok'], ['d2', 'Odoo two', 'unenrolled']]);
    assert.deepEqual(h.service.status('nope'), {state: 'unenrolled',
        pending: 0, lastReport: null, error: null});
});

// ------------------------------------------------- destinations change

test('a destination added in the settings reports, a removed one stops',
    async () => {
        await enrolledAndReported([], {tokens: {d1: TOKEN, d2: 'TOKEN-TWO'}});
        h.settings.set_string('inventory-destinations',
            JSON.stringify([D1, D2]));
        await settle();
        assert.equal(h.calls.length, 2);
        assert.equal(h.calls[1].db, 'base2');
        const pending = h.calls[1];
        h.settings.set_string('inventory-destinations', JSON.stringify([D1]));
        await settle();
        assert.equal(pending.cancellable.is_cancelled(), true);
        pending.reply(...ok());
        await settle();
        assert.equal(h.service.status('d2').state, 'unenrolled');
        assert.deepEqual(h.service.statuses().map(s => s.id), ['d1']);
    });

const OTHER = {url: 'https://other.example.invalid', db: 'other'};

for (const [what, change] of [['URL and database', OTHER],
    ['URL', {url: OTHER.url}], ['database', {db: OTHER.db}]])
    test(`a destination whose ${what} changes is unenrolled there`,
        async () => {
            await enrolledAndReported([]);
            h.usb.emit([DECK_A]);
            await settle();
            await reply(1, [0, null]);
            assert.equal(h.service.status('d1').pending, 1);
            const moved = {...D1, ...change};
            h.settings.set_string('inventory-destinations',
                JSON.stringify([moved]));
            await settle();
            // The token of the first Odoo never goes to the second one.
            assert.equal(h.calls.length, 2);
            assert.deepEqual(h.service.status('d1'), {state: 'unenrolled',
                pending: 0, lastReport: null, error: null});
            // Enrolled there, it reports without the first one's events.
            h.tokens.d1 = {token: 'TOKEN-OTHER', url: moved.url,
                db: moved.db};
            for (const t of liveMs(POLL_S * 1000)) fire(t);
            await settle();
            assert.equal(h.calls.length, 3);
            assert.deepEqual([h.calls[2].url, h.calls[2].db, h.calls[2].token],
                [moved.url, moved.db, 'TOKEN-OTHER']);
            assert.deepEqual(h.calls[2].body.events, []);
            assert.equal(h.calls[2].body.lost_events, 0);
            assert.deepEqual(readState().destination,
                {url: moved.url, db: moved.db});
        });

test('a state file kept for another URL or database is not read back',
    async () => {
        await enrolledAndReported([]);
        h.usb.emit([DECK_A]);
        await settle();
        await reply(1, [0, null]);
        h.service.stop();
        const moved = {...D1, db: 'other'};
        harness({dests: [moved], tokens: {d1: 'TOKEN-OTHER'}});
        await settle();
        assert.deepEqual(h.service.status('d1'), {state: 'unenrolled',
            pending: 0, lastReport: null, error: null});
        // The same deck as before the stop: no event of the start.
        h.usb.emit([DECK_A]);
        await settle();
        assert.deepEqual(h.calls[0].body.events, []);
        assert.equal(h.calls[0].token, 'TOKEN-OTHER');
    });

test('a state file that does not say its destination is not read back',
    async () => {
        fs.mkdirSync(path.dirname(stateFile()), {recursive: true});
        fs.writeFileSync(stateFile(), JSON.stringify({
            queue: {events: [{uuid: 'uuid-old', kind: 'plugged',
                at: '2026-03-01T09:00:00.000Z', serial: 'SN-INVENTED-A',
                usb_product_id: '0084', usb_path: '1-2',
                service_state: null}], lost: 3},
            status: {state: 'ok', lastReport: '2026-03-01T09:00:00.000Z',
                error: null}}));
        harness();
        h.usb.emit([]);
        await settle();
        assert.deepEqual(h.calls[0].body.events, []);
        assert.equal(h.calls[0].body.lost_events, 0);
    });

// ----------------------------------------------------------------- stop

test('stop() cancels the call in flight and every timer', async () => {
    await enrolledAndReported([]);
    const signals = h.settings.handlers.length;
    assert.ok(signals >= 1);
    h.usb.emit([DECK_A]);
    await settle();
    const call = h.calls[1];
    assert.ok(live().length >= 2, 'tick and deadline');
    h.service.stop();
    assert.equal(call.cancellable.is_cancelled(), true);
    assert.deepEqual(live(), []);
    assert.equal(h.usb.stopped, 1);
    assert.equal(h.settings.handlers.length, 0);
    call.reply(...ok(['uuid-1']));
    await settle();
    assert.equal(readState().queue.events.length, 1,
        'a late reply acknowledges nothing');
    assert.deepEqual(live(), [], 'and schedules nothing');
    h.usb.emit([]);
    await settle();
    assert.equal(h.calls.length, 2);
    h.service.stop();
});

// The two tests below read the service's own fields: what they check (a
// listener or a pending report let go) has no other effect to observe.

test('stop() lets go of the listeners', async () => {
    harness();
    h.service.connect('changed', () => {});
    assert.equal(h.service._handlers.size, 1);
    h.service.stop();
    assert.equal(h.service._handlers.size, 0);
});

test('a removed destination ends its report even if the call never does',
    async () => {
        harness({dests: [D1, D2], tokens: {d1: TOKEN, d2: 'TOKEN-TWO'}});
        h.usb.emit([]);
        await settle();
        assert.equal(h.calls.length, 2);
        const rec = h.service._records.get('d2');
        assert.equal(rec.inFlight, true);
        h.settings.set_string('inventory-destinations', JSON.stringify([D1]));
        await settle();
        // The fake call ignores its cancellable and never answers.
        assert.equal(rec.inFlight, false);
    });

// ---------------------------------------------------------- pure parts

test('serviceStateFrom maps the unit to the four states of the wire', () => {
    const s = svc.serviceStateFrom;
    assert.equal(s({LoadState: 'not-found', ActiveState: 'inactive'}),
        'absent');
    assert.equal(s({}), 'absent');
    assert.equal(s({LoadState: 'loaded', ActiveState: 'active'}), 'active');
    assert.equal(s({LoadState: 'loaded', ActiveState: 'reloading'}),
        'active');
    assert.equal(s({LoadState: 'loaded', ActiveState: 'activating',
        SubState: 'start'}), 'active');
    assert.equal(s({LoadState: 'loaded', ActiveState: 'activating',
        SubState: 'auto-restart'}), 'failed');
    assert.equal(s({LoadState: 'loaded', ActiveState: 'failed'}), 'failed');
    assert.equal(s({LoadState: 'loaded', ActiveState: 'inactive'}),
        'inactive');
    assert.equal(s({LoadState: 'loaded', ActiveState: 'deactivating'}),
        'inactive');
});

test('deckProgramFrom reads DECK_PROGRAM as the deck entry point does',
    () => {
        assert.equal(svc.deckProgramFrom(null), 'tiler');
        assert.equal(svc.deckProgramFrom('GAMES=on\n'), 'tiler');
        assert.equal(svc.deckProgramFrom(
            'DECK_PROGRAM=tiler\nDECK_PROGRAM=controller\n'), 'controller');
        assert.equal(svc.deckProgramFrom('DECK_PROGRAM=none'), 'none');
        assert.equal(svc.deckProgramFrom('DECK_PROGRAM=\n'), null);
        assert.equal(svc.deckProgramFrom(' DECK_PROGRAM=x\n'), 'tiler');
    });

test('inventorySummary gives the line the deck menu shows', () => {
    const f = svc.inventorySummary;
    const st = (state, pending = 0) => ({state, pending});
    assert.equal(f([]), null);
    assert.equal(f([st('unenrolled', 3)]), null);
    assert.deepEqual(f([st('ok'), st('unenrolled', 4)]),
        {kind: 'ok', pending: 0});
    assert.deepEqual(f([st('ok'), st('offline', 2), st('offline', 1)]),
        {kind: 'offline', pending: 3});
    assert.deepEqual(f([st('offline', 2), st('refused', 1)]),
        {kind: 'refused', pending: 3});
    assert.deepEqual(f([st('refused'), st('revoked', 5), st('ok')]),
        {kind: 'revoked', pending: 5});
});

// ------------------------------------------------------ device indicator

function fakeInventory(decks = [], statuses = [], pending = null) {
    const handlers = new Map();
    let next = 0;
    return {
        decks: () => decks.map(d => ({...d})),
        statuses: () => statuses.map(s => ({...s})),
        pendingConfig: () => (pending ? {...pending} : null),
        clicks: [],
        applyConfig(id, rev) {
            this.clicks.push(['apply', id, rev]);
            return Promise.resolve(null);
        },
        keepLocal(id, rev) {
            this.clicks.push(['keep', id, rev]);
            return Promise.resolve(true);
        },
        setPending(p) { pending = p; },
        connect: (sig, cb) => { handlers.set(++next, cb); return next; },
        disconnect: id => handlers.delete(id),
        rescan() { this.rescans = (this.rescans ?? 0) + 1; },
        emit: () => { for (const cb of handlers.values()) cb(); },
        handlers,
        set(d, s) { decks = d; statuses = s; },
    };
}

function indicator(inventory) {
    fake.settings = makeSettings();
    return new DeviceIndicator({extension: {getSettings: () => fake.settings,
        path: fake.root}, inventory});
}

const labels = ind => ind.menu.items.map(i => i.text);

test('the deck menu lists the decks of the service, no lsusb of its own',
    async () => {
        const inv = fakeInventory([{...DECK_A, bus: '001', device: '002',
            vendor_name: 'Elgato'}]);
        const ind = indicator(inv);
        await settle();
        assert.equal(fake.spawned.length, 0);
        assert.ok(labels(ind).includes('Stream Deck + (SN-INVENTED-A)'));
        assert.equal(ind._cache.length, 1);
        inv.set([], []);
        inv.emit();
        assert.ok(labels(ind).includes('(no Stream Deck found)'));
        assert.equal(ind._cache.length, 0);
        // The Re-scan entry asks the service.
        ind.menu.items.find(i => i.text === '🔄 Re-scan USB').activate();
        assert.equal(inv.rescans, 1);
        ind.destroy();
        assert.equal(inv.handlers.size, 0);
    });

test('the deck menu is rebuilt only when what it shows changed', () => {
    const inv = fakeInventory([DECK_A], [{state: 'ok', pending: 0}]);
    const ind = indicator(inv);
    const first = ind.menu.items[0];
    inv.emit();
    assert.equal(ind.menu.items[0], first, 'same decks, same line');
    inv.set([DECK_A], [{state: 'offline', pending: 2}]);
    inv.emit();
    assert.notEqual(ind.menu.items[0], first);
    assert.ok(labels(ind).includes('Inventory: offline (2 pending)'));
    ind.destroy();
});

test('the deck menu shows the inventory status line', async () => {
    const cases = [
        [[], null],
        [[{state: 'unenrolled', pending: 0}], null],
        [[{state: 'ok', pending: 0}], 'Inventory: up to date'],
        [[{state: 'offline', pending: 4}], 'Inventory: offline (4 pending)'],
        [[{state: 'refused', pending: 0}], 'Inventory: refused'],
        [[{state: 'revoked', pending: 1}], 'Inventory: enrollment revoked'],
    ];
    for (const [statuses, line] of cases) {
        const ind = indicator(fakeInventory([], statuses));
        const found = labels(ind).filter(t => t.startsWith('Inventory'));
        assert.deepEqual(found, line ? [line] : [], JSON.stringify(statuses));
        ind.destroy();
    }
});

test('the deck menu offers a pending configuration, applied on a click',
    async () => {
        const inv = fakeInventory([], [{state: 'ok', pending: 0}],
            {destinationId: 'd1', label: 'Odoo one', revision: 3,
                keys: ['deck_program', 'games'], ask: []});
        const ind = indicator(inv);
        const entry = 'Apply Stream Deck configuration (rev. 3): '
            + 'deck_program, games';
        assert.ok(labels(ind).includes(entry));
        assert.deepEqual(inv.clicks, [], 'nothing before the click');
        ind.menu.items.find(i => i.text === entry).activate();
        assert.deepEqual(inv.clicks, [['apply', 'd1', 3]]);
        inv.setPending(null);
        inv.emit();
        assert.ok(!labels(ind).some(t => t.startsWith('Apply Stream Deck')),
            'gone once nothing is pending');
        ind.destroy();
    });

test('the deck menu asks the first-pilot question with two entries', () => {
    const inv = fakeInventory([], [{state: 'ok', pending: 0}],
        {destinationId: 'd1', label: 'Odoo one', revision: 4,
            keys: ['session_refresh_sec'], ask: ['session_refresh_sec']});
    const ind = indicator(inv);
    assert.ok(labels(ind).includes('Stream Deck: keep your settings or use '
        + 'Odoo\'s? (session_refresh_sec)'));
    assert.ok(!labels(ind).some(t => t.startsWith('Apply Stream Deck')),
        'no plain Apply while Odoo asks');
    ind.menu.items.find(i => i.text === 'Keep my settings (rev. 4)')
        .activate();
    ind.menu.items.find(i => i.text === 'Use Odoo\'s settings (rev. 4)')
        .activate();
    assert.deepEqual(inv.clicks, [['keep', 'd1', 4], ['apply', 'd1', 4]]);
    ind.destroy();
});

test('the status strings have their French translation', () => {
    const fr = fs.readFileSync(new URL('../../po/fr.po', import.meta.url),
        'utf8');
    for (const [msgid, msgstr] of [
        ['Inventory: up to date', 'Inventaire : à jour'],
        ['Inventory: offline ({n} pending)',
            'Inventaire : hors ligne ({n} en attente)'],
        ['Inventory: refused', 'Inventaire : refusé'],
        ['Inventory: enrollment revoked',
            'Inventaire : inscription révoquée'],
    ])
        assert.ok(fr.includes(`msgid "${msgid}"\nmsgstr "${msgstr}"`), msgid);
    for (const file of ['po/erplibre-home.pot', 'po/en.po']) {
        const text = fs.readFileSync(new URL(`../../${file}`,
            import.meta.url), 'utf8');
        assert.ok(text.includes('msgid "Inventory: offline ({n} pending)"'),
            file);
    }
});

// ---------------------------------------------------- facts from the system

function osRelease(text) {
    const p = path.join(fake.root, 'os-release');
    fs.writeFileSync(p, text);
    return p;
}

function deckConf(text) {
    const dir = path.join(fake.env.XDG_CONFIG_HOME, 'erplibre-home');
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(path.join(dir, 'streamdeck.conf'), text);
}

const EXT_LINK = '/srv/invented-home/.local/share/gnome-shell/extensions/x';
const EXT_REAL = '/srv/invented-erplibre/script/gnome-extension/erplibre_home';

test('collectFacts reads the system, the checkout and the deck settings',
    async () => {
        const os = osRelease('NAME="Debian GNU/Linux"\nVERSION_ID="13"\n');
        deckConf('DECK_PROGRAM=controller\n');
        fake.onSpawn = argv => {
            if (argv[0] === 'realpath')
                return {stdout: `${EXT_REAL}/extension.js\n`};
            if (argv.includes('--abbrev-ref')) return {stdout: 'dev/x\n'};
            if (argv[0] === 'git') return {stdout: 'abc123\n'};
            return {exit: 1};
        };
        const facts = await svc.collectFacts({extensionPath: EXT_LINK,
            osRelease: [path.join(fake.root, 'missing'), os]});
        assert.deepEqual(facts, {hostname: 'deckhost',
            os: {name: 'Debian GNU/Linux', version: '13'},
            erplibre: {branch: 'dev/x', commit: 'abc123'},
            deckProgram: 'controller', deckPlugins: []});
        assert.deepEqual(fake.spawned.map(s => s.argv), [
            ['realpath', '-e', '--', `${EXT_LINK}/extension.js`],
            ['git', '-C', '/srv/invented-erplibre', 'rev-parse',
                '--abbrev-ref', 'HEAD'],
            ['git', '-C', '/srv/invented-erplibre', 'rev-parse', 'HEAD'],
        ]);
    });

test('collectFacts outside a checkout, detached or unreadable', async () => {
    fake.onSpawn = argv => (argv[0] === 'realpath'
        ? {stdout: '/srv/invented-ext/extension.js\n'} : {exit: 1});
    let facts = await svc.collectFacts({extensionPath: EXT_LINK,
        osRelease: [path.join(fake.root, 'missing')]});
    assert.equal(facts.erplibre, null);
    assert.deepEqual(facts.os, {name: null, version: null});
    assert.equal(facts.deckProgram, 'tiler', 'the entry point default');
    assert.ok(!fake.spawned.some(s => s.argv[0] === 'git'));

    fake.spawned = [];
    fake.onSpawn = argv => {
        if (argv[0] === 'realpath')
            return {stdout: `${EXT_REAL}/extension.js\n`};
        if (argv.includes('--abbrev-ref')) return {stdout: 'HEAD\n'};
        return {stdout: 'abc123\n'};
    };
    facts = await svc.collectFacts({extensionPath: EXT_LINK, osRelease: []});
    assert.deepEqual(facts.erplibre, {branch: null, commit: 'abc123'});

    facts = await svc.collectFacts({extensionPath: null, osRelease: []});
    assert.equal(facts.erplibre, null);
});

test('a reading cancelled by its deadline kills the process', async () => {
    fake.onSpawn = () => ({hang: true});
    const cancellable = new (await import('gi://Gio')).default.Cancellable();
    const state = svc.readServiceState(cancellable);
    await settle();
    assert.equal(fake.spawned[0].killed, undefined);
    cancellable.cancel();
    assert.equal(await state, 'absent');
    assert.equal(fake.spawned[0].killed, true);
});

test('readServiceState asks systemd about the deck unit', async () => {
    fake.onSpawn = () => ({stdout:
        'LoadState=loaded\nActiveState=failed\nSubState=failed\n'});
    assert.equal(await svc.readServiceState(), 'failed');
    assert.deepEqual(fake.spawned[0].argv, ['systemctl', '--user', 'show',
        '-p', 'LoadState', '-p', 'ActiveState', '-p', 'SubState',
        'erplibre-home-streamdeck.service']);
    fake.onSpawn = () => ({exit: 1});
    assert.equal(await svc.readServiceState(), 'absent');
    assert.equal(await svc.readServiceState(null, null), null,
        'unreadable: what the caller asks for');
});

// ------------------------------------------------- deck plugins on disk

test('collectFacts lists the deck plugins of the checkout and the user',
    async () => {
        const root = path.join(fake.root, 'checkout');
        const ext = path.join(root, 'script/gnome-extension/erplibre_home');
        const plugins = path.join(root,
            'script/stream_deck/erplibre_streamdeck/plugins');
        const mine = path.join(fake.env.XDG_CONFIG_HOME, 'erplibre-home',
            'deck-plugins');
        for (const d of [ext, plugins, mine])
            fs.mkdirSync(d, {recursive: true});
        for (const f of ['timers.py', '_base.py', 'Bad-Name.py', 'notes.txt',
            'clock.py'])
            fs.writeFileSync(path.join(plugins, f), '');
        fs.mkdirSync(path.join(plugins, 'folder.py'));
        for (const f of ['custom.py', 'timers.py'])
            fs.writeFileSync(path.join(mine, f), '');
        fake.onSpawn = argv => {
            if (argv[0] === 'realpath')
                return {stdout: `${ext}/extension.js\n`};
            return {stdout: 'x\n'};
        };
        const facts = await svc.collectFacts({extensionPath: EXT_LINK,
            osRelease: []});
        assert.deepEqual([...facts.deckPlugins].sort(),
            ['clock', 'custom', 'timers']);
        fake.onSpawn = () => ({exit: 1});
        const outside = await svc.collectFacts({extensionPath: EXT_LINK,
            osRelease: []});
        assert.deepEqual(outside.deckPlugins, [], 'none outside a checkout');
    });

test('the report carries the deck plugins of the facts', async () => {
    harness();
    h.facts.deckPlugins = ['timers', 'clock', 'Bad'];
    h.usb.emit([]);
    await settle();
    assert.deepEqual(h.calls[0].body.state.deck_plugins, ['clock', 'timers']);
});

// ------------------------------------------------- Odoo configuration

const HASH = '0123456789abcdef'.repeat(4);
const CONF = '# kept comment\nINVENTED_KEY=1\nDECK_PROGRAM=tiler\nGAMES=on\n';
const RESTART = ['systemctl', '--user', 'restart',
    'erplibre-home-streamdeck.service'];

function confPath() {
    return path.join(fake.env.XDG_CONFIG_HOME, 'erplibre-home',
        'streamdeck.conf');
}

const confBytes = () => fs.readFileSync(confPath());
const confText = () => fs.readFileSync(confPath(), 'latin1');
const restarts = () => fake.spawned.filter(s => s.argv[0] === 'systemctl' &&
    s.argv.includes('restart')).map(s => s.argv);
const pilotFile = () => path.join(fake.env.XDG_STATE_HOME, 'erplibre-home',
    'pilot.json');

function config(revision, settings, {locked = [], ask} = {}) {
    return {revision, hash: HASH, settings, locked, ...ask ? {ask} : {}};
}

/**
 * A service piloted by `pilot`, whose first report is out; `h.announced`
 * collects what it announces.
 */
async function piloted({conf = CONF, dests = [D1], pilot = 'd1',
    tokens = {d1: TOKEN}} = {}) {
    if (conf !== null) deckConf(conf);
    harness({dests, pilot, tokens});
    h.announced = [];
    h.service.connect('announce', p => h.announced.push(p));
    h.usb.emit([DECK_A]);
    await settle(40);
    return h;
}

/** Replies to call `i` with `config` and lets the service handle it. */
async function offer(i, cfg) {
    h.calls[i].reply(...ok([], {config: cfg}));
    await settle(60);
}

async function heartbeat() {
    const t = liveMs(HEARTBEAT_S * 1000);
    assert.equal(t.length, 1, 'one heartbeat');
    fire(t[0]);
    await settle(40);
    return h.calls[h.calls.length - 1];
}

test('the schema holds the pilot and the apply request, empty by default',
    () => {
        const xml = fs.readFileSync(new URL(
            '../../schemas/org.gnome.shell.extensions.erplibre-home'
            + '.gschema.xml', import.meta.url), 'utf8');
        for (const key of ['inventory-pilot', 'inventory-apply-request'])
            assert.match(xml, new RegExp(`<key name="${key}" type="s">`
                + '<default>""</default>'), key);
    });

test('the pilot body carries the local values, read again at each report',
    async () => {
        await piloted({conf: 'DECK_PROGRAM=controller\nGAMES=bad\n'});
        assert.deepEqual(h.calls[0].body.config, {pilot: true,
            revision_applied: null, current: {deck_program: 'controller',
                plugins_off: null, session_refresh_sec: null, games: null},
            result: null, choice: null});
        await reply(0, ok());
        deckConf('DECK_PROGRAM=none\nDECK_SESSION_REFRESH_SEC=2.5\n');
        const next = await heartbeat();
        assert.deepEqual(next.body.config.current, {deck_program: 'none',
            plugins_off: null, session_refresh_sec: 2.5, games: null});
    });

test('only_the_pilot_destination_is_applied', async () => {
    await piloted({dests: [D1, D2], pilot: 'd2',
        tokens: {d1: TOKEN, d2: TOKEN}});
    assert.equal(h.calls.length, 2);
    const of = id => h.calls.findIndex(c => c.db === (id === 'd1'
        ? 'base1' : 'base2'));
    assert.deepEqual(h.calls[of('d1')].body.config, {pilot: false});
    assert.equal(h.calls[of('d2')].body.config.pilot, true);
    const before = confBytes();
    await offer(of('d1'), config(7, {deck_program: 'none'}));
    await offer(of('d2'), config(3, {deck_program: 'controller'}));
    assert.deepEqual(h.announced.map(p => [p.destinationId, p.revision]),
        [['d2', 3]], 'only the pilot announces');
    assert.equal(h.service.pendingConfig().destinationId, 'd2');
    assert.equal(await h.service.applyConfig('d1', 7), null);
    assert.deepEqual(confBytes(), before, 'another Odoo writes nothing');
    const r = await h.service.applyConfig('d2', 3);
    assert.equal(r.status, 'applied');
    assert.match(confText(), /^DECK_PROGRAM=controller$/m);
    // Unchecking the pilot withdraws what it offered.
    h.settings.set_string('inventory-pilot', '');
    await settle(40);
    assert.equal(h.service.pendingConfig(), null);
});

test('a_revision_is_announced_once', async () => {
    await piloted();
    await offer(0, config(3, {deck_program: 'controller'}));
    assert.deepEqual(h.announced, [{destinationId: 'd1', label: 'Odoo one',
        revision: 3, keys: ['deck_program'], ask: []}]);
    await heartbeat();
    await offer(1, config(3, {deck_program: 'controller'}));
    assert.equal(h.announced.length, 1, 'the same revision again: silent');
    // A start after a screen lock does not announce it again either.
    h.service.stop();
    await settle();
    harness({pilot: 'd1'});
    const again = [];
    h.service.connect('announce', p => again.push(p));
    h.usb.emit([DECK_A]);
    await settle(40);
    await offer(0, config(3, {deck_program: 'controller'}));
    assert.deepEqual(again, []);
    assert.equal(h.service.pendingConfig().revision, 3,
        'still pending, in the menu and the preferences');
    await heartbeat();
    await offer(1, config(4, {deck_program: 'none'}));
    assert.deepEqual(again.map(p => p.revision), [4]);
});

test('nothing_applies_without_a_click', async () => {
    await piloted();
    const before = confBytes();
    await offer(0, config(3, {deck_program: 'controller', games: 'off'}));
    assert.deepEqual(confBytes(), before);
    assert.deepEqual(restarts(), []);
    assert.deepEqual(h.service.pendingConfig(), {destinationId: 'd1',
        label: 'Odoo one', revision: 3, keys: ['deck_program', 'games'],
        ask: []});
    const next = await heartbeat();
    assert.equal(next.body.config.result, null);
    assert.equal(next.body.config.revision_applied, null);
    assert.deepEqual(confBytes(), before);
});

test('the_first_pilot_asks_before_applying: the question, not an apply',
    async () => {
        await piloted({conf: `${CONF}DECK_SESSION_REFRESH_SEC=5\n`});
        await offer(0, config(3, {session_refresh_sec: 2,
            plugins_off: ['sound']}, {locked: ['plugins_off'],
            ask: ['session_refresh_sec']}));
        assert.deepEqual(h.announced, [{destinationId: 'd1',
            label: 'Odoo one', revision: 3,
            keys: ['plugins_off', 'session_refresh_sec'],
            ask: ['session_refresh_sec']}]);
        assert.deepEqual(restarts(), []);
    });

test('keep_local_writes_nothing_and_reports_the_choice', async () => {
    await piloted({conf: `${CONF}DECK_SESSION_REFRESH_SEC=5\n`});
    fs.chmodSync(confPath(), 0o640);
    const before = confBytes();
    const mtime = fs.statSync(confPath()).mtimeMs;
    await offer(0, config(3, {session_refresh_sec: 2,
        plugins_off: ['sound']}, {locked: ['plugins_off'],
        ask: ['session_refresh_sec']}));
    assert.equal(await h.service.keepLocal('d1', 3), true);
    await settle(40);
    assert.deepEqual(confBytes(), before);
    assert.equal(fs.statSync(confPath()).mtimeMs, mtime, 'not even touched');
    assert.deepEqual(restarts(), []);
    assert.equal(h.service.pendingConfig(), null, 'the question is answered');
    assert.equal(h.calls.length, 2, 'the choice goes at once');
    assert.equal(h.calls[1].body.config.choice, 'keep_local');
    assert.equal(h.calls[1].body.config.result, null);
    await reply(1, ok());
    const next = await heartbeat();
    assert.equal(next.body.config.choice, null, 'sent once');
});

test('locked_keys_still_need_the_usual_apply_after_keep_local', async () => {
    await piloted({conf: `${CONF}DECK_SESSION_REFRESH_SEC=5\n`});
    await offer(0, config(3, {session_refresh_sec: 2,
        plugins_off: ['sound']}, {locked: ['plugins_off'],
        ask: ['session_refresh_sec']}));
    await h.service.keepLocal('d1', 3);
    await settle(40);
    const before = confBytes();
    // Odoo adopted the local value: the next revision asks nothing.
    await offer(1, config(4, {session_refresh_sec: 5,
        plugins_off: ['sound']}, {locked: ['plugins_off']}));
    assert.deepEqual(h.announced.map(p => [p.revision, p.keys, p.ask]), [
        [3, ['plugins_off', 'session_refresh_sec'], ['session_refresh_sec']],
        [4, ['plugins_off'], []]]);
    assert.equal(await h.service.keepLocal('d1', 4), false);
    assert.deepEqual(confBytes(), before, 'still waiting for the click');
    const r = await h.service.applyConfig('d1', 4);
    assert.equal(r.status, 'applied');
    assert.match(confText(), /^DECK_PLUGINS_OFF=sound$/m);
    assert.match(confText(), /^DECK_SESSION_REFRESH_SEC=5$/m);
});

test('take_odoo_applies_and_reports_the_choice', async () => {
    await piloted({conf: `${CONF}DECK_SESSION_REFRESH_SEC=5\n`});
    await offer(0, config(3, {session_refresh_sec: 2,
        plugins_off: ['sound']}, {locked: ['plugins_off'],
        ask: ['session_refresh_sec']}));
    const r = await h.service.applyConfig('d1', 3);
    await settle(40);
    assert.equal(r.status, 'applied');
    assert.match(confText(), /^DECK_SESSION_REFRESH_SEC=2$/m);
    assert.match(confText(), /^DECK_PLUGINS_OFF=sound$/m);
    const sent = h.calls[1].body.config;
    assert.equal(sent.choice, 'take_odoo');
    assert.deepEqual(sent.result, {revision: 3, status: 'applied',
        reason: null, at: h.now});
    assert.equal(sent.revision_applied, 3);
});

test('keep_local_is_refused_without_ask', async () => {
    await piloted();
    await offer(0, config(3, {games: 'off'}));
    assert.equal(await h.service.keepLocal('d1', 3), false);
    assert.equal(await h.service.keepLocal('d1', 9), false);
    await settle(40);
    assert.equal(h.calls.length, 1);
    assert.equal(h.service.pendingConfig().revision, 3);
    const next = await heartbeat();
    assert.equal(next.body.config.choice, null);
});

test('the_question_is_asked_once_per_revision', async () => {
    await piloted({conf: `${CONF}DECK_SESSION_REFRESH_SEC=5\n`});
    const asking = config(3, {session_refresh_sec: 2},
        {ask: ['session_refresh_sec']});
    await offer(0, asking);
    await heartbeat();
    await offer(1, asking);
    assert.equal(h.announced.length, 1);
    assert.deepEqual(h.announced[0].ask, ['session_refresh_sec']);
});

test('apply_writes_then_restarts_an_active_unit', async () => {
    await piloted();
    fs.chmodSync(confPath(), 0o640);
    let atRestart = null;
    fake.onSpawn = argv => {
        if (argv.includes('restart')) atRestart = confText();
        return {};
    };
    await offer(0, config(3, {deck_program: 'controller',
        plugins_off: ['sound', 'clock']}, {locked: ['plugins_off']}));
    const r = await h.service.applyConfig('d1', 3);
    assert.deepEqual(r, {revision: 3, status: 'applied', reason: null,
        at: h.now});
    assert.equal(confText(), '# kept comment\nINVENTED_KEY=1\n'
        + 'DECK_PROGRAM=controller\nGAMES=on\nDECK_PLUGINS_OFF=sound,clock\n');
    assert.equal(fs.statSync(confPath()).mode & 0o777, 0o640,
        'the mode is kept');
    assert.deepEqual(restarts(), [RESTART]);
    assert.equal(atRestart, confText(), 'written before the restart');
});

test('apply_does_not_restart_for_games_only', async () => {
    await piloted();
    await offer(0, config(3, {games: 'off', deck_program: 'tiler'}));
    const r = await h.service.applyConfig('d1', 3);
    assert.equal(r.status, 'applied');
    assert.match(confText(), /^GAMES=off$/m);
    assert.deepEqual(restarts(), []);
});

test('an_inactive_unit_is_not_started', async () => {
    await piloted();
    h.serviceState = 'inactive';
    await offer(0, config(3, {deck_program: 'controller'}));
    const r = await h.service.applyConfig('d1', 3);
    assert.equal(r.status, 'applied');
    assert.match(confText(), /^DECK_PROGRAM=controller$/m);
    assert.deepEqual(fake.spawned.filter(s => s.argv[0] === 'systemctl'),
        [], 'neither restarted nor started');
});

test('a_failed_unit_is_not_started', async () => {
    await piloted();
    h.serviceState = 'failed';
    await offer(0, config(3, {deck_program: 'controller'}));
    const r = await h.service.applyConfig('d1', 3);
    assert.equal(r.status, 'applied');
    assert.match(confText(), /^DECK_PROGRAM=controller$/m);
    assert.deepEqual(restarts(), [], 'left to systemd, not started');
});

test('an_unreadable_unit_state_starts_nothing', async () => {
    await piloted();
    await offer(0, config(3, {deck_program: 'controller'}));
    h.serviceUnreadable = true;
    const r = await h.service.applyConfig('d1', 3);
    assert.deepEqual(r, {revision: 3, status: 'refused',
        reason: 'restart_failed', at: h.now});
    assert.match(confText(), /^DECK_PROGRAM=controller$/m, 'written');
    assert.deepEqual(restarts(), []);
});

test('a_unit_state_past_the_deadline_starts_nothing', async () => {
    await piloted();
    await offer(0, config(3, {plugins_off: ['sound']}));
    h.serviceHang = true;
    let result = null;
    h.service.applyConfig('d1', 3).then(r => {
        result = r;
    });
    await settle(60);
    assert.equal(result, null, 'the state reading hangs');
    for (const t of live().filter(t => t.ms === TIMEOUT_S * 1000)) fire(t);
    await settle(40);
    assert.deepEqual(result, {revision: 3, status: 'refused',
        reason: 'restart_failed', at: h.now});
    assert.deepEqual(restarts(), []);
});

test('a_missing_unit_refuses_unit_missing_after_writing', async () => {
    await piloted();
    h.serviceState = 'absent';
    await offer(0, config(3, {deck_program: 'controller'}));
    const r = await h.service.applyConfig('d1', 3);
    assert.deepEqual(r, {revision: 3, status: 'refused',
        reason: 'unit_missing', at: h.now});
    assert.match(confText(), /^DECK_PROGRAM=controller$/m, 'written');
    assert.deepEqual(restarts(), []);
    await settle(40);
    assert.deepEqual(h.calls[1].body.config.result, r);
    assert.equal(h.calls[1].body.config.revision_applied, null);
});

test('a_write_failure_refuses_write_failed_and_leaves_the_file',
    async () => {
        await piloted();
        const dir = path.dirname(confPath());
        const before = confBytes();
        await offer(0, config(3, {deck_program: 'controller'}));
        fs.chmodSync(dir, 0o555);
        let r;
        try {
            r = await h.service.applyConfig('d1', 3);
        } finally {
            fs.chmodSync(dir, 0o755);
        }
        assert.equal(r.status, 'refused');
        assert.equal(r.reason, 'write_failed');
        assert.deepEqual(confBytes(), before);
        assert.deepEqual(fs.readdirSync(dir), ['streamdeck.conf'],
            'no temporary file left');
        assert.deepEqual(restarts(), []);
        assert.equal(h.service.pendingConfig().revision, 3,
            'still offered, for another click');
    });

test('a_restart_failure_refuses_restart_failed', async () => {
    await piloted();
    fake.onSpawn = argv => (argv.includes('restart') ? {exit: 1} : {});
    await offer(0, config(3, {deck_program: 'controller'}));
    const r = await h.service.applyConfig('d1', 3);
    assert.equal(r.status, 'refused');
    assert.equal(r.reason, 'restart_failed');
    assert.match(confText(), /^DECK_PROGRAM=controller$/m);
});

test('an_unchanged_revision_is_applied_silently', async () => {
    await piloted();
    const before = confBytes();
    const mtime = fs.statSync(confPath()).mtimeMs;
    await offer(0, config(3, {deck_program: 'tiler', games: 'on'},
        {locked: ['games']}));
    assert.deepEqual(h.announced, []);
    assert.equal(h.service.pendingConfig(), null);
    assert.deepEqual(confBytes(), before);
    assert.equal(fs.statSync(confPath()).mtimeMs, mtime);
    assert.deepEqual(restarts(), []);
    assert.equal(h.calls.length, 2, 'reported at once');
    assert.deepEqual(h.calls[1].body.config.result, {revision: 3,
        status: 'applied', reason: null, at: h.now});
    assert.equal(h.calls[1].body.config.revision_applied, 3);
    await offer(1, config(3, {deck_program: 'tiler', games: 'on'},
        {locked: ['games']}));
    assert.equal(h.calls.length, 2, 'no loop on the same revision');
});

test('the_result_goes_in_the_next_report_at_once', async () => {
    await piloted();
    await offer(0, config(3, {deck_program: 'controller'}));
    assert.equal(h.calls.length, 1, 'nothing before the click');
    const r = await h.service.applyConfig('d1', 3);
    await settle(40);
    assert.equal(h.calls.length, 2);
    const sent = h.calls[1].body.config;
    assert.deepEqual(sent.result, r);
    assert.equal(sent.revision_applied, 3);
    assert.equal(sent.current.deck_program, 'controller',
        'the file read again');
    assert.equal(h.factsReads.length, 2,
        'the facts read again: deck_program changed');
    await offer(1, config(3, {deck_program: 'controller'}));
    assert.equal(h.service.pendingConfig(), null);
    const next = await heartbeat();
    assert.equal(next.body.config.result, null, 'answered 200: settled');
    assert.equal(next.body.config.revision_applied, 3);
    assert.equal(await h.service.applyConfig('d1', 3), null,
        'an applied revision is not applied again');
});

test('a value outside the schema refuses the revision once, writes nothing',
    async () => {
        await piloted();
        const before = confBytes();
        await offer(0, config(3, {deck_program: '/bin/sh', games: 'off'}));
        assert.deepEqual(h.announced, []);
        assert.equal(h.service.pendingConfig(), null);
        assert.deepEqual(confBytes(), before);
        assert.equal(h.calls.length, 2);
        assert.deepEqual(h.calls[1].body.config.result, {revision: 3,
            status: 'refused', reason: 'invalid:deck_program', at: h.now});
        await offer(1, config(3, {deck_program: '/bin/sh', games: 'off'}));
        assert.equal(h.calls.length, 2, 'refused once, no loop');
        assert.equal(await h.service.applyConfig('d1', 3), null);
        assert.deepEqual(confBytes(), before);
    });

test('a reply without config withdraws the offer and the pilot file',
    async () => {
        await piloted();
        await offer(0, config(3, {deck_program: 'controller'}));
        assert.ok(fs.existsSync(pilotFile()));
        const next = await heartbeat();
        next.reply(...ok());
        await settle(40);
        assert.equal(h.service.pendingConfig(), null);
        assert.equal(fs.existsSync(pilotFile()), false);
    });

test('pilot_json_is_0600_and_holds_no_secret', async () => {
    await piloted();
    await offer(0, config(3, {deck_program: 'controller',
        plugins_off: ['sound']}, {locked: ['plugins_off']}));
    const file = pilotFile();
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const text = fs.readFileSync(file, 'utf8');
    assert.deepEqual(JSON.parse(text), {destination: 'Odoo one', revision: 3,
        locked: ['plugins_off']});
    for (const secret of [TOKEN, 'TOKEN', D1.url, D1.db])
        assert.ok(!text.includes(secret), secret);
    h.settings.set_string('inventory-pilot', '');
    await settle(40);
    assert.equal(fs.existsSync(file), false, 'no pilot, no file');
});

test('the_journal_names_keys_never_tokens', async () => {
    await piloted();
    await offer(0, config(3, {deck_program: 'controller', games: 'off'}));
    const lines = [];
    const log = console.log;
    console.log = (...a) => lines.push(a.join(' '));
    try {
        await h.service.applyConfig('d1', 3);
        await settle(40);
    } finally {
        console.log = log;
    }
    const said = lines.filter(l => l.includes('inventory config'));
    assert.equal(said.length, 1, lines.join('\n'));
    for (const part of ['Odoo one', 'revision 3', 'deck_program,games',
        'applied'])
        assert.ok(said[0].includes(part), part);
    assert.ok(!lines.some(l => l.includes(TOKEN)));
});

test('the_main_loop_never_waits_on_apply', async () => {
    await piloted();
    fake.onSpawn = argv => (argv.includes('restart') ? {hang: true} : {});
    await offer(0, config(3, {deck_program: 'controller'}));
    let result = null;
    h.service.applyConfig('d1', 3).then(r => {
        result = r;
    });
    await settle(60);
    assert.equal(result, null, 'the click returned, the restart hangs');
    assert.ok(!fake.spawned.some(s => s.argv[0] === '__sync__'));
    const [hung] = fake.spawned.filter(s => s.argv.includes('restart'));
    assert.ok(hung, 'restart started');
    const deadline = live().filter(t => t.ms === TIMEOUT_S * 1000).at(-1);
    fire(deadline);
    await settle(40);
    assert.equal(hung.killed, true);
    assert.equal(result.status, 'refused');
    assert.equal(result.reason, 'restart_failed');
});

test('the preferences ask through inventory-apply-request, cleared after',
    async () => {
        await piloted({conf: `${CONF}DECK_SESSION_REFRESH_SEC=5\n`});
        await offer(0, config(3, {games: 'off'}));
        h.settings.set_string('inventory-apply-request', 'd2:3');
        await settle(60);
        assert.equal(h.settings.get_string('inventory-apply-request'), '');
        assert.match(confText(), /^GAMES=on$/m, 'not the pilot: nothing');
        h.settings.set_string('inventory-apply-request', 'garbage');
        await settle(60);
        assert.equal(h.settings.get_string('inventory-apply-request'), '');
        h.settings.set_string('inventory-apply-request', 'd1:3');
        await settle(60);
        assert.match(confText(), /^GAMES=off$/m);
        assert.equal(h.settings.get_string('inventory-apply-request'), '');
        await reply(1, ok());
        const next = await heartbeat();
        await offer(h.calls.indexOf(next), config(4,
            {session_refresh_sec: 2}, {ask: ['session_refresh_sec']}));
        h.settings.set_string('inventory-apply-request', 'd1:4:keep_local');
        await settle(60);
        assert.match(confText(), /^DECK_SESSION_REFRESH_SEC=5$/m);
        assert.equal(h.calls.at(-1).body.config.choice, 'keep_local');
    });
