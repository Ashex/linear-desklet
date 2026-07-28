#!/usr/bin/env bash
#
# reload.sh - reloads the desklet after a code change, in place.
#
#   ./tools/reload.sh          reload
#   ./tools/reload.sh --check  report cached vs on-disk module sizes only
#
# Unloads the extension with deleteConfig = false, then loads it again in a
# separate main-loop turn. The desklet instance is rebuilt from the new
# code, the desktop is not restarted, and the settings under
# ~/.config/cinnamon/spices/linear@ashex/ are left alone.
#
# Two alternatives are unsuitable:
#
#   Removing and re-adding the desklet through org.cinnamon
#   enabled-desklets deletes its settings, including any configured API
#   key. Cinnamon's _unloadDesklet calls _removeDeskletConfigFile on
#   removal, and there is no undo.
#
#   Extension.reloadExtension() reloads the modules but keeps the running
#   desklet object, because _createDesklets returns early when
#   definitions[i].desklet is already set. The new code is loaded while the
#   live instance keeps the old prototype.

set -euo pipefail

UUID="linear@ashex"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
XLET_DIR="${SCRIPT_DIR}/../${UUID}/files/${UUID}"

cinnamon_eval() {
    dbus-send --session --print-reply=literal \
        --dest=org.Cinnamon /org/Cinnamon org.Cinnamon.Eval \
        string:"$1" 2>&1 | tail -1 | sed -e 's/^[[:space:]]*//' -e 's/^"//' -e 's/"$//' -e 's/\\n/\n/g'
}

# Compares the module sizes Cinnamon has cached against the files on disk.
# Cinnamon keys its module cache on file size, so a mismatch means the
# running code differs from the source.
check_sizes() {
    echo "cached in Cinnamon:"
    cinnamon_eval '
        let F = imports.misc.fileUtils;
        F.LoadedModules
            .filter(m => m && m.path && m.path.indexOf("'"${UUID}"'") !== -1)
            .map(m => "  " + m.path.split("/").pop() + " " + m.size)
            .join("\n") || "  (nothing loaded)"'

    echo "on disk:"
    for file in "${XLET_DIR}/desklet.js" "${XLET_DIR}"/lib/*.js; do
        [ -f "${file}" ] || continue
        printf '  %s %s\n' "$(basename "${file}")" "$(wc -c < "${file}")"
    done
}

if [ "${1:-}" = "--check" ]; then
    check_sizes
    exit 0
fi

# Syntax check before unloading: a file that fails to parse leaves the
# desklet absent from the desktop rather than reporting an error.
for file in "${XLET_DIR}/desklet.js" "${XLET_DIR}"/lib/*.js; do
    [ -f "${file}" ] || continue
    if ! node --check "${file}" >/dev/null 2>&1; then
        echo "syntax error in $(basename "${file}") -- not reloading" >&2
        node --check "${file}" || true
        exit 1
    fi
done

echo -n "unloading... "
cinnamon_eval '
    let E = imports.ui.extension;
    E.unloadExtension("'"${UUID}"'", E.Type.DESKLET, false, false);
    "ok"'

# The load must happen in a later main-loop turn than the unload, or the
# old instance is still registered and is kept instead of being rebuilt.
sleep 1

echo -n "loading... "
cinnamon_eval '
    let E = imports.ui.extension;
    E.loadExtension("'"${UUID}"'", E.Type.DESKLET);
    "ok"'

sleep 3

cinnamon_eval '
    let M = imports.ui.deskletManager;
    let d = M.definitions.filter(x => x && x.uuid === "'"${UUID}"'")[0];
    let k = d ? d.desklet : null;
    if (!k) {
        "FAILED: the desklet did not come back. Check Melange (Alt+F2, lg).";
    } else {
        let errors = (imports.ui.main._errorLogStack || [])
            .filter(e => e.category === "error" && e.message.indexOf("'"${UUID}"'") !== -1);
        "reloaded" +
        (k.actor.mapped ? ", on the desktop" : ", but not mapped") +
        (errors.length ? " | " + errors.length + " error(s) logged" : "");
    }'
