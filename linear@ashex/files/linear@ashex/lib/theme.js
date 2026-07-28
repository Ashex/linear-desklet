/*
 * theme.js - the soft neon rainbow palette and the Fluent acrylic surface
 * rules built on top of it.
 *
 * Ported from the Agenda desklet so the two read as siblings on one
 * desktop: the same surface tokens, the same geometry, the same contrast
 * handling. What differs is how an accent gets chosen. Agenda colours by
 * calendar or time of day; here the colour carries priority or workflow
 * state, which is the thing worth encoding about a Linear issue.
 *
 * Cinnamon's CSS engine understands a useful subset of CSS: solid and
 * rgba colours, border radius, box shadows and two-stop background
 * gradients. Everything here is expressed within that subset, and the
 * per-item colours are emitted as inline style strings because they are
 * chosen at runtime rather than authored in the stylesheet.
 */

// Soft neon: saturated enough to glow against a photograph, desaturated
// enough that eight of them side by side do not fight each other.
var RAINBOW = [
    { name: 'rose', rgb: [255, 122, 183] },
    { name: 'coral', rgb: [255, 150, 110] },
    { name: 'amber', rgb: [255, 205, 112] },
    { name: 'lime', rgb: [168, 240, 140] },
    { name: 'mint', rgb: [116, 240, 190] },
    { name: 'cyan', rgb: [116, 224, 245] },
    { name: 'azure', rgb: [130, 170, 255] },
    { name: 'violet', rgb: [190, 150, 250] },
];

function named(name) {
    for (let i = 0; i < RAINBOW.length; i++) {
        if (RAINBOW[i].name === name)
            return RAINBOW[i];
    }
    return RAINBOW[0];
}

/*
 * Deliberately outside the rainbow. Cancelled work and read mentions
 * still need an accent for their borders and bars, but giving them a neon
 * would put them in competition with the things that matter.
 */
var SLATE = { name: 'slate', rgb: [150, 158, 178] };

/*
 * Priority runs from urgent through to none. Warm and loud at the urgent
 * end, cool and quiet at the low end, with "no priority" pushed off to
 * violet so it reads as unclassified rather than as merely lowest.
 */
var PRIORITY_ACCENTS = {
    0: named('violet'),
    1: named('rose'),
    2: named('coral'),
    3: named('amber'),
    4: named('azure'),
};

/*
 * Workflow state. Linear's own state types, coloured so that motion is
 * visible at a glance: cool while waiting, green once moving.
 */
var STATE_ACCENTS = {
    triage: named('coral'),
    backlog: named('violet'),
    unstarted: named('azure'),
    started: named('mint'),
    completed: named('lime'),
    canceled: SLATE,
    duplicate: SLATE,
};

function rgba(rgb, alpha) {
    if (alpha >= 1)
        return 'rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')';
    return 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + alpha.toFixed(3) + ')';
}

function mix(a, b, amount) {
    return [
        Math.round(a[0] + (b[0] - a[0]) * amount),
        Math.round(a[1] + (b[1] - a[1]) * amount),
        Math.round(a[2] + (b[2] - a[2]) * amount),
    ];
}

function lighten(rgb, amount) {
    return mix(rgb, [255, 255, 255], amount);
}

function darken(rgb, amount) {
    return mix(rgb, [0, 0, 0], amount);
}

/*
 * Linear publishes a hex colour for every workflow state and project.
 * Accepting both the three and six digit forms costs a line and saves a
 * whole colour mode falling back to grey on an unexpected payload.
 */
function parseHexColor(value) {
    let text = String(value || '').trim();
    let match = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(text);
    if (!match)
        return null;

    let digits = match[1];
    if (digits.length === 3) {
        digits = digits.charAt(0) + digits.charAt(0) +
            digits.charAt(1) + digits.charAt(1) +
            digits.charAt(2) + digits.charAt(2);
    }

    let number = parseInt(digits, 16);
    return [(number >> 16) & 255, (number >> 8) & 255, number & 255];
}

// WCAG relative luminance, used to keep accent text readable rather than
// merely pretty.
function relativeLuminance(rgb) {
    let channels = rgb.map(function (value) {
        let c = value / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(a, b) {
    let la = relativeLuminance(a);
    let lb = relativeLuminance(b);
    let lighter = Math.max(la, lb);
    let darker = Math.min(la, lb);
    return (lighter + 0.05) / (darker + 0.05);
}

var CONTRAST_TARGET = 4.5;

function wrapIndex(index) {
    let length = RAINBOW.length;
    return ((index % length) + length) % length;
}

/*
 * Picks a colour for an issue or a mention. Four strategies, because
 * which one reads best depends entirely on how someone works: a person
 * living out of one team's backlog wants state, a person triaging across
 * teams wants priority.
 *
 * Every branch falls through to the positional rainbow when the field it
 * needs is missing, which is what keeps mentions - who have neither a
 * priority nor a state of their own - from all rendering grey.
 */
function accentFor(mode, item, position) {
    let subject = item || {};

    switch (mode) {
        case 'priority': {
            let priority = Number(subject.priority);
            if (!isNaN(priority) && PRIORITY_ACCENTS[priority])
                return PRIORITY_ACCENTS[priority];
            break;
        }
        case 'state': {
            if (subject.stateType && STATE_ACCENTS[subject.stateType])
                return STATE_ACCENTS[subject.stateType];
            break;
        }
        case 'linear': {
            let rgb = parseHexColor(subject.stateColor);
            if (rgb)
                return { name: 'linear', rgb: rgb };
            if (subject.stateType && STATE_ACCENTS[subject.stateType])
                return STATE_ACCENTS[subject.stateType];
            break;
        }
    }

    return RAINBOW[wrapIndex(position)];
}

/*
 * Palette derived from the user's light/dark preference. Fluent leans on
 * layered translucency rather than hard borders, so every surface here is
 * a low-alpha wash over whatever the desktop wallpaper happens to be.
 */
function surfacePalette(dark) {
    if (dark) {
        return {
            dark: true,
            base: [18, 18, 26],
            text: 'rgba(255,255,255,0.96)',
            textMuted: 'rgba(255,255,255,0.62)',
            textFaint: 'rgba(255,255,255,0.40)',
            stroke: 'rgba(255,255,255,0.10)',
            strokeStrong: 'rgba(255,255,255,0.16)',
            layer: 'rgba(255,255,255,0.055)',
            layerHover: 'rgba(255,255,255,0.095)',
            shadow: 'rgba(0,0,0,0.55)',
        };
    }
    return {
        dark: false,
        base: [246, 246, 250],
        text: 'rgba(16,16,24,0.94)',
        textMuted: 'rgba(16,16,24,0.62)',
        textFaint: 'rgba(16,16,24,0.42)',
        stroke: 'rgba(16,16,24,0.10)',
        strokeStrong: 'rgba(16,16,24,0.18)',
        layer: 'rgba(255,255,255,0.55)',
        layerHover: 'rgba(255,255,255,0.78)',
        shadow: 'rgba(0,0,0,0.22)',
    };
}

/*
 * Accent text needs different treatment on light and dark surfaces: the
 * same neon that sings on near-black is illegible on near-white. Rather
 * than guess at a fixed adjustment, walk the colour toward the far end of
 * the scale until it actually clears the contrast threshold. Hues vary
 * enormously in luminance, so a single factor would leave the yellows and
 * greens unreadable while over-darkening the pinks.
 *
 * This matters more here than in Agenda: in "the colour Linear uses" mode
 * the input is whatever hex a workspace admin picked, not one of eight
 * hand-tuned neons.
 */
function accentText(accent, palette) {
    let background = palette.base;
    if (contrastRatio(accent.rgb, background) >= CONTRAST_TARGET)
        return rgba(accent.rgb, 1);

    for (let step = 1; step <= 20; step++) {
        let amount = step * 0.05;
        let candidate = palette.dark
            ? lighten(accent.rgb, amount)
            : darken(accent.rgb, amount);
        if (contrastRatio(candidate, background) >= CONTRAST_TARGET)
            return rgba(candidate, 1);
    }

    return palette.dark ? 'rgb(255,255,255)' : 'rgb(0,0,0)';
}

function join(rules) {
    return rules.filter(function (rule) { return !!rule; }).join(' ');
}

var Theme = class Theme {
    constructor(options) {
        this.update(options);
    }

    update(options) {
        this.scale = options.scale || 1;
        this.dark = options.dark !== false;
        // A missing value would otherwise become NaN, which St rejects,
        // taking the whole style string with it and leaving the desklet
        // completely unstyled.
        let opacity = Number(options.opacity);
        this.opacity = isNaN(opacity) ? 0.72 : Math.max(0, Math.min(1, opacity));
        this.glow = options.glow !== false;
        this.tint = options.tint !== false;
        this.density = options.density || 'comfortable';
        this.width = options.width || 380;
        this.palette = surfacePalette(this.dark);
    }

    // Every dimension in the desklet flows through here, which is what
    // makes a single width or scale change reflow the whole layout.
    px(value) {
        return Math.max(0, Math.round(value * this.scale));
    }

    pt(value) {
        return Math.max(6, Math.round(value * this.scale * 10) / 10);
    }

    get densityFactor() {
        switch (this.density) {
            case 'compact': return 0.72;
            case 'spacious': return 1.35;
            default: return 1;
        }
    }

    gap(value) {
        return this.px(value * this.densityFactor);
    }

    rootStyle() {
        let p = this.palette;
        return join([
            'width: ' + Math.round(this.width) + 'px;',
            'background-color: ' + rgba(p.base, this.opacity) + ';',
            'border: 1px solid ' + p.stroke + ';',
            'border-radius: ' + this.px(14) + 'px;',
            'padding: ' + this.gap(14) + 'px;',
            'box-shadow: 0 ' + this.px(10) + 'px ' + this.px(28) + 'px 0 ' + p.shadow + ';',
            'color: ' + p.text + ';',
        ]);
    }

    headerStyle() {
        return join([
            'font-size: ' + this.pt(9.5) + 'pt;',
            'font-weight: bold;',
            'color: ' + this.palette.textMuted + ';',
        ]);
    }

    headerDateStyle() {
        return join([
            'font-size: ' + this.pt(9.5) + 'pt;',
            'color: ' + this.palette.textFaint + ';',
        ]);
    }

    // ------------------------------------------------------------------
    // Tabs
    // ------------------------------------------------------------------

    /*
     * A hairline under the whole tab row, so the selected tab's own bar
     * reads as sitting on a rail rather than floating loose.
     */
    tabBarStyle() {
        return join([
            'border-bottom: 1px solid ' + this.palette.stroke + ';',
            'padding-bottom: ' + this.gap(6) + 'px;',
        ]);
    }

    tabStyle(accent, selected, hovered) {
        let p = this.palette;
        let color = selected ? accentText(accent, p) : (hovered ? p.text : p.textMuted);

        return join([
            'font-size: ' + this.pt(9.5) + 'pt;',
            'font-weight: bold;',
            'color: ' + color + ';',
            'padding: ' + this.px(3) + 'px ' + this.px(10) + 'px;',
            'border-radius: ' + this.px(8) + 'px;',
            'background-color: ' + (hovered && !selected ? p.layer : 'transparent') + ';',
        ]);
    }

    /*
     * The selected tab's underline. Same geometry as the accent bar on a
     * card, which is what ties the two together visually; an unselected
     * tab gets the same widget fully transparent so the row does not
     * shift by three pixels as the selection moves.
     */
    tabUnderlineStyle(accent, selected, width) {
        // Width is optional: the underline normally stretches to whatever
        // the tab above it measured. Passing NaN here would make St
        // discard the entire style string and leave the rail unpainted, so
        // the rule is omitted rather than computed from a missing value.
        let hasWidth = width !== null && width !== undefined && !isNaN(Number(width));

        return join([
            'background-color: ' + (selected ? rgba(accent.rgb, 0.95) : 'transparent') + ';',
            'height: ' + this.px(2) + 'px;',
            hasWidth ? 'width: ' + Math.max(0, Math.round(Number(width))) + 'px;' : '',
            'border-radius: ' + this.px(2) + 'px;',
            this.glow && selected
                ? 'box-shadow: 0 0 ' + this.px(8) + 'px 0 ' + rgba(accent.rgb, 0.55) + ';'
                : '',
        ]);
    }

    /*
     * The unread count. A filled pill rather than an outlined one: this is
     * the one number in the desklet that should pull the eye to a tab the
     * user is not currently looking at.
     */
    badgeStyle(accent) {
        let onAccent = relativeLuminance(accent.rgb) > 0.45
            ? 'rgba(12,12,18,0.92)'
            : 'rgba(255,255,255,0.96)';

        return join([
            'background-color: ' + rgba(accent.rgb, 0.92) + ';',
            'border-radius: ' + this.px(20) + 'px;',
            'padding: ' + this.px(0) + 'px ' + this.px(6) + 'px;',
            'font-size: ' + this.pt(8) + 'pt;',
            'font-weight: bold;',
            'color: ' + onAccent + ';',
            'margin-left: ' + this.px(5) + 'px;',
            this.glow ? 'box-shadow: 0 0 ' + this.px(8) + 'px 0 ' + rgba(accent.rgb, 0.5) + ';' : '',
        ]);
    }

    // ------------------------------------------------------------------
    // Cards and rows
    // ------------------------------------------------------------------

    /*
     * A row carrying emphasis, such as an overdue issue or an unread
     * mention.
     *
     * Intensity runs from 0 to 1 and scales the accent tint, the border
     * alpha and the glow radius together, so a row can be made to stand
     * out by degree rather than being either plain or shouting. Any number
     * of rows may be emphasised at once.
     */
    emphasisRowStyle(accent, intensity, hovered) {
        let p = this.palette;
        let strength = Math.max(0, Math.min(1, Number(intensity) || 0));

        let tintAmount = this.tint ? (0.08 + 0.08 * strength) : 0;
        let background = this.tint
            ? rgba(mix(p.base, accent.rgb, hovered ? tintAmount + 0.06 : tintAmount),
                Math.max(this.opacity * 0.55, 0.30))
            : (hovered ? p.layerHover : p.layer);

        let glowRadius = this.px(8 + 12 * strength);
        let glowAlpha = (0.14 + 0.22 * strength) * (hovered ? 1.35 : 1);

        return join([
            'background-color: ' + background + ';',
            'border: 1px solid ' + rgba(accent.rgb,
                (0.26 + 0.30 * strength) * (hovered ? 1.3 : 1)) + ';',
            'border-radius: ' + this.px(9) + 'px;',
            'padding: ' + this.gap(9) + 'px ' + this.gap(11) + 'px;',
            this.glow
                ? 'box-shadow: 0 0 ' + glowRadius + 'px 0 ' + rgba(accent.rgb, glowAlpha) + ';'
                : '',
        ]);
    }

    accentBarStyle(accent, height) {
        return join([
            'background-color: ' + rgba(accent.rgb, 0.95) + ';',
            'width: ' + this.px(3) + 'px;',
            'height: ' + height + 'px;',
            'border-radius: ' + this.px(2) + 'px;',
            this.glow ? 'box-shadow: 0 0 ' + this.px(8) + 'px 0 ' + rgba(accent.rgb, 0.55) + ';' : '',
        ]);
    }

    eyebrowStyle(accent) {
        return join([
            'font-size: ' + this.pt(8) + 'pt;',
            'font-weight: bold;',
            'color: ' + accentText(accent, this.palette) + ';',
        ]);
    }

    /*
     * The issue title: the largest text in the list, and the field that
     * says what the work is. Everything else on the row is set smaller so
     * it reads as supporting detail.
     */
    issueTitleStyle(compact) {
        return join([
            'font-size: ' + this.pt(compact ? 11 : 12) + 'pt;',
            'color: ' + this.palette.text + ';',
        ]);
    }

    /*
     * Roughly how many characters of the given point size fit into a pixel
     * width, used to budget how much text a wrapping label can hold.
     *
     * An approximation that bounds runaway text, not an exact line count:
     * a point is 96 / 72 pixels at CSS resolution and an average Latin
     * glyph is about half an em, so one character occupies close to
     * pointSize * (96 / 72) * 0.5 pixels. Narrow glyphs pack tighter and
     * wide ones looser, so text near the budget can still land one line
     * either side of the nominal count.
     */
    charsPerLine(widthPx, pointSize) {
        let approxCharWidth = Math.max(1, pointSize * (96 / 72) * 0.5);
        return Math.max(8, Math.floor(widthPx / approxCharWidth));
    }

    metaStyle() {
        return join([
            'font-size: ' + this.pt(9) + 'pt;',
            'color: ' + this.palette.textMuted + ';',
        ]);
    }

    /*
     * Supporting context - team names, project names, timestamps. Quiet
     * on purpose: it is context, not content.
     */
    tagStyle() {
        return join([
            'font-size: ' + this.pt(8) + 'pt;',
            'color: ' + this.palette.textFaint + ';',
        ]);
    }

    // A team heading over a run of rows. Uppercased by the caller.
    sectionStyle() {
        return join([
            'font-size: ' + this.pt(8) + 'pt;',
            'font-weight: bold;',
            'color: ' + this.palette.textFaint + ';',
            'padding: ' + this.gap(4) + 'px ' + this.px(2) + 'px;',
        ]);
    }

    rowStyle(accent, hovered) {
        let p = this.palette;
        let background = hovered ? p.layerHover : p.layer;
        if (this.tint && hovered)
            background = rgba(mix(p.base, accent.rgb, 0.16), 0.55);

        return join([
            'background-color: ' + background + ';',
            'border-radius: ' + this.px(9) + 'px;',
            'padding: ' + this.gap(8) + 'px ' + this.gap(10) + 'px;',
            'border: 1px solid ' + (hovered ? rgba(accent.rgb, 0.28) : 'transparent') + ';',
        ]);
    }

    /*
     * The issue identifier, carrying the row's accent colour. Sits on the
     * context line beneath the title.
     */
    identifierStyle(accent) {
        return join([
            'font-size: ' + this.pt(8.5) + 'pt;',
            'font-weight: bold;',
            'color: ' + accentText(accent, this.palette) + ';',
        ]);
    }

    /*
     * The supporting line beneath a title: workflow state, team, due date.
     * Muted, so it reads as context rather than content.
     */
    contextStyle() {
        return join([
            'font-size: ' + this.pt(8.5) + 'pt;',
            'color: ' + this.palette.textFaint + ';',
        ]);
    }

    /*
     * The name of whoever wrote a mention. Set smaller than the message
     * beneath it, which is the part worth reading first.
     */
    mentionActorStyle(unread) {
        return join([
            'font-size: ' + this.pt(9) + 'pt;',
            'font-weight: bold;',
            'color: ' + (unread ? this.palette.text : this.palette.textMuted) + ';',
        ]);
    }

    /*
     * The text of a mention, and the largest element on the row.
     *
     * Read mentions are dimmed rather than set smaller, so every row keeps
     * the same height and the list stays evenly spaced.
     */
    mentionMessageStyle(unread) {
        return join([
            'font-size: ' + this.pt(11) + 'pt;',
            'color: ' + (unread ? this.palette.text : this.palette.textMuted) + ';',
        ]);
    }

    rowTitleStyle(muted) {
        return join([
            'font-size: ' + this.pt(10) + 'pt;',
            'color: ' + (muted ? this.palette.textMuted : this.palette.text) + ';',
        ]);
    }

    chipStyle(accent) {
        return join([
            'background-color: ' + rgba(accent.rgb, 0.18) + ';',
            'border: 1px solid ' + rgba(accent.rgb, 0.35) + ';',
            'border-radius: ' + this.px(20) + 'px;',
            'padding: ' + this.px(2) + 'px ' + this.px(9) + 'px;',
            'font-size: ' + this.pt(8.5) + 'pt;',
            'color: ' + accentText(accent, this.palette) + ';',
        ]);
    }

    /*
     * The actor's initials beside a mention. Linear's avatar images live
     * behind the same API key the desklet authenticates with, so fetching
     * them would mean a second authenticated request per row; initials
     * carry the same "who" at no network cost.
     */
    avatarStyle(accent) {
        let size = this.px(22);
        return join([
            'background-color: ' + rgba(accent.rgb, 0.20) + ';',
            'border: 1px solid ' + rgba(accent.rgb, 0.40) + ';',
            'border-radius: ' + Math.round(size / 2) + 'px;',
            'width: ' + size + 'px;',
            'height: ' + size + 'px;',
            'font-size: ' + this.pt(8) + 'pt;',
            'font-weight: bold;',
            'color: ' + accentText(accent, this.palette) + ';',
        ]);
    }

    // A small filled dot: the cheapest possible unread marker, and the
    // only one that survives the narrow layout without stealing a line.
    unreadDotStyle(accent) {
        let size = this.px(7);
        return join([
            'background-color: ' + rgba(accent.rgb, 0.95) + ';',
            'width: ' + size + 'px;',
            'height: ' + size + 'px;',
            'border-radius: ' + Math.max(1, Math.round(size / 2)) + 'px;',
            'margin-left: ' + this.px(6) + 'px;',
            this.glow ? 'box-shadow: 0 0 ' + this.px(6) + 'px 0 ' + rgba(accent.rgb, 0.6) + ';' : '',
        ]);
    }

    emptyStyle() {
        return join([
            'font-size: ' + this.pt(11) + 'pt;',
            'color: ' + this.palette.textMuted + ';',
            'padding: ' + this.gap(18) + 'px 0;',
        ]);
    }

    // The first-run prompt, which has to be readable enough that nobody
    // mistakes an unconfigured desklet for a broken one.
    setupStyle() {
        return join([
            'font-size: ' + this.pt(9.5) + 'pt;',
            'color: ' + this.palette.textMuted + ';',
            'padding: ' + this.gap(10) + 'px 0;',
        ]);
    }

    errorStyle() {
        return join([
            'font-size: ' + this.pt(8.5) + 'pt;',
            'color: ' + rgba([255, 150, 110], 0.95) + ';',
        ]);
    }

    footerStyle() {
        return join([
            'font-size: ' + this.pt(8) + 'pt;',
            'color: ' + this.palette.textFaint + ';',
        ]);
    }
};
