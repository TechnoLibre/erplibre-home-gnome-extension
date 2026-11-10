/**
 * The workstation tokens of the inventory, in the GNOME keyring through
 * libsecret: one password item per destination, under the schema
 * SECRET_SCHEMA with the attribute `destination` = the destination id.
 * Nothing else on the workstation holds a token.
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
            {[SECRET_ATTRIBUTE]: Secret.SchemaAttributeType.STRING});
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

/** The token of destination `destId`, or null when none is stored. */
export async function lookupToken(destId) {
    const {Secret, schema} = await _lib();
    const token = await _call(
        cb => Secret.password_lookup(schema,
            {[SECRET_ATTRIBUTE]: destId}, null, cb),
        res => Secret.password_lookup_finish(res));
    return token || null;
}

/**
 * Stores `token` for `destId` in the default collection, replacing the
 * previous one; `label` is what the keyring manager shows.
 */
export async function storeToken(destId, label, token) {
    const {Secret, schema} = await _lib();
    await _call(
        cb => Secret.password_store(schema, {[SECRET_ATTRIBUTE]: destId},
            Secret.COLLECTION_DEFAULT, label, token, null, cb),
        res => Secret.password_store_finish(res));
}

/** Removes the token of `destId`; no token is not an error. */
export async function clearToken(destId) {
    const {Secret, schema} = await _lib();
    await _call(
        cb => Secret.password_clear(schema, {[SECRET_ATTRIBUTE]: destId},
            null, cb),
        res => Secret.password_clear_finish(res));
}
