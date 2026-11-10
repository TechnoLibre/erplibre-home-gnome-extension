import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fake, settle} from './gjs-fake.js';
import {
    runProcess,
    spawnDetached,
    buildTerminalArgv,
    buildBrowserArgv,
    buildMpvArgv,
    buildVlcArgv,
    buildSpotifyArgv,
    parsePosition,
    formatPosition,
    LOGIN_PASSWORD_ENV,
    buildSeleniumLoginStep,
    buildXdotoolLoginSteps,
} from '../../lib/spawn.js';

test('buildTerminalArgv with cwd + command', () => {
    const argv = buildTerminalArgv({
        cwd: '/home/x/proj',
        command: 'claude --resume',
        terminal: 'gnome-terminal',
    });
    assert.deepEqual(argv, [
        'gnome-terminal', '--working-directory=/home/x/proj',
        '--', 'bash', '-lc', 'claude --resume; exec bash',
    ]);
});

test('buildTerminalArgv falls back to xterm', () => {
    const argv = buildTerminalArgv({
        cwd: '/p', command: 'cmd', terminal: 'xterm',
    });
    assert.deepEqual(argv, ['xterm', '-e',
        'bash -lc "cd /p && cmd; exec bash"']);
});

test('buildBrowserArgv', () => {
    assert.deepEqual(
        buildBrowserArgv('https://example.com'),
        ['xdg-open', 'https://example.com']
    );
});

test('buildMpvArgv with position', () => {
    assert.deepEqual(
        buildMpvArgv('https://x', '00:01:23'),
        ['mpv', '--script-opts=ytdl_hook-ytdl_path=yt-dlp',
         '--save-position-on-quit=yes',
         '--start=00:01:23', 'https://x']
    );
});

test('buildMpvArgv without position', () => {
    assert.deepEqual(
        buildMpvArgv('https://x', ''),
        ['mpv', '--script-opts=ytdl_hook-ytdl_path=yt-dlp',
         '--save-position-on-quit=yes', 'https://x']
    );
});

test('buildMpvArgv always pins ytdl backend to yt-dlp', () => {
    const argv = buildMpvArgv('https://x', '');
    assert.ok(argv.some(a => a.includes('ytdl_path=yt-dlp')),
        `expected yt-dlp in argv, got ${argv}`);
});

test('buildMpvArgv enables save-position-on-quit', () => {
    const argv = buildMpvArgv('https://x', '');
    assert.ok(argv.includes('--save-position-on-quit=yes'),
        `expected save-position arg in ${argv}`);
});

test('buildVlcArgv wraps with yt-dlp resolver shell command', () => {
    const argv = buildVlcArgv('https://x', '');
    assert.equal(argv[0], 'bash');
    assert.equal(argv[1], '-c');
    assert.match(argv[2], /yt-dlp -g -f best "\$1"/);
    assert.match(argv[2], /exec vlc /);
    // URL is pased as $1 (after the script name placeholder).
    assert.equal(argv[3], 'sdt-vlc');
    assert.equal(argv[4], 'https://x');
});

test('buildVlcArgv embeds --start-time when position set', () => {
    const argv = buildVlcArgv('https://x', '00:01:23');
    assert.match(argv[2], /exec vlc --start-time=83/);
});

test('buildSpotifyArgv hands the URI to xdg-open', () => {
    assert.deepEqual(
        buildSpotifyArgv('spotify:track:abc'),
        ['xdg-open', 'spotify:track:abc']);
    assert.deepEqual(
        buildSpotifyArgv('https://open.spotify.com/track/abc'),
        ['xdg-open', 'https://open.spotify.com/track/abc']);
});

test('buildVlcArgv passes URL via $1 (no quoting hell)', () => {
    const argv = buildVlcArgv('https://x?with&weird="chars', '');
    // The URL is in argv[4] verbatim; the shell never sees it as
    // unescaped text inside the script string.
    assert.equal(argv[4], 'https://x?with&weird="chars');
    assert.match(argv[2], /\$\{URL:-\$1\}/);
});

test('parsePosition handles hh:mm:ss / mm:ss / seconds', () => {
    assert.equal(parsePosition('01:23:45'), 5025);
    assert.equal(parsePosition('05:30'),    330);
    assert.equal(parsePosition('120'),      120);
    assert.equal(parsePosition(''),         0);
    assert.equal(parsePosition('garbage'),  0);
});

test('formatPosition seconds → hh:mm:ss', () => {
    assert.equal(formatPosition(5025), '01:23:45');
    assert.equal(formatPosition(0),    '00:00:00');
    assert.equal(formatPosition(59),   '00:00:59');
});

test('a malformed URL reaches the player verbatim', () => {
    // The player, not the extension, reports a bad URL.
    for (const url of ['not a url', 'htp:/x y', '://', 'https://']) {
        assert.deepEqual(buildBrowserArgv(url), ['xdg-open', url]);
        assert.equal(buildMpvArgv(url, '').at(-1), url);
        assert.equal(buildMpvArgv(url, '1:00').at(-1), url);
    }
});

/** The entries of the extension log, once the async append landed. */
async function logEntries() {
    const path = join(fake.env.XDG_STATE_HOME, 'erplibre-home', 'log.jsonl');
    for (let i = 0; i < 50 && !existsSync(path); i++) await settle();
    return readFileSync(path, 'utf8').trim().split('\n')
        .map(l => JSON.parse(l));
}

test('a spawn that fails notifies and logs under the program', async () => {
    fake.reset();
    fake.onSpawn = () => { throw new Error('No such file'); };
    const notified = [];
    const ok = await spawnDetached(['mpv', 'https://v.test/a'],
        {notify: (t, b) => notified.push([t, b]), title: 'Media'});
    assert.equal(ok, false);
    assert.deepEqual(notified, [['Media', 'Spawn failed: No such file']]);
    const [entry] = await logEntries();
    assert.equal(entry.level, 'error');
    assert.equal(entry.source, 'mpv');
    assert.equal(entry.message, 'mpv https://v.test/a :: No such file');
});

test('a command that exits non-zero notifies and logs its exit', async () => {
    fake.reset();
    fake.onSpawn = () => ({exit: 3, stderr: 'locked'});
    const notified = [];
    const res = await runProcess(['xdotool', 'key', 'Tab'],
        {notify: (t, b) => notified.push([t, b]), title: 'ERPLibre'});
    assert.equal(res.ok, false);
    assert.equal(res.exit, 3);
    assert.deepEqual(notified, [['ERPLibre', 'Command failed: xdotool']]);
    const [entry] = await logEntries();
    assert.equal(entry.level, 'error');
    assert.equal(entry.source, 'xdotool');
    assert.equal(entry.message, 'xdotool key Tab :: exit=3 locked');
});

const LOGIN = {python: '/p/.venv.erplibre/bin/python',
    script: '/p/script/selenium/web_login.py', url: 'https://erp.test',
    user: 'admin', password: 'pw-not-in-argv'};

/** Every argv element that holds the password, whole or in part. */
const leaks = (argv, password) => argv.filter(a => String(a).includes(password));

/**
 * The log entries once an error landed: the info line of an earlier
 * test's spawn can reach the same fresh file first.
 */
async function entriesWithError() {
    let entries = [];
    for (let i = 0; i < 50; i++) {
        entries = await logEntries();
        if (entries.some(e => e.level === 'error')) return entries;
        await settle();
    }
    assert.fail('no error entry was logged');
}

test('selenium login: the password travels in the environment only', () => {
    const step = buildSeleniumLoginStep(LOGIN);
    assert.deepEqual(step.argv, [LOGIN.python, LOGIN.script,
        '--url', 'https://erp.test', '--default_email_auth', 'admin',
        '--default_password_auth_env', 'ERPLIBRE_HOME_LOGIN_PASSWORD']);
    assert.deepEqual(leaks(step.argv, LOGIN.password), []);
    assert.equal(LOGIN_PASSWORD_ENV, 'ERPLIBRE_HOME_LOGIN_PASSWORD');
    assert.deepEqual(step.env, {ERPLIBRE_HOME_LOGIN_PASSWORD: LOGIN.password});
    assert.equal(step.stdin, undefined);
});

test('xdotool login: the password is typed from standard input', () => {
    const steps = buildXdotoolLoginSteps(LOGIN);
    assert.deepEqual(steps.map(s => s.argv), [
        ['sleep', '2'],
        ['xdotool', 'type', 'admin'],
        ['xdotool', 'key', 'Tab'],
        ['xdotool', 'type', '--file', '-'],
        ['xdotool', 'key', 'Return'],
    ]);
    for (const s of steps) {
        assert.deepEqual(leaks(s.argv, LOGIN.password), []);
        assert.equal(s.env, undefined);
    }
    assert.deepEqual(steps.filter(s => s.stdin !== undefined),
        [{argv: ['xdotool', 'type', '--file', '-'], stdin: LOGIN.password}]);
});

test('runProcess hands env and stdin to the child', async () => {
    fake.reset();
    const res = await runProcess(['xdotool', 'type', '--file', '-'],
        {stdin: 'typed', env: {SOME_VAR: 'v'}});
    assert.equal(res.ok, true);
    const [rec] = fake.spawned;
    assert.equal(rec.stdin, 'typed');
    assert.ok(rec.flags & 1, 'STDIN_PIPE');
    assert.deepEqual(rec.env, {SOME_VAR: 'v'});
});

test('runProcess without stdin opens no stdin pipe', async () => {
    fake.reset();
    await runProcess(['xdotool', 'key', 'Tab']);
    const [rec] = fake.spawned;
    assert.equal(rec.stdin, null);
    assert.equal(rec.flags & 1, 0);
    assert.deepEqual(rec.env, {});
});

test('a failed login logs and notifies neither env nor stdin', async () => {
    const secret = 'pw-never-logged';
    for (const step of [
        buildSeleniumLoginStep({...LOGIN, password: secret}),
        buildXdotoolLoginSteps({...LOGIN, password: secret})[3],
    ]) {
        fake.reset();
        fake.onSpawn = () => ({exit: 1, stderr: 'boom'});
        const notified = [];
        await runProcess(step.argv, {env: step.env,
            stdin: step.stdin, notify: (t, b) => notified.push([t, b])});
        const entries = await entriesWithError();
        assert.ok(!JSON.stringify(entries).includes(secret));
        assert.equal(notified.length, 1);
        assert.ok(!JSON.stringify(notified).includes(secret));
    }
});

test('a login that cannot spawn logs no secret either', async () => {
    const secret = 'pw-never-logged';
    fake.reset();
    fake.onSpawn = () => { throw new Error('No such file'); };
    const step = buildSeleniumLoginStep({...LOGIN, password: secret});
    await runProcess(step.argv, {env: step.env, notify: () => {}});
    const entries = await entriesWithError();
    assert.ok(!JSON.stringify(entries).includes(secret));
});
