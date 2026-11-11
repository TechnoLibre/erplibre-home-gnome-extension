# Architecture

How the GNOME extension, the Stream Deck driver and Claude Code hooks
talk to each other. Everything is local but the Odoo inventory, which
pushes to the Odoo instances the user enrolled: no daemon, no inbound
connection, no persistent storage outside `$XDG_STATE_HOME/erplibre-home/`
and, for the inventory tokens, the GNOME keyring.

## Process map

```
+-------------------+    JSONL files     +---------------------+
|  Claude Code      | -----------------> |  $XDG_STATE_HOME/   |
|  (claude binary)  |                    |  erplibre-home/  |
|                   |     fires hooks    |  claude/{sid}.json  |
+--------+----------+                    +---------+-----------+
         |                                          |
         | gdbus call                               | Gio.FileMonitor
         v                                          v
+--------+----------+                    +---------+-----------+
|  GNOME Shell      |                    |  ClaudeStateWatcher |
|  (gjs / mutter)   | <----------------- |  (lib/claude-state) |
|  extension.js     |   indexed sessions +---------------------+
+--------+----------+
         |
         | adds indicators
         v
+--------+----------+      D-Bus      +---------------------+
|  Top-bar buttons  | <-------------> | erplibre_streamdeck |
|  (indicators/*)   |                 |  (Stream Deck       |
|                   |                 |   physical hardware)|
+-------------------+                 +---------------------+
```

## Data flow: Claude session → coloured badge

1. **`claude` runs a hook**. `hooks/erplibre-home-hook.py` wakes
   on every `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `Stop`,
   `Notification`, `SessionEnd` event.
2. **Hook writes state**. The hook stamps the matching field
   (`ts_active`, `ts_tool`, `ts_stop`, `ts_notification`) in
   `$XDG_STATE_HOME/erplibre-home/claude/{session_id}.json`.
3. **Hook captures the focused window id** (when SessionStart /
   UserPromptSubmit fires) by calling the extension's
   `GetFocusedWindowId` D-Bus method, so the row "Click to focus
   terminal" later resolves to the right Mutter window.
4. **`ClaudeStateWatcher` notices**. A `Gio.FileMonitor` plus a 2 s
   poll timer reload every changed file, derive `status` from the
   max timestamp (`notify > stop > tool > active`) and rebuild a
   subscriber index `{byPath, totalAlive, totalAwaitStop, …}`.
5. **`PencilIndicator` re-renders**. The indicator subscribes to the
   watcher, calls `_refreshBadge()` (paths + most-severe secondary
   slot) and `_rebuildMenu()` if the dropdown is open.
6. **Optional desktop notification**. When a session transitions to
   `awaiting_notification` the extension fires `Main.notify(...)`
   once per `ts_notification` value (throttled).
7. **Deck mirror**. The deck program's `claude_sessions` plugin
   (`erplibre_streamdeck/plugins/claude_sessions.py`) reads the same state
   files on the deck's loop and shows a coloured per-session button
   (green / cyan / yellow / red) on its idle layout; `mpv_sessions.py`
   does the same for the mpv state directory. A session whose pid now
   belongs to a younger process is dropped (`liveness.py`), and a session
   page refreshes every `DECK_SESSION_REFRESH_SEC` and goes home when its
   session ends.

## Data flow: Stream Deck → Odoo inventory

1. **Watch.** `InventoryService` (`lib/inventory-service.js`), created at
   `enable()` whatever indicator is shown, lists the Elgato decks through
   `UsbWatch` (`lib/usb-watch.js`: GUdev uevents, else an asynchronous
   `lsusb` poll every `POLL_S`) and polls the deck unit with
   `systemctl --user show`.
2. **Queue.** Each change becomes dated events (`diffDecks`,
   `serviceChanged` in `lib/inventory.js`), queued per destination in an
   `EventQueue` and saved in its state file,
   `$XDG_STATE_HOME/erplibre-home/inventory/<id>.json` (mode 0600). What
   the service last saw goes to `inventory-seen.json` beside it: the
   first scan and deck service reading after a start (the extension is
   disabled at each screen lock) are compared with it.
3. **Report.** One report at a time per destination, at each change and
   every `heartbeat_s`: `postJson` (`lib/odoo-http.js`, Soup 3) selects
   the database, then posts the state and the queued events with the
   token that `lib/secret-store.js` finds in the keyring. Odoo's
   `accepted` uuids leave the queue; a call past `TIMEOUT_S` is
   cancelled and retried later; a revoked token stops the reports.
4. **Show.** The device indicator reads `decks()` and the statuses from
   the service: its deck list and its inventory line.
5. **Enroll.** The preferences page « Odoo inventory » (`prefs.js` on
   `lib/inventory-prefs.js`) writes the destinations to
   `inventory-destinations`, enrolls them (`/streamdeck/v1/enroll`, the
   token to the keyring) and reads the state files for the statuses. The
   service picks a new token up within `POLL_S`, and sees one the
   preferences cleared within `POLL_S` too: that destination queues
   nothing more, and drops its queue once the token is still missing
   `POLL_S` later.
6. **Configure.** Only the destination named by `inventory-pilot` sends
   the local values of `streamdeck.conf` (`readCurrent`,
   `lib/deck-config.js`) and has its reply's `config` kept, in the
   `config` of its state file. The service announces a revision once
   (`announce` signal: `extension.js` notifies, the device indicator
   lists it through `pendingConfig()`, the preferences read it from the
   state file and answer through `inventory-apply-request`). Only a click
   calls `applyConfig` (rewrite through `rewriteConf`, atomic, then
   `systemctl --user restart` when needed) or `keepLocal`; the result or
   the choice goes in a report sent at once, and `pilot.json` names the
   locked keys for ERPLibre.

The wire protocol is in `CONTRACT.md`, section « Odoo inventory ».

## Key surfaces

| Layer | Code | Notes |
| --- | --- | --- |
| Hooks | `hooks/erplibre-home-hook.py` | One Python script, six events. Idempotent per `(session_id, event)`. |
| State | `$XDG_STATE_HOME/erplibre-home/claude/{sid}.json` | Plain JSON, atomic writes. |
| Watcher | `lib/claude-state.js` | `parseStateEntry`, `indexSessions`. Pure helpers, unit-tested. |
| Indicator | `indicators/pencil.js` | Lazy import so node tests can read `lib/`. |
| D-Bus | `extension.js` | Interface `org.gnome.Shell.Extensions.ERPLibreHome` exposes `FocusClaudeSession`, `GetFocusedWindowId`, `AcceptClaudeSession`, `SetClaudeSessionWindow`, `KillClaudeSession`, `RenameClaudeSession`, `DebugClaudeIndex`, `ListMpvSessions`, `MpvSendCommand`, `TileWindow`, `OpenPath`, `OpenMedia`, etc. |
| Driver | `script/stream_deck/erplibre_streamdeck/` (package, one plugin per feature) | Python streamdeck library, reads the same state directories, calls back into the extension over D-Bus. |
| Inventory | `lib/inventory.js`, `lib/deck-config.js` | Pure: URL policy, fingerprint, wire state and events, `EventQueue`, report and enrollment bodies and replies; the Odoo configuration's keys, validation and `streamdeck.conf` rewrite. Unit-tested. |
| Inventory service | `lib/inventory-service.js`, `lib/usb-watch.js`, `lib/odoo-http.js`, `lib/secret-store.js` | Runs in GNOME Shell; asynchronous only, the application of the pilot's configuration included. Tested on the fakes of `test/unit/gjs-fake.js`. |
| Inventory preferences | `lib/inventory-prefs.js`, `prefs.js` | Destinations, enrollment, status, the pilot and its pending revision; runs in the preferences process and never writes `streamdeck.conf`. |

## D-Bus interface

```
gdbus introspect --session \
  --dest org.gnome.Shell \
  --object-path /org/gnome/Shell/Extensions/ERPLibreHome
```

Used by:
- the Claude hooks (`GetFocusedWindowId`),
- the deck driver (`FocusClaudeSession`, `AcceptClaudeSession`,
  `SetClaudeSessionWindow`, `KillClaudeSession`,
  `MpvSendCommand`, `TileWindow`),
- developers (`HotReload`, `DebugClaudeIndex`, `ListWindows`).

## Hot reload

`HotReload` builds `erplibre-home-reload-{ts}@technolibre.ca` as a real
directory: one symlink per entry of the source folder, and a
`metadata.json` of its own that names the new UUID, so the checkout's
file is never written. It then enables the new UUID and disables the old
one. `projectRootFrom` finds the checkout through the directory's
`extension.js` link.
Each indicator class registers a per-process random `GTypeName`
suffix so the second load does not collide with GObject's
process-wide type table.

## Settings + migrations

- `Gio.Settings(schema_id='org.gnome.shell.extensions.erplibre-home')`.
- Schema in `schemas/*.gschema.xml`, compiled at install via
  `glib-compile-schemas`.
- Migrations in `lib/migrations.js`, runner exits on first failed
  step so the next launch retries.

## Translations

- Source strings in JS through `_()` (`lib/i18n.js` thin wrapper
  over the GNOME extension's `gettext`).
- Catalogues under `po/{lang}.po`, compiled to
  `locale/{lang}/LC_MESSAGES/erplibre-home.mo` at install.
- Locale resolution comes from the system `LANG`; the
  `gettext-domain` field in `metadata.json` ties it together.

## Tests

- `test/unit/*.test.js` — Node tests covering pure helpers.
- `test/e2e_nested.sh` — opt-in headless gnome-shell smoke test:
  ACTIVE, D-Bus up, and every indicator mounted.
- `lib/shell-compat.js` — one helper per Shell/Mutter API that changed
  between the declared GNOME versions.
- `test/manual.md` — checklist for shell-only behaviours.
