import {test} from 'node:test';
import assert from 'node:assert/strict';
import {statSync, realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

import {DECK_DIRS_REL, DECK_MARK, deckDirCandidates, deckDir, deckPaths}
    from '../../lib/deck-layout.js';
import {projectRootFrom} from '../../lib/project-root.js';

const ROOT = '/srv/invented-checkout';
const CLONE = `${ROOT}/script/stream_deck/deck`;
const FORMER = `${ROOT}/script/stream_deck`;

// isFile answering from the paths `present` holds.
const has = (...present) => (p) => present.includes(p);

test('the deck clone is tried first, the former place second', () => {
    assert.deepEqual(DECK_DIRS_REL,
        ['script/stream_deck/deck', 'script/stream_deck']);
    assert.equal(DECK_MARK, 'erplibre_streamdeck/__main__.py');
    assert.deepEqual(deckDirCandidates(ROOT), [CLONE, FORMER]);
    assert.deepEqual(deckDirCandidates(`${ROOT}//`), [CLONE, FORMER]);
    assert.deepEqual(deckDirCandidates('/'),
        ['/script/stream_deck/deck', '/script/stream_deck']);
});

test('the clone wins when it holds the deck program', () => {
    assert.equal(deckDir(ROOT, has(`${CLONE}/${DECK_MARK}`)), CLONE);
    assert.equal(deckDir(ROOT,
        has(`${CLONE}/${DECK_MARK}`, `${FORMER}/${DECK_MARK}`)), CLONE);
});

test('an older checkout without the clone keeps its former place', () => {
    assert.equal(deckDir(ROOT, has(`${FORMER}/${DECK_MARK}`)), FORMER);
});

test('only the entry point of the package marks a deck directory', () => {
    // A clone directory without the package, or a former package left
    // with its caches, does not count.
    assert.equal(deckDir(ROOT, has(`${CLONE}/erplibre_controller.py`,
        `${FORMER}/${DECK_MARK}`)), FORMER);
    assert.equal(deckDir(ROOT, has(`${FORMER}/erplibre_streamdeck`)), CLONE);
});

test('without any deck program, the clone is named', () => {
    assert.equal(deckDir(ROOT, has()), CLONE);
    assert.equal(deckDir(ROOT, undefined), CLONE);
});

test('an isFile that throws counts as absent, and the next place is tried',
    () => {
        const asked = [];
        const isFile = (p) => {
            asked.push(p);
            if (p.startsWith(CLONE))
                throw new Error('stat');
            return p === `${FORMER}/${DECK_MARK}`;
        };
        assert.equal(deckDir(ROOT, isFile), FORMER);
        assert.deepEqual(asked,
            [`${CLONE}/${DECK_MARK}`, `${FORMER}/${DECK_MARK}`]);
    });

test('the controller, the program and the plugins share one directory', () => {
    for (const dir of [CLONE, FORMER]) {
        assert.deepEqual(deckPaths(`${ROOT}/`, has(`${dir}/${DECK_MARK}`)), {
            dir,
            program: `${dir}/erplibre_streamdeck`,
            plugins: `${dir}/erplibre_streamdeck/plugins`,
            controller: `${dir}/erplibre_controller.py`,
        });
    }
});

// The ERPLibre checkout that holds this clone, found as the extension
// finds it; the test is skipped when the clone stands alone.
const EXTENSION_DIR = realpathSync(
    fileURLToPath(new URL('../../', import.meta.url))).replace(/\/+$/, '');
const CHECKOUT = projectRootFrom(EXTENSION_DIR, null);
const IN_CHECKOUT = CHECKOUT !== EXTENSION_DIR;

test('the checkout holding this clone has its deck where the lookup says', {
    skip: IN_CHECKOUT ? false : 'not inside an ERPLibre checkout',
}, () => {
    const isFile = (p) => {
        try {
            return statSync(p).isFile();
        } catch (_e) {
            return false;
        }
    };
    const paths = deckPaths(CHECKOUT, isFile);
    assert.ok(statSync(`${paths.dir}/${DECK_MARK}`).isFile());
    assert.ok(statSync(paths.controller).isFile());
    assert.ok(statSync(paths.plugins).isDirectory());
});
