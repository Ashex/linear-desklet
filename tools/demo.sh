#!/usr/bin/env bash
#
# demo.sh - drives the Linear desklet's demo data, for taking the
# screenshots the Cinnamon Spices listing requires.
#
# The data is fabricated and lives only in memory: nothing is written to
# the response cache, and no request is made. That is deliberate, so a
# published screenshot never carries a real workspace name, a real issue
# title or a colleague's name.
#
#   ./tools/demo.sh on         load the data (Issues tab)
#   ./tools/demo.sh mentions   switch to the Mentions tab
#   ./tools/demo.sh grouped    Issues, grouped by team
#   ./tools/demo.sh issues     back to the plain Issues tab
#   ./tools/demo.sh raise      float desklets above windows, to shoot them
#   ./tools/demo.sh lower      put them back behind windows
#   ./tools/demo.sh off        discard the data and resume normal refreshes
#
# While the demo is loaded the periodic refresh is disarmed, so the data
# stays put for as long as it takes to frame a shot. 'off' re-arms it.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEMO_JS="${SCRIPT_DIR}/demo-data.js"

if [ ! -f "${DEMO_JS}" ]; then
    echo "cannot find demo-data.js next to this script" >&2
    exit 1
fi

# Runs a snippet inside Cinnamon and prints whatever it returns.
cinnamon_eval() {
    dbus-send --session --print-reply=literal \
        --dest=org.Cinnamon /org/Cinnamon org.Cinnamon.Eval \
        string:"$1" 2>&1 | tail -1 | sed -e 's/^[[:space:]]*//' -e 's/\\n/\n/g'
}

run_demo() {
    cinnamon_eval "global.__linearDemoCommand='$1'; let [ok,b]=imports.gi.GLib.file_get_contents('${DEMO_JS}'); eval(imports.byteArray.toString(b))"
}

case "${1:-on}" in
    on|issues|mentions|grouped|off)
        run_demo "${1:-on}"
        ;;
    raise)
        # Desklets normally sit behind windows, so they cannot be
        # photographed without either this or minimising everything.
        cinnamon_eval 'global.display.set_desklets_above(true); "desklets are above windows"'
        ;;
    lower)
        cinnamon_eval 'global.display.set_desklets_above(false); "desklets are behind windows again"'
        ;;
    where)
        # Prints the position and size, which is what a cropping command
        # needs.
        cinnamon_eval '
            let M = imports.ui.deskletManager;
            let d = M.definitions.filter(x => x && x.uuid === "linear@ashex")[0];
            if (!d || !d.desklet) "the desklet is not on the desktop";
            else {
                let a = d.desklet.actor;
                let p = a.get_transformed_position();
                "x=" + Math.round(p[0]) + " y=" + Math.round(p[1]) +
                " w=" + Math.round(a.width) + " h=" + Math.round(a.height);
            }'
        ;;
    *)
        sed -n '3,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
        exit 1
        ;;
esac
