/**
 * Where the deck program lies in an ERPLibre checkout.
 *
 * The deck program is a repository of its own, which ERPLibre clones at
 * script/stream_deck/deck/. An older checkout holds the same files
 * directly under script/stream_deck/. The lookup tries the clone first,
 * then the former place, and takes the controller, the deck program and
 * its plugins from the one directory it settles on, so they never mix two
 * versions of the deck.
 *
 * Pure: the caller passes `isFile`, so node --test loads this module
 * without any gi:// import. The callers look the directory up at the time
 * of the action, so a clone added after the session started is found.
 */

// Directories that may hold the deck program, relative to the checkout
// root, in the order they are tried.
export const DECK_DIRS_REL = ['script/stream_deck/deck', 'script/stream_deck'];

// The deck program, a package run as a directory, under the deck directory.
export const DECK_PROGRAM_NAME = 'erplibre_streamdeck';

// The file whose presence marks a deck directory: the package's entry
// point. A directory left with only caches after its files moved does
// not hold it.
export const DECK_MARK = `${DECK_PROGRAM_NAME}/__main__.py`;

// The plugins of the deck program and the controller, under the deck
// directory.
export const PLUGINS_NAME = `${DECK_PROGRAM_NAME}/plugins`;
export const CONTROLLER_NAME = 'erplibre_controller.py';

function trimRoot(root) {
    const s = String(root);
    return s.length > 1 ? s.replace(/\/+$/, '') : s;
}

/** The deck directories of checkout `root`, in the order they are tried. */
export function deckDirCandidates(root) {
    const base = trimRoot(root);
    return DECK_DIRS_REL.map((rel) => `${base === '/' ? '' : base}/${rel}`);
}

/**
 * The deck directory of checkout `root`: the first of deckDirCandidates
 * whose DECK_MARK passes `isFile`. When none does, the first candidate,
 * so that a failure names the place the deck program belongs to. An
 * `isFile` that throws, or that is missing, counts as absent.
 */
export function deckDir(root, isFile) {
    const candidates = deckDirCandidates(root);
    for (const dir of candidates) {
        try {
            if (isFile(`${dir}/${DECK_MARK}`))
                return dir;
        } catch (_e) {}
    }
    return candidates[0];
}

/**
 * The paths of the deck under checkout `root`, all from deckDir(root,
 * isFile): `{dir, program, plugins, controller}`, `program` being the
 * package directory the deck venv's python runs.
 */
export function deckPaths(root, isFile) {
    const dir = deckDir(root, isFile);
    return {
        dir,
        program: `${dir}/${DECK_PROGRAM_NAME}`,
        plugins: `${dir}/${PLUGINS_NAME}`,
        controller: `${dir}/${CONTROLLER_NAME}`,
    };
}
