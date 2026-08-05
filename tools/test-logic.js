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

// ----------------------------------------------------------------------
// Viewer
// ----------------------------------------------------------------------

(function viewer() {
    let full = Model.normaliseViewer({
        id: 'u1', name: 'Evelyn Ashe', displayName: 'evelyn',
        organization: { id: 'o1', name: 'Acme Inc', urlKey: 'acme' },
    });
    equal('keeps the account name', full.name, 'Evelyn Ashe');
    equal('keeps the workspace name', full.organizationName, 'Acme Inc');
    equal('keeps the workspace slug', full.organizationKey, 'acme');

    // A workspace with no display name is identified by its slug, which is
    // the only other name the API offers.
    let slugOnly = Model.normaliseViewer({
        name: 'Evelyn Ashe', organization: { urlKey: 'acme' },
    });
    equal('falls back to the workspace slug', slugOnly.organizationName, 'acme');

    let noOrg = Model.normaliseViewer({ name: 'Evelyn Ashe' });
    equal('survives a missing organisation', noOrg.organizationName, '');
    equal('and keeps the account name', noOrg.name, 'Evelyn Ashe');

    let displayOnly = Model.normaliseViewer({ displayName: 'evelyn' });
    equal('falls back to the display name', displayOnly.name, 'evelyn');

    equal('a missing viewer is null', Model.normaliseViewer(null), null);
    equal('an undefined viewer is null', Model.normaliseViewer(undefined), null);
})();

(function accountDescriptions() {
    /*
     * The line shown above the sign out button. Every field is optional in
     * the reply, so each combination has to read as a whole sentence.
     */
    equal('names the account and the workspace',
        Model.describeAccount({ name: 'Evelyn Ashe', organizationName: 'Acme Inc' }),
        'Signed in as Evelyn Ashe to Acme Inc.');
    equal('names the workspace alone',
        Model.describeAccount({ name: '', organizationName: 'Acme Inc' }),
        'Signed in to Acme Inc.');
    equal('names the account alone',
        Model.describeAccount({ name: 'Evelyn Ashe', organizationName: '' }),
        'Signed in as Evelyn Ashe.');
    equal('says something when it knows nothing',
        Model.describeAccount({ name: '', organizationName: '' }),
        'Signed in to Linear.');
    equal('describes nothing when not signed in',
        Model.describeAccount(null), '');
})();

(function categories() {
    /*
     * The rule this whole redesign turns on: a notification whose category
     * we cannot determine is shown, never hidden. The previous design hid
     * anything it did not recognise, which is how a misspelled type name
     * concealed every pull request notification without leaving a trace.
     */
    equal('Linear\'s own category wins',
        Model.categoryOf({ category: 'reviews', type: 'issueMention' }), 'reviews');
    equal('falls back to the type when the category was not asked for',
        Model.categoryOf({ type: 'pullRequestCommented' }), 'reviews');
    equal('a mention type maps to mentions',
        Model.categoryOf({ type: 'issueCommentMention' }), 'mentions');
    equal('an unrecognised type has no category',
        Model.categoryOf({ type: 'somethingLinearInventedTuesday' }), '');
    equal('nothing at all has no category', Model.categoryOf(null), '');

    check('a named category is on by default', Model.allowsCategory({}, 'mentions'));
    check('an unknown category rides the catch-all',
        Model.allowsCategory({}, 'somethingNew'));
    check('an absent category rides the catch-all too',
        Model.allowsCategory({}, ''));
    check('switching a named category off hides it',
        !Model.allowsCategory({ reactions: false }, 'reactions'));
    check('switching one off leaves the others alone',
        Model.allowsCategory({ reactions: false }, 'mentions'));
    check('the catch-all covers unnamed categories',
        !Model.allowsCategory({ other: false }, 'billing'));
    check('the catch-all does not cover named ones',
        Model.allowsCategory({ other: false }, 'reviews'));
    check('no preferences at all shows everything',
        Model.allowsCategory(null, 'reactions'));

    /*
     * The lookup tables are keyed by strings that arrive from a remote API,
     * so an inherited Object.prototype member must not answer for a
     * category. groupByTeam already uses a null prototype for this reason.
     */
    equal('an inherited property is not a category',
        Model.categoryOf({ type: 'constructor' }), '');
    check('nor a setting key', Model.allowsCategory({ other: false }, 'constructor') === false);
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

    /*
     * Anything arriving through an integration has a null actor and names
     * its author here instead. Pull request notifications are the common
     * case and the largest category in a working inbox, so a row that lost
     * the name here would be a row that showed its subject twice.
     */
    let external = Model.normaliseMentions([Object.assign({}, base, {
        actor: null,
        externalUserActor: { name: 'Ada Lovelace', displayName: 'ada' },
    })]);
    equal('an external actor is named', external[0].actor, 'Ada Lovelace');
    equal('and reads as a sentence', external[0].title,
        'Ada Lovelace mentioned you in a comment');

    /*
     * A document reached through an initiative. DocumentNotification itself
     * carries only a documentId and no document object, so this shape comes
     * from InitiativeNotification and ProjectNotification, which both do.
     */
    let document = Model.normaliseMentions([{
        __typename: 'InitiativeNotification',
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

    /*
     * A real DocumentNotification, which has no document object to build a
     * link from. Linear's internal url is the only thing that can save it,
     * so under QUERY_SAFE it is dropped rather than shown as a dead link.
     */
    let documentOnly = {
        __typename: 'DocumentNotification',
        id: 'n2b',
        type: 'documentMention',
        createdAt: new Date().toISOString(),
        actor: { name: 'Ada Lovelace' },
        documentId: 'doc-1',
        commentId: 'c1',
    };
    equal('a document notification with no internal url is dropped',
        Model.normaliseMentions([documentOnly]).length, 0);
    equal('and survives when the internal url is there',
        Model.normaliseMentions([Object.assign({}, documentOnly, {
            url: 'https://linear.app/acme/document/launch-plan#comment-c1',
        })]).length, 1);

    // Pull requests were invisible entirely until the fragment existed.
    let pullRequest = Model.normaliseMentions([{
        __typename: 'PullRequestNotification',
        id: 'n4',
        type: 'pullRequestReviewRequested',
        category: 'reviews',
        createdAt: new Date().toISOString(),
        actor: { name: 'Grace Hopper' },
        pullRequest: {
            title: 'Add release announcement skill',
            url: 'https://github.com/acme/infra/pull/7',
            number: 7,
        },
    }]);
    equal('a pull request is named by number', pullRequest[0].subject,
        '#7 Add release announcement skill');
    equal('and links to the forge', pullRequest[0].url,
        'https://github.com/acme/infra/pull/7');
    equal('and is filed under reviews', pullRequest[0].category, 'reviews');
    equal('a review request is phrased as one', pullRequest[0].title,
        'Grace Hopper requested your review');

    /*
     * action never defers to Linear's own title, because the row needs it
     * even when Linear supplied one: a review request, an approval and an
     * assignment otherwise render as the same actor and subject with
     * nothing to tell them apart.
     */
    let titled = Model.normaliseMentions([{
        __typename: 'PullRequestNotification',
        id: 'n6',
        type: 'pullRequestApproved',
        createdAt: new Date().toISOString(),
        actor: { name: 'Grace Hopper' },
        title: 'Add release announcement skill',
        subtitle: 'Grace Hopper approved',
        pullRequest: { title: 'T', url: 'https://github.com/acme/infra/pull/7', number: 7 },
    }]);
    equal('the title still defers to Linear', titled[0].title,
        'Add release announcement skill');
    equal('but the action is always ours', titled[0].action,
        'Grace Hopper approved the pull request');

    let assigned = Model.normaliseMentions([Object.assign({}, base, {
        type: 'issueAssignedToYou',
        title: 'Desklet crashes on wake',
    })]);
    equal('an assignment is distinguishable from a mention', assigned[0].action,
        'Priya Raman assigned this to you');
    equal('and an actorless one still reads',
        Model.normaliseMentions([Object.assign({}, base, {
            type: 'issueStatusChanged', actor: null,
        })])[0].action, 'The status changed');

    /*
     * The wording for an unrecognised type. This arm used to fall through
     * to "mentioned you", which told the user something that had not
     * happened for every kind in the "everything else" bucket - the exact
     * bucket the widened tab exists to surface.
     */
    let unknownType = Model.normaliseMentions([Object.assign({}, base, {
        type: 'somethingLinearInventedTuesday',
        subtitle: 'Priya Raman archived the project',
    })]);
    equal('an unknown type does not claim to be a mention', unknownType[0].action,
        'Priya Raman archived the project');

    let unknownAndUnhelped = Model.normaliseMentions([Object.assign({}, base, {
        type: 'somethingLinearInventedTuesday',
    })]);
    equal('and with no help from Linear stays vague rather than wrong',
        unknownAndUnhelped[0].action, 'Priya Raman updated this');
    equal('vaguer still without an actor',
        Model.normaliseMentions([Object.assign({}, base, {
            type: 'somethingLinearInventedTuesday', actor: null,
        })])[0].action, 'Something changed');

    // A project update is the real-world case: a category with no named
    // setting, so it rides the catch-all and must not read as a mention.
    let projectUpdate = Model.normaliseMentions([{
        __typename: 'ProjectNotification',
        id: 'n7',
        type: 'projectUpdateCreated',
        category: 'postsAndUpdates',
        createdAt: new Date().toISOString(),
        actor: { name: 'Mara Lindqvist' },
        project: { id: 'p1', name: 'Desklet 1.2', url: 'https://linear.app/a/project/d12' },
    }]);
    equal('a project update is not described as a mention', projectUpdate[0].action,
        'Mara Lindqvist updated this');
    equal('and still rides the catch-all', projectUpdate[0].category, 'postsAndUpdates');

    // number is a Float in the schema, so it must not render as "#7.0".
    let floatNumber = Model.normaliseMentions([{
        __typename: 'PullRequestNotification',
        id: 'n5',
        type: 'pullRequestCommented',
        createdAt: new Date().toISOString(),
        actor: { name: 'Grace Hopper' },
        pullRequestCommentId: '55',
        pullRequest: { title: 'T', url: 'https://github.com/acme/infra/pull/7', number: 7.0 },
    }]);
    equal('a float number renders as an integer', floatNumber[0].subject, '#7 T');
    equal('a forge comment gets a forge anchor', floatNumber[0].url,
        'https://github.com/acme/infra/pull/7#issuecomment-55');

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

    let all = Model.prepareMentions(mentions, { limit: 10 });
    equal('newest first', all[0].id, 'new');
    equal('oldest last', all[2].id, 'old');
    equal('everything is kept by default', all.length, 3);

    let unread = Model.prepareMentions(mentions, { unreadOnly: true, limit: 10 });
    equal('unread only drops the read one', unread.length, 2);
    check('and keeps only unread', unread.every(function (m) { return m.unread; }));

    // These are issueMention, so they answer to the mentions checkbox.
    equal('switching the category off empties the list',
        Model.prepareMentions(mentions, { categories: { mentions: false }, limit: 10 }).length, 0);
    equal('switching an unrelated category off changes nothing',
        Model.prepareMentions(mentions, { categories: { reviews: false }, limit: 10 }).length, 3);

    equal('the limit is honoured', Model.prepareMentions(mentions, { limit: 2 }).length, 2);
    equal('a zero limit still shows something',
        Model.prepareMentions(mentions, { limit: 0 }).length >= 1, true);

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
        broken.emphasisRowStyle(accent, 0, false),
        broken.emphasisRowStyle(accent, 1, true),
        broken.accentBarStyle(accent, 40),
        broken.eyebrowStyle(accent),
        broken.issueTitleStyle(false),
        broken.issueTitleStyle(true),
        broken.metaStyle(),
        broken.tagStyle(),
        broken.contextStyle(),
        broken.sectionStyle(),
        broken.rowStyle(accent, false),
        broken.mentionActorStyle(true),
        broken.mentionMessageStyle(false),
        broken.identifierStyle(accent),
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

// ----------------------------------------------------------------------
// API client
// ----------------------------------------------------------------------

const LinearClient = shim.load('linear');

(function errorClassification() {
    /*
     * classifyErrors turns a GraphQL error body into a code the desklet
     * acts on.
     *
     * The VALIDATION code is what triggers the fallback to the reduced
     * query, so a schema mismatch that stops being classified as one would
     * disable the fallback silently.
     */
    let validation = LinearClient.classifyErrors([{
        message: 'Cannot query field "document" on type "DocumentNotification". ' +
            'Did you mean "documentId"?',
        extensions: { code: 'GRAPHQL_VALIDATION_FAILED' },
    }]);
    equal('a schema mismatch is a validation failure', validation.code, 'VALIDATION');
    check('and keeps the message Linear sent',
        validation.message.indexOf('DocumentNotification') !== -1);

    equal('a rejected credential is an auth failure',
        LinearClient.classifyErrors([{
            message: 'Authentication required, not authenticated',
            extensions: { code: 'AUTHENTICATION_ERROR' },
        }]).code, 'AUTH');

    equal('a rate limit is recognised',
        LinearClient.classifyErrors([{
            message: 'Rate limit exceeded',
            extensions: { code: 'RATELIMITED' },
        }]).code, 'RATELIMITED');

    // Not every deployment sets an extensions code, so the wording is a
    // fallback path and has to keep working.
    equal('a validation failure is recognised from its wording alone',
        LinearClient.classifyErrors([{ message: 'Cannot query field "x" on type "Y".' }]).code,
        'VALIDATION');
    equal('an auth failure is recognised from its wording alone',
        LinearClient.classifyErrors([{ message: 'Authentication required' }]).code,
        'AUTH');

    equal('an unrecognised error stays generic',
        LinearClient.classifyErrors([{ message: 'Something went wrong' }]).code,
        'GRAPHQL');
    equal('an empty list is survivable',
        LinearClient.classifyErrors([]).code, 'GRAPHQL');
})();

(function statusMerge() {
    /*
     * The HTTP status backstops the body heuristics: a 429 whose errors
     * array never says "rate limit" must still engage the backoff, and a
     * 401 whose wording matches no auth keyword must still trigger the
     * OAuth refresh-and-retry.
     */
    equal('a 429 with an unhelpful body is still a rate limit',
        LinearClient.mergeStatusIntoCode('GRAPHQL', 429), 'RATELIMITED');
    equal('a 429 wins over any other reading',
        LinearClient.mergeStatusIntoCode('AUTH', 429), 'RATELIMITED');
    equal('a 401 upgrades a generic error to an auth failure',
        LinearClient.mergeStatusIntoCode('GRAPHQL', 401), 'AUTH');
    equal('a 401 does not downgrade a validation failure',
        LinearClient.mergeStatusIntoCode('VALIDATION', 401), 'VALIDATION');
    equal('a 200 keeps whatever the body said',
        LinearClient.mergeStatusIntoCode('AUTH', 200), 'AUTH');
    equal('an ordinary 400 stays as classified',
        LinearClient.mergeStatusIntoCode('VALIDATION', 400), 'VALIDATION');
})();

(function authorizationHeader() {
    /*
     * A personal API key is sent verbatim and an OAuth token takes the
     * "Bearer" prefix. Sending either in the other form is rejected as an
     * authentication failure.
     */
    equal('a personal API key is sent verbatim',
        LinearClient.authorizationFor({ apiKey: 'lin_api_ABC' }), 'lin_api_ABC');
    equal('an OAuth token is prefixed',
        LinearClient.authorizationFor({ accessToken: 'TOK' }), 'Bearer TOK');
    equal('an access token wins when both are present',
        LinearClient.authorizationFor({ apiKey: 'K', accessToken: 'T' }), 'Bearer T');
    equal('nothing configured yields nothing',
        LinearClient.authorizationFor({}), '');
    equal('whitespace around a key is ignored',
        LinearClient.authorizationFor({ apiKey: '  lin_api_ABC  ' }), 'lin_api_ABC');
    equal('a key of only whitespace counts as absent',
        LinearClient.authorizationFor({ apiKey: '   ' }), '');
})();

(function documentNotificationShape() {
    /*
     * DocumentNotification carries documentId and commentId but no
     * document or comment object. Requesting either makes the whole query
     * fail with HTTP 400.
     */
    let fragments = (LinearClient.QUERY_FULL + LinearClient.QUERY_SAFE)
        .match(/\.\.\. on DocumentNotification \{[^}]*\}/g) || [];

    equal('both queries carry a document fragment', fragments.length, 2);

    fragments.forEach(function (fragment, index) {
        check('document fragment ' + index + ' asks for no document object',
            !/document\s*\{/.test(fragment), fragment);
        check('document fragment ' + index + ' asks for no comment object',
            !/comment\s*\{/.test(fragment), fragment);
        check('document fragment ' + index + ' asks for documentId',
            fragment.indexOf('documentId') !== -1, fragment);
    });
})();


// ----------------------------------------------------------------------
// Message rendering
// ----------------------------------------------------------------------

(function markdown() {
    // Comment bodies are markdown, which St labels cannot render.
    equal('plain text is left alone',
        Format.preview('Can you repro this on Wayland?', 200),
        'Can you repro this on Wayland?');

    // Linear writes a mention as @[Display Name](uuid).
    equal('a mention keeps the name and drops the id',
        Format.preview('@[Evelyn Ashe](u_123) can you look?', 200),
        '@Evelyn Ashe can you look?');

    equal('emphasis markers are removed',
        Format.preview('This is **very** important and *urgent*', 200),
        'This is very important and urgent');
    equal('a link keeps its text, not its url',
        Format.preview('See [the docs](https://example.com/a) for details', 200),
        'See the docs for details');
    equal('inline code keeps the code',
        Format.preview('Run `systemctl restart` first', 200),
        'Run systemctl restart first');

    // A pasted stack trace is often the whole point of the comment.
    equal('a fenced block keeps its contents',
        Format.preview('Trace:\n```js\nTypeError: x is undefined\n```\ndone', 200),
        'Trace: TypeError: x is undefined done');

    equal('headings lose their hashes',
        Format.preview('## Summary\nIt broke', 200), 'Summary It broke');
    equal('quotes lose their angle bracket',
        Format.preview('> previous\nagreed', 200), 'previous agreed');
    equal('list items become bullets',
        Format.preview('- first\n- second', 200), '\u2022 first \u2022 second');
    equal('checkboxes show their state',
        Format.preview('- [ ] todo\n- [x] done', 200), '\u2610 todo \u2611 done');
    equal('a horizontal rule disappears',
        Format.preview('above\n---\nbelow', 200), 'above below');

    // A hyphen mid-sentence is not a list marker.
    equal('a hyphen inside a sentence survives',
        Format.preview('the well-known case', 200), 'the well-known case');

    equal('nothing at all is survivable', Format.preview('', 200), '');
    equal('null is survivable', Format.preview(null, 200), '');

    // The tooltip keeps the shape the author gave it.
    equal('the tooltip form keeps paragraph breaks',
        Format.messageText('## Head\n\npara one\n\npara two', 200),
        'Head\n\npara one\n\npara two');

    // The indent allowance before a marker must not swallow the newline
    // before it, or the paragraph break disappears with it.
    equal('a heading after a paragraph keeps the blank line before it',
        Format.messageText('intro\n\n## Head', 200), 'intro\n\nHead');

    check('a very long message is cut for the row',
        Format.preview('word '.repeat(60), 40).length <= 40);
    check('and the cut is marked',
        Format.preview('word '.repeat(60), 40).indexOf('\u2026') !== -1);
})();

(function previewBounds() {
    /*
     * preview and messageText bound the input before stripping, because
     * stripMarkdown runs on the compositor's main loop. A long backtick
     * run is the pathological input for the fence rule: unbounded, its
     * backtracking is quadratic in the body length.
     */
    let hostile = 'Important words first. ' + '`'.repeat(1 << 20);
    let started = Date.now();
    let row = Format.preview(hostile, 120);
    let elapsed = Date.now() - started;
    check('a multi-megabyte hostile body is previewed quickly',
        elapsed < 500, elapsed + 'ms');
    check('and stays within the row limit', row.length <= 120, 'length ' + row.length);
    check('and keeps the leading prose',
        row.indexOf('Important words first.') === 0, row);

    let long = 'word '.repeat(500000);
    let cut = Format.preview(long, 120);
    check('a huge plain body is cut to the limit', cut.length <= 120);
    check('and the cut is marked', cut.indexOf('\u2026') !== -1);
    check('the tooltip form is bounded the same way',
        Format.messageText(long, 400).length <= 400);

    equal('a short body passes through the bound unchanged',
        Format.preview('Can you check this?', 120), 'Can you check this?');
})();

(function mentionMessages() {
    let base = {
        __typename: 'IssueNotification',
        id: 'm1',
        type: 'issueCommentMention',
        createdAt: new Date().toISOString(),
        readAt: null,
        actor: { name: 'Priya Raman' },
        issue: {
            identifier: 'ENG-412', title: 'Tray icon',
            url: 'https://linear.app/a/issue/ENG-412/x',
            state: { type: 'started', color: '#f2c94c' },
        },
    };

    let withBody = Model.normaliseMentions([Object.assign({}, base, {
        commentId: 'c1',
        comment: { id: 'c1', url: 'https://linear.app/a/issue/ENG-412#comment-c1',
            body: '@[Evelyn](u1) does this reproduce on **Wayland**?' },
    })]);
    equal('the comment body is carried through', withBody[0].message,
        '@[Evelyn](u1) does this reproduce on **Wayland**?');
    equal('and the subject is kept for context',
        withBody[0].subject, 'ENG-412 Tray icon');

    // A mention in an issue description has no comment, and a document
    // mention has no comment object at all. Neither is an error.
    let withoutBody = Model.normaliseMentions([Object.assign({}, base, {
        type: 'issueMention',
    })]);
    equal('no comment means no message', withoutBody[0].message, '');
    check('but the row still has something to show',
        withoutBody[0].title.length > 0);

    let emptyBody = Model.normaliseMentions([Object.assign({}, base, {
        comment: { id: 'c2', url: 'https://linear.app/a/issue/ENG-412#comment-c2' },
    })]);
    equal('a comment with no body yields no message', emptyBody[0].message, '');
})();

(function commentBodyRequested() {
    // The preview cannot work if the query stops asking for the body.
    let queries = LinearClient.QUERY_FULL + LinearClient.QUERY_SAFE;
    let fragments = queries.match(/comment \{[^}]*\}/g) || [];

    check('both queries request comment bodies', fragments.length >= 2);
    fragments.forEach(function (fragment, index) {
        check('comment fragment ' + index + ' asks for body',
            fragment.indexOf('body') !== -1, fragment);
    });
})();

(function lineBudget() {
    let theme = new ThemeLib.Theme({ width: 380 });

    let narrow = theme.charsPerLine(200, 12);
    let wide = theme.charsPerLine(400, 12);
    check('a wider row fits more characters', wide > narrow, wide + ' vs ' + narrow);

    let small = theme.charsPerLine(300, 9);
    let large = theme.charsPerLine(300, 14);
    check('a larger font fits fewer characters', small > large, small + ' vs ' + large);

    check('the estimate is plausible for a default desklet',
        narrow > 10 && narrow < 60, 'got ' + narrow);
    check('a pathological width still yields something usable',
        theme.charsPerLine(1, 12) >= 8);
})();

(function emphasisStyles() {
    let theme = new ThemeLib.Theme({ width: 380 });
    let accent = ThemeLib.RAINBOW[0];

    // Emphasis is a property of any row rather than a distinct card.
    check('emphasis is available to any row',
        typeof theme.emphasisRowStyle === 'function');

    [0, 0.5, 1].forEach(function (intensity) {
        [false, true].forEach(function (hovered) {
            let style = theme.emphasisRowStyle(accent, intensity, hovered);
            check('emphasis ' + intensity + '/' + hovered + ' has no NaN',
                style.indexOf('NaN') === -1, style);
            check('emphasis ' + intensity + '/' + hovered + ' has no undefined',
                style.indexOf('undefined') === -1, style);
        });
    });

    // Settings arrive from disk and can be nonsense.
    check('a missing intensity is survivable',
        theme.emphasisRowStyle(accent, undefined, false).indexOf('NaN') === -1);

    [theme.issueTitleStyle(false), theme.issueTitleStyle(true),
     theme.mentionMessageStyle(true), theme.mentionMessageStyle(false),
     theme.mentionActorStyle(true), theme.contextStyle(),
     theme.identifierStyle(accent)].forEach(function (style, index) {
        check('new style ' + index + ' is well formed',
            style.indexOf('NaN') === -1 && style.indexOf('undefined') === -1, style);
    });
})();


// ----------------------------------------------------------------------
// Tooltip geometry
// ----------------------------------------------------------------------

(function tooltipPlacement() {
    /*
     * A copy of the placement arithmetic from lib/tooltip.js show(), so it
     * can be exercised without a compositor. Text measurement is not
     * covered here: it needs a real St.Label on a stage.
     */
    const MARGIN = 8;

    function place(pointer, size, area, cursorSize) {
        let left = Math.round(pointer.x - size.width / 2);
        let top = pointer.y + Math.round(cursorSize * 0.75);

        if (top + size.height > area.y + area.height) {
            let above = pointer.y - size.height - Math.round(cursorSize * 0.25);
            if (above >= area.y)
                top = above;
        }

        left = Math.max(area.x, Math.min(left, area.x + area.width - size.width));
        top = Math.max(area.y, Math.min(top, area.y + area.height - size.height));

        return { left: left, top: top };
    }

    let area = { x: MARGIN, y: MARGIN, width: 3840 - MARGIN * 2, height: 2160 - MARGIN * 2 };
    let cursor = 24;

    // Centred under the pointer when there is room on both sides.
    let centred = place({ x: 1900, y: 1000 }, { width: 400, height: 100 }, area, cursor);
    equal('centred horizontally on the pointer', centred.left + 200, 1900);
    check('placed below the pointer', centred.top > 1000, 'top ' + centred.top);

    // Clamped rather than allowed to hang off either edge.
    let atLeft = place({ x: 20, y: 1000 }, { width: 400, height: 100 }, area, cursor);
    equal('never crosses the left edge', atLeft.left, area.x);

    let atRight = place({ x: 3820, y: 1000 }, { width: 400, height: 100 }, area, cursor);
    equal('never crosses the right edge',
        atRight.left + 400, area.x + area.width);

    // Flipped above the pointer when it would not fit below.
    let atBottom = place({ x: 1900, y: 2100 }, { width: 400, height: 200 }, area, cursor);
    check('flips above the pointer near the bottom', atBottom.top < 2100,
        'top ' + atBottom.top);
    check('and stays on screen', atBottom.top >= area.y &&
        atBottom.top + 200 <= area.y + area.height);

    // A tooltip taller than the screen keeps its beginning visible rather
    // than its end.
    let huge = place({ x: 1900, y: 1000 }, { width: 400, height: 3000 }, area, cursor);
    equal('an oversized tooltip is pinned to the top', huge.top, area.y);

    // Every corner, which is where clamping and flipping interact.
    [[2, 2], [3838, 2], [2, 2158], [3838, 2158]].forEach(function (corner) {
        let box = place({ x: corner[0], y: corner[1] },
            { width: 400, height: 150 }, area, cursor);
        check('corner ' + corner.join(',') + ' stays on screen',
            box.left >= area.x &&
            box.left + 400 <= area.x + area.width &&
            box.top >= area.y &&
            box.top + 150 <= area.y + area.height,
            'got ' + box.left + ',' + box.top);
    });

    // A narrow monitor must not produce a negative position.
    let small = { x: MARGIN, y: MARGIN, width: 800 - MARGIN * 2, height: 600 - MARGIN * 2 };
    let onSmall = place({ x: 400, y: 300 }, { width: 700, height: 100 }, small, cursor);
    check('a tooltip wider than the gap still starts on screen',
        onSmall.left >= small.x, 'got ' + onSmall.left);
})();

(function tooltipWidthBudget() {
    /*
     * The wrap width: a fraction of the usable screen width, bounded by a
     * floor and a ceiling.
     */
    const FRACTION = 0.28;
    const CEILING = 560;
    const FLOOR = 240;

    function budget(areaWidth) {
        return Math.max(FLOOR, Math.min(CEILING, Math.round(areaWidth * FRACTION)));
    }

    equal('a 4K monitor is capped by the ceiling', budget(3824), CEILING);
    equal('a 1080p monitor uses the proportion', budget(1904), Math.round(1904 * FRACTION));
    equal('a small screen is held up by the floor', budget(640), FLOOR);

    check('the budget is never wider than a small screen allows',
        Math.min(budget(640), 640 - 16) <= 640);
    check('the budget is always positive', budget(1) > 0);
})();

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
