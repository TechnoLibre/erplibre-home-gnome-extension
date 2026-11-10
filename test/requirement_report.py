#!/usr/bin/env python3
# © 2026 TechnoLibre (http://www.technolibre.ca)
# License AGPL-3.0 or later (http://www.gnu.org/licenses/agpl)
"""Pushes the verdict of each test of this repository to the requirement
registry.

The registry is an Odoo instance where the `erplibre_devops_requirement`
module lists, for each requirement, the tests that prove it. A proof made
by a test of this repository is a test line whose reference reads

    erplibre-home-gnome-extension:test/unit/<file>::<test name>
    erplibre-home-gnome-extension:test/python/<file>::<Class>::<method>

of kind `node_test` for the first form and `repo_unittest` for the second,
the path being relative to the repository root. This module turns the
notes of a run (test/requirement-reporter.mjs for node, unittest_notes.py
for Python) into those references, then writes each verdict through
`devops.requirement.test.record_result_by_reference`, over JSON-RPC. It
needs only the Python standard library and imports nothing from ERPLibre;
ERPLibre's own runner has a client of the same contract for its tests.

The configuration comes from the environment, all four variables or none:

    ERPLIBRE_REQUIREMENT_URL    HTTPS root of the Odoo instance
    ERPLIBRE_REQUIREMENT_DB     its database
    ERPLIBRE_REQUIREMENT_LOGIN  a user of the runner group
    ERPLIBRE_REQUIREMENT_KEY    that user's API key

None set: `from_environment` returns None without printing anything, and
`npm test` runs as without this module: no connection, same output, same
exit code. Some set only: one warning line, nothing sent. Plain HTTP is
accepted only towards a loopback address (an SSH tunnel to the instance):
anywhere else the key would travel in clear.

Only the references the registry declares are sent: one read of this
repository's `node_test` and `repo_unittest` lines, then one call per
declared reference that has a verdict. A test that no requirement cites
costs no call and leaves no warning in the server's log.

The push stops at the first failure (server unreachable, credentials
refused, missing right, Ctrl+C) and says so in ONE line; it never raises,
and the suites' exit code does not depend on it. The key is never printed:
every readable message goes through `Registry._mask`, and every sent log
through `Registry._neutralize`, which also turns the paths under the
repository root into relative ones and the home directory into « ~ ».
"""

import ipaddress
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

YELLOW = "\033[0;33m"
END = "\033[0m"

VARIABLES = (
    "ERPLIBRE_REQUIREMENT_URL",
    "ERPLIBRE_REQUIREMENT_DB",
    "ERPLIBRE_REQUIREMENT_LOGIN",
    "ERPLIBRE_REQUIREMENT_KEY",
)

REPOSITORY = "erplibre-home-gnome-extension"
NODE_KIND = "node_test"
UNITTEST_KIND = "repo_unittest"
KINDS = (NODE_KIND, UNITTEST_KIND)
MODEL = "devops.requirement.test"

# The repository root: test/ is one level below it.
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# From the least to the most severe: several notes of one test (its
# subtests, its class fixture, its file) come down to the most severe.
SEVERITY = {"skipped": 0, "passed": 1, "failed": 2, "error": 3}

# Timeout of one call, in seconds: past it, the push stops.
TIMEOUT = 30


class RegistryUnavailable(Exception):
    """The registry refused or did not answer; the message is readable."""


def _base(path, root):
    """`erplibre-home-gnome-extension:<relative path>`, or None outside
    `root`."""
    relative = os.path.relpath(os.path.abspath(path), root)
    if relative == os.pardir or relative.startswith(os.pardir + os.sep):
        return None
    return f"{REPOSITORY}:{relative.replace(os.sep, '/')}"


def _verdict(result, log, duration):
    return {"result": result, "log": log or None, "duration": duration}


def note_key(note, root=ROOT):
    """(kind, key) of a note, or None for a file outside `root`.

    A note is a dict with `kind`, `file`, `test`, `result`, `log`,
    `duration`, plus `class` for a unittest note. The key of a test is its
    full reference. A note without a test is a PREFIX: `<base>::<Class>::`
    for a unittest class fixture, `<base>::` for a file that failed as a
    whole (import error, module fixture, process failure)."""
    kind = note.get("kind")
    base = _base(note.get("file") or "", root) if note.get("file") else None
    if base is None or kind not in KINDS:
        return None
    test = note.get("test")
    if kind == NODE_KIND:
        return kind, f"{base}::{test}" if test else f"{base}::"
    cls = note.get("class")
    if not cls:
        return kind, f"{base}::"
    return kind, f"{base}::{cls}::{test}" if test else f"{base}::{cls}::"


def _prefixes(kind, reference):
    """The prefixes whose notes also apply to `reference`: that of its
    file and, for a unittest reference, that of its class."""
    base, separator, test = reference.partition("::")
    if not separator:
        return []
    prefixes = [f"{base}::"]
    cls, separator, _ = test.partition("::")
    if kind == UNITTEST_KIND and separator:
        prefixes.append(f"{base}::{cls}::")
    return prefixes


def _worst(verdicts):
    """The most severe verdict; its duration is the longest, its log joins
    those of the notes of the same severity."""
    worst = max(verdicts, key=lambda v: SEVERITY.get(v["result"], 3))
    logs = [
        v["log"]
        for v in verdicts
        if v["result"] == worst["result"] and v["log"]
    ]
    return _verdict(
        worst["result"],
        "\n\n".join(logs),
        max(v["duration"] for v in verdicts),
    )


def declared_verdicts(notes, declared, root=ROOT):
    """{(kind, reference): verdict} for each pair of `declared` that the
    `notes` cover, by the reference itself or by the prefix of its class or
    its file.

    A file with at least one note ran COMPLETELY: the node reporter and
    unittest_notes.py write their notes once the whole run is over. A
    declared reference of such a file that nothing noted names a test that
    no longer exists there, renamed or deleted: it gets an error that says
    so, rather than keeping a verdict that proves nothing any more. A
    reference of a file that did not run is left out: its last verdict
    stays the registry's."""
    noted = {}
    complete = set()
    for note in notes:
        found = note_key(note, root)
        if found is None:
            continue
        kind, key = found
        result = note.get("result")
        if result not in SEVERITY:
            result = "error"
        noted.setdefault((kind, key), []).append(
            _verdict(result, note.get("log"), float(note.get("duration") or 0))
        )
        complete.add((kind, key.partition("::")[0]))
    verdicts = {}
    for kind, reference in declared:
        found = list(noted.get((kind, reference), []))
        for prefix in _prefixes(kind, reference):
            found += noted.get((kind, prefix), [])
        base, separator, test = reference.partition("::")
        if found:
            verdicts[(kind, reference)] = _worst(found)
        elif separator and (kind, base) in complete:
            verdicts[(kind, reference)] = _verdict(
                "error",
                f"{test} missing from {base.split(':', 1)[1]} in a complete"
                " run of the file: test renamed or deleted, the reference"
                " is to update.",
                0.0,
            )
    return verdicts


def _displayable(url):
    """`url` without credentials nor query: what can be printed."""
    parts = urllib.parse.urlsplit(url)
    host = parts.hostname or ""
    try:
        if parts.port:
            host += f":{parts.port}"
    except ValueError:
        pass
    return urllib.parse.urlunsplit((parts.scheme, host, parts.path, "", ""))


def warn(message, out=None):
    """One yellow line « Requirement registry: `message` » on `out`,
    standard output by default."""
    print(
        f"  {YELLOW}Requirement registry: {message}{END}",
        file=out or sys.stdout,
    )


def _loopback(host):
    """True when `host` names this machine: `localhost` or a loopback
    address, IPv4 or IPv6."""
    if (host or "").lower() in ("localhost", "localhost."):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def from_environment(env=None, out=None):
    """The Registry the environment configures, or None.

    No variable: None, printing nothing. Some only, a URL that is not
    HTTPS, or HTTP towards a host that is not loopback: None and one
    warning line on `out`, without any connection."""
    env = os.environ if env is None else env
    out = out or sys.stdout
    values = {name: (env.get(name) or "").strip() for name in VARIABLES}
    if not any(values.values()):
        return None
    missing = [name for name, value in values.items() if not value]
    if missing:
        warn(f"{', '.join(missing)} not set, no verdict sent.", out=out)
        return None
    url, database, login, key = (values[name] for name in VARIABLES)
    parts = urllib.parse.urlsplit(url)
    if parts.scheme == "https":
        return Registry(url, database, login, key)
    if parts.scheme == "http" and _loopback(parts.hostname):
        return Registry(url, database, login, key)
    if parts.scheme == "http":
        reason = (
            "plain HTTP off this machine would carry the key in clear;"
            " HTTPS, or a tunnel to localhost"
        )
    else:
        reason = "neither HTTPS nor HTTP"
    warn(f"URL « {_displayable(url)} »: {reason}, no verdict sent.", out=out)
    return None


class Registry:
    """An Odoo instance that receives the verdicts, through /jsonrpc."""

    def __init__(self, url, database, login, key, timeout=TIMEOUT):
        self.url = url.rstrip("/")
        self.database = database
        self.login = login
        self.key = key
        self.timeout = timeout
        self._id = 0

    def _mask(self, text, limit=None):
        """`text` on one line, the key replaced by « *** »; cut at `limit`
        characters when given."""
        if self.key:
            text = text.replace(self.key, "***")
        text = " ".join(text.split())
        if limit and len(text) > limit:
            text = text[: limit - 1] + "…"
        return text

    def _neutralize(self, log, root):
        """`log` as it may leave for the registry, lines kept: the key
        replaced by « *** », a path under `root` made relative to it, the
        home directory replaced by « ~ ». None stays None.

        A path is replaced only whole: `/repo` touches neither `/repo2` nor
        `/x/repo`. A `file://` URL of such a path, as in a node stack,
        becomes the same relative path rather than a URL without its root.
        The root goes before the home directory, which usually holds it.

        Every `file://` token is percent-decoded first, so the paths are
        matched in one form whatever set of characters the writer encoded:
        node's pathToFileURL keeps « + @ ( » and encodes « ~ », Python's
        quote does the reverse. The key is replaced before the decoding,
        which could rewrite a key holding a « %XX » sequence, and again
        after it, which catches a key that was encoded in a URL."""
        if not log:
            return log
        if self.key:
            log = log.replace(self.key, "***")
        log = re.sub(
            r"file://\S+", lambda m: urllib.parse.unquote(m.group()), log
        )
        if self.key:
            log = log.replace(self.key, "***")
        for path, below, alone in (
            (os.path.abspath(root), "", "."),
            (os.path.expanduser("~"), "~/", "~"),
        ):
            path = str(path).rstrip(os.sep)
            if not path:
                continue
            path = rf"(?<![\w.-])(?:file://)?{re.escape(path)}"
            log = re.sub(path + re.escape(os.sep), below, log)
            log = re.sub(path + r"(?![\w.-])", alone, log)
        return log

    def _call(self, service, method, args):
        """The `result` of one JSON-RPC call; RegistryUnavailable when the
        server answers an error."""
        self._id += 1
        body = {
            "jsonrpc": "2.0",
            "method": "call",
            "id": self._id,
            "params": {"service": service, "method": method, "args": args},
        }
        request = urllib.request.Request(
            self.url + "/jsonrpc",
            data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=self.timeout) as answer:
            data = json.loads(answer.read().decode("utf-8"))
        error = data.get("error")
        if error:
            detail = (error.get("data") or {}).get("message")
            raise RegistryUnavailable(detail or error.get("message") or "")
        return data.get("result")

    def _execute(self, uid, method, args, kwargs):
        return self._call(
            "object",
            "execute_kw",
            [self.database, uid, self.key, MODEL, method, args, kwargs],
        )

    def push(self, notes, root=None, out=None):
        """Sends the verdict of each declared reference the `notes` cover,
        then writes one line: the count, or the warning of the first
        failure. Never raises. `root`: ROOT by default."""
        root = root or ROOT
        out = out or sys.stdout
        sent = updated = 0
        try:
            uid = self._call(
                "common", "login", [self.database, self.login, self.key]
            )
            if not uid:
                raise RegistryUnavailable(
                    f"credentials refused for « {self.login} »"
                )
            lines = self._execute(
                uid,
                "search_read",
                [
                    [
                        ["kind", "in", list(KINDS)],
                        ["reference", "=like", f"{REPOSITORY}:%"],
                    ]
                ],
                {"fields": ["kind", "reference"]},
            )
            declared = {
                (line["kind"], line["reference"]) for line in lines or []
            }
            verdicts = declared_verdicts(notes, declared, root)
            for kind, reference in sorted(verdicts):
                verdict = verdicts[(kind, reference)]
                updated += int(
                    self._execute(
                        uid,
                        "record_result_by_reference",
                        [kind, reference, verdict["result"]],
                        {
                            "log": self._neutralize(verdict["log"], root),
                            "duration": verdict["duration"],
                        },
                    )
                    or 0
                )
                sent += 1
        # Every failure, unforeseen ones included, becomes the warning line:
        # the registry never decides the suites' exit code. Ctrl+C, or the
        # SIGTERM run_suites.py turns into KeyboardInterrupt, stops the push
        # the same way.
        except (Exception, KeyboardInterrupt) as exc:  # noqa: BLE001
            reason = str(exc)
            if isinstance(exc, KeyboardInterrupt):
                reason = "stopped by Ctrl+C or SIGTERM"
            elif not isinstance(
                exc, (RegistryUnavailable, urllib.error.URLError)
            ):
                reason = f"{type(exc).__name__}: {reason}"
            warn(
                self._mask(
                    f"push interrupted after {sent} verdict(s)"
                    f" ({self._mask(reason, limit=300)}); the suites' exit"
                    " code does not depend on it."
                ),
                out=out,
            )
            return
        print(
            "  "
            + self._mask(
                f"Requirement registry: {sent} verdicts sent,"
                f" {updated} lines updated ({_displayable(self.url)})."
            ),
            file=out,
        )
