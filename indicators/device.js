import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {inventorySummary} from '../lib/inventory-service.js';
import {spawnDetached, runProcess} from '../lib/spawn.js';
import {makeBadgedIcon, bindBadgeOrientation, attachHoverTooltip,
    formatBadgeTooltip} from '../lib/badges.js';
import {projectRootFrom, makeGioReadLink, streamDeckPython}
    from '../lib/project-root.js';
import {deckUnitPath, deckLockPath, openDeckArgv, restartDeckArgv,
    deckStateArgv, deckCheckArgv, parseUnitShow, awaitDeckStart,
    parseLockHolder, deckStartNotice}
    from '../lib/deck-service.js';
import {_} from '../lib/i18n.js';

function _notify(title, body) {
    try { Main.notify(title, body); } catch (_e) {}
}

const PIDFILE = `${GLib.get_user_cache_dir()}/erplibre-home/controller.pid`;

// See indicators/controller.js for the rationale of the random suffix.
const _GTYPE_SUFFIX = Math.floor(Math.random() * 1e9).toString(36);

export const DeviceIndicator = GObject.registerClass(
{GTypeName: `SDT_DeviceIndicator_${_GTYPE_SUFFIX}`},
class DeviceIndicator extends PanelMenu.Button {
    // `inventory` is the extension's InventoryService: the indicator shows
    // its decks and its status, and never scans USB itself.
    _init({extension, openPrefs, inventory = null,
        iconName = 'input-tablet-symbolic'} = {}) {
        super._init(0.0, 'Stream Deck Device');
        this._extension = extension;
        this._openPrefs = openPrefs;
        this._inventory = inventory;
        this._settings = extension.getSettings();
        this._cache = [];
        // GLib sources of the waits _driveUnit runs after a start.
        this._settleIds = new Set();
        this._badged = makeBadgedIcon({St, Gio, Clutter, iconName});
        this.add_child(this._badged.actor);
        this._sigInventory = inventory?.connect('changed',
            () => this._refresh()) ?? 0;
        this._refresh();
        this._sigTimer = this._settings.connect(
            'changed::device-auto-refresh-sec', () => this._resetTimer());
        this._sigBadges = this._settings.connect(
            'changed::enable-icon-badges',
            () => this._refreshBadge());
        this._sigOrient = bindBadgeOrientation(this._badged, this._settings);
        this._tip = attachHoverTooltip({
            St, Clutter,
            uiGroup: Main.layoutManager.uiGroup,
            target: this,
            getText: () => this._tooltipText(),
        });
        this._resetTimer();
    }

    destroy() {
        this._destroyed = true;
        if (this._timerId) GLib.source_remove(this._timerId);
        this._timerId = 0;
        for (const id of this._settleIds) GLib.source_remove(id);
        this._settleIds.clear();
        if (this._sigTimer) this._settings.disconnect(this._sigTimer);
        this._sigTimer = 0;
        if (this._sigBadges) this._settings.disconnect(this._sigBadges);
        this._sigBadges = 0;
        if (this._sigOrient) this._settings.disconnect(this._sigOrient);
        this._sigOrient = 0;
        if (this._sigInventory) this._inventory?.disconnect(this._sigInventory);
        this._sigInventory = 0;
        this._tip?.detach();
        super.destroy();
    }

    _tooltipText() {
        return formatBadgeTooltip([
            {count: this._cache.length, label: 'devices', alwaysShow: true},
        ]);
    }

    _refreshBadge() {
        if (!this._badged) return;
        if (!this._settings.get_boolean('enable-icon-badges')) {
            this._badged.setBadges([]);
            return;
        }
        this._badged.setBadges([{count: this._cache.length}]);
    }

    _resetTimer() {
        if (this._timerId) GLib.source_remove(this._timerId);
        this._timerId = 0;
        const sec = this._settings.get_int('device-auto-refresh-sec');
        if (sec > 0) {
            this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, sec, () => {
                this._rescanThenRebuild();
                return GLib.SOURCE_CONTINUE;
            });
        }
    }

    // Asks the service for a scan; its 'changed' signal rebuilds the menu
    // when the decks differ.
    _rescanThenRebuild() {
        this._inventory?.rescan();
        this._refresh();
    }

    // Rebuilds the menu when the decks, the inventory line or the pending
    // configuration changed: the service signals every report, and a
    // rebuild under an open menu closes what the user had open.
    _refresh() {
        const decks = this._inventory?.decks() ?? [];
        const shown = JSON.stringify([decks, this._inventoryLine(),
            this._pendingConfig()]);
        if (shown === this._shown) return;
        this._shown = shown;
        this._cache = decks;
        this._rebuildMenu();
        this._refreshBadge();
    }

    // The inventory line: null when no destination is enrolled.
    _inventoryLine() {
        const summary = inventorySummary(this._inventory?.statuses() ?? []);
        if (summary === null) return null;
        if (summary.kind === 'revoked')
            return _('Inventory: enrollment revoked');
        if (summary.kind === 'refused')
            return _('Inventory: refused');
        if (summary.kind === 'offline')
            return _('Inventory: offline ({n} pending)')
                .replace('{n}', summary.pending);
        return _('Inventory: up to date');
    }

    // The revision of the pilot Odoo waiting on the employee, or null.
    _pendingConfig() {
        try {
            return this._inventory?.pendingConfig?.() ?? null;
        } catch (_e) {
            return null;
        }
    }

    // The entries of a pending configuration: one that applies it, or, when
    // Odoo asks at the first pilot report, the question and its two
    // answers. Nothing is applied but by one of these clicks.
    _configItems(pending) {
        const keys = (pending.ask.length ? pending.ask : pending.keys)
            .join(', ');
        const item = (text, run) => {
            const it = new PopupMenu.PopupMenuItem(text);
            it.connect('activate', () => Promise.resolve(
                run(pending.destinationId, pending.revision)).catch(e =>
                console.log(`[ERPLibreHome] inventory config: ${e.message}`)));
            return it;
        };
        const apply = (id, rev) => this._inventory.applyConfig(id, rev);
        if (!pending.ask.length) {
            return [item(_('Apply Stream Deck configuration (rev. {n}): {keys}')
                .replace('{n}', pending.revision).replace('{keys}', keys),
            apply)];
        }
        return [
            new PopupMenu.PopupMenuItem(
                _('Stream Deck: keep your settings or use Odoo\'s? ({keys})')
                    .replace('{keys}', keys), {reactive: false}),
            item(_('Use Odoo\'s settings (rev. {n})')
                .replace('{n}', pending.revision), apply),
            item(_('Keep my settings (rev. {n})')
                .replace('{n}', pending.revision),
            (id, rev) => this._inventory.keepLocal(id, rev)),
        ];
    }

    _rebuildMenu() {
        this.menu.removeAll();
        if (!this._cache.length) {
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem(
                _('(no Stream Deck found)'), {reactive: false}));
        } else {
            for (const d of this._cache)
                this.menu.addMenuItem(this._row(d));
        }
        const line = this._inventoryLine();
        if (line !== null) {
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem(line,
                {reactive: false}));
        }
        const pending = this._pendingConfig();
        if (pending !== null) {
            for (const it of this._configItems(pending))
                this.menu.addMenuItem(it);
        }
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const rescan = new PopupMenu.PopupMenuItem(_('🔄 Re-scan USB'));
        rescan.connect('activate', () => this._rescanThenRebuild());
        this.menu.addMenuItem(rescan);
        const prefs = new PopupMenu.PopupMenuItem(_('⚙ Open prefs'));
        prefs.connect('activate', () => this._openPrefs?.());
        this.menu.addMenuItem(prefs);
    }

    _row(dev) {
        const sub = new PopupMenu.PopupSubMenuMenuItem(
            `${dev.product || 'Stream Deck'} (${dev.serial || '?'})`);

        const status = new PopupMenu.PopupMenuItem(_('Status'));
        status.connect('activate', () => _notify(dev.product || 'Stream Deck',
            `Bus ${dev.bus} Device ${dev.device}\n` +
            `Vendor: ${dev.vendor_name}\n` +
            `Serial: ${dev.serial || '?'}`));
        sub.menu.addMenuItem(status);

        const open = new PopupMenu.PopupMenuItem(_('Start deck program'));
        open.connect('activate', () => this._launchController());
        sub.menu.addMenuItem(open);

        const restart = new PopupMenu.PopupMenuItem(_('Restart deck'));
        restart.connect('activate', () => this._restart());
        sub.menu.addMenuItem(restart);

        const det = new PopupMenu.PopupMenuItem(_('Show details'));
        det.connect('activate', async () => {
            const {default: GLib2} = await import('gi://GLib');
            const [, stdout] = GLib2.spawn_command_line_sync(
                `lsusb -s ${dev.bus}:${dev.device} -v`);
            _notify(dev.product || 'Stream Deck',
                new TextDecoder().decode(stdout || new Uint8Array())
                    .slice(0, 800));
        });
        sub.menu.addMenuItem(det);
        return sub;
    }

    _projectRoot() {
        // extension.path is the link under gnome-shell/extensions; the
        // checkout root is derived from the link target.
        return projectRootFrom(this._extension.path, makeGioReadLink(Gio));
    }

    // The deck service unit, looked up at the click like the venv below.
    _deckUnitExists() {
        return GLib.file_test(deckUnitPath(GLib.get_user_config_dir()),
            GLib.FileTest.EXISTS);
    }

    _launchController() {
        const root = this._projectRoot();
        // .venv.streamdeck exists only once the Stream Deck level is
        // installed. It is looked up at the click, not in enable(), so a
        // level added after the session started is found.
        const py = streamDeckPython(root,
            (p) => GLib.file_test(p, GLib.FileTest.IS_EXECUTABLE));
        const argv = openDeckArgv(
            {unitExists: this._deckUnitExists(), python: py, root});
        if (argv === null) {
            _notify('Stream Deck',
                _('ERPLibre Home Stream Deck is not installed: make erplibre_home_streamdeck_install'));
            return;
        }
        if (argv[0] === 'systemctl')
            this._driveUnit(argv, root);
        else
            spawnDetached(argv, {notify: _notify, title: 'Stream Deck'});
    }

    // Runs systemctl start or restart on the unit, then reads the unit's
    // state at the times awaitDeckStart() sets, without blocking the
    // shell: a start that ExecCondition skips exits 0 and leaves the unit
    // inactive, and, with Type=simple, a program that finds the deck busy
    // or no visual deck, or that crashes and waits for its restart, exits
    // after systemctl has returned. The click would otherwise do nothing
    // visible; the notice says why no program runs.
    async _driveUnit(argv, root) {
        const done = await runProcess(argv,
            {notify: _notify, title: 'Stream Deck'});
        if (!done.ok)
            return;
        const outcome = await awaitDeckStart({
            wait: ms => this._settle(ms),
            readProps: async () =>
                parseUnitShow((await runProcess(deckStateArgv())).stdout),
        });
        if (outcome.kind === 'running')
            return;
        const facts = {};
        if (outcome.kind === 'busy')
            facts.holder = parseLockHolder(this._readDeckLock());
        else if (outcome.kind === 'skipped')
            facts.checkStderr = (await runProcess(deckCheckArgv(root))).stderr;
        _notify('Stream Deck', deckStartNotice(outcome, facts));
    }

    // Resolves after `ms` milliseconds; destroy() removes a pending wait,
    // whose promise then never resolves and ends the series of reads. A
    // wait asked for after destroy(), once a read in flight returns, never
    // resolves either and adds no source.
    _settle(ms) {
        return new Promise(resolve => {
            if (this._destroyed)
                return;
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms,
                () => {
                    this._settleIds.delete(id);
                    resolve();
                    return GLib.SOURCE_REMOVE;
                });
            this._settleIds.add(id);
        });
    }

    // The deck lock's text, "" when it cannot be read. Only a regular
    // file is read: the lock lives in the private $XDG_RUNTIME_DIR, and a
    // FIFO in its place would block the shell.
    _readDeckLock() {
        const path = deckLockPath(GLib.get_user_runtime_dir());
        if (GLib.file_test(path, GLib.FileTest.IS_SYMLINK) ||
            !GLib.file_test(path, GLib.FileTest.IS_REGULAR))
            return '';
        try {
            const [ok, contents] = GLib.file_get_contents(path);
            return ok ? new TextDecoder().decode(contents) : '';
        } catch (_e) {
            return '';
        }
    }

    _restart() {
        // With the unit, systemd stops the program it runs and starts the
        // one the settings name; the pidfile is the controller's own.
        const viaUnit = restartDeckArgv({unitExists: this._deckUnitExists()});
        if (viaUnit !== null) {
            this._driveUnit(viaUnit, this._projectRoot());
            return;
        }
        if (GLib.file_test(PIDFILE, GLib.FileTest.EXISTS)) {
            try {
                const [ok, contents] = GLib.file_get_contents(PIDFILE);
                if (ok) {
                    const pid = parseInt(
                        new TextDecoder().decode(contents).trim(), 10);
                    if (pid > 0) spawnDetached(['kill', String(pid)],
                        {notify: _notify, title: 'Stream Deck'});
                }
            } catch (_e) {}
        }
        // Give it half a second to die, then relaunch.
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this._launchController();
            return GLib.SOURCE_REMOVE;
        });
    }
});

export const indicatorDescriptor = {
    id: 'device',
    displayName: 'Device',
    defaultEnabled: true,
    ctor: (opts) => new DeviceIndicator(opts),
};
