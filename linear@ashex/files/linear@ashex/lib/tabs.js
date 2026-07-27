/*
 * tabs.js - the Issues / Mentions selector.
 *
 * St has no notebook widget, so a tab row is assembled from buttons. The
 * selection is expressed by an accent underline rather than by a CSS
 * pseudo-class, for the same reason the rest of the desklet avoids them:
 * the colours are chosen at runtime from the user's settings, so the style
 * has to be built in JavaScript either way.
 *
 * Each tab keeps its underline widget even when unselected, transparent
 * rather than absent. Adding and removing it would change the row's height
 * by two pixels as the selection moved, and the whole desklet would twitch.
 */

const Cinnamon = imports.gi.Cinnamon;
const Clutter = imports.gi.Clutter;
const St = imports.gi.St;

/*
 * Builds the tab row.
 *
 * options.tabs is a list of { id, label, badge, accent }; badge is an
 * optional count rendered as a filled pill, shown only when above zero.
 * options.onSelect is called with a tab id, and only when that id is not
 * already the active one.
 */
function buildTabBar(theme, options) {
    let tabs = options.tabs || [];
    let active = options.active;
    let onSelect = options.onSelect || function () {};

    let bar = new St.BoxLayout({ vertical: false });
    bar.set_style(theme.tabBarStyle());

    tabs.forEach(function (tab) {
        let selected = tab.id === active;
        let accent = tab.accent;

        let button = new St.Button({
            reactive: true,
            track_hover: true,
            can_focus: true,
            x_expand: false,
        });

        let column = new St.BoxLayout({ vertical: true });

        let labelRow = new St.BoxLayout({ vertical: false });
        let label = new St.Label({ text: tab.label });
        labelRow.add_child(label);

        let badge = null;
        if (tab.badge > 0) {
            badge = new St.Label({ text: String(tab.badge) });
            badge.set_style(theme.badgeStyle(accent));
            labelRow.add_child(badge);
        }

        let underline = new St.Widget({
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
        });
        underline.set_style(theme.tabUnderlineStyle(accent, selected, null));

        column.add_child(labelRow);
        column.add_child(new St.Widget({ height: theme.px(4) }));
        column.add_child(underline);
        button.set_child(column);

        function applyStyle(hovered) {
            button.set_style(theme.tabStyle(accent, selected, hovered));
        }
        applyStyle(false);

        button.connect('enter-event', function () {
            applyStyle(true);
            // The pointing hand is the only affordance a flat tab has;
            // without it the row reads as a heading rather than a control.
            global.set_cursor(Cinnamon.Cursor.POINTING_HAND);
        });
        button.connect('leave-event', function () {
            applyStyle(false);
            global.unset_cursor();
        });
        /*
         * Switching tabs rebuilds this row, destroying the button under
         * the pointer without ever sending leave-event. Without this the
         * pointing-hand cursor would be stranded across the whole desktop
         * after every single tab change.
         */
        button.connect('destroy', function () {
            if (button.get_hover())
                global.unset_cursor();
        });

        button.connect('clicked', function () {
            if (tab.id !== active)
                onSelect(tab.id);
        });

        bar.add_child(button);
    });

    // Pushes the tabs left and lets the row own the full desklet width, so
    // the hairline under it runs edge to edge.
    bar.add_child(new St.Widget({ x_expand: true }));

    return bar;
}
