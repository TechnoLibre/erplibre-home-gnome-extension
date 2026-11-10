/**
 * The workstation tokens of the inventory, in the GNOME keyring through
 * libsecret: one password item per destination, under the schema
 * SECRET_SCHEMA with the attributes `destination` = the destination id,
 * and `url` and `db` = the Odoo URL (without a trailing slash) and the
 * database the token was issued for. Nothing else on the workstation
 * holds a token.
 *
 * A token is looked up by all three: a destination whose URL or database
 * is edited under the same id finds no token, so the token one Odoo
 * issued never goes to another server, which could replay it. Odoo also
 * derives the workstation fingerprint from the URL and the database, so
 * the new pair needs an enrollment of its own anyway.
 *
 * Every call is asynchronous (libsecret talks to the keyring over D-Bus)
 * and rejects when the keyring fails, so that a caller never mistakes a
 * locked or absent keyring for "no token".
 */

export const SECRET_SCHEMA = 'ca.technolibre.erplibre-home.inventory';
export const SECRET_ATTRIBUTE = 'destination';

let _secret = null;
let _schema = null;

async function _lib() {
    if (!_secret) {
        const {default: Secret} = await import('gi://Secret?version=1');
        _secret = Secret;
        _schema = new Secret.Schema(SECRET_SCHEMA, Secret.SchemaFlags.NONE,
            {[SECRET_ATTRIBUTE]: Secret.SchemaAttributeType.STRING,
                url: Secret.SchemaAttributeType.STRING,
                db: Secret.SchemaAttributeType.STRING});
    }
    return {Secret: _secret, schema: _schema};
}

function _call(start, finish) {
    return new Promise((resolve, reject) => {
        start((_o, res) => {
            try {
                resolve(finish(res));
            } catch (e) {
                reject(e);
            }
        });
    });
}

/**
 * The attributes of the token of `destId` issued for `issuedFor`
 * (`{url, db}`, both non-empty strings); throws a TypeError otherwise, so
 * that no call ever matches a token whatever its Odoo.
 */
function _attributes(destId, issuedFor) {
    const url = typeof issuedFor?.url === 'string'
        ? issuedFor.url.replace(/\/+$/, '') : '';
    const db = issuedFor?.db;
    if (typeof destId !== 'string' || destId === '' || url === '' ||
        typeof db !== 'string' || db === '')
        throw new TypeError('a token is bound to a destination, URL and db');
    return {[SECRET_ATTRIBUTE]: destId, url, db};
}

/**
 * The token of destination `destId` issued for `issuedFor` (`{url, db}`),
 * or null when none is stored for that URL and database.
 */
export async function lookupToken(destId, issuedFor) {
    const attributes = _attributes(destId, issuedFor);
    const {Secret, schema} = await _lib();
    const token = await _call(
        cb => Secret.password_lookup(schema, attributes, null, cb),
        res => Secret.password_lookup_finish(res));
    return token || null;
}

/**
 * Stores `token`, issued for `issuedFor` (`{url, db}`), as the only token
 * of `destId` in the default collection: the tokens it held, whatever
 * their Odoo, are removed first. `label` is what the keyring manager
 * shows.
 */
export async function storeToken(destId, label, token, issuedFor) {
    const attributes = _attributes(destId, issuedFor);
    await clearToken(destId);
    const {Secret, schema} = await _lib();
    await _call(
        cb => Secret.password_store(schema, attributes,
            Secret.COLLECTION_DEFAULT, label, token, null, cb),
        res => Secret.password_store_finish(res));
}

/**
 * Removes every token of `destId`, whatever its Odoo; none is not an
 * error. An id that is not a non-empty string throws a TypeError: the
 * keyring would read a missing attribute as "any destination".
 */
export async function clearToken(destId) {
    if (typeof destId !== 'string' || destId === '')
        throw new TypeError('a destination id is required');
    const {Secret, schema} = await _lib();
    await _call(
        cb => Secret.password_clear(schema, {[SECRET_ATTRIBUTE]: destId},
            null, cb),
        res => Secret.password_clear_finish(res));
}
