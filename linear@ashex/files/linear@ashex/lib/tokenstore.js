/*
 * tokenstore.js - where OAuth tokens live.
 *
 * Not in the desklet settings. Cinnamon writes those to
 * ~/.config/cinnamon/spices/<uuid>/<instance>.json with default
 * permissions, and the settings window will happily display anything stored
 * there. A refresh token is a long-lived credential and deserves better
 * than a world-readable file with its value on screen.
 *
 * Instead: one file per desklet instance under the user's state directory,
 * created 0600. That is the same standard of care the response cache gets,
 * for something considerably more sensitive. It is not a keyring, and on a
 * machine where someone else has your uid it is no defence at all, but it
 * closes the gap between "any process can read it" and "any process running
 * as you can read it".
 *
 * libsecret would be better still. It is not reachable here: GJS needs
 * Secret-1.typelib, which is not part of a default Mint install, and a
 * desklet cannot ask for a package to be installed.
 */

const ByteArray = imports.byteArray;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;

var DIRECTORY_NAME = 'linear@ashex';

function directory() {
    return GLib.build_filenamev([GLib.get_user_state_dir(), DIRECTORY_NAME]);
}

function pathFor(instanceId) {
    let safe = String(instanceId || 'default').replace(/[^A-Za-z0-9_-]/g, '_');
    return GLib.build_filenamev([directory(), 'tokens-' + safe + '.json']);
}

/*
 * Reads the stored tokens, asynchronously.
 *
 * A desklet shares the Cinnamon process: a synchronous read here stalls the
 * whole desktop. Calls back with null when there is nothing stored, which
 * is the normal case before anyone has connected.
 */
function load(instanceId, onDone) {
    let file = Gio.File.new_for_path(pathFor(instanceId));

    file.load_contents_async(null, function (source, result) {
        let tokens = null;
        try {
            let [ok, contents] = source.load_contents_finish(result);
            if (ok) {
                let parsed = JSON.parse(ByteArray.toString(contents));
                // A file with no access token is not a usable grant, and
                // treating it as one would mean sending "Bearer undefined".
                if (parsed && parsed.accessToken)
                    tokens = parsed;
            }
        } catch (e) {
            // Missing on first run, and unreadable is handled the same way:
            // there is no grant, so the desklet asks for one.
            tokens = null;
        }
        onDone(tokens);
    });
}

/*
 * Writes tokens, creating the directory and the file 0600.
 *
 * PRIVATE is what sets the mode, and it only applies when the file is
 * created. A file that already exists keeps whatever permissions it has, so
 * the mode is asserted separately afterwards rather than assumed.
 */
function save(instanceId, tokens, onDone) {
    let path = pathFor(instanceId);
    let file = Gio.File.new_for_path(path);

    let body;
    try {
        body = JSON.stringify(tokens);
    } catch (e) {
        if (onDone)
            onDone(false);
        return;
    }

    let flags = Gio.FileCreateFlags.REPLACE_DESTINATION | Gio.FileCreateFlags.PRIVATE;

    function write() {
        file.replace_contents_bytes_async(
            GLib.Bytes.new(ByteArray.fromString(body)),
            null, false, flags, null,
            function (source, result) {
                let ok = false;
                try {
                    source.replace_contents_finish(result);
                    ok = true;
                } catch (e) {
                    // Deliberately not logging the body: it is a credential.
                    global.logWarning('linear@ashex: could not store the Linear tokens: ' + e);
                }

                if (ok)
                    enforcePermissions(file);

                if (onDone)
                    onDone(ok);
            });
    }

    let dir = Gio.File.new_for_path(directory());
    dir.make_directory_async(GLib.PRIORITY_DEFAULT, null, function (source, result) {
        try {
            source.make_directory_finish(result);
        } catch (e) {
            // Already there is the usual outcome, and is not an error.
        }
        write();
    });
}

/*
 * Makes sure the file really is owner-only.
 *
 * Gio.FileCreateFlags.PRIVATE governs creation; a file that predates this
 * code, or that was replaced rather than created, could still be readable
 * by others. Cheap to assert, and the whole point of the module.
 */
function enforcePermissions(file) {
    file.query_info_async(Gio.FILE_ATTRIBUTE_UNIX_MODE,
        Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null,
        function (source, result) {
            try {
                let info = source.query_info_finish(result);
                let mode = info.get_attribute_uint32(Gio.FILE_ATTRIBUTE_UNIX_MODE);
                // Keep the file type bits, drop every group and other bit.
                let wanted = mode & ~0o077;
                if (mode !== wanted) {
                    let update = new Gio.FileInfo();
                    update.set_attribute_uint32(Gio.FILE_ATTRIBUTE_UNIX_MODE, wanted);
                    source.set_attributes_async(update, Gio.FileQueryInfoFlags.NONE,
                        GLib.PRIORITY_DEFAULT, null, function (target, setResult) {
                            try {
                                target.set_attributes_finish(setResult);
                            } catch (e) {
                                global.logWarning('linear@ashex: could not restrict ' +
                                    'permissions on the token file: ' + e);
                            }
                        });
                }
            } catch (e) {
                // A filesystem without unix modes; nothing to enforce.
            }
        });
}

/*
 * Deletes the stored tokens. Used on disconnect, where leaving a stale
 * refresh token on disk after the user has asked to sign out would be
 * exactly the wrong behaviour.
 */
function clear(instanceId, onDone) {
    let file = Gio.File.new_for_path(pathFor(instanceId));

    file.delete_async(GLib.PRIORITY_DEFAULT, null, function (source, result) {
        try {
            source.delete_finish(result);
        } catch (e) {
            // Already gone is a success as far as the caller is concerned.
        }
        if (onDone)
            onDone();
    });
}
