# Contract between the extension and ERPLibre

**Contract version: 1.5**

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
   - `$XDG_CACHE_HOME/erplibre-home/controller.pid`: written by the
     controller of the deck directory (item 2 of What the extension
     relies on), read by the device indicator;
   - `$XDG_RUNTIME_DIR/erplibre-home/deck.lock`: text `<pid> <program>`,
     written by the deck lock of the deck program, read by the extension.
6. **Records** in `$XDG_STATE_HOME/erplibre-home/`, each JSON. A reader
   takes a missing key as empty text or 0 and ignores the keys it does not
   know; a writer may add keys.
   - `claude/<session_id>.json`, one per Claude Code session: written by
     `hooks/erplibre-home-hook.py` at each hook event and removed at the
     end of the session, read by the extension and by the deck program.
     The latest of the four timestamps gives the session's status;
     `description`, when empty, falls back to `last_prompt`.
   - `mpv/<pid>.json`, one per mpv player the extension started: written
     by the extension and removed when the player exits, read by the
     deck program.
   - `todo_terminals.json`, an array with one entry per TODO terminal:
     the extension and the deck program each add their own entries
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
8. **Odoo pilot.** `$XDG_STATE_HOME/erplibre-home/pilot.json`, mode 0600,
   written by the extension only, holds the configuration an Odoo pilots
   (see [Odoo inventory](#odoo-inventory)): `{"destination": <label>,
   "revision": <integer>, "locked": [<wire key>]}`, and never a secret.
   ERPLibre reads it only to warn, in its TODO menu, before it changes a
   key of `locked`. A missing file, or one that does not parse, means that
   no Odoo pilots the workstation.
9. **Shared fixtures.** `test/fixtures/streamdeck_conf/` holds, for each
   case `<name>`: `<name>.in.conf`, a `streamdeck.conf` before; `<name>.json`
   with `settings` (wire values), `lines` (the value each of them gives
   its `KEY=` line, in the order a missing line is added) and `current`
   (what the extension reads in `<name>.in.conf`); `<name>.out.conf`, the
   bytes once `lines` are written. ERPLibre's writer of `streamdeck.conf`
   gives the same bytes from the same input.
10. **Key layouts.** `~/.config/erplibre-home/keymap.json`, the literal
    directory of the deck's `settings.json` whatever `$XDG_CONFIG_HOME`
    says, mode 0644, written by the extension only, in one atomic
    replacement, holds the home keys an Odoo lays out per deck model (see
    [Odoo inventory](#odoo-inventory)): `{"format": 1, "revision":
    <integer>, "layouts": {<model>: {"keys": [<entry>]}}}`. `<model>` is a
    `usb_product_id`, 4 lowercase hex digits, 16 models at most;
    `<entry>` is `{"key": <integer>, "action": <action>, "icon": <icon>,
    "label": <text>}`, `icon` and `label` optional and never null, and no
    other key. A layout holds at most as many entries as the model has
    keys, each `key` from 0 to that count minus one, once. `<action>` is
    `plugin:<id>` (the home key of that plugin, `<id>` of the pattern
    `[a-z][a-z0-9_]{0,63}`), `tiles` (a key of the dashboard) or `empty`
    (a black key), each `plugin:<id>` once in a layout, since the deck
    lays out the first key of a plugin and leaves the others free;
    `<icon>` a name of the catalog's `icons`; `label` at most 16
    characters, counted by code point, none of the Unicode categories Cc
    or Cs. The extension writes only layouts whose actions and icons the
    catalog of the checkout lists (item 2 of What the extension relies
    on), for models whose geometry it gives, and no action of a plugin
    `DECK_PLUGINS_OFF` turns off. A plugin the catalog lists because it
    is turned off may have no home key: a revision that turns it on and
    names it gets a black key, with a line in the deck's journal.
11. **Shared keymap fixtures.** `test/fixtures/keymap/<name>.json` holds
    `catalog` (as `--catalog` prints it), `plugins_off` (the plugins
    turned off), `layouts` (a reply's `settings.key_layouts`), `valid`,
    whether the extension writes those layouts, and `loader`, what
    ERPLibre's loader does with a `keymap.json` that holds them: read by
    its `load`, then laid out by its `layout_for` on each model of the
    catalog, with the plugins that layout names loaded with a home button
    unless the catalog lacks them or `plugins_off` turns them off.
    `problem`: `layout_for` gives one problem at least. `automatic`: it
    gives none and keeps the automatic layout of every model (a model it
    does not find, or a file `load` refuses). `as_sent`: it gives none and
    lays out the entries (a field it does not know is ignored). A valid
    case is never `problem`: the deck skips nothing the extension
    writes. An invalid case may be any of the three, the extension being
    the stricter reader.

## What the extension relies on

1. **Checkout root.** When the extension's directory, links followed,
   ends with `/script/gnome-extension/erplibre_home`, the part before it
   is the ERPLibre checkout (`lib/project-root.js`). Otherwise the
   features below find nothing and say so; the rest of the extension
   works the same.
2. **Stream Deck level,** relative to that root:
   - `.venv.streamdeck/bin/python` runs the deck programs;
   - the deck directory is `script/stream_deck/deck/`, where ERPLibre
     clones the deck program's own repository, or, in an older checkout
     without that clone, `script/stream_deck/`: the first of the two
     that holds `erplibre_streamdeck/__main__.py`, looked up at each use,
     the clone when neither does. The controller, the deck program and
     its plugins below all come from that one directory;
   - `erplibre_controller.py` of the deck directory is the controller:
     `script/stream_deck/deck/erplibre_controller.py`, or
     `script/stream_deck/erplibre_controller.py` in an older checkout;
   - `script/install/erplibre_home_deck.sh --check` exits 0 when the deck
     program may start; otherwise its last stderr line is the reason;
   - the systemd user unit `erplibre-home-streamdeck.service`, in
     `$XDG_CONFIG_HOME/systemd/user/`, runs the deck program; its exit
     codes 2 (deck held by another program) and 3 (no deck with keys that
     show images) are final, not restarted;
   - the messages name `make erplibre_home_streamdeck_install` as the
     install command;
   - `$XDG_CONFIG_HOME/erplibre-home/streamdeck.conf`, read by
     `script/install/erplibre_home_deck.sh`: the last line starting with
     `DECK_PROGRAM=` names the deck program (`tiler` without one), which
     the inventory reports; the inventory reads the state of the unit
     with `systemctl --user show` (`LoadState`, `ActiveState`,
     `SubState`). The lines `DECK_PLUGINS_OFF=`,
     `DECK_SESSION_REFRESH_SEC=` and `GAMES=` are read as
     `script/install/erplibre_home_settings.sh` reads them, byte by byte;
     the extension writes the keys of the configuration an Odoo pilots
     into this file, then restarts the unit with
     `systemctl --user restart`;
   - deck plugins are the `*.py` files, not starting with `_`, of
     `erplibre_streamdeck/plugins/` of the deck directory and of
     `$XDG_CONFIG_HOME/erplibre-home/deck-plugins/`, named by the file
     without `.py`;
   - `.venv.streamdeck/bin/python <deck directory>/erplibre_streamdeck
     --catalog` prints the catalog of the deck program as JSON and exits
     0, without opening a deck nor taking the deck lock: `{"format": 1,
     "actions": [<action>], "icons": [<icon>], "models": {<model>:
     {"cols": <integer>, "rows": <integer>, "keys": <integer>}}}`, the
     actions `plugin:<id>` of the plugins loaded with a home key and of
     the plugins `DECK_PLUGINS_OFF` turns off, never imported and left
     out only when their file, read without being run, shows they have
     no home key, sorted, then `tiles` and `empty`; the icon names of the pattern
     `[a-z][a-z0-9_]{0,63}`; the geometry of each deck model the Stream
     Deck library knows, from 0 to 256 each. The extension runs it at its
     start and when the checkout's commit changes, and abandons it after
     10 s. An item of another form is left out; an output that does not
     parse, or of another `format`, is no catalog; the deck program reads
     `keymap.json` (item 10 of What ERPLibre relies on) at its start.
3. **Games gallery:** `script/stream_deck/games/gallery_server.py`, run by
   the Stream Deck venv's python, serves `http://localhost:8042` with
   `GET /api/games` and `GET /launch/<id>` (header
   `X-Stream-Deck-Gallery: 1`), as the games' contract 2.x states.
4. **ERPLibre instances:** an instance is a directory holding `.git` and
   `env_var.sh` (`ERPLIBRE_PORT_HTTP`, 8069 when unset); the extension
   starts it with `make run`, opens its TODO menu with
   `source .venv.erplibre/bin/activate && python3 -u ./script/todo/todo.py`,
   and logs in with
   `.venv.erplibre/bin/python script/selenium/web_login.py --url
   --default_email_auth --default_password_auth_env
   ERPLIBRE_HOME_LOGIN_PASSWORD`, the password in that environment
   variable only (xdotool when that venv is missing). One notice names
   `script/stream_deck/INSTALL.md`.
5. **Odoo inventory:** an Odoo instance with the ERPLibre module
   `erplibre_streamdeck` serves `/streamdeck/v1/enroll`,
   `/streamdeck/v1/report` and `/streamdeck/v1/unenroll` as
   [Odoo inventory](#odoo-inventory) states. Any Odoo the workstation
   reaches serves, inside a checkout or not.

## Odoo inventory

The extension reports the Stream Decks of the workstation, and the state
of its deck service, to each Odoo instance of the GSettings key
`inventory-destinations`. The wire format has its own version,
`"protocol": "1.2"` in every body and every reply, apart from this
contract's: Odoo answers an unknown MAJOR with 400
`protocol_unsupported`, accepts a newer MINOR and ignores the keys it does
not know.

**Transport.** HTTPS to any host; plain HTTP only to this machine
(`localhost`, `127.0.0.0/8`, `[::1]`). A URL with a user part, a query or
a fragment is refused, and no redirect is followed. Each call first sends
`GET <url>/web/login?db=<db>` on a session that keeps cookies, which
selects the database, then a POST whose body and reply are JSON objects.
An error reply carries `error`, one of `bad_request`,
`protocol_unsupported`, `credentials_refused`, `user_inactive`,
`token_invalid`. A 404 means that this database does not serve the
route.

**Routes,** under the destination's URL:

- `POST /streamdeck/v1/enroll`: body `protocol`, `method`, `fingerprint`,
  `hostname`, and the secret of the method: `code` for `pairing_code`
  (8 characters, case, spaces and hyphens ignored), `key` for `api_key`,
  `login` and `password` for `password`. Reply 200: `workstation_id`,
  `token`. Errors: 400 `bad_request` or `protocol_unsupported`, 401
  `credentials_refused` (wrong, expired or used), 403 `user_inactive`.
  The same user and fingerprint enrolling again keep their workstation,
  whose token is replaced.
- `POST /streamdeck/v1/report`: header `Authorization: Bearer <token>`,
  body `protocol`, `state`, `events`, `lost_events`, `config`. Reply 200:
  `accepted`, the uuids of the events stored or already known, and
  `heartbeat_s`; `config` for the pilot of a workstation that a layer
  configures. Errors: 401 `token_invalid` (unknown or revoked token),
  403 `user_inactive`, 400 `bad_request` or `protocol_unsupported`.
- `POST /streamdeck/v1/unenroll`: the same header, body `protocol`;
  reply 200 once the token is revoked.

**Report.**

- `state`: `hostname`; `os`, with `name` and `version`; `gnome_shell`;
  `extension_version`; `contract_version`, this file's version;
  `erplibre`, the `branch` and `commit` of the checkout, or null outside
  one; `deck_program`; `service_state`, one of `active`, `failed`,
  `inactive`, `absent`; `deck_plugins`, the ids of the deck plugins found
  on disk, sorted, at most 128 of the pattern `[a-z][a-z0-9_]{0,63}`
  (`[]` outside a checkout); `decks`, the decks connected now, each with
  `serial`, `usb_product_id` (4 lowercase hex digits), `usb_path` and
  `firmware`; `deck_catalog`, the catalog the deck program printed, left
  out when there is none or past 32 KiB of JSON. Unknown values are null,
  and so is a serial outside
  `[A-Za-z0-9._-]{1,64}` or a `usb_product_id` of another form, which
  Odoo refuses. Every text holds at most 256 characters, counted by code
  point, and no NUL character: Odoo answers 400 `bad_request` to either,
  so the extension cuts a longer text and drops the NUL. A deck with
  neither a `serial` nor a `usb_path` cannot be named and is left out of
  `decks` and of the events. A deck of the workstation that `decks` does
  not list becomes disconnected.
- `events`: the events not acknowledged yet, oldest first, each with
  `uuid`, `kind` (`plugged`, `unplugged` or `service_changed`), `at`
  (ISO 8601 in UTC, when the extension saw it), `serial`,
  `usb_product_id`, `usb_path` and `service_state`, under the bounds of
  `state`. Odoo keeps one event per uuid, so a report sent again
  duplicates nothing.
- `lost_events`: the running total of events the destination's queue
  dropped unsent; Odoo keeps the largest total it received.
- `config`: `{"pilot": false}` from a destination that is not the
  pilot; from the pilot, `{"pilot": true, "revision_applied": <integer>
  or null, "current": {<key>: <value> or null}, "result": <result> or
  null, "choice": "keep_local", "take_odoo" or null}`, where `<result>`
  is `{"revision": <integer>, "status": "applied" or "refused",
  "reason": <text> or null, "at": <ISO 8601>}`. `current` holds every
  key of the table of **Odoo configuration** below as the file gives it:
  a key the file lacks, or a value outside the table, as null, which
  holds nothing local to keep (the deck runs its default). `result` says
  what became of the last revision received, until a report carrying it
  is answered 200.
  `current.key_layouts` holds, for each model of `keymap.json` (16 at
  most, in order), the sha256 of its layout in lowercase hex, taken on
  its canonical JSON: Python's
  `json.dumps(layout, sort_keys=True, separators=(",", ":"))`, keys
  sorted, no white space, every character outside printable ASCII
  escaped as `\uXXXX` in lowercase hex. It holds null for a layout that
  is not an object or that nests lists and objects more than 8 levels
  deep (the format nests 3), and is null without a `keymap.json` of
  format 1.
  `choice` is the employee's answer to an `ask`, sent once, in the
  report that follows it. A pilot that cannot read `streamdeck.conf`,
  though it exists, sends no `config` in that report, and Odoo changes
  nothing of the configuration; the reply's `config` is not taken.

**Odoo configuration.** One destination at most is the pilot: the one
whose id the GSettings key `inventory-pilot` holds, none by default. Only
its replies' `config` is ever announced or applied; the others get
`{"pilot": false}` and give nothing back. Odoo can set these keys of
`streamdeck.conf` and the key layouts of `keymap.json`, and nothing else:
no path, no environment variable, no command, no plugin to turn on.

| Wire key | `streamdeck.conf` line | Values | Restart |
|---|---|---|---|
| `deck_program` | `DECK_PROGRAM` | `tiler`, `controller`, `none` | yes |
| `plugins_off` | `DECK_PLUGINS_OFF` | a list of at most 64 ids `[a-z][a-z0-9_]{0,63}`, written joined by `,` | yes |
| `session_refresh_sec` | `DECK_SESSION_REFRESH_SEC` | a number from 0.5 to 60 | yes |
| `games` | `GAMES` | `on`, `off` | no |
| `key_layouts` | `keymap.json`, not a line | the layouts of item 10 of What ERPLibre relies on, for the decks connected | yes |

- Reply `config`: `{"revision": <integer>, "hash": <64 lowercase hex>,
  "settings": {<key>: <value>}, "locked": [<key>], "ask": [<key>]}`.
  `settings` are Odoo's values of the keys a layer sets, and
  `settings.key_layouts` `{<model>: {"keys": [<entry>]}}` for the models
  of the decks connected; `locked` the
  keys the manager locked; `ask`, omitted when empty, the free keys
  whose local value Odoo asks the employee to keep or replace. A key of
  `locked` outside `settings`, or of `ask` outside `settings` or in
  `locked`, refuses the revision with `invalid:<key>`; a key unknown to
  this table is ignored. A `config` of another shape is ignored, as if
  absent: nothing is announced, written or reported, since no key of
  the table is at fault (`revision` not a non-negative integer, `hash`
  not 64 lowercase hex digits, `settings` not an object, `locked` or
  `ask` not a list of texts).
- First pilot: at the first pilot report of a workstation, Odoo lists in
  `ask` the free keys whose local value is not null and differs from its
  own, unless the organisation forces the choice; the extension asks the
  employee to keep their settings or use Odoo's, and sends the answer as
  `choice`. « Keep my settings » writes nothing. The revision answered
  that way comes back without `ask` when Odoo adopted nothing, and is
  then announced again for what it still offers. Locked keys are offered
  for the usual confirmation in every case.
- Nothing is applied without the employee's click: a notification, an
  entry of the deck menu and a button of the preferences announce each
  revision once; the preferences ask the service through the GSettings key
  `inventory-apply-request`, `"<destination id>:<revision>"` to apply, or
  `"<destination id>:<revision>:keep_local"` to keep the local values.
- Applying validates every value of the revision first: one outside the
  table refuses the whole revision with `invalid:<key>`, and nothing is
  written. Otherwise the file is read again and rewritten in one atomic
  replacement: every line `<KEY>=` of a key of `settings` takes its value,
  a missing key is added at the end in the order of the table, every
  other line stays byte for byte, and the file ends with a newline.
  When a key whose Restart column says yes changed and the deck unit is
  active, it is restarted; `games` alone restarts nothing. A revision
  whose values the file already holds is reported `applied` without a
  notification nor a restart, unless the unit still owes a restart for
  one of them: after a `restart_failed` or `unit_missing` refusal, the
  revision stays offered until a click restarts the unit or finds it
  not running.
- Key layouts: the layouts of `key_layouts` are checked against the
  format of `keymap.json` when the reply comes, then against the catalog
  the extension last read and the plugins turned off (`plugins_off` of
  the revision, else the file's) when it comes and again at the click,
  unless the revision is applied already, or answered by keeping the
  local values and still asked: it writes nothing. One outside them
  refuses the revision with `invalid:key_layouts`, and nothing is
  written; no catalog read refuses every layout. `keymap.json`
  is then rewritten, the revision and its layouts, after
  `streamdeck.conf`: the layouts of `key_layouts` replace those of their
  models, and the file's layouts of the other models (each an object
  nesting 8 levels at most) are kept as they are, 16 models at most,
  those of `key_layouts` first, then the file's in order: a layout Odoo
  does not send stays the employee's. A `keymap.json` that exists but
  cannot be read refuses the revision `write_failed` before any write.
  When it cannot be written, `streamdeck.conf` is put
  back as it was (removed when it did not exist) and the revision refused
  `write_failed`. A change of either restarts the unit once. A
  `keymap.json` holds the revision's layouts already when each model of
  `key_layouts` hashes there as the revision's, whatever its other
  models.
- `result.reason` of a refusal is `invalid:<key>`, `<key>` a wire key
  of the table, `write_failed`, `restart_failed` or `unit_missing` (the
  program changed while no unit is installed: the file is written all
  the same), at most 256 characters, and nothing else.
- `pilot.json` (item 8 of What ERPLibre relies on) names the pilot's
  label, the revision received last and its `locked` keys.

**Timing.** A report goes at the first USB scan, at each change, and
every 900 s otherwise, or every `heartbeat_s` of the last reply; one at a
time per destination. A call is abandoned after 10 s and counts as
offline: its events wait in the queue of the destination, which keeps
1000 events or 30 days, the oldest dropping first. The extension is
disabled at each screen lock, logout or GNOME Shell restart: at its next
start it compares the decks and the deck service with those it last saw,
and reports a difference as events dated at that start. A destination
whose token leaves the keyring queues nothing more; still without one
10 s later, it drops the events it held, which never reach a later
enrollment of that destination, perhaps another employee's. A locked
keyring is not taken for a missing token.

**Identity and secrets.**

- `fingerprint`: the HMAC-SHA256, keyed by `<uid>|<url>|<db>` (the URL
  without its trailing slashes), of the stripped content of
  `/etc/machine-id`, in 64 lowercase hex characters. The machine-id never
  leaves the workstation; two destinations, or two users, see unrelated
  values.
- `token`: base64url of 32 random bytes, 43 characters; Odoo keeps only
  its SHA-256. The workstation keeps it in the GNOME keyring only, under
  the libsecret schema `ca.technolibre.erplibre-home.inventory` with the
  attributes `destination` (the destination id), `url` and `db`: the
  token of one Odoo never goes to another. A pairing code, an API key or
  a password serves the one enrollment call and is never stored.
- `inventory-destinations`: a JSON array of destinations, each with
  `id`, `label`, `url`, `db`, `source` (`local` for an entry of the
  `instances` key, then named by `instanceId`, or `remote`); no secret.
- `$XDG_STATE_HOME/erplibre-home/inventory/<id>.json`, mode 0600, one per
  destination, written by the extension only:
  `{destination: {url, db}, queue: {events, lost}, status: {state,
  pending, lastReport, error}}`, plus `config` once Odoo configured the
  destination as the pilot: the revision applied, the last configuration
  received, the revision announced, and the result or the choice the next
  report carries. It is read back only when it names the destination's
  URL and database, never holds a secret, and ERPLibre does not read it;
  the preferences read `config` to offer the revision that waits.
- `$XDG_STATE_HOME/erplibre-home/inventory-seen.json`, mode 0600, written
  by the extension only: `{decks, service}`, the decks (`serial`,
  `usb_product_id`, `usb_path`) and the deck service state it last saw.
  It never holds a secret; ERPLibre does not read it.

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
The wire of the Odoo inventory is versioned by its `protocol` the same
way, MAJOR for what Odoo can see, MINOR for an optional addition; this
file's version moves with it.

- **1.5:** the deck directory: the controller, the deck program and its
  plugins are read from `script/stream_deck/deck/`, the clone of the
  deck program's repository, then from `script/stream_deck/` for an
  older checkout.

- **1.4:** the key layouts, protocol 1.2: the state carries
  `deck_catalog`, the output of the deck program's `--catalog`; the
  pilot reports the hashes of `keymap.json` and writes it from
  `key_layouts`, keeping its layouts of the models Odoo does not send;
  the keymap fixtures are shared with ERPLibre.

- **1.3:** the Odoo configuration, protocol 1.1: the report carries
  `config` and `state.deck_plugins`, the pilot destination receives a
  `config` it applies to `streamdeck.conf` after the employee's click;
  `pilot.json` and the fixtures of `streamdeck.conf` are shared with
  ERPLibre.

- **1.2:** the Odoo inventory: the extension enrolls with and reports to
  the routes of the Odoo module `erplibre_streamdeck`, and reads
  `streamdeck.conf` and the state of the deck unit.

- **1.1:** the test commands, the records of the shared state files and
  the journal lines are stated.
- **1.0:** the first version.
