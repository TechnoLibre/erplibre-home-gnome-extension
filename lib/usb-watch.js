/**
 * The Stream Decks plugged into this machine, kept up to date for the
 * inventory service and the device indicator.
 *
 * With the GUdev typelib, a udev client on `usb/usb_device` wakes the
 * watch at each uevent, and the watch lists the Elgato devices (vendor
 * 0fd9) from sysfs. Without it, the watch runs `lsusb -d 0fd9: -v` every
 * POLL_S seconds, asynchronously, and finds each device's port path and
 * sysfs serial through its character device link
 * `/sys/dev/char/189:<minor>`. A deck's serial is the sysfs `serial`
 * attribute, else the `iSerial` lsusb prints, else null.
 *
 * Nothing here blocks GNOME Shell on a process: every spawn and file read
 * is asynchronous. GUdev's own listing reads sysfs synchronously; sysfs is
 * served by the kernel from memory and never waits on a disk or a network.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {parseLsusbVerbose} from './usb.js';
import {captureOutput} from './spawn.js';
import {POLL_S} from './inventory.js';

export const ELGATO_VENDOR = '0fd9';

// A plug or an unplug sends several uevents (add, bind…) within a few
// milliseconds; one scan follows the burst.
const UEVENT_SETTLE_MS = 300;

// Character major of USB device nodes; the kernel numbers the minor
// (bus - 1) * 128 + (device - 1).
const USB_DEVICE_MAJOR = 189;

const USB_PATH_RE = /^\d+-\d+(\.\d+)*$/;

/**
 * The minor of the device node of USB device `device` on bus `bus`
 * (decimal text, zero-padded or not), or null when either is not 1–128
 * for the device, a positive integer for the bus.
 */
export function usbMinor(bus, device) {
    const b = /^\d+$/.test(String(bus ?? '')) ? Number(bus) : 0;
    const d = /^\d+$/.test(String(device ?? '')) ? Number(device) : 0;
    if (b < 1 || d < 1 || d > 128) return null;
    return (b - 1) * 128 + (d - 1);
}

/**
 * The port path (`1-2.3`) that ends the target of a sysfs device link,
 * or null when the link names something else (a root hub, an interface).
 */
export function usbPathFromLink(target) {
    if (typeof target !== 'string') return null;
    const name = target.slice(target.lastIndexOf('/') + 1);
    return USB_PATH_RE.test(name) ? name : null;
}

function _text(v) {
    const t = typeof v === 'string' ? v.trim() : '';
    return t === '' ? null : t;
}

function _pad3(v) {
    const t = _text(v);
    return t !== null && /^\d+$/.test(t) ? t.padStart(3, '0') : t ?? '';
}

/**
 * One deck: the wire fields of the inventory (`serial`, `usb_product_id`,
 * `usb_path`, `firmware`, always null: the deck program holds the device)
 * and those the device menu and ListDevices show, as lsusb named them.
 */
export function deckRecord({usbPath, productId, serial, product,
    manufacturer, bus, device}) {
    const pid = _text(productId)?.toLowerCase() ?? null;
    const path = _text(usbPath);
    return {
        serial: _text(serial),
        usb_product_id: pid,
        usb_path: path !== null && USB_PATH_RE.test(path) ? path : null,
        firmware: null,
        product: _text(product),
        vendor_id: ELGATO_VENDOR,
        product_id: pid,
        vendor_name: _text(manufacturer) ?? 'Elgato',
        bus: _pad3(bus),
        device: _pad3(device),
    };
}

function _sorted(decks) {
    return [...decks].sort((a, b) =>
        (a.usb_path ?? '').localeCompare(b.usb_path ?? '') ||
        (a.serial ?? '').localeCompare(b.serial ?? ''));
}

/**
 * The text of the file at `path`, read asynchronously, or null when it
 * cannot be read.
 */
export function readText(path, cancellable = null) {
    return new Promise(resolve => {
        try {
            Gio.File.new_for_path(path).load_contents_async(cancellable,
                (f, res) => {
                    try {
                        const [, bytes] = f.load_contents_finish(res);
                        resolve(new TextDecoder().decode(bytes));
                    } catch (_e) {
                        resolve(null);
                    }
                });
        } catch (_e) {
            resolve(null);
        }
    });
}

function _readLink(path, cancellable) {
    return new Promise(resolve => {
        try {
            Gio.File.new_for_path(path).query_info_async(
                'standard::symlink-target',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                GLib.PRIORITY_DEFAULT, cancellable, (f, res) => {
                    try {
                        resolve(f.query_info_finish(res)
                            .get_symlink_target() || null);
                    } catch (_e) {
                        resolve(null);
                    }
                });
        } catch (_e) {
            resolve(null);
        }
    });
}

/**
 * Watches the Elgato devices. `onChange(decks)` runs once after the first
 * scan, whatever it finds (an empty list when neither GUdev nor lsusb is
 * there), then each time the list differs from the last one it gave.
 * `decks()` is a copy of that list, sorted by port path.
 */
export class UsbWatch {
    constructor({onChange, pollS = POLL_S, sysfsRoot = '/sys'} = {}) {
        this._onChange = onChange;
        this._pollS = pollS;
        this._sysfs = sysfsRoot.replace(/\/+$/, '');
        this._decks = [];
        this._signature = null;
        this._client = null;
        this._uevent = 0;
        this._settleId = 0;
        this._pollId = 0;
        this._lsusb = false;
        this._mode = null;
        this._scanning = false;
        this._again = false;
        this._stopped = false;
        this._cancellable = new Gio.Cancellable();
    }

    start() {
        this._lsusb = GLib.find_program_in_path('lsusb') !== null;
        this._startAsync().catch(e =>
            console.log(`[ERPLibreHome] usb watch: ${e.message}`));
    }

    async _startAsync() {
        this._client = await this._udevClient();
        if (this._stopped) return;
        if (this._client) {
            this._mode = 'udev';
            this._uevent = this._client.connect('uevent',
                () => this._settleThenScan());
        } else if (this._lsusb) {
            this._mode = 'poll';
            this._pollId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW,
                this._pollS, () => {
                    this.rescan();
                    return GLib.SOURCE_CONTINUE;
                });
        } else {
            this._mode = 'none';
        }
        await this._scan();
    }

    /** A GUdev client on USB devices, or null without the typelib. */
    async _udevClient() {
        try {
            const {default: GUdev} = await import('gi://GUdev?version=1.0');
            if (!GUdev) return null;
            return new GUdev.Client({subsystems: ['usb/usb_device']});
        } catch (_e) {
            return null;
        }
    }

    stop() {
        this._stopped = true;
        this._cancellable.cancel();
        if (this._uevent) this._client?.disconnect(this._uevent);
        this._uevent = 0;
        this._client = null;
        for (const id of [this._settleId, this._pollId])
            if (id) GLib.source_remove(id);
        this._settleId = 0;
        this._pollId = 0;
    }

    decks() {
        return this._decks.map(d => ({...d}));
    }

    /** Scans now; a scan already running is followed by one more. */
    rescan() {
        if (this._stopped || this._mode === null) return;
        this._scan().catch(e =>
            console.log(`[ERPLibreHome] usb scan: ${e.message}`));
    }

    _settleThenScan() {
        if (this._settleId || this._stopped) return;
        this._settleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            UEVENT_SETTLE_MS, () => {
                this._settleId = 0;
                this.rescan();
                return GLib.SOURCE_REMOVE;
            });
    }

    async _scan() {
        if (this._scanning) {
            this._again = true;
            return;
        }
        this._scanning = true;
        try {
            do {
                this._again = false;
                // A failed scan keeps the last list; before any, it is
                // empty, so that the first onChange always comes.
                let decks = this._decks;
                try {
                    if (this._mode === 'udev')
                        decks = await this._udevDecks();
                    else if (this._mode === 'poll')
                        decks = await this._polledDecks();
                } catch (e) {
                    console.log(`[ERPLibreHome] usb scan: ${e.message}`);
                }
                if (this._stopped) return;
                this._publish(_sorted(decks));
            } while (this._again && !this._stopped);
        } finally {
            this._scanning = false;
        }
    }

    _publish(decks) {
        const signature = JSON.stringify(decks);
        if (signature === this._signature) return;
        this._signature = signature;
        this._decks = decks;
        this._onChange?.(this.decks());
    }

    async _udevDecks() {
        const decks = [];
        for (const dev of this._client?.query_by_subsystem('usb') ?? []) {
            if (dev.get_devtype() !== 'usb_device' ||
                dev.get_sysfs_attr('idVendor') !== ELGATO_VENDOR)
                continue;
            const attr = k => dev.get_sysfs_attr(k);
            let serial = attr('serial');
            if (_text(serial) === null && this._lsusb)
                serial = await this._lsusbSerial(attr('busnum'), attr('devnum'));
            decks.push(deckRecord({usbPath: dev.get_name(),
                productId: attr('idProduct'), serial, product: attr('product'),
                manufacturer: attr('manufacturer'), bus: attr('busnum'),
                device: attr('devnum')}));
        }
        return decks;
    }

    /** The iSerial lsusb prints for one device, or null. */
    async _lsusbSerial(bus, device) {
        if (usbMinor(bus, device) === null) return null;
        const out = await captureOutput(['lsusb', '-s',
            `${_pad3(bus)}:${_pad3(device)}`, '-v'], this._cancellable);
        return parseLsusbVerbose(out ?? '')[0]?.serial || null;
    }

    async _polledDecks() {
        const out = await captureOutput(['lsusb', '-d', `${ELGATO_VENDOR}:`,
            '-v'], this._cancellable);
        if (out === null) return this._decks;
        const decks = [];
        for (const dev of parseLsusbVerbose(out)) {
            if (dev.vendor_id !== ELGATO_VENDOR) continue;
            const minor = usbMinor(dev.bus, dev.device);
            let usbPath = null;
            let serial = null;
            if (minor !== null) {
                const node = `${this._sysfs}/dev/char/${USB_DEVICE_MAJOR}:${minor}`;
                usbPath = usbPathFromLink(
                    await _readLink(node, this._cancellable));
                if (usbPath !== null)
                    serial = await readText(`${node}/serial`, this._cancellable);
            }
            decks.push(deckRecord({usbPath, productId: dev.product_id,
                serial: _text(serial) ?? dev.serial, product: dev.product,
                manufacturer: dev.manufacturer, bus: dev.bus,
                device: dev.device}));
        }
        return decks;
    }
}
