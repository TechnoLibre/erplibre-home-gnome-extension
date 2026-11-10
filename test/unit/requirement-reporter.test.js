// The node:test reporter that notes each test's verdict for the
// requirement registry (test/requirement-reporter.mjs): the events it reads
// are built here in the shape node 22 emits, then one real `node --test`
// run checks that shape against the runner itself.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

import requirementReporter, {Notes}
    from '../requirement-reporter.mjs';

const REPORTER = fileURLToPath(
    new URL('../requirement-reporter.mjs', import.meta.url));
const FILE = resolve('test/unit/a.test.js');

function assertionError(message) {
    const cause = new assert.AssertionError({message});
    return Object.assign(new Error('fail'),
        {failureType: 'testCodeFailure', cause});
}

function ev(type, data) {
    return {type, data: {file: FILE, nesting: 0, details: {}, ...data}};
}

// The notes the reporter writes for `events`, parsed back from its lines.
async function notesOf(events) {
    async function* source() {
        yield* events;
    }
    let text = '';
    for await (const line of requirementReporter(source()))
        text += line;
    return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('a passing test is noted passed, with its duration in seconds',
    async () => {
        const notes = await notesOf([ev('test:pass',
            {name: 'adds', details: {duration_ms: 1500}})]);
        assert.deepEqual(notes, [{file: FILE, test: 'adds',
            result: 'passed', duration: 1.5, log: null}]);
    });

test('a failed assertion is failed, another exception an error',
    async () => {
        const typeError = Object.assign(new Error('fail'),
            {failureType: 'testCodeFailure',
                cause: new TypeError('null has no x')});
        const notes = await notesOf([
            ev('test:fail', {name: 'asserts',
                details: {duration_ms: 2, error: assertionError('1 !== 2')}}),
            ev('test:fail', {name: 'throws',
                details: {duration_ms: 3, error: typeError}}),
        ]);
        assert.deepEqual(notes.map((n) => [n.test, n.result]),
            [['asserts', 'failed'], ['throws', 'error']]);
        assert.match(notes[0].log, /1 !== 2/);
        assert.match(notes[1].log, /TypeError: null has no x/);
    });

test('a skipped or todo test is skipped, whatever its outcome', async () => {
    const notes = await notesOf([
        ev('test:pass', {name: 'later', skip: true}),
        ev('test:fail', {name: 'unfinished', todo: true,
            details: {error: assertionError('not yet')}}),
    ]);
    assert.deepEqual(notes.map((n) => [n.result, n.log]),
        [['skipped', null], ['skipped', null]]);
});

test('the reason of a skip or a todo is the log of its verdict',
    async () => {
        const notes = await notesOf([
            ev('test:pass', {name: 'later', skip: 'no device here'}),
            ev('test:fail', {name: 'unfinished', todo: 'waits for v2',
                details: {error: assertionError('not yet')}}),
        ]);
        assert.deepEqual(notes.map((n) => [n.result, n.log]),
            [['skipped', 'no device here'], ['skipped', 'waits for v2']]);
    });

test('a failing subtest is noted on its top-level test, with its error',
    async () => {
        const notes = await notesOf([
            ev('test:pass', {name: 'part one', nesting: 1}),
            ev('test:fail', {name: 'part two', nesting: 1,
                details: {error: assertionError('part two broke')}}),
            ev('test:fail', {name: 'whole', details: {error: Object.assign(
                new Error('1 subtest failed'),
                {failureType: 'subtestsFailed'})}}),
        ]);
        assert.equal(notes.length, 1);
        assert.equal(notes[0].test, 'whole');
        assert.equal(notes[0].result, 'failed');
        assert.match(notes[0].log, /part two: .*part two broke/s);
    });

test('a file whose process fails is noted on the file, with its stderr',
    async () => {
        const fileName = 'test/unit/a.test.js';
        const notes = await notesOf([
            ev('test:stderr', {message: 'Error: import broke\n'}),
            ev('test:fail', {name: fileName, details: {duration_ms: 40,
                error: Object.assign(new Error('test failed'),
                    {failureType: 'testCodeFailure'})}}),
        ]);
        assert.equal(notes.length, 1);
        assert.equal(notes[0].test, null);
        assert.equal(notes[0].result, 'error');
        assert.match(notes[0].log, /import broke/);
    });

test('a file failing only through its tests adds no file note',
    async () => {
        const notes = await notesOf([
            ev('test:fail', {name: 'one', details: {
                error: assertionError('x')}}),
            ev('test:fail', {name: 'test/unit/a.test.js', details: {
                error: Object.assign(new Error('test failed'),
                    {failureType: 'subtestsFailed'})}}),
        ]);
        assert.deepEqual(notes.map((n) => n.test), ['one']);
    });

test('the stderr kept for a file is bounded to its last lines', () => {
    const notes = new Notes();
    for (let i = 0; i < 100; i++)
        notes.read(ev('test:stderr', {message: `line ${i}\n`}));
    const kept = notes.stderrOf(FILE).split('\n').filter(Boolean);
    assert.equal(kept.length, 40);
    assert.equal(kept.at(-1), 'line 99');
});

test('events of other kinds, or without a file, write nothing', async () => {
    const notes = await notesOf([
        {type: 'test:plan', data: {nesting: 0, count: 1}},
        {type: 'test:diagnostic', data: {message: 'tests 1'}},
        {type: 'test:pass', data: {name: 'no file', nesting: 0,
            details: {}}},
        ev('test:start', {name: 'adds'}),
    ]);
    assert.deepEqual(notes, []);
});

test('a real node --test run gives one note per top-level test', () => {
    const dir = mkdtempSync(join(tmpdir(), 'requirement-reporter-'));
    try {
        writeFileSync(join(dir, 'x.test.js'), [
            "import {test} from 'node:test';",
            "import assert from 'node:assert/strict';",
            "test('ok', () => {});",
            "test('bad', () => assert.equal(1, 2));",
            "test('later', {skip: 'no device here'}, () => {});",
            "test('parent', async (t) => {",
            "    await t.test('child', () => assert.ok(false));",
            '});',
        ].join('\n'));
        writeFileSync(join(dir, 'broken.test.js'),
            "throw new Error('import broke');\n");
        const out = join(dir, 'notes.jsonl');
        // A node --test started from a test file inherits the variable
        // that makes it a child of this run, and then runs no file.
        const env = {...process.env};
        delete env.NODE_TEST_CONTEXT;
        const run = spawnSync(process.execPath, ['--test',
            `--test-reporter=${REPORTER}`,
            `--test-reporter-destination=${out}`,
            'x.test.js', 'broken.test.js'], {cwd: dir, env, encoding: 'utf8'});
        assert.equal(run.status, 1, run.stderr);
        const notes = readFileSync(out, 'utf8').split('\n')
            .filter(Boolean).map((l) => JSON.parse(l));
        const byTest = new Map(notes.map((n) => [n.test, n]));
        assert.deepEqual(
            notes.map((n) => [n.test, n.result]).sort(),
            [[null, 'error'], ['bad', 'failed'], ['later', 'skipped'],
                ['ok', 'passed'], ['parent', 'failed']]);
        assert.equal(byTest.get('ok').file, join(dir, 'x.test.js'));
        assert.equal(byTest.get(null).file, join(dir, 'broken.test.js'));
        assert.match(byTest.get(null).log, /import broke/);
        assert.match(byTest.get('parent').log, /child: /);
        assert.equal(byTest.get('later').log, 'no device here');
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
});
