#!/usr/bin/env python3
# © 2026 TechnoLibre (http://www.technolibre.ca)
# License AGPL-3.0 or later (http://www.gnu.org/licenses/agpl)
"""Runs the test suites of this repository: what `npm test` starts.

    python3 test/run_suites.py

The two suites are COMMAND: the node suite, then, when it passes, the
Python suite, from the repository root. Without the requirement registry
(none of the ERPLIBRE_REQUIREMENT_* variables of requirement_report.py),
this process becomes `sh -c COMMAND`: same output, same exit code, no
connection.

With the registry, each suite runs with a note per test: the node suite
with test/requirement-reporter.mjs beside its usual reporter (spec on a
terminal, tap otherwise, as node chooses), the Python suite through
unittest_notes.py, which prints what `python3 -m unittest` prints. The
suites do not receive the registry variables. Once they are over, the
verdicts go to the registry and one line says how it went; the exit code
is the suites' own. A suite that ends without writing any note (a crash,
a missing interpreter) gives an error to each file it would have run, so
that their declared tests do not keep a verdict this run did not
confirm. An interrupted run (Ctrl+C, SIGTERM, exit code 130) sends
nothing.
"""

import glob
import json
import os
import shlex
import signal
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import requirement_report  # noqa: E402

NODE_COMMAND = "node --test test/unit/*.test.js"
PYTHON_COMMAND = "python3 -m unittest discover -s test/python"
COMMAND = f"{NODE_COMMAND} && {PYTHON_COMMAND}"

REPORTER = os.path.join(HERE, "requirement-reporter.mjs")
UNITTEST_NOTES = os.path.join(HERE, "unittest_notes.py")

# The files each suite runs, relative to the root: the glob of the node
# command, and unittest's default discovery pattern in its start directory.
NODE_FILES = NODE_COMMAND.rpartition(" ")[2]
PYTHON_FILES = PYTHON_COMMAND.rpartition(" ")[2] + "/test*.py"

INTERRUPTED = 130


def node_command(notes, tty):
    """NODE_COMMAND with node's usual reporter on standard output and the
    requirement reporter writing its notes to `notes`."""
    head, _, files = NODE_COMMAND.rpartition(" ")
    flags = [
        "--test-reporter=" + ("spec" if tty else "tap"),
        "--test-reporter-destination=stdout",
        "--test-reporter=" + REPORTER,
        "--test-reporter-destination=" + str(notes),
    ]
    return " ".join([head, *map(shlex.quote, flags), files])


def python_command(notes):
    """PYTHON_COMMAND run through unittest_notes.py, notes in `notes`."""
    return PYTHON_COMMAND.replace(
        " -m unittest ",
        f" {shlex.quote(UNITTEST_NOTES)} {shlex.quote(str(notes))} ",
        1,
    )


def _interrupt(signum, frame):
    raise KeyboardInterrupt


def _run(command, root, env, stdio):
    """Exit code of `sh -c command` from `root`, 128 + N for a child
    killed by signal N; INTERRUPTED on Ctrl+C or SIGTERM, after the child
    has ended."""
    child = subprocess.Popen(
        ["sh", "-c", command], cwd=root, env=env, stdout=stdio, stderr=stdio
    )
    try:
        code = child.wait()
    except KeyboardInterrupt:
        while True:
            try:
                if child.poll() is None:
                    child.terminate()
                child.wait()
                break
            except KeyboardInterrupt:
                continue
        return INTERRUPTED
    return 128 - code if code < 0 else code


def _isatty(stream):
    try:
        return os.isatty(stream.fileno())
    except (AttributeError, OSError, ValueError):
        return False


def _node_notes(path):
    """The notes of the node reporter, one JSON object per line."""
    notes = []
    try:
        with open(path, encoding="utf-8") as handle:
            lines = handle.readlines()
    except OSError:
        return notes
    for line in lines:
        try:
            note = json.loads(line)
        except ValueError:
            continue
        if isinstance(note, dict):
            notes.append({**note, "kind": requirement_report.NODE_KIND})
    return notes


def _unittest_notes(path):
    """The notes of unittest_notes.py, or None when it wrote none."""
    try:
        with open(path, encoding="utf-8") as handle:
            notes = json.load(handle)
    except (OSError, ValueError):
        return None
    return [n for n in notes if isinstance(n, dict)]


def _died(kind, root, pattern, command, code):
    """An error note for each file `pattern` matches under `root`."""
    log = (
        f"`{command}` ended with exit code {code} before writing any"
        " result."
    )
    return [
        {
            "kind": kind,
            "file": path,
            "class": None,
            "test": None,
            "result": "error",
            "duration": 0.0,
            "log": log,
        }
        for path in sorted(glob.glob(os.path.join(root, pattern)))
    ]


def _run_noted(root, env, out, stdio):
    """(exit code, notes) of COMMAND run with a note per test."""
    notes = []
    with tempfile.TemporaryDirectory(prefix="run-suites-") as tmp:
        node_notes = os.path.join(tmp, "node.jsonl")
        tty = _isatty(stdio if stdio is not None else sys.stdout)
        out.flush()
        code = _run(node_command(node_notes, tty), root, env, stdio)
        found = _node_notes(node_notes)
        if code not in (0, INTERRUPTED) and not found:
            found = _died(
                requirement_report.NODE_KIND,
                root,
                NODE_FILES,
                NODE_COMMAND,
                code,
            )
        notes += found
        if code != 0:
            return code, notes
        python_notes = os.path.join(tmp, "unittest.json")
        code = _run(python_command(python_notes), root, env, stdio)
        found = _unittest_notes(python_notes)
        if found is None and code not in (0, INTERRUPTED):
            found = _died(
                requirement_report.UNITTEST_KIND,
                root,
                PYTHON_FILES,
                PYTHON_COMMAND,
                code,
            )
        notes += found or []
        return code, notes


def main(root=ROOT, env=None, out=None, stdio=None):
    """Runs the suites from `root`; returns their exit code.

    `env`: the environment, os.environ by default; `out`: where the
    registry's line goes; `stdio`: the suites' output, inherited by
    default. Without the registry, never returns: the process becomes
    `sh -c COMMAND`."""
    env = os.environ if env is None else env
    out = out or sys.stdout
    registry = requirement_report.from_environment(env, out=out)
    if registry is None:
        # exec drops Python's buffers: a warning line printed above must
        # leave before.
        out.flush()
        os.chdir(root)
        os.execvp("sh", ["sh", "-c", COMMAND])
    # A test that prints its environment must not reveal the key; a
    # node --test started inside a node test inherits NODE_TEST_CONTEXT.
    children = {
        name: value
        for name, value in env.items()
        if name not in requirement_report.VARIABLES
        and name != "NODE_TEST_CONTEXT"
    }
    previous = signal.signal(signal.SIGTERM, _interrupt)
    try:
        code, notes = _run_noted(root, children, out, stdio)
        if code == INTERRUPTED:
            requirement_report.warn(
                "suites interrupted, no verdict sent.", out=out
            )
            return code
        registry.push(notes, root=root, out=out)
        return code
    finally:
        signal.signal(signal.SIGTERM, previous)


if __name__ == "__main__":
    sys.exit(main())
