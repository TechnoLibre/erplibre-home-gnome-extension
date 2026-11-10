#!/usr/bin/env python3
# © 2026 TechnoLibre (http://www.technolibre.ca)
# License AGPL-3.0 or later (http://www.gnu.org/licenses/agpl)
"""Runs unittest as `python3 -m unittest` does, and notes each test.

    unittest_notes.py NOTES.json [unittest arguments...]

run_suites.py starts it in place of `python3 -m unittest` when the
requirement registry is configured. The output and the exit code are
those of `python3 -m unittest` with the same arguments; NOTES.json
receives, once the whole run is over, a list of notes in the form
requirement_report.py reads:

    {"kind": "repo_unittest", "file": "<absolute path>",
     "class": "<Class>" | null, "test": "<method>" | null,
     "result": "passed" | "failed" | "error" | "skipped",
     "duration": <seconds>, "log": "<text>" | null}

A subtest is noted under its test method. A class fixture
(setUpClass, tearDownClass) has no method: `test` is null. A module that
fails to import, or a module fixture, has neither class nor method. A run
cut short (Ctrl+C, a test that ends the process) writes no NOTES.json.
"""

import importlib.util
import json
import os
import sys
import time
import unittest

KIND = "repo_unittest"


def _module_file(module):
    """The absolute path of `module`, loaded or not; None if unknown."""
    loaded = sys.modules.get(module)
    path = getattr(loaded, "__file__", None)
    if not path:
        try:
            spec = importlib.util.find_spec(module)
        except (ImportError, ValueError):
            spec = None
        path = getattr(spec, "origin", None)
    return os.path.abspath(path) if path else None


class NotesResult(unittest.TextTestResult):
    """A TextTestResult that keeps, for each test, its outcome, its
    duration and its file."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.notes = []
        self._start = {}

    def startTest(self, test):
        self._start[test.id()] = time.perf_counter()
        super().startTest(test)

    @staticmethod
    def _locate(test):
        """(module, class, method) of `test`, class and method None where
        the failure has none.

        A subtest arrives as a _SubTest, an import error as a _FailedTest
        named after its module, a fixture error or skip as an
        _ErrorHolder described « setUpClass (module.Class) » or
        « setUpModule (module) »."""
        test = getattr(test, "test_case", test)
        if isinstance(test, unittest.loader._FailedTest):
            return test._testMethodName, None, None
        if hasattr(test, "_testMethodName"):
            return (
                type(test).__module__,
                type(test).__qualname__,
                test._testMethodName,
            )
        description = getattr(test, "description", test.id())
        fixture, _, where = description.partition(" (")
        where = where.rstrip(")")
        if fixture in ("setUpModule", "tearDownModule"):
            return where, None, None
        module, _, cls = where.rpartition(".")
        return module, cls, None

    def stopTest(self, test):
        super().stopTest(test)
        self._start.pop(test.id(), None)

    def _note(self, test, result, log=""):
        # A test and each of its failing subtests share the start time.
        start = self._start.get(test.id())
        duration = time.perf_counter() - start if start is not None else 0.0
        module, cls, method = self._locate(test)
        self.notes.append(
            {
                "kind": KIND,
                "file": _module_file(module),
                "class": cls,
                "test": method,
                "result": result,
                "duration": round(duration, 4),
                "log": log or None,
            }
        )

    def addSuccess(self, test):
        super().addSuccess(test)
        self._note(test, "passed")

    def addFailure(self, test, err):
        super().addFailure(test, err)
        self._note(test, "failed", self._exc_info_to_string(err, test))

    def addError(self, test, err):
        super().addError(test, err)
        self._note(test, "error", self._exc_info_to_string(err, test))

    def addSubTest(self, test, subtest, err):
        super().addSubTest(test, subtest, err)
        # A failing subtest goes through neither addFailure nor addError:
        # without this note its test would look passed.
        if err is not None:
            result = "error"
            if issubclass(err[0], test.failureException):
                result = "failed"
            log = f"{subtest._subDescription()}\n"
            self._note(test, result, log + self._exc_info_to_string(err, test))

    def addSkip(self, test, reason):
        super().addSkip(test, reason)
        self._note(test, "skipped", reason)

    def addExpectedFailure(self, test, err):
        super().addExpectedFailure(test, err)
        self._note(test, "passed")

    def addUnexpectedSuccess(self, test):
        super().addUnexpectedSuccess(test)
        self._note(test, "failed", "unexpected success")


def runner_class(path):
    """A TextTestRunner class whose run writes its notes to `path`."""

    class NotesRunner(unittest.TextTestRunner):
        resultclass = NotesResult

        def run(self, test):
            result = super().run(test)
            with open(path, "w", encoding="utf-8") as handle:
                json.dump(result.notes, handle)
            return result

    return NotesRunner


def main(argv=None):
    """Runs `python3 -m unittest <argv[1:]>`, notes in `argv[0]`."""
    argv = sys.argv[1:] if argv is None else argv
    path, arguments = os.path.abspath(argv[0]), argv[1:]
    # `python3 -m unittest` puts the working directory first on the import
    # path and names itself after the interpreter: the same here, so that
    # the tests import and print exactly as they would there.
    sys.path[0] = os.getcwd()
    program = os.path.basename(sys.executable) + " -m unittest"
    unittest.main(
        module=None,
        argv=[program] + arguments,
        testRunner=runner_class(path),
    )


if __name__ == "__main__":
    main()
