# Contract between the extension and ERPLibre

**Contract version: 1.1**

The extension runs on its own (see `README.md`). ERPLibre also clones this
repository at `script/gnome-extension/erplibre_home/`, by Google Repo or by
`install_erplibre_home.sh`, links it as `erplibre-home@technolibre.ca` and
drives it from its installer, make targets, Stream Deck program and TODO
menu. This file states what each side relies on in that case. ERPLibre
records the version it was built against in
`script/gnome-extension/erplibre_home_contract`; the tests of both sides
check it.

## What ERPLibre relies on

1. **Layout and identity.** The repository root is the extension root.
   `metadata.json` holds:
   - `uuid`: `erplibre-home@technolibre.ca`;
   - `shell-version`: the GNOME Shell majors the extension supports; the
     installer accepts a session only when its major is listed;
   - `gettext-domain`: `erplibre-home`;
   - `settings-schema`: `org.gnome.shell.extensions.erplibre-home`.

   `schemas/` holds exactly one schema file,
   `org.gnome.shell.extensions.erplibre-home.gschema.xml`, whose schema
   reads the path `/org/gnome/shell/extensions/erplibre-home/` and which
   `glib-compile-schemas --strict schemas/` compiles. Each `po/<lang>.po`
   compiles with `msgfmt --check` to
   `locale/<lang>/LC_MESSAGES/erplibre-home.mo`; `po/erplibre-home.pot` is
   the template. `schemas/gschemas.compiled` and `locale/` are build
   outputs, ignored by git.
2. **Tools.** Each runs under the system `python3`. The executable ones
   start with `#!/usr/bin/env python3` and are run directly:
   - `tools/migrate_legacy.py`, no argument: moves a workstation from the
     extension's previous identity; idempotent, and never fails the
     install that runs it;
   - `tools/enable_next_login.py <uuid>`: enables the extension at the
     next login;
   - `hooks/install_claude_hooks.py [--dry-run] [--remove]`;
   - `po/compile_locales.py`, which needs `polib`; the others need only
     the standard library.

   `tools/gsettings_strv.py` is imported, not run: it exports
   `parse_strv` and `format_strv`, which read and write a GSettings string
   array in both forms `@as []` and `['a', 'b']`.

   `dev_nested.sh` and `test/e2e_nested.sh` run a nested GNOME Shell for
   development; ERPLibre's make targets call them without arguments.

   The test suites run from the repository root, as
   `make test_gnome_extension` runs them in ERPLibre:
   `node --test test/unit/*.test.js` and
   `python3 -m unittest discover -s test/python`; `npm test` runs both.
3. **D-Bus.** On the session bus name `org.gnome.Shell`, object
   `/org/gnome/Shell/Extensions/ERPLibreHome`, interface
   `org.gnome.Shell.Extensions.ERPLibreHome`. ERPLibre calls these methods,
   with these input arguments; an answer typed `s` is JSON text:

   | Method | In | Out |
   |---|---|---|
   | `TileWindow` | `iiiiii` | `b` |
   | `ListTrackerTimers` | | `s` |
   | `ToggleTrackerTimer` | `s` | `b` |
   | `AddTrackerTimer` | | `s` |
   | `ResetAllTrackerTimers` | | `b` |
   | `ListWindows` | | `s` |
   | `ApplyLayout` | `s` | `i` |
   | `GetFocusedWindowClass` | | `s` |
   | `GetFocusedWindowId` | | `s` |
   | `FocusWindowById` | `s` | `b` |
   | `SendKeysToWindow` | `ss` | `b` |
   | `FocusClaudeSession` | `s` | `b` |
   | `SetClaudeSessionWindow` | `s` | `b` |
   | `AcceptClaudeSession` | `s` | `b` |
   | `KillClaudeSession` | `s` | `b` |
   | `MpvSendCommand` | `is` | `b` |
   | `HotReload` | | `s` |
   | `HotExit` | | `b` |
   | `ListPaths` | | `s` |
   | `ListDevices` | | `s` |

   The interface's other methods serve the extension's own menus and
   tests and may change freely.
4. **Hot reload.** The copies `HotReload` loads are named
   `erplibre-home-reload-*@technolibre.ca` in the user's extensions
   directory; ERPLibre's clean-up removes that prefix.
5. **Shared directories**, `~` standing for an unset XDG variable as the
   XDG specification says:
   - `$XDG_STATE_HOME/erplibre-home/`: `claude/`, `mpv/` and
     `todo_terminals.json`, which item 6 describes, and `todo/`, the logs
     of the TODO terminals;
   - `$XDG_CACHE_HOME/erplibre-home/controller.pid`: written by ERPLibre's
     Stream Deck controller, read by the device indicator;
   - `$XDG_RUNTIME_DIR/erplibre-home/deck.lock`: text `<pid> <program>`,
     written by ERPLibre's deck lock, read by the extension.
6. **Records** in `$XDG_STATE_HOME/erplibre-home/`, each JSON. A reader
   takes a missing key as empty text or 0 and ignores the keys it does not
   know; a writer may add keys.
   - `claude/<session_id>.json`, one per Claude Code session: written by
     `hooks/erplibre-home-hook.py` at each hook event and removed at the
     end of the session, read by the extension and by ERPLibre's Stream
     Deck. The latest of the four timestamps gives the session's status;
     `description`, when empty, falls back to `last_prompt`.
   - `mpv/<pid>.json`, one per mpv player the extension started: written
     by the extension and removed when the player exits, read by
     ERPLibre's Stream Deck.
   - `todo_terminals.json`, an array with one entry per TODO terminal:
     the extension and ERPLibre's Stream Deck each add their own entries
     and rewrite the whole file.

   | Record | Key | Type |
   |---|---|---|
   | `claude/*.json` | `session_id` | text, the file's name |
   | `claude/*.json` | `pid` | integer, the Claude Code process, 0 when unknown |
   | `claude/*.json` | `cwd` | text |
   | `claude/*.json` | `description` | text |
   | `claude/*.json` | `last_prompt` | text, first line of the last prompt |
   | `claude/*.json` | `notification_message` | text, empty when none waits |
   | `claude/*.json` | `ts_active` | integer, milliseconds since the epoch, 0 when never |
   | `claude/*.json` | `ts_stop` | integer, milliseconds since the epoch, 0 when never |
   | `claude/*.json` | `ts_notification` | integer, milliseconds since the epoch, 0 when never |
   | `claude/*.json` | `ts_tool` | integer, milliseconds since the epoch, 0 when never |
   | `mpv/*.json` | `pid` | integer, the mpv process |
   | `mpv/*.json` | `started_at` | integer, milliseconds since the epoch |
   | `mpv/*.json` | `title` | text |
   | `mpv/*.json` | `url` | text |
   | `todo_terminals.json` | `window_id` | text, the window's stable id in decimal |
   | `todo_terminals.json` | `name` | text |
   | `todo_terminals.json` | `opened_at` | number, seconds since the epoch |
   | `todo_terminals.json` | `log_path` | text, empty when none |
7. **Journal.** The extension writes `[ERPLibreHome] enabled` to the
   session journal once enabled, and
   `[ERPLibreHome] mount <id> failed: <reason>` when indicator `<id>`
   fails to start; ERPLibre's long test reads these lines.

## What the extension relies on

1. **Checkout root.** When the extension's directory, links followed,
   ends with `/script/gnome-extension/erplibre_home`, the part before it
   is the ERPLibre checkout (`lib/project-root.js`). Otherwise the
   features below find nothing and say so; the rest of the extension
   works the same.
2. **Stream Deck level,** relative to that root:
   - `.venv.streamdeck/bin/python` runs the deck programs;
   - `script/stream_deck/erplibre_controller.py` is the controller;
   - `script/install/erplibre_home_deck.sh --check` exits 0 when the deck
     program may start; otherwise its last stderr line is the reason;
   - the systemd user unit `erplibre-home-streamdeck.service`, in
     `$XDG_CONFIG_HOME/systemd/user/`, runs the deck program; its exit
     codes 2 (deck held by another program) and 3 (no deck with keys that
     show images) are final, not restarted;
   - the messages name `make erplibre_home_streamdeck_install` as the
     install command.
3. **Games gallery:** `script/stream_deck/games/gallery_server.py`, run by
   the Stream Deck venv's python, serves `http://localhost:8042` with
   `GET /api/games` and `GET /launch/<id>` (header
   `X-Stream-Deck-Gallery: 1`), as the games' contract 2.x states.
4. **ERPLibre instances:** an instance is a directory holding `.git` and
   `env_var.sh` (`ERPLIBRE_PORT_HTTP`, 8069 when unset); the extension
   starts it with `make run`, opens its TODO menu with
   `source .venv.erplibre/bin/activate && python3 -u ./script/todo/todo.py`,
   and logs in with
   `.venv.erplibre/bin/python script/selenium/web_login.py --url --user --pass`
   (xdotool when that venv is missing). One notice names
   `script/stream_deck/INSTALL.md`.

## Versioning

A change that a reader on the other side can see bumps MAJOR: a file or
tool above renamed, moved or removed, a test command of item 2 changed, a
D-Bus method of the table removed, renamed or given other input
arguments, a shared directory moved, a record key removed, renamed or
given another type, a journal line reworded, a changed identity in
`metadata.json` or the schema. An optional addition bumps MINOR.
ERPLibre's tests fail when the MAJOR it records differs from this one.
They read from this repository only what this file states, and the
values it gives; the tests of this repository hold the code to them.
ERPLibre follows `main`: a MAJOR change is pushed on both sides together.

- **1.1:** the test commands, the records of the shared state files and
  the journal lines are stated.
- **1.0:** the first version.
