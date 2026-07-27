/*
 * Exercises the desklet's pure logic: date handling, sorting, urgency, the
 * notification fallbacks, and the style generator's resistance to missing
 * values.
 *
 * Run with: node tools/test-logic.js
 */

'use strict';

const shim = require('./gjs-shim');

// Load order matters: each module reaches for the ones before it.
shim.load('i18n');
const Format = shim.load('format');
const ThemeLib = shim.load('theme');
const Model = shim.load('model');

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
    if (condition) {
        passed++;
        return;
    }
    failed++;
    console.log('FAIL  ' + name + (detail ? '\n      ' + detail : ''));
}

function equal(name, actual, expected) {
    check(name, actual === expected, 'expected ' + JSON.stringify(expected) +
        ', got ' + JSON.stringify(actual));
}

const DAY = 86400000;

// Anchored to local noon so adding or subtracting whole days never crosses
// a daylight-saving boundary into the previous or next calendar day.
function localNoon(offsetDays) {
    let date = new Date();
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() + (offsetDays || 0));
    return date;
}

function isoDate(date) {
    let month = String(date.getMonth() + 1).padStart(2, '0');
    let day = String(date.getDate()).padStart(2, '0');
    return date.getFullYear() + '-' + month + '-' + day;
}

// ----------------------------------------------------------------------
// Dates
// ----------------------------------------------------------------------

(function timelessDates() {
    let parsed = Format.parseTimelessDate('2026-07-30');
    check('parses a TimelessDate', parsed !== null);
    equal('keeps the year', parsed.getFullYear(), 2026);
    equal('keeps the month', parsed.getMonth(), 6);
    equal('keeps the day', parsed.getDate(), 30);
    equal('parses at local midnight, not UTC', parsed.getHours(), 0);

    equal('rejects a date that never existed', Format.parseTimelessDate('2026-02-31'), null);
    equal('rejects a timestamp', Format.parseTimelessDate('2026-07-30T12:00:00Z'), null);
    equal('rejects an empty value', Format.parseTimelessDate(''), null);
    equal('rejects null', Format.parseTimelessDate(null), null);
})();

(function dayDeltas() {
    let now = localNoon(0).getTime();

    equal('today is zero days away', Format.dayDelta(now, localNoon(0).getTime()), 0);
    equal('tomorrow is one day away', Format.dayDelta(now, localNoon(1).getTime()), 1);
    equal('yesterday is minus one', Format.dayDelta(now, localNoon(-1).getTime()), -1);

    /*
     * The reason dayDelta counts calendar days rather than elapsed time: at
     * 23:00, something due at 08:00 tomorrow is nine hours away, which
     * rounds to zero days and would read as "due today".
     */
    let lateEvening = new Date();
    lateEvening.setHours(23, 0, 0, 0);
    let tomorrowMorning = new Date(lateEvening.getTime());
    tomorrowMorning.setDate(tomorrowMorning.getDate() + 1);
    tomorrowMorning.setHours(8, 0, 0, 0);
    equal('late evening still sees tomorrow as tomorrow',
        Format.dayDelta(lateEvening.getTime(), tomorrowMorning.getTime()), 1);
})();

(function dueWording() {
    let now = Date.now();

    equal('due today', Format.dueText(localNoon(0), now), 'Due today');
    equal('due tomorrow', Format.dueText(localNoon(1), now), 'Due tomorrow');
    equal('due yesterday', Format.dueText(localNoon(-1), now), 'Due yesterday');
    equal('overdue by several days', Format.dueText(localNoon(-3), now), '3 days overdue');
    equal('due within the week', Format.dueText(localNoon(4), now), 'Due in 4 days');
    equal('no due date is an empty string', Format.dueText(null, now), '');

    equal('short form today', Format.dueTextShort(localNoon(0), now), 'Today');
    equal('short form overdue', Format.dueTextShort(localNoon(-5), now), 'Overdue');
})();

(function relativeTimes() {
    equal('a few seconds is just now', Format.since(5000), 'just now');
    equal('minutes', Format.since(5 * 60000), '5 minutes ago');
    equal('hours', Format.since(3 * 3600000), '3 hours ago');
    equal('days', Format.since(2 * DAY), '2 days ago');
    equal('a negative delta does not go backwards', Format.since(-5000), 'just now');

    equal('short seconds', Format.sinceShort(1000), 'now');
    equal('short minutes', Format.sinceShort(120000), '2m');
    equal('short hours', Format.sinceShort(7200000), '2h');
    equal('short days', Format.sinceShort(3 * DAY), '3d');
})();

(function initialsAndLabels() {
    equal('two names', Format.initials('Priya Raman'), 'PR');
    equal('one name', Format.initials('Cher'), 'C');
    equal('three names takes first and last', Format.initials('Ada Byron Lovelace'), 'AL');
    equal('extra whitespace is ignored', Format.initials('  Ada   Lovelace  '), 'AL');
    equal('no name at all', Format.initials(''), '?');
    equal('null name', Format.initials(null), '?');

    equal('priority 1', Format.priorityLabel(1), 'Urgent');
    equal('priority 0', Format.priorityLabel(0), 'No priority');
    equal('an unknown priority falls back', Format.priorityLabel(99), 'No priority');
})();

// ----------------------------------------------------------------------
// Issues
// ----------------------------------------------------------------------

function issueNode(overrides) {
    return Object.assign({
        id: 'id-' + Math.random(),
        identifier: 'ENG-1',
        title: 'An issue',
        priority: 3,
        priorityLabel: 'Medium',
        dueDate: null,
        url: 'https://linear.app/acme/issue/ENG-1/an-issue',
        updatedAt: new Date().toISOString(),
        state: { name: 'Todo', type: 'unstarted', color: '#e2e2e2' },
        team: { key: 'ENG', name: 'Engineering' },
        project: { name: 'Linux Client' },
    }, overrides || {});
}

(function normalisingIssues() {
    let issues = Model.normaliseIssues([
        issueNode({ identifier: 'ENG-9', dueDate: '2026-07-30' }),
        null,
        issueNode({ identifier: '', title: '', priority: null, state: null, team: null, project: null }),
    ]);

    equal('skips null nodes', issues.length, 2);
    equal('keeps the identifier', issues[0].identifier, 'ENG-9');
    // Not instanceof: the modules run in their own vm realm, so the Date
    // they construct is not the host's Date.
    check('parses the due date into a Date',
        issues[0].dueDate !== null &&
        typeof issues[0].dueDate.getFullYear === 'function');
    equal('substitutes a missing identifier', issues[1].identifier, 'Issue');
    equal('substitutes a missing title', issues[1].title, 'Untitled');
    equal('a null priority stays null', issues[1].priority, null);
    equal('a missing state is an empty string', issues[1].stateType, '');

    let rejected = Model.normaliseIssues([issueNode({ url: 'javascript:alert(1)' })]);
    equal('a non-web url is dropped', rejected[0].url, '');

    equal('a non-array payload yields nothing', Model.normaliseIssues(null).length, 0);
    equal('an undefined payload yields nothing', Model.normaliseIssues(undefined).length, 0);
})();

(function sorting() {
    let issues = Model.normaliseIssues([
        issueNode({ identifier: 'NONE', priority: 0 }),
        issueNode({ identifier: 'LOW', priority: 4 }),
        issueNode({ identifier: 'URGENT', priority: 1 }),
        issueNode({ identifier: 'MEDIUM', priority: 3 }),
    ]);

    let byPriority = Model.sortIssues(issues, 'priority').map(function (issue) {
        return issue.identifier;
    });

    /*
     * Linear numbers "no priority" zero but ranks it last. Sorting on the
     * raw number would put every unprioritised issue above the urgent ones,
     * which is the single most misleading thing this list could do.
     */
    equal('urgent sorts first', byPriority[0], 'URGENT');
    equal('no priority sorts last, not first', byPriority[3], 'NONE');
    equal('the middle keeps its order', byPriority.join(','), 'URGENT,MEDIUM,LOW,NONE');

    let dated = Model.normaliseIssues([
        issueNode({ identifier: 'NODATE', priority: 1, dueDate: null }),
        issueNode({ identifier: 'LATER', priority: 4, dueDate: isoDate(localNoon(10)) }),
        issueNode({ identifier: 'SOON', priority: 4, dueDate: isoDate(localNoon(1)) }),
    ]);

    let byDue = Model.sortIssues(dated, 'due').map(function (issue) {
        return issue.identifier;
    });
    equal('the nearest due date comes first', byDue[0], 'SOON');
    equal('no due date sorts after every date', byDue[2], 'NODATE');

    let byUpdated = Model.sortIssues(Model.normaliseIssues([
        issueNode({ identifier: 'OLD', updatedAt: new Date(Date.now() - DAY).toISOString() }),
        issueNode({ identifier: 'NEW', updatedAt: new Date().toISOString() }),
    ]), 'updated').map(function (issue) { return issue.identifier; });
    equal('most recently updated first', byUpdated[0], 'NEW');

    check('sorting does not mutate the input',
        issues[0].identifier === 'NONE');
})();

(function urgency() {
    let now = Date.now();
    let make = function (overrides) {
        return Model.normaliseIssues([issueNode(overrides)])[0];
    };

    equal('nothing due and nothing urgent is silent',
        Model.urgencyFor(make({ priority: 3 }), now, 3), 0);
    equal('overdue is maximal',
        Model.urgencyFor(make({ dueDate: isoDate(localNoon(-1)) }), now, 3), 1);
    equal('due today is nearly maximal',
        Model.urgencyFor(make({ dueDate: isoDate(localNoon(0)) }), now, 3), 0.85);

    let urgentNoDate = Model.urgencyFor(make({ priority: 1 }), now, 3);
    check('urgent priority is loud without a due date', urgentNoDate >= 0.5,
        'got ' + urgentNoDate);

    let soon = Model.urgencyFor(make({ dueDate: isoDate(localNoon(1)), priority: 3 }), now, 3);
    let later = Model.urgencyFor(make({ dueDate: isoDate(localNoon(3)), priority: 3 }), now, 3);
    check('urgency decays with distance', soon > later, soon + ' should exceed ' + later);
    check('urgency stays within range', later >= 0 && later <= 1, 'got ' + later);

    // A zero setting must not divide by zero and produce NaN, which would
    // reach the style string and blank the desklet.
    let zeroWindow = Model.urgencyFor(make({ dueDate: isoDate(localNoon(5)), priority: 3 }), now, 0);
    check('a zero imminent window yields a number', !isNaN(zeroWindow), 'got ' + zeroWindow);
    equal('a zero imminent window ignores distant dates', zeroWindow, 0);
})();

(function eyebrows() {
    let now = Date.now();
    let make = function (overrides) {
        return Model.normaliseIssues([issueNode(overrides)])[0];
    };

    equal('overdue wins', Model.eyebrowFor(make({
        dueDate: isoDate(localNoon(-2)), priority: 1 }), now), 'Overdue');
    equal('due today beats urgent', Model.eyebrowFor(make({
        dueDate: isoDate(localNoon(0)), priority: 1 }), now), 'Due today');
    equal('urgent shows when nothing is due', Model.eyebrowFor(make({ priority: 1 }), now), 'Urgent');
    equal('in progress', Model.eyebrowFor(make({
        priority: 3, state: { name: 'In Progress', type: 'started', color: '#f2c94c' } }), now),
        'In progress');
    equal('nothing worth saying is empty', Model.eyebrowFor(make({ priority: 3 }), now), '');
})();

(function grouping() {
    let issues = Model.normaliseIssues([
        issueNode({ identifier: 'ENG-1', team: { key: 'ENG', name: 'Engineering' } }),
        issueNode({ identifier: 'DES-1', team: { key: 'DES', name: 'Design' } }),
        issueNode({ identifier: 'ENG-2', team: { key: 'ENG', name: 'Engineering' } }),
        issueNode({ identifier: 'ORPHAN', team: null }),
    ]);

    let groups = Model.groupByTeam(issues);
    equal('one group per team', groups.length, 3);
    equal('the first team is the one with the first issue', groups[0].label, 'Engineering');
    equal('issues collect into their team', groups[0].issues.length, 2);
    equal('a missing team still gets a heading', groups[2].label, 'No team');
})();

// ----------------------------------------------------------------------
// Mentions
// ----------------------------------------------------------------------

(function mentionScopes() {
    let core = Model.mentionTypes('core');
    let wide = Model.mentionTypes('wide');

    check('core covers issue mentions', core.indexOf('issueMention') !== -1);
    check('core covers document mentions', core.indexOf('documentMention') !== -1);
    check('core leaves projects out', core.indexOf('projectMention') === -1);
    check('wide includes projects', wide.indexOf('projectMention') !== -1);
    check('wide is a superset of core', core.every(function (type) {
        return wide.indexOf(type) !== -1;
    }));

    /*
     * The whole point of the tab: assignments and status changes belong to
     * the issues list, not to a list of times someone said your name.
     */
    check('no assignment notifications', wide.indexOf('issueAssignedToYou') === -1);
    check('no status changes', wide.indexOf('issueStatusChanged') === -1);
    check('no plain replies', wide.indexOf('issueNewComment') === -1);
    check('no reactions', wide.indexOf('issueEmojiReaction') === -1);
    equal('an unknown scope falls back to core', Model.mentionTypes('nonsense').length, core.length);
})();

(function normalisingMentions() {
    let base = {
        __typename: 'IssueNotification',
        id: 'n1',
        type: 'issueCommentMention',
        createdAt: new Date().toISOString(),
        readAt: null,
        actor: { name: 'Priya Raman' },
        issue: {
            identifier: 'ENG-412',
            title: 'Desklet crashes on wake',
            url: 'https://linear.app/acme/issue/ENG-412/desklet-crashes-on-wake',
            state: { name: 'In Progress', type: 'started', color: '#f2c94c' },
        },
    };

    // The happy path, where Linear's own internal fields are present.
    let withInternals = Model.normaliseMentions([Object.assign({}, base, {
        title: 'Priya Raman mentioned you',
        subtitle: 'ENG-412 Desklet crashes on wake',
        url: 'https://linear.app/acme/issue/ENG-412#comment-abc',
    })]);
    equal('uses the title Linear supplies', withInternals[0].title, 'Priya Raman mentioned you');
    equal('uses the url Linear supplies', withInternals[0].url,
        'https://linear.app/acme/issue/ENG-412#comment-abc');
    check('unread when readAt is null', withInternals[0].unread);

    /*
     * The important case: url, title and subtitle are marked internal in
     * Linear's schema and could vanish without notice. Everything has to
     * be reconstructible from the documented fields alone.
     */
    let composed = Model.normaliseMentions([Object.assign({}, base, {
        commentId: 'c99',
    })]);
    equal('composes a title from the actor', composed[0].title,
        'Priya Raman mentioned you in a comment');
    equal('composes a subtitle from the issue', composed[0].subtitle,
        'ENG-412 Desklet crashes on wake');
    equal('anchors the url on the comment', composed[0].url,
        'https://linear.app/acme/issue/ENG-412/desklet-crashes-on-wake#comment-c99');
    equal('carries the state colour through', composed[0].stateColor, '#f2c94c');

    let plainMention = Model.normaliseMentions([Object.assign({}, base, {
        type: 'issueMention',
    })]);
    equal('a plain mention is phrased differently', plainMention[0].title,
        'Priya Raman mentioned you');

    let anonymous = Model.normaliseMentions([Object.assign({}, base, { actor: null })]);
    equal('an actorless mention still reads as a sentence', anonymous[0].title,
        'You were mentioned in a comment');

    let botAuthored = Model.normaliseMentions([Object.assign({}, base, {
        actor: null,
        botActor: { name: 'Sentry' },
    })]);
    equal('a bot actor is named', botAuthored[0].title, 'Sentry mentioned you in a comment');

    let document = Model.normaliseMentions([{
        __typename: 'DocumentNotification',
        id: 'n2',
        type: 'documentMention',
        createdAt: new Date().toISOString(),
        readAt: new Date().toISOString(),
        actor: { displayName: 'ada' },
        document: { title: 'Launch plan', url: 'https://linear.app/acme/document/launch-plan' },
    }]);
    equal('a document mention names the document', document[0].subtitle, 'Launch plan');
    equal('falls back to a display name', document[0].title, 'ada mentioned you');
    check('read when readAt is set', !document[0].unread);

    // A row that looks clickable and does nothing is worse than no row.
    let unreachable = Model.normaliseMentions([{
        __typename: 'IssueNotification',
        id: 'n3',
        type: 'issueMention',
        actor: { name: 'Nobody' },
    }]);
    equal('a mention with nowhere to go is dropped', unreachable.length, 0);

    let hostile = Model.normaliseMentions([Object.assign({}, base, {
        url: 'javascript:alert(1)',
        issue: null,
    })]);
    equal('a non-web url is not trusted', hostile.length, 0);

    equal('a non-array payload yields nothing', Model.normaliseMentions(null).length, 0);
})();

(function preparingMentions() {
    let now = Date.now();
    let node = function (id, ageMs, read) {
        return {
            __typename: 'IssueNotification',
            id: id,
            type: 'issueMention',
            createdAt: new Date(now - ageMs).toISOString(),
            readAt: read ? new Date().toISOString() : null,
            actor: { name: 'A B' },
            issue: { identifier: 'ENG-1', title: 'T', url: 'https://linear.app/a/issue/ENG-1/t' },
        };
    };

    let mentions = Model.normaliseMentions([
        node('old', 3 * DAY, false),
        node('new', 60000, true),
        node('mid', DAY, false),
    ]);

    let all = Model.prepareMentions(mentions, false, 10);
    equal('newest first', all[0].id, 'new');
    equal('oldest last', all[2].id, 'old');

    let unread = Model.prepareMentions(mentions, true, 10);
    equal('unread only drops the read one', unread.length, 2);
    check('and keeps only unread', unread.every(function (m) { return m.unread; }));

    equal('the limit is honoured', Model.prepareMentions(mentions, false, 2).length, 2);
    equal('a zero limit still shows something',
        Model.prepareMentions(mentions, false, 0).length >= 1, true);

    equal('unread count', Model.unreadCount(mentions), 2);
    equal('unread count of nothing', Model.unreadCount([]), 0);
})();

// ----------------------------------------------------------------------
// Theme
// ----------------------------------------------------------------------

(function colours() {
    check('six digit hex', ThemeLib.parseHexColor('#5e6ad2') !== null);
    equal('six digit hex red channel', ThemeLib.parseHexColor('#5e6ad2')[0], 0x5e);
    equal('hex without a hash', ThemeLib.parseHexColor('5e6ad2')[2], 0xd2);
    equal('three digit hex expands', ThemeLib.parseHexColor('#abc')[0], 0xaa);
    equal('rejects nonsense', ThemeLib.parseHexColor('not-a-colour'), null);
    equal('rejects an empty value', ThemeLib.parseHexColor(''), null);
    equal('rejects null', ThemeLib.parseHexColor(null), null);
    equal('rejects a four digit value', ThemeLib.parseHexColor('#abcd'), null);
})();

(function accents() {
    let urgent = ThemeLib.accentFor('priority', { priority: 1 }, 0);
    let none = ThemeLib.accentFor('priority', { priority: 0 }, 0);
    check('urgent and unprioritised differ', urgent.name !== none.name);

    equal('started state is mint',
        ThemeLib.accentFor('state', { stateType: 'started' }, 0).name, 'mint');
    equal('cancelled work is not given a neon',
        ThemeLib.accentFor('state', { stateType: 'canceled' }, 0).name, 'slate');

    let borrowed = ThemeLib.accentFor('linear', { stateColor: '#5e6ad2' }, 0);
    equal('the Linear colour is used verbatim', borrowed.rgb[0], 0x5e);

    /*
     * Every mode has to survive a subject that lacks the field it wants:
     * mentions have no priority and no state of their own, and a single
     * grey list would be the visible result of getting this wrong.
     */
    check('priority mode falls back when there is no priority',
        ThemeLib.accentFor('priority', {}, 2).name === ThemeLib.RAINBOW[2].name);
    check('state mode falls back when there is no state',
        ThemeLib.accentFor('state', {}, 3).name === ThemeLib.RAINBOW[3].name);
    check('linear mode falls back through state to position',
        ThemeLib.accentFor('linear', {}, 4).name === ThemeLib.RAINBOW[4].name);
    check('an unknown mode falls back to position',
        ThemeLib.accentFor('nonsense', {}, 5).name === ThemeLib.RAINBOW[5].name);

    check('positions wrap rather than overrun',
        ThemeLib.accentFor('position', {}, 99) !== undefined);
    check('a negative position wraps too',
        ThemeLib.accentFor('position', {}, -3) !== undefined);

    let readMention = Model.accentForMention('priority', { unread: false }, 0);
    equal('a read mention is muted', readMention.name, 'slate');
    check('an unread mention is not',
        Model.accentForMention('priority', { unread: true }, 0).name !== 'slate');
})();

(function styleStrings() {
    /*
     * St discards an entire style string that contains NaN, leaving the
     * element completely unstyled. Every generator therefore has to survive
     * a missing or nonsensical setting, because settings arrive from disk.
     */
    let broken = new ThemeLib.Theme({});
    let accent = ThemeLib.RAINBOW[0];

    let generated = [
        broken.rootStyle(),
        broken.headerStyle(),
        broken.headerDateStyle(),
        broken.tabBarStyle(),
        broken.tabStyle(accent, true, false),
        broken.tabUnderlineStyle(accent, true, null),
        broken.badgeStyle(accent),
        broken.focusCardStyle(accent, 0),
        broken.accentBarStyle(accent, 40),
        broken.eyebrowStyle(accent),
        broken.focusTitleStyle(false),
        broken.metaStyle(),
        broken.tagStyle(),
        broken.sectionStyle(),
        broken.rowStyle(accent, false),
        broken.unreadRowStyle(accent, true),
        broken.identifierStyle(accent, 60),
        broken.identifierStyle(accent, null),
        broken.rowTitleStyle(true),
        broken.chipStyle(accent),
        broken.avatarStyle(accent),
        broken.unreadDotStyle(accent),
        broken.emptyStyle(),
        broken.setupStyle(),
        broken.errorStyle(),
        broken.footerStyle(),
    ];

    generated.forEach(function (style, index) {
        check('style ' + index + ' contains no NaN', style.indexOf('NaN') === -1, style);
        check('style ' + index + ' contains no undefined',
            style.indexOf('undefined') === -1, style);
    });

    equal('a missing opacity falls back rather than becoming NaN', broken.opacity, 0.72);

    let nonsense = new ThemeLib.Theme({ opacity: 'not a number', scale: 0, width: 0 });
    check('a non-numeric opacity is survivable',
        nonsense.rootStyle().indexOf('NaN') === -1, nonsense.rootStyle());

    // An omitted width has to drop the rule, not emit "width: NaNpx".
    let noWidth = broken.tabUnderlineStyle(accent, false, undefined);
    check('an omitted underline width drops the rule',
        noWidth.indexOf('width') === -1, noWidth);
    check('a supplied underline width is kept',
        broken.tabUnderlineStyle(accent, true, 40).indexOf('width: 40px') !== -1);

    let clamped = new ThemeLib.Theme({ opacity: 5 });
    equal('opacity above one is clamped', clamped.opacity, 1);
    equal('opacity below zero is clamped', new ThemeLib.Theme({ opacity: -3 }).opacity, 0);

    // Density has to keep spacing positive, or rows collapse into each other.
    ['compact', 'comfortable', 'spacious', 'auto', undefined].forEach(function (density) {
        let theme = new ThemeLib.Theme({ density: density });
        check('density ' + density + ' yields a positive gap', theme.gap(10) > 0);
    });

    equal('point sizes never go below the readable floor',
        new ThemeLib.Theme({ scale: 0.1 }).pt(8), 6);
})();

(function contrast() {
    /*
     * "The colour Linear uses" mode feeds in whatever hex a workspace admin
     * picked, including colours that are illegible on the desklet surface.
     * The walker has to return something readable in every case.
     */
    let dark = ThemeLib.surfacePalette(true);
    let light = ThemeLib.surfacePalette(false);

    ['#000000', '#ffffff', '#5e6ad2', '#f2c94c', '#0a0a0a'].forEach(function (hex) {
        let accent = { name: hex, rgb: ThemeLib.parseHexColor(hex) };

        [dark, light].forEach(function (palette) {
            let colour = ThemeLib.accentText(accent, palette);
            check('accent text for ' + hex + ' is a colour',
                /^rgba?\(/.test(colour), colour);

            let match = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(colour);
            if (match) {
                let rgb = [Number(match[1]), Number(match[2]), Number(match[3])];
                let ratio = ThemeLib.contrastRatio(rgb, palette.base);
                check('accent text for ' + hex + ' on a ' +
                    (palette.dark ? 'dark' : 'light') + ' surface is readable',
                    ratio >= 4.0, 'contrast ratio ' + ratio.toFixed(2));
            }
        });
    });
})();


// ----------------------------------------------------------------------
// OAuth
// ----------------------------------------------------------------------

const OAuth = shim.load('oauth');

(function pkce() {
    /*
     * The RFC 7636 appendix B vector. This is the one value in the whole
     * flow that has to match byte for byte what Linear computes: get the
     * challenge wrong and every sign-in fails with an opaque error.
     *
     * The specific trap is that GLib only returns a hex digest, so encoding
     * it directly would give a 64-character challenge instead of the raw
     * 32-byte digest encoded to 43 characters.
     */
    equal('S256 challenge matches the RFC 7636 test vector',
        OAuth.challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
        'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');

    let challenge = OAuth.challengeFor('some-other-verifier');
    equal('a challenge is 43 characters, not 64', challenge.length, 43);
    check('a challenge is base64url, never base64',
        !/[+/=]/.test(challenge), challenge);
    check('a different verifier gives a different challenge',
        OAuth.challengeFor('a') !== OAuth.challengeFor('b'));
})();

(function randomness() {
    let a = OAuth.randomToken(32);
    let b = OAuth.randomToken(32);

    check('a token is base64url', !/[+/=]/.test(a), a);
    check('32 bytes gives 43 characters', a.length === 43, 'got ' + a.length);
    check('two tokens differ', a !== b);

    // Anything shorter would make the state guessable, which is the one
    // thing it exists to prevent.
    check('tokens are long enough to be unguessable', a.length >= 32);
})();

(function requestLines() {
    let parsed = OAuth.parseRequestLine('GET /callback?code=abc&state=xyz HTTP/1.1');
    check('parses a callback request', parsed !== null);
    equal('extracts the path', parsed.path, '/callback');
    equal('extracts the code', parsed.params.code, 'abc');
    equal('extracts the state', parsed.params.state, 'xyz');

    let denied = OAuth.parseRequestLine(
        'GET /callback?error=access_denied&error_description=User+refused HTTP/1.1');
    equal('extracts an error', denied.params.error, 'access_denied');
    equal('decodes a plus as a space', denied.params.error_description, 'User refused');

    let encoded = OAuth.parseRequestLine('GET /callback?code=a%2Fb%2Bc%3D HTTP/1.1');
    equal('decodes percent escapes', encoded.params.code, 'a/b+c=');

    // The browser asks for this on the same port; treating it as the
    // callback would end the flow before the real reply arrived.
    let favicon = OAuth.parseRequestLine('GET /favicon.ico HTTP/1.1');
    check('a favicon request parses but is not the callback path',
        favicon !== null && favicon.path !== '/callback');

    equal('a bare path has no parameters',
        Object.keys(OAuth.parseRequestLine('GET /callback HTTP/1.1').params).length, 0);

    equal('rejects a POST', OAuth.parseRequestLine('POST /callback HTTP/1.1'), null);
    equal('rejects junk', OAuth.parseRequestLine('not an http request'), null);
    equal('rejects an empty line', OAuth.parseRequestLine(''), null);
    equal('rejects null', OAuth.parseRequestLine(null), null);

    // A malformed escape must not throw: it arrives from the network.
    let malformed = OAuth.parseRequestLine('GET /callback?code=%ZZ&state=ok HTTP/1.1');
    check('survives a malformed escape', malformed !== null);
    equal('and keeps the parameters it could read', malformed.params.state, 'ok');
})();

(function authorizeUrls() {
    let url = OAuth.authorizeUrl({
        clientId: 'client-1',
        redirectUri: 'http://127.0.0.1:61823/callback',
        scope: 'read',
        state: 'state-1',
        challenge: 'challenge-1',
    });

    check('points at Linear', url.indexOf('https://linear.app/oauth/authorize?') === 0);
    check('carries the client id', url.indexOf('client_id=client-1') !== -1);
    check('carries the code type', url.indexOf('response_type=code') !== -1);
    check('declares S256', url.indexOf('code_challenge_method=S256') !== -1);
    check('carries the challenge', url.indexOf('code_challenge=challenge-1') !== -1);
    check('carries the state', url.indexOf('state=state-1') !== -1);
    check('encodes the redirect uri',
        url.indexOf('redirect_uri=http%3A%2F%2F127.0.0.1%3A61823%2Fcallback') !== -1);
    // Without this a second sign-in silently reuses the first workspace.
    check('forces the consent screen', url.indexOf('prompt=consent') !== -1);
    // PKCE means no secret; one appearing here would be a serious leak.
    check('never carries a client secret', url.indexOf('client_secret') === -1);
})();

(function ports() {
    check('every callback port is above the ephemeral range',
        OAuth.CALLBACK_PORTS.every(function (port) { return port > 60999; }),
        OAuth.CALLBACK_PORTS.join(','));
    check('every callback port is a valid port',
        OAuth.CALLBACK_PORTS.every(function (port) { return port < 65536; }));
    check('ports are unique',
        new Set(OAuth.CALLBACK_PORTS).size === OAuth.CALLBACK_PORTS.length);
    // Linear matches redirect URIs exactly, so more ports than are
    // registered on the application would fail at authorization time.
    check('there are several ports to fall back through',
        OAuth.CALLBACK_PORTS.length >= 3);

    equal('a redirect uri is loopback and exact',
        OAuth.redirectUriFor(61823), 'http://127.0.0.1:61823/callback');
    check('a redirect uri never uses a hostname',
        OAuth.redirectUriFor(61823).indexOf('localhost') === -1);
})();

(function tokenExpiry() {
    equal('nothing stored does not need refreshing',
        OAuth.needsRefresh(null), false);
    equal('a token with no expiry is treated as stale',
        OAuth.needsRefresh({ accessToken: 'x' }), true);
    equal('a live token does not need refreshing',
        OAuth.needsRefresh({ accessToken: 'x', expiresAtMs: Date.now() + 3600000 }), false);
    equal('an expired token does',
        OAuth.needsRefresh({ accessToken: 'x', expiresAtMs: Date.now() - 1000 }), true);

    check('scope is recognised', OAuth.hasScope({ scope: 'read,write' }, 'write'));
    check('a missing scope is reported', !OAuth.hasScope({ scope: 'read' }, 'write'));
    check('scope survives space separation', OAuth.hasScope({ scope: 'read write' }, 'write'));
    check('no scope at all is not a grant', !OAuth.hasScope({}, 'read'));
    check('null tokens grant nothing', !OAuth.hasScope(null, 'read'));
    // "read" must not be mistaken for a prefix of "readonly" or similar.
    check('scope matching is exact, not substring',
        !OAuth.hasScope({ scope: 'readonly' }, 'read'));
})();

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
