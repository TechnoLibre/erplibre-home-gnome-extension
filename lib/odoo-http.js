/**
 * The HTTP client of the inventory: JSON calls to the `/streamdeck/v1/`
 * routes of an Odoo instance, on Soup 3, never blocking GNOME Shell.
 *
 * Odoo picks the database of a request from its session cookie, so each
 * call first sends `GET <url>/web/login?db=<db>` on a session that keeps
 * cookies; on a server with one database it changes nothing. Neither call
 * follows a redirect: a redirect would carry the token or the credentials
 * to another place than the URL the policy checked.
 *
 * Nothing here logs: the bodies carry tokens, keys and passwords, and the
 * headers the token.
 */

import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {TIMEOUT_S} from './inventory.js';

/**
 * A Soup session for one destination: a cookie jar for the database
 * choice, and TIMEOUT_S seconds as its I/O and idle timeouts.
 */
export function newSession() {
    const session = new Soup.Session({timeout: TIMEOUT_S,
        idle_timeout: TIMEOUT_S});
    session.add_feature(new Soup.CookieJar());
    return session;
}

/** Sends `message`; resolves to the body bytes, rejects on a transport error. */
function _send(session, message, cancellable) {
    return new Promise((resolve, reject) => {
        session.send_and_read_async(message, GLib.PRIORITY_DEFAULT,
            cancellable, (s, res) => {
                try {
                    resolve(s.send_and_read_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

function _message(method, uri) {
    const message = Soup.Message.new(method, uri);
    if (!message) throw new Error('invalid URI');
    message.set_flags(Soup.MessageFlags.NO_REDIRECT);
    return message;
}

/**
 * POSTs `body` as JSON to `<url><path>` after selecting `db`, with
 * `Authorization: Bearer <token>` when `token` is given. Resolves to
 * `{status, json}`: `json` is the parsed reply, null when it is not JSON;
 * `status` is 0 when either call did not complete (refused, timed out,
 * cancelled through `cancellable`, invalid URL). Never rejects.
 */
export async function postJson(session, url, db, path, body, token,
    {cancellable = null} = {}) {
    const base = String(url).replace(/\/+$/, '');
    try {
        await _send(session, _message('GET',
            `${base}/web/login?db=${encodeURIComponent(db)}`), cancellable);
        const message = _message('POST', `${base}${path}`);
        const headers = message.get_request_headers();
        headers.append('Accept', 'application/json');
        if (token) headers.append('Authorization', `Bearer ${token}`);
        message.set_request_body_from_bytes('application/json',
            new GLib.Bytes(new TextEncoder().encode(JSON.stringify(body))));
        const bytes = await _send(session, message, cancellable);
        let json = null;
        try {
            json = JSON.parse(new TextDecoder().decode(bytes.get_data()));
        } catch (_e) {}
        return {status: message.get_status(), json};
    } catch (_e) {
        return {status: 0, json: null};
    }
}
