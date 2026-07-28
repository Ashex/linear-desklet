/*
 * tooltip.js - a multi-line tooltip, centred below the pointer and kept
 * inside the screen.
 *
 * Suits blocks of text rather than short labels: it measures the string,
 * wraps once it would exceed a comfortable reading width, centres the box
 * horizontally on the pointer, and positions it below - flipping above
 * when there is no room, and clamping to the usable area of the monitor in
 * both axes.
 *
 * Cinnamon's Tooltips.TooltipBase supplies the show and hide triggers:
 * enter, motion, leave, button presses, and the delay before appearing.
 * This class implements only show, hide and _destroy, which is the
 * contract that base class expects.
 */

const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const Main = imports.ui.main;
const Pango = imports.gi.Pango;
const St = imports.gi.St;
const Tooltips = imports.ui.tooltips;

const DESKTOP_SCHEMA = 'org.cinnamon.desktop.interface';
const CURSOR_SIZE_KEY = 'cursor-size';

/*
 * The reading width the text wraps at, as a fraction of the usable screen
 * width, bounded at both ends.
 *
 * A line much wider than this is hard to read back regardless of available
 * space. The fraction keeps the box proportionate on a small display, the
 * ceiling stops it sprawling on a large one, and the floor keeps it usable
 * on a narrow one.
 */
var MAX_WIDTH_FRACTION = 0.28;
var MAX_WIDTH_CEILING = 560;
var MIN_WIDTH_FLOOR = 240;

// Kept clear of the screen edge, so the tooltip never looks wedged into it.
var SCREEN_MARGIN = 8;

var Tooltip = class Tooltip extends Tooltips.TooltipBase {
    constructor(item, initialText) {
        super(item);

        this._label = new St.Label({ name: 'Tooltip' });
        this._label.show_on_set_parent = false;
        this._label.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);

        Main.uiGroup.add_actor(this._label);

        this._text = initialText || '';
        this._desktopSettings = new Gio.Settings({ schema_id: DESKTOP_SCHEMA });
    }

    setText(text) {
        this._text = text || '';
    }

    // Alias matching Cinnamon's own tooltip API.
    set_text(text) {
        this.setText(text);
    }

    /*
     * The area the tooltip may occupy: the monitor under the owning actor,
     * less any horizontal panels and a margin at each edge.
     *
     * Panels are measured directly because Cinnamon 6 exposes no work-area
     * helper. Vertical panels are ignored, as they do not constrain the
     * vertical space a tooltip needs.
     */
    _usableArea() {
        let monitor = Main.layoutManager.findMonitorForActor(this.item) ||
            Main.layoutManager.primaryMonitor;

        let top = monitor.y;
        let bottom = monitor.y + monitor.height;

        let panels = [];
        try {
            if (Main.panelManager && Main.panelManager.getPanels)
                panels = Main.panelManager.getPanels() || [];
        } catch (e) {
            panels = [];
        }

        panels.forEach(function (panel) {
            if (!panel || !panel.actor || !panel.actor.visible)
                return;

            let box;
            try {
                box = panel.actor.get_allocation_box();
            } catch (e) {
                return;
            }

            // Panels on another monitor, and vertical panels, do not
            // constrain the space available here.  A panel spanning less
            // than half the monitor width is taken to be vertical.
            if (box.x2 <= monitor.x || box.x1 >= monitor.x + monitor.width)
                return;
            if ((box.x2 - box.x1) < monitor.width * 0.5)
                return;

            if (box.y1 <= monitor.y + monitor.height / 2)
                top = Math.max(top, box.y2);
            else
                bottom = Math.min(bottom, box.y1);
        });

        return {
            x: monitor.x + SCREEN_MARGIN,
            y: top + SCREEN_MARGIN,
            width: Math.max(1, monitor.width - SCREEN_MARGIN * 2),
            height: Math.max(1, bottom - top - SCREEN_MARGIN * 2),
        };
    }

    /*
     * Sizes the label to its text, wrapping if it exceeds the reading
     * width, and returns the outer box dimensions.
     *
     * Two St.Label measurement rules govern the order of operations here:
     *
     *   Natural width must be measured with wrapping off and no width set,
     *   otherwise the width left over from the previous call is what gets
     *   reported.
     *
     *   A St.Label reports the width of its previous string until the next
     *   allocation cycle, so clutter_text.allocate_preferred_size() must be
     *   called after set_text and before measuring.
     */
    _layoutText(area) {
        let text = this._label.clutter_text;

        text.set_line_wrap(false);
        this._label.set_width(-1);
        this._label.set_text(this._text);
        text.allocate_preferred_size(Clutter.AllocationFlags.NONE);

        let node = this._label.get_theme_node();
        let padH = node.get_padding(St.Side.LEFT) + node.get_padding(St.Side.RIGHT);
        let padV = node.get_padding(St.Side.TOP) + node.get_padding(St.Side.BOTTOM);

        let maxTextWidth = Math.max(MIN_WIDTH_FLOOR,
            Math.min(MAX_WIDTH_CEILING, Math.round(area.width * MAX_WIDTH_FRACTION)));
        // However wide the reading measure, it can never exceed the screen.
        maxTextWidth = Math.min(maxTextWidth, area.width - padH);

        let natural = text.get_preferred_width(-1)[1];
        let wrapping = natural > maxTextWidth;

        if (wrapping) {
            text.set_line_wrap(true);
            // WORD_CHAR so that an unbroken run, such as a long URL, wraps
            // instead of forcing the box wider than the reading width.
            text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
        }

        let textWidth = wrapping ? maxTextWidth : Math.ceil(natural);
        let textHeight = text.get_preferred_height(textWidth)[1];

        this._label.set_width(textWidth + padH);

        return {
            width: textWidth + padH,
            height: Math.ceil(textHeight) + padV,
        };
    }

    show() {
        if (!this._text || !this.mousePosition)
            return;

        /*
         * The label is mapped before being measured, off-screen so that no
         * frame is drawn at the stale position.
         *
         * An actor that has never been shown has never been allocated, and
         * an unallocated St.Label reports a preferred width close to zero
         * whatever its text.
         */
        if (!this.visible) {
            this._label.set_position(-10000, -10000);
            this._label.show();
        }

        let area = this._usableArea();
        let size = this._layoutText(area);

        // The cursor is drawn down and right of the hotspot, so the
        // tooltip is offset to clear the whole glyph.
        let cursorSize = 24;
        try {
            cursorSize = this._desktopSettings.get_int(CURSOR_SIZE_KEY);
        } catch (e) {
            // The default above is the usual value.
        }

        let pointerX = this.mousePosition[0];
        let pointerY = this.mousePosition[1];

        let left = Math.round(pointerX - size.width / 2);
        let top = pointerY + Math.round(cursorSize * 0.75);

        /*
         * Below the pointer where it fits, above it where it does not.
         * Flipping rather than clamping keeps the tooltip clear of the
         * actor being hovered.
         */
        if (top + size.height > area.y + area.height) {
            let above = pointerY - size.height - Math.round(cursorSize * 0.25);
            if (above >= area.y)
                top = above;
        }

        // Final clamp into the usable area.  A tooltip taller than the
        // screen is pinned to the top, leaving the start of the text
        // visible rather than the end.
        left = Math.max(area.x, Math.min(left, area.x + area.width - size.width));
        top = Math.max(area.y, Math.min(top, area.y + area.height - size.height));

        this._label.set_position(left, top);
        this._label.show();
        this._label.raise_top();
        this.visible = true;
    }

    hide() {
        if (this._label.is_finalized())
            return;
        this._label.hide();
        this.visible = false;
    }

    _destroy() {
        this._label.destroy();
    }
};
