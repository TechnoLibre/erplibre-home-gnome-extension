// A node:test reporter that writes one JSON line per verdict, for the
// requirement registry (test/requirement_report.py reads the lines, and
// test/run_suites.py adds this reporter only when the registry is
// configured):
//
//     {"file": "<absolute path>", "test": "<top-level test name>" | null,
//      "result": "passed" | "failed" | "error" | "skipped",
//      "duration": <seconds>, "log": "<text>" | null}
//
// A top-level test gives one line. A subtest gives none: its parent's
// verdict already counts it, and the error of a failing subtest is added
// to the parent's log. `test` is null on the line of a file whose own
// process failed (an import error, a non-zero exit after its tests): its
// log is the end of that file's stderr. A file that fails only because
// one of its tests failed adds no line.

import {resolve} from 'node:path';

// Lines of a file's stderr kept for the log of its failure.
const STDERR_LINES = 40;

// The text of a test's error: the stack of the thrown value when it has
// one, its message otherwise.
function errorText(error) {
    const cause = error?.cause ?? error;
    if (cause === undefined || cause === null)
        return '';
    return String(cause.stack ?? cause.message ?? cause);
}

// `failed` for an assertion, or for a test failed through its subtests;
// `error` for any other exception, a timeout or a failed hook.
function failureResult(error) {
    if (error?.failureType === 'subtestsFailed')
        return 'failed';
    const cause = error?.cause;
    if (cause?.code === 'ERR_ASSERTION' || cause?.name === 'AssertionError')
        return 'failed';
    return 'error';
}

// The notes of one run: the reporter feeds it every event and writes the
// notes `read` returns. It keeps, per file, the end of its stderr and the
// errors of the failing subtests not yet attached to their parent.
export class Notes {
    constructor() {
        this._stderr = new Map();
        this._pending = new Map();
    }

    stderrOf(file) {
        return (this._stderr.get(file) ?? []).join('');
    }

    _keepStderr(file, message) {
        const lines = this._stderr.get(file) ?? [];
        lines.push(...String(message).split(/(?<=\n)/));
        this._stderr.set(file, lines.slice(-STDERR_LINES));
    }

    // The notes `event` gives, as an array: empty for most events.
    read(event) {
        const data = event.data ?? {};
        if (!data.file)
            return [];
        // A test's file is absolute, a file's stderr names it as the
        // command line did: both are resolved from the working directory.
        const file = resolve(data.file);
        if (event.type === 'test:stderr') {
            this._keepStderr(file, data.message ?? '');
            return [];
        }
        if (event.type !== 'test:pass' && event.type !== 'test:fail')
            return [];
        const failed = event.type === 'test:fail';
        const error = data.details?.error;
        const duration = (data.details?.duration_ms ?? 0) / 1000;
        // The runner reports each file as a test named by its path.
        if (data.nesting === 0 && resolve(data.name) === file) {
            if (!failed || error?.failureType === 'subtestsFailed')
                return [];
            const log = [errorText(error), this.stderrOf(file)]
                .filter(Boolean).join('\n');
            return [{file, test: null, result: 'error', duration,
                log: log || null}];
        }
        if (data.nesting > 0) {
            if (failed && !data.todo && !data.skip) {
                const pending = this._pending.get(file) ?? [];
                pending.push(`${data.name}: ${errorText(error)}`);
                this._pending.set(file, pending);
            }
            return [];
        }
        let result = 'passed';
        if (data.skip || data.todo)
            result = 'skipped';
        else if (failed)
            result = failureResult(error);
        // A skip or todo given as a string is its reason, the log of the
        // skipped verdict; `true` gives none.
        const reason = [data.skip, data.todo]
            .find((value) => typeof value === 'string');
        const logs = [];
        if (result === 'skipped' && reason)
            logs.push(reason);
        if (failed && result !== 'skipped')
            logs.push(errorText(error));
        logs.push(...(this._pending.get(file) ?? []));
        this._pending.delete(file);
        const log = logs.filter(Boolean).join('\n\n');
        return [{file, test: data.name, result, duration, log: log || null}];
    }
}

export default async function* requirementReporter(source) {
    const notes = new Notes();
    for await (const event of source) {
        for (const note of notes.read(event))
            yield `${JSON.stringify(note)}\n`;
    }
}
