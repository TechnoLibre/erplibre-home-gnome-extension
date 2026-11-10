#!/usr/bin/env python3
# © 2026 TechnoLibre (http://www.technolibre.ca)
# License AGPL-3.0 or later (http://www.gnu.org/licenses/agpl)
"""Each test's verdict, pushed to the requirement registry by ``npm test``.

The registry is an Odoo instance whose requirements list the tests that
prove them. ``test/run_suites.py`` runs the two suites, the node reporter
and ``test/unittest_notes.py`` note each test, and
``test/requirement_report.py`` sends the verdict of every test the registry
declares. No test opens a connection outside this machine: the client tests
replace ``urllib.request.urlopen`` with a fake registry that answers like
Odoo's JSON-RPC, and the end-to-end tests run the real suites of a
temporary repository against the same fake registry served on 127.0.0.1.
"""

import importlib.util
import io
import json
import os
import signal
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

EXT = Path(__file__).resolve().parents[2]
TEST_DIR = EXT / "test"


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


rr = _load("requirement_report", TEST_DIR / "requirement_report.py")
rs = _load("run_suites", TEST_DIR / "run_suites.py")

REPO = "erplibre-home-gnome-extension"
KEY = "invented-key-0123456789"
ENV = {
    "ERPLIBRE_REQUIREMENT_URL": "https://registry.invalid/",
    "ERPLIBRE_REQUIREMENT_DB": "registry",
    "ERPLIBRE_REQUIREMENT_LOGIN": "runner",
    "ERPLIBRE_REQUIREMENT_KEY": KEY,
}


def _tmp(case):
    """A temporary directory removed when the test ends."""
    tmp = tempfile.TemporaryDirectory()
    case.addCleanup(tmp.cleanup)
    return Path(tmp.name)


def _note(kind, path, test=None, cls=None, result="passed", log=None):
    note = {
        "kind": kind,
        "file": str(path),
        "test": test,
        "result": result,
        "duration": 0.5,
        "log": log,
    }
    if kind == rr.UNITTEST_KIND:
        note["class"] = cls
    return note


class FakeRegistry:
    """Odoo's /jsonrpc as the client uses it, with every call kept.

    `declared` lists (kind, reference) pairs, one per test line: a pair
    given twice is two lines, and its verdict updates both."""

    def __init__(self, declared=(), key=KEY, error_on=None, error=""):
        self.declared = list(declared)
        self.key = key
        self.error_on = error_on
        self.error = error
        self.calls = []
        self.timeouts = []

    def answer(self, payload):
        params = payload["params"]
        service, method, args = (
            params["service"],
            params["method"],
            params["args"],
        )
        name = method if service == "common" else args[4]
        self.calls.append((service, name, args))
        if name == self.error_on:
            return {
                "jsonrpc": "2.0",
                "id": payload["id"],
                "error": {
                    "message": "Odoo Server Error",
                    "data": {"message": self.error},
                },
            }
        if service == "common":
            result = 7 if args[2] == self.key else False
        elif name == "search_read":
            (domain,) = args[5]
            kinds = dict((d[0], d[2]) for d in domain)["kind"]
            prefix = dict((d[0], d[2]) for d in domain)["reference"]
            result = [
                {"id": i, "kind": kind, "reference": ref}
                for i, (kind, ref) in enumerate(self.declared)
                if kind in kinds and ref.startswith(prefix.rstrip("%"))
            ]
        else:
            kind, ref = args[5][0], args[5][1]
            result = self.declared.count((kind, ref))
        return {"jsonrpc": "2.0", "id": payload["id"], "result": result}

    def urlopen(self, request, timeout=None):
        self.timeouts.append(timeout)
        body = self.answer(json.loads(request.data.decode("utf-8")))
        return io.BytesIO(json.dumps(body).encode("utf-8"))

    def sent(self):
        """{(kind, reference): (result, kwargs)} of the verdicts sent."""
        return {
            (args[5][0], args[5][1]): (args[5][2], args[6])
            for _, name, args in self.calls
            if name == "record_result_by_reference"
        }


class TestReferences(unittest.TestCase):
    def test_a_unittest_note_names_its_file_class_and_method(self):
        note = _note(
            rr.UNITTEST_KIND, EXT / "test/python/test_a.py", "test_x", "A"
        )
        self.assertEqual(
            rr.note_key(note, EXT),
            (rr.UNITTEST_KIND, f"{REPO}:test/python/test_a.py::A::test_x"),
        )

    def test_a_node_note_names_its_file_and_test(self):
        note = _note(rr.NODE_KIND, EXT / "test/unit/a.test.js", "adds up")
        self.assertEqual(
            rr.note_key(note, EXT),
            (rr.NODE_KIND, f"{REPO}:test/unit/a.test.js::adds up"),
        )

    def test_a_fixture_or_a_file_failure_is_a_prefix(self):
        path = EXT / "test/python/test_a.py"
        self.assertEqual(
            rr.note_key(_note(rr.UNITTEST_KIND, path, None, "A"), EXT)[1],
            f"{REPO}:test/python/test_a.py::A::",
        )
        self.assertEqual(
            rr.note_key(_note(rr.UNITTEST_KIND, path), EXT)[1],
            f"{REPO}:test/python/test_a.py::",
        )
        node = EXT / "test/unit/a.test.js"
        self.assertEqual(
            rr.note_key(_note(rr.NODE_KIND, node), EXT)[1],
            f"{REPO}:test/unit/a.test.js::",
        )

    def test_a_file_outside_the_repository_has_no_reference(self):
        note = _note(rr.NODE_KIND, "/elsewhere/a.test.js", "x")
        self.assertIsNone(rr.note_key(note, EXT))


class TestDeclaredVerdicts(unittest.TestCase):
    PY = EXT / "test/python/test_a.py"
    JS = EXT / "test/unit/a.test.js"
    REF_PY = f"{REPO}:test/python/test_a.py::A::test_x"
    REF_JS = f"{REPO}:test/unit/a.test.js::adds up"

    def verdicts(self, notes, declared):
        return rr.declared_verdicts(notes, declared, EXT)

    def test_only_declared_references_get_a_verdict(self):
        notes = [
            _note(rr.UNITTEST_KIND, self.PY, "test_x", "A"),
            _note(rr.UNITTEST_KIND, self.PY, "test_y", "A"),
        ]
        got = self.verdicts(notes, {(rr.UNITTEST_KIND, self.REF_PY)})
        self.assertEqual(list(got), [(rr.UNITTEST_KIND, self.REF_PY)])
        self.assertEqual(
            got[(rr.UNITTEST_KIND, self.REF_PY)]["result"], "passed"
        )

    def test_the_worst_note_wins_and_keeps_its_logs(self):
        notes = [
            _note(rr.UNITTEST_KIND, self.PY, "test_x", "A", "passed"),
            _note(rr.UNITTEST_KIND, self.PY, "test_x", "A", "failed", "i=1"),
            _note(rr.UNITTEST_KIND, self.PY, "test_x", "A", "failed", "i=2"),
            _note(rr.UNITTEST_KIND, self.PY, "test_x", "A", "skipped"),
        ]
        got = self.verdicts(notes, {(rr.UNITTEST_KIND, self.REF_PY)})
        verdict = got[(rr.UNITTEST_KIND, self.REF_PY)]
        self.assertEqual(verdict["result"], "failed")
        self.assertEqual(verdict["log"], "i=1\n\ni=2")

    def test_a_run_outcome_outweighs_a_skip(self):
        notes = [
            _note(rr.NODE_KIND, self.JS, "adds up", result="skipped"),
            _note(rr.NODE_KIND, self.JS, "adds up", result="passed"),
        ]
        got = self.verdicts(notes, {(rr.NODE_KIND, self.REF_JS)})
        self.assertEqual(got[(rr.NODE_KIND, self.REF_JS)]["result"], "passed")

    def test_a_class_fixture_error_reaches_the_tests_of_its_class(self):
        notes = [
            _note(rr.UNITTEST_KIND, self.PY, None, "A", "error", "setUp"),
            _note(rr.UNITTEST_KIND, self.PY, "test_z", "B"),
        ]
        other = f"{REPO}:test/python/test_a.py::B::test_z"
        got = self.verdicts(
            notes,
            {(rr.UNITTEST_KIND, self.REF_PY), (rr.UNITTEST_KIND, other)},
        )
        self.assertEqual(
            got[(rr.UNITTEST_KIND, self.REF_PY)],
            {"result": "error", "log": "setUp", "duration": 0.5},
        )
        self.assertEqual(got[(rr.UNITTEST_KIND, other)]["result"], "passed")

    def test_a_file_failure_reaches_every_declared_test_of_the_file(self):
        notes = [
            _note(rr.NODE_KIND, self.JS, "adds up"),
            _note(rr.NODE_KIND, self.JS, None, result="error", log="died"),
        ]
        got = self.verdicts(notes, {(rr.NODE_KIND, self.REF_JS)})
        self.assertEqual(got[(rr.NODE_KIND, self.REF_JS)]["result"], "error")
        self.assertEqual(got[(rr.NODE_KIND, self.REF_JS)]["log"], "died")

    def test_a_declared_test_missing_from_a_file_that_ran_is_an_error(self):
        notes = [_note(rr.NODE_KIND, self.JS, "another test")]
        got = self.verdicts(notes, {(rr.NODE_KIND, self.REF_JS)})
        verdict = got[(rr.NODE_KIND, self.REF_JS)]
        self.assertEqual(verdict["result"], "error")
        self.assertIn("adds up", verdict["log"])
        self.assertIn("test/unit/a.test.js", verdict["log"])

    def test_a_file_that_did_not_run_keeps_its_last_verdict(self):
        notes = [_note(rr.NODE_KIND, EXT / "test/unit/b.test.js", "other")]
        got = self.verdicts(notes, {(rr.NODE_KIND, self.REF_JS)})
        self.assertEqual(got, {})

    def test_a_note_of_one_kind_proves_nothing_of_the_other(self):
        notes = [_note(rr.NODE_KIND, self.JS, "adds up")]
        got = self.verdicts(notes, {(rr.UNITTEST_KIND, self.REF_JS)})
        self.assertEqual(got, {})


class TestEnvironment(unittest.TestCase):
    def config(self, env):
        out = io.StringIO()
        with mock.patch.object(rr.urllib.request, "urlopen") as urlopen:
            registry = rr.from_environment(env, out=out)
        urlopen.assert_not_called()
        return registry, out.getvalue()

    def test_no_variable_means_no_registry_and_no_output(self):
        self.assertEqual(self.config({}), (None, ""))

    def test_some_variables_only_is_one_warning_line(self):
        registry, out = self.config(
            {"ERPLIBRE_REQUIREMENT_URL": "https://registry.invalid"}
        )
        self.assertIsNone(registry)
        self.assertEqual(out.count("\n"), 1)
        self.assertIn("ERPLIBRE_REQUIREMENT_KEY", out)

    def test_https_or_loopback_http_is_accepted(self):
        for url in (
            "https://registry.invalid",
            "http://127.0.0.1:8069",
            "http://localhost:8069",
            "http://[::1]:8069",
        ):
            with self.subTest(url=url):
                registry, out = self.config(
                    {**ENV, "ERPLIBRE_REQUIREMENT_URL": url}
                )
                self.assertIsInstance(registry, rr.Registry)
                self.assertEqual(out, "")

    def test_http_to_another_host_is_refused_in_one_line(self):
        for url in (
            "http://192.0.2.10:8069",
            "http://localhost.invalid",
            "ftp://registry.invalid",
            f"http://runner:{KEY}@192.0.2.10:8069/?key={KEY}",
        ):
            with self.subTest(url=url):
                registry, out = self.config(
                    {**ENV, "ERPLIBRE_REQUIREMENT_URL": url}
                )
                self.assertIsNone(registry)
                self.assertEqual(out.count("\n"), 1)
                self.assertNotIn(KEY, out)
                self.assertNotIn("runner", out)


class TestPush(unittest.TestCase):
    PY = EXT / "test/python/test_a.py"
    JS = EXT / "test/unit/a.test.js"
    REF_PY = f"{REPO}:test/python/test_a.py::A::test_x"
    REF_JS = f"{REPO}:test/unit/a.test.js::adds up"

    def push(self, fake, notes, registry=None):
        registry = registry or rr.Registry(
            "https://registry.invalid/", "registry", "runner", KEY
        )
        out = io.StringIO()
        with mock.patch.object(rr.urllib.request, "urlopen", fake.urlopen):
            registry.push(notes, root=EXT, out=out)
        return out.getvalue()

    def test_one_read_then_one_call_per_declared_verdict(self):
        fake = FakeRegistry(
            [
                (rr.UNITTEST_KIND, self.REF_PY),
                (rr.NODE_KIND, self.REF_JS),
                (rr.NODE_KIND, self.REF_JS),
                (rr.NODE_KIND, f"{REPO}:test/unit/b.test.js::not run"),
            ]
        )
        notes = [
            _note(rr.UNITTEST_KIND, self.PY, "test_x", "A", "failed", "AE"),
            _note(rr.NODE_KIND, self.JS, "adds up"),
            _note(rr.NODE_KIND, self.JS, "undeclared"),
        ]
        out = self.push(fake, notes)
        names = [name for _, name, _ in fake.calls]
        self.assertEqual(
            names,
            ["login", "search_read"] + ["record_result_by_reference"] * 2,
        )
        domain = fake.calls[1][2][5][0]
        self.assertIn(["kind", "in", [rr.NODE_KIND, rr.UNITTEST_KIND]], domain)
        self.assertIn(["reference", "=like", f"{REPO}:%"], domain)
        sent = fake.sent()
        self.assertEqual(
            sent[(rr.UNITTEST_KIND, self.REF_PY)],
            ("failed", {"log": "AE", "duration": 0.5}),
        )
        self.assertEqual(sent[(rr.NODE_KIND, self.REF_JS)][0], "passed")
        self.assertEqual(out.count("\n"), 1)
        self.assertIn("2 verdicts sent, 3 lines updated", out)

    def test_every_call_carries_the_timeout(self):
        fake = FakeRegistry([(rr.NODE_KIND, self.REF_JS)])
        self.push(fake, [_note(rr.NODE_KIND, self.JS, "adds up")])
        self.assertEqual(fake.timeouts, [rr.TIMEOUT] * 3)

    def test_a_refused_login_is_one_warning_line(self):
        fake = FakeRegistry(key="another-key")
        out = self.push(fake, [_note(rr.NODE_KIND, self.JS, "adds up")])
        self.assertEqual(out.count("\n"), 1)
        self.assertIn("runner", out)
        self.assertEqual([name for _, name, _ in fake.calls], ["login"])

    def test_a_server_error_is_one_warning_line_without_the_key(self):
        fake = FakeRegistry(
            [(rr.NODE_KIND, self.REF_JS)],
            error_on="record_result_by_reference",
            error=f"AccessError for key {KEY}\nsecond line",
        )
        out = self.push(fake, [_note(rr.NODE_KIND, self.JS, "adds up")])
        self.assertEqual(out.count("\n"), 1)
        self.assertIn("AccessError", out)
        self.assertNotIn(KEY, out)

    def test_an_unreachable_registry_never_raises(self):
        def unreachable(request, timeout=None):
            raise urllib.error.URLError("connection refused")

        fake = FakeRegistry()
        fake.urlopen = unreachable
        out = self.push(fake, [_note(rr.NODE_KIND, self.JS, "adds up")])
        self.assertEqual(out.count("\n"), 1)
        self.assertIn("connection refused", out)

    def test_an_interrupt_during_the_push_is_one_warning_line(self):
        def interrupted(request, timeout=None):
            raise KeyboardInterrupt

        fake = FakeRegistry()
        fake.urlopen = interrupted
        out = self.push(fake, [_note(rr.NODE_KIND, self.JS, "adds up")])
        self.assertEqual(out.count("\n"), 1)
        self.assertIn("interrupted", out)

    def test_the_sent_log_names_no_home_nor_key(self):
        root = Path("/srv/invented-account/repo")
        registry = rr.Registry("https://registry.invalid/", "r", "u", KEY)
        with mock.patch.dict(os.environ, {"HOME": "/srv/invented-account"}):
            log = registry._neutralize(
                f'File "{root}/test/python/test_a.py", line 3\n'
                f"key {KEY} in /srv/invented-account/.cache/x\n"
                f"{root}2/other /x{root}",
                root,
            )
        self.assertEqual(
            log,
            'File "test/python/test_a.py", line 3\n'
            "key *** in ~/.cache/x\n"
            f"~/repo2/other /x{root}",
        )

    def test_a_key_holding_a_percent_sequence_is_masked_in_a_file_url(self):
        """Decoding the URL would turn « %41 » into « A »: the key is
        masked before, then again for a key that was itself encoded."""
        key = "k%41y-invented"
        registry = rr.Registry("https://registry.invalid/", "r", "u", key)
        log = registry._neutralize(
            f"at t (file:///opt/x.js?{key}:1:2)\n"
            "at u (file:///opt/y.js?k%2541y-invented:1:2)",
            "/srv/invented-root",
        )
        self.assertEqual(
            log,
            "at t (file:///opt/x.js?***:1:2)\nat u (file:///opt/y.js?***:1:2)",
        )

    def test_a_file_url_of_a_stack_becomes_a_relative_path(self):
        root = Path("/srv/invented account/repo")
        registry = rr.Registry("https://registry.invalid/", "r", "u", KEY)
        with mock.patch.dict(os.environ, {"HOME": "/srv/invented account"}):
            log = registry._neutralize(
                "at t (file:///srv/invented%20account/repo/test/unit/"
                "a.test.js:23:56)\n"
                "at u (file:///srv/invented%20account/lib/x.js:1:2)",
                root,
            )
        self.assertEqual(
            log,
            "at t (test/unit/a.test.js:23:56)\nat u (~/lib/x.js:1:2)",
        )

    # Invented roots: a space, which every file URL encodes, next to a
    # character that node's pathToFileURL keeps as is and Python's quote
    # encodes (« + », « @ », « ( »), or the reverse (« ~ »).
    ODD_ROOTS = (
        "/srv/invented base+one/repo",
        "/srv/invented@two base/repo",
        "/srv/invented (three)/repo",
        "/srv/~invented four/repo",
    )

    @staticmethod
    def _node_urls(paths):
        """The file URL node's own pathToFileURL gives each of `paths`."""
        script = (
            "const {pathToFileURL} = require('node:url');"
            "for (const p of JSON.parse(process.argv[1]))"
            " console.log(pathToFileURL(p).href);"
        )
        done = subprocess.run(
            ["node", "-e", script, json.dumps(list(paths))],
            capture_output=True,
            text=True,
            check=True,
        )
        return done.stdout.splitlines()

    def test_a_node_file_url_of_an_odd_root_leaves_no_root(self):
        registry = rr.Registry("https://registry.invalid/", "r", "u", KEY)
        for root in self.ODD_ROOTS:
            home = os.path.dirname(root)
            url_root, url_home = self._node_urls([root, home + "/lib/x.js"])
            with self.subTest(root=root), mock.patch.dict(
                os.environ, {"HOME": home}
            ):
                log = registry._neutralize(
                    f"at t ({url_root}/test/unit/a.test.js:23:56)\n"
                    f"at u ({url_home}:1:2)\n"
                    f"in {url_root}",
                    Path(root),
                )
                self.assertEqual(
                    log,
                    "at t (test/unit/a.test.js:23:56)\n"
                    "at u (~/lib/x.js:1:2)\n"
                    "in .",
                )

    def test_every_encoding_of_an_odd_root_is_made_relative(self):
        registry = rr.Registry("https://registry.invalid/", "r", "u", KEY)
        for root in self.ODD_ROOTS:
            forms = (
                root,
                "file://" + rr.urllib.parse.quote(root),
                "file://" + rr.urllib.parse.quote(root, safe="/@+()~"),
            )
            for form in forms:
                with self.subTest(form=form), mock.patch.dict(
                    os.environ, {"HOME": "/nonexistent-home"}
                ):
                    log = registry._neutralize(
                        f"at t ({form}/test/unit/a.test.js:1:2)", Path(root)
                    )
                    self.assertEqual(log, "at t (test/unit/a.test.js:1:2)")

    def test_the_sent_log_of_an_odd_root_names_none_of_it(self):
        for root in self.ODD_ROOTS:
            js = Path(root) / "test/unit/a.test.js"
            (url,) = self._node_urls([str(js)])
            fake = FakeRegistry([(rr.NODE_KIND, TestPush.REF_JS)])
            registry = rr.Registry(
                "https://registry.invalid/", "registry", "runner", KEY
            )
            note = _note(
                rr.NODE_KIND,
                js,
                "adds up",
                result="failed",
                log=f"Error: no\n    at t ({url}:23:56)\n    at {js}:1:2",
            )
            with self.subTest(root=root), mock.patch.object(
                rr.urllib.request, "urlopen", fake.urlopen
            ), mock.patch.dict(os.environ, {"HOME": "/nonexistent-home"}):
                registry.push([note], root=Path(root), out=io.StringIO())
                (sent,) = fake.sent().values()
                log = sent[1]["log"]
                self.assertNotIn("invented", log)
                self.assertNotIn("/srv", log)
                self.assertIn("at t (test/unit/a.test.js:23:56)", log)
                self.assertIn("at test/unit/a.test.js:1:2", log)


FIXTURE_PY = """\
import unittest


class A(unittest.TestCase):
    def test_ok(self):
        pass

    def test_fails(self):
        self.assertEqual(1, 2)

    def test_sub(self):
        for i in range(3):
            with self.subTest(i=i):
                self.assertNotEqual(i, 1)

    @unittest.skip("absent")
    def test_skip(self):
        pass

    def test_err(self):
        raise KeyError("x")

    @unittest.expectedFailure
    def test_expected(self):
        self.assertTrue(False)

    @unittest.expectedFailure
    def test_unexpected(self):
        pass


class B(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        raise RuntimeError("fixture")

    def test_b(self):
        pass
"""


class TestUnittestNotes(unittest.TestCase):
    NOTES = TEST_DIR / "unittest_notes.py"

    def setUp(self):
        self.root = _tmp(self)
        suite = self.root / "test" / "python"
        suite.mkdir(parents=True)
        (suite / "test_demo.py").write_text(FIXTURE_PY, encoding="utf-8")
        (suite / "test_broken.py").write_text(
            "raise ImportError('broken at import')\n", encoding="utf-8"
        )

    def run_in(self, argv):
        return subprocess.run(
            argv,
            cwd=self.root,
            capture_output=True,
            text=True,
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
        )

    def test_each_outcome_is_noted_under_its_file_class_and_method(self):
        out = self.root / "notes.json"
        run = self.run_in(
            [
                sys.executable,
                str(self.NOTES),
                str(out),
                "discover",
                "-s",
                "test/python",
            ]
        )
        self.assertEqual(run.returncode, 1, run.stderr)
        notes = json.loads(out.read_text(encoding="utf-8"))
        seen = {
            (Path(n["file"]).name, n["class"], n["test"], n["result"])
            for n in notes
        }
        demo = "test_demo.py"
        for expected in (
            (demo, "A", "test_ok", "passed"),
            (demo, "A", "test_fails", "failed"),
            (demo, "A", "test_sub", "failed"),
            (demo, "A", "test_skip", "skipped"),
            (demo, "A", "test_err", "error"),
            (demo, "A", "test_expected", "passed"),
            (demo, "A", "test_unexpected", "failed"),
            (demo, "B", None, "error"),
            ("test_broken.py", None, None, "error"),
        ):
            self.assertIn(expected, seen)
        self.assertTrue(all(n["kind"] == rr.UNITTEST_KIND for n in notes))
        self.assertTrue(
            all(
                Path(n["file"]).parent == self.root / "test/python"
                for n in notes
            )
        )
        (sub,) = [n for n in notes if n["test"] == "test_sub"]
        self.assertIn("i=1", sub["log"])
        (broken,) = [n for n in notes if n["file"].endswith("broken.py")]
        self.assertIn("broken at import", broken["log"])

    def test_the_output_and_exit_code_are_those_of_unittest(self):
        def scrub(text):
            # The run time is the only part that changes between two runs.
            return "\n".join(
                line
                for line in text.splitlines()
                if not line.startswith("Ran ")
            )

        plain = self.run_in(
            [sys.executable, "-m", "unittest", "discover", "-s", "test/python"]
        )
        noted = self.run_in(
            [
                sys.executable,
                str(self.NOTES),
                str(self.root / "n.json"),
                "discover",
                "-s",
                "test/python",
            ]
        )
        self.assertEqual(noted.returncode, plain.returncode)
        self.assertEqual(scrub(noted.stderr), scrub(plain.stderr))
        self.assertEqual(noted.stdout, plain.stdout)

    def test_the_tests_import_from_the_working_directory_first(self):
        # As with `python3 -m unittest`: the working directory, not the
        # directory of unittest_notes.py, heads the import path.
        (self.root / "invented_helper.py").write_text(
            "VALUE = 4\n", encoding="utf-8"
        )
        (self.root / "test/python/test_cwd.py").write_text(
            "import unittest\n"
            "import invented_helper\n\n\n"
            "class C(unittest.TestCase):\n"
            "    def test_value(self):\n"
            "        self.assertEqual(invented_helper.VALUE, 4)\n",
            encoding="utf-8",
        )
        out = self.root / "notes.json"
        run = self.run_in(
            [
                sys.executable,
                str(self.NOTES),
                str(out),
                "discover",
                "-s",
                "test/python",
                "-p",
                "test_cwd.py",
            ]
        )
        self.assertEqual(run.returncode, 0, run.stderr)
        notes = json.loads(out.read_text(encoding="utf-8"))
        self.assertEqual(
            [(n["class"], n["test"], n["result"]) for n in notes],
            [("C", "test_value", "passed")],
        )


class FakeServer:
    """FakeRegistry served over HTTP on 127.0.0.1, port chosen by the OS."""

    def __init__(self, case, registry):
        fake = registry

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers["Content-Length"])
                body = fake.answer(json.loads(self.rfile.read(length)))
                data = json.dumps(body).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(
            target=self.server.serve_forever, daemon=True
        )
        thread.start()
        case.addCleanup(self.server.server_close)
        case.addCleanup(self.server.shutdown)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"


NODE_SUITE = """\
import {test} from 'node:test';
import assert from 'node:assert/strict';
test('adds up', () => assert.equal(1 + 1, 2));
test('sees no key', () =>
    assert.equal(process.env.ERPLIBRE_REQUIREMENT_KEY, undefined));
test('fails when asked', () =>
    assert.equal(process.env.SUITE_FAILS ?? 'no', 'no'));
"""

PYTHON_SUITE = """\
import os
import unittest


class P(unittest.TestCase):
    def test_ok(self):
        pass

    def test_sees_no_key(self):
        self.assertIsNone(os.environ.get("ERPLIBRE_REQUIREMENT_KEY"))

    def test_dies_when_asked(self):
        if os.environ.get("SUITE_DIES"):
            os._exit(3)
"""


class TestRunSuites(unittest.TestCase):
    JS = f"{REPO}:test/unit/a.test.js::"
    PY = f"{REPO}:test/python/test_p.py::P::"

    def declared(self):
        return [
            (rr.NODE_KIND, self.JS + "adds up"),
            (rr.NODE_KIND, self.JS + "sees no key"),
            (rr.NODE_KIND, self.JS + "fails when asked"),
            (rr.NODE_KIND, self.JS + "renamed away"),
            (rr.UNITTEST_KIND, self.PY + "test_ok"),
            (rr.UNITTEST_KIND, self.PY + "test_sees_no_key"),
        ]

    def make_repo(self):
        root = _tmp(self)
        (root / "test/unit").mkdir(parents=True)
        (root / "test/python").mkdir(parents=True)
        (root / "test/unit/a.test.js").write_text(NODE_SUITE, encoding="utf-8")
        (root / "test/python/test_p.py").write_text(
            PYTHON_SUITE, encoding="utf-8"
        )
        return root

    def run_main(self, root, env):
        out = io.StringIO()
        stdio = tempfile.TemporaryFile(mode="w+")
        self.addCleanup(stdio.close)
        base = {
            k: v
            for k, v in os.environ.items()
            if k not in rr.VARIABLES and k != "NODE_TEST_CONTEXT"
        }
        # Without a registry main would exec the suites in place of this
        # test process: that must fail the test instead.
        with mock.patch.object(
            rs.os, "execvpe", side_effect=AssertionError("no registry")
        ):
            code = rs.main(
                root=root, env={**base, **env}, out=out, stdio=stdio
            )
        stdio.seek(0)
        return code, out.getvalue(), stdio.read()

    def exec_main(self, env, out):
        """The arguments main passes to os.execvpe, which is stopped."""

        class Exec(Exception):
            pass

        with mock.patch.object(
            rs.os, "execvpe", side_effect=Exec
        ) as execvpe, mock.patch.object(
            rs.os, "chdir"
        ) as chdir, mock.patch.object(
            rr.urllib.request, "urlopen"
        ) as urlopen:
            with self.assertRaises(Exec):
                rs.main(env=env, out=out)
        chdir.assert_called_once_with(rs.ROOT)
        urlopen.assert_not_called()
        execvpe.assert_called_once()
        return execvpe.call_args.args

    def test_without_the_registry_the_suites_run_as_before(self):
        out = mock.Mock()
        args = self.exec_main({"OTHER": "kept"}, out)
        self.assertEqual(
            args,
            (
                "sh",
                [
                    "sh",
                    "-c",
                    "node --test test/unit/*.test.js"
                    " && python3 -m unittest discover -s test/python",
                ],
                {"OTHER": "kept"},
            ),
        )
        out.flush.assert_called()

    def test_a_partial_or_refused_registry_keeps_its_variables_away(self):
        for env in (
            {"ERPLIBRE_REQUIREMENT_KEY": KEY},
            {**ENV, "ERPLIBRE_REQUIREMENT_URL": "http://192.0.2.10:8069"},
        ):
            with self.subTest(variables=sorted(env)):
                out = io.StringIO()
                _, _, children = self.exec_main({**env, "OTHER": "kept"}, out)
                self.assertEqual(children, {"OTHER": "kept"})
                self.assertEqual(out.getvalue().count("\n"), 1)
                self.assertNotIn(KEY, out.getvalue())

    def test_an_interrupt_between_the_suites_sends_nothing(self):
        out = io.StringIO()
        with mock.patch.object(
            rs, "node_major", side_effect=KeyboardInterrupt
        ), mock.patch.object(rs, "_run") as run, mock.patch.object(
            rr.urllib.request, "urlopen"
        ) as urlopen:
            code = rs.main(root=_tmp(self), env=ENV, out=out)
        self.assertEqual(code, 130)
        run.assert_not_called()
        urlopen.assert_not_called()
        self.assertIn("no verdict sent", out.getvalue())

    def test_the_suites_receive_neither_the_registry_nor_a_test_context(self):
        env = {**ENV, "NODE_TEST_CONTEXT": "child-v8", "OTHER": "kept"}
        with mock.patch.object(
            rs, "_run", return_value=130
        ) as run, mock.patch.object(rs, "node_major", return_value=22):
            rs.main(root=_tmp(self), env=env, out=io.StringIO())
        self.assertEqual(run.call_args.args[2], {"OTHER": "kept"})

    def test_a_child_killed_by_a_signal_gives_128_plus_its_number(self):
        code = rs._run(
            "kill -TERM $$",
            _tmp(self),
            {"PATH": os.environ.get("PATH", "")},
            subprocess.DEVNULL,
        )
        self.assertEqual(code, 128 + signal.SIGTERM)

    def test_each_declared_test_gets_the_verdict_of_this_run(self):
        root = self.make_repo()
        fake = FakeRegistry(self.declared())
        server = FakeServer(self, fake)
        code, out, suites = self.run_main(
            root, {**ENV, "ERPLIBRE_REQUIREMENT_URL": server.url}
        )
        self.assertEqual(code, 0, suites)
        sent = {ref: result for (_, ref), (result, _) in fake.sent().items()}
        self.assertEqual(
            sent,
            {
                self.JS + "adds up": "passed",
                self.JS + "sees no key": "passed",
                self.JS + "fails when asked": "passed",
                self.JS + "renamed away": "error",
                self.PY + "test_ok": "passed",
                self.PY + "test_sees_no_key": "passed",
            },
        )
        self.assertEqual(out.count("\n"), 1)
        self.assertIn("6 verdicts sent, 6 lines updated", out)
        self.assertNotIn(KEY, out + suites)
        self.assertNotIn(str(root), json.dumps(fake.calls))

    def test_a_failing_node_suite_keeps_its_code_and_skips_python(self):
        root = self.make_repo()
        fake = FakeRegistry(self.declared())
        server = FakeServer(self, fake)
        code, out, suites = self.run_main(
            root,
            {
                **ENV,
                "ERPLIBRE_REQUIREMENT_URL": server.url,
                "SUITE_FAILS": "yes",
            },
        )
        self.assertEqual(code, 1, suites)
        sent = {ref: result for (_, ref), (result, _) in fake.sent().items()}
        self.assertEqual(sent[self.JS + "fails when asked"], "failed")
        self.assertNotIn(self.PY + "test_ok", sent)
        self.assertNotIn("Ran ", suites)

    def test_a_suite_that_dies_errs_the_tests_of_its_files(self):
        root = self.make_repo()
        fake = FakeRegistry(self.declared())
        server = FakeServer(self, fake)
        code, out, suites = self.run_main(
            root,
            {
                **ENV,
                "ERPLIBRE_REQUIREMENT_URL": server.url,
                "SUITE_DIES": "yes",
            },
        )
        self.assertEqual(code, 3, suites)
        sent = {ref: result for (_, ref), (result, _) in fake.sent().items()}
        self.assertEqual(sent[self.PY + "test_ok"], "error")
        self.assertEqual(sent[self.JS + "adds up"], "passed")

    def test_an_unreachable_registry_is_one_line_and_keeps_the_code(self):
        root = self.make_repo()
        server = FakeServer(self, FakeRegistry())
        url = server.url
        server.server.shutdown()
        server.server.server_close()
        code, out, suites = self.run_main(
            root, {**ENV, "ERPLIBRE_REQUIREMENT_URL": url}
        )
        self.assertEqual(code, 0, suites)
        self.assertEqual(out.count("\n"), 1)
        self.assertIn("interrupted after 0 verdict(s)", out)
        self.assertNotIn(KEY, out + suites)

    def test_a_node_suite_ending_without_notes_errs_its_files(self):
        root = self.make_repo()
        with mock.patch.object(rs, "_run", return_value=127) as run:
            code, notes = rs._run_noted(root, {}, io.StringIO(), None)
        self.assertEqual(code, 127)
        self.assertEqual(run.call_count, 1)
        self.assertEqual(
            [(n["kind"], n["file"], n["test"], n["result"]) for n in notes],
            [(rr.NODE_KIND, str(root / "test/unit/a.test.js"), None, "error")],
        )
        self.assertIn("exit code 127", notes[0]["log"])

    def test_an_interrupted_suite_sends_nothing(self):
        out = io.StringIO()
        with mock.patch.object(
            rs, "_run", return_value=130
        ), mock.patch.object(rr.urllib.request, "urlopen") as urlopen:
            code = rs.main(root=_tmp(self), env=ENV, out=out)
        self.assertEqual(code, 130)
        urlopen.assert_not_called()
        self.assertEqual(out.getvalue().count("\n"), 1)
        self.assertIn("no verdict sent", out.getvalue())

    def test_the_node_command_keeps_its_files_and_adds_the_reporters(self):
        command = rs.node_command(Path("/tmp/n.jsonl"), "tap")
        self.assertTrue(
            command.startswith(
                "node --test --test-reporter=tap"
                " --test-reporter-destination="
                "stdout --test-reporter="
            )
        )
        self.assertTrue(command.endswith(" test/unit/*.test.js"))

    def test_the_reporter_is_the_one_node_would_choose(self):
        for tty, major, reporter in (
            (True, 22, "spec"),
            (False, 22, "tap"),
            (False, None, "tap"),
            (False, 23, "spec"),
            (False, 24, "spec"),
        ):
            with self.subTest(tty=tty, major=major):
                self.assertEqual(rs.default_reporter(tty, major), reporter)

    def test_the_node_version_is_read_from_the_node_the_suites_use(self):
        self.assertIsInstance(rs.node_major(_tmp(self), os.environ), int)
        empty = _tmp(self)
        self.assertIsNone(rs.node_major(empty, {"PATH": str(empty)}))


if __name__ == "__main__":
    unittest.main()
