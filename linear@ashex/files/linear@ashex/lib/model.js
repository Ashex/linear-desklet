/*
 * model.js - turns Linear's GraphQL payload into the flat, pre-sorted
 * shape the renderer draws from.
 *
 * Everything defensive lives here. The desklet talks to a schema it does
 * not control, over a field set that includes several Linear marks
 * internal, so every value is treated as possibly absent and every
 * display string has a composed fallback. The renderer downstream is then
 * free to assume its input is complete.
 */

// Relative to the desklet directory, not to this file.
const Format = require('./lib/format');
const ThemeLib = require('./lib/theme');

const _ = require('./lib/i18n')._;

const DAY = 86400000;

/*
 * Which notifications to show is decided here rather than in the query.
 *
 * It used to be decided by the query, with filter: { type: { in: [...] } }
 * and a hand-written list of type names. That was wrong in a way that took
 * a long time to notice. Notification.type is String! and not an enum, so a
 * name that does not exist matches nothing and raises no error - the list
 * just comes back shorter. "pullRequestMention" was in that list, is not a
 * real type, and hid every pull request notification for as long as it was
 * there. Linear also invents new types without notice, and each one would
 * have been invisible on arrival.
 *
 * Every notification instead carries exactly one of these categories, so
 * filtering on the category puts an unrecognised type in a known bucket
 * rather than nowhere. Linear will not let this happen server-side -
 * NotificationFilter has no category field - so it happens here, after the
 * fetch, which has the pleasant side effect of making the category settings
 * cost no network traffic at all.
 */
var CATEGORIES = [
    'assignments', 'statusChanges', 'commentsAndReplies', 'mentions',
    'reactions', 'subscriptions', 'documentChanges', 'postsAndUpdates',
    'reminders', 'reviews', 'loops', 'appsAndIntegrations', 'triage',
    'customers', 'feed', 'billing', 'system',
];

/*
 * The categories with a checkbox of their own, mapped to the suffix of
 * their setting key. Everything not named here shares the 'other'
 * catch-all, which keeps the settings page at nine checkboxes rather than
 * seventeen.
 */
var CATEGORY_SETTING = Object.assign(Object.create(null), {
    mentions: 'mentions',
    reviews: 'reviews',
    commentsAndReplies: 'comments',
    assignments: 'assignments',
    statusChanges: 'status',
    subscriptions: 'subscriptions',
    documentChanges: 'documents',
    reactions: 'reactions',
});

/*
 * Type to category, for the QUERY_SAFE path where category is not asked
 * for. Every entry below was observed coming back from the live API, not
 * inferred from the name - note that pullRequestCommentMention is filed
 * under reviews rather than mentions, which is not what the name suggests.
 *
 * The map is deliberately incomplete. A type that is missing from it falls
 * through to the 'other' catch-all and is shown, because a stray extra row
 * is a far smaller failure than the one this whole redesign exists to fix.
 * The cost is that under QUERY_SAFE an unmapped reaction type could appear
 * even with reactions switched off; QUERY_SAFE only runs when the schema
 * has already changed underneath us, and a visible surprise is the right
 * behaviour there.
 */
const CATEGORY_BY_TYPE = Object.assign(Object.create(null), {
    issueAssignedToYou: 'assignments',
    issueUnassignedFromYou: 'assignments',
    issueStatusChanged: 'statusChanges',
    issueNewComment: 'commentsAndReplies',
    documentThreadResolved: 'commentsAndReplies',
    issueMention: 'mentions',
    issueCommentMention: 'mentions',
    documentMention: 'mentions',
    documentCommentMention: 'mentions',
    issueSubscribed: 'subscriptions',
    pullRequestCommented: 'reviews',
    pullRequestCommentMention: 'reviews',
    pullRequestReviewRequested: 'reviews',
    pullRequestReviewRerequested: 'reviews',
    pullRequestApproved: 'reviews',
    workspaceWelcome: 'system',
});

// Comment mentions get a different phrasing, because "in a comment" is the
// difference between a passing reference and a question aimed at you.
const COMMENT_MENTION_TYPES = {
    issueCommentMention: true,
    documentCommentMention: true,
    projectCommentMention: true,
    projectUpdateCommentMention: true,
    initiativeCommentMention: true,
    pullRequestCommentMention: true,
};

/*
 * The category a notification belongs to. Linear's own answer when the
 * query asked for it, the local map when it did not, and an empty string
 * when neither knows - which allowsCategory() treats as 'other' rather than
 * as a reason to hide the row.
 */
function categoryOf(node) {
    if (!node)
        return '';
    return text(node.category) || CATEGORY_BY_TYPE[text(node.type)] || '';
}

/*
 * Whether a category is switched on. prefs is keyed by the suffixes in
 * CATEGORY_SETTING plus 'other'; a missing entry counts as on, so a
 * category Linear adds later shows up instead of vanishing.
 */
function allowsCategory(prefs, category) {
    let settings = prefs || {};
    let key = CATEGORY_SETTING[category] || 'other';
    return settings[key] !== false;
}

function text(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function webUrl(value) {
    let url = text(value);
    return /^https?:\/\//i.test(url) ? url : '';
}

// ----------------------------------------------------------------------
// Viewer
// ----------------------------------------------------------------------

/*
 * The signed-in account and the workspace it belongs to.
 *
 * Both names are optional in the reply, so each field falls back through
 * the alternatives before giving up. describeAccount() below produces the
 * one-line form shown in the settings window.
 */
function normaliseViewer(node) {
    if (!node)
        return null;

    let organization = node.organization || {};

    return {
        id: text(node.id),
        name: text(node.name) || text(node.displayName),
        displayName: text(node.displayName),
        // urlKey is the workspace slug, and is the only name available
        // when an organisation has no display name set.
        organizationName: text(organization.name) || text(organization.urlKey),
        organizationKey: text(organization.urlKey),
    };
}

/*
 * A single line naming the account and workspace, for the settings window.
 * Degrades as fields go missing rather than rendering a sentence with a
 * hole in it.
 */
function describeAccount(viewer) {
    if (!viewer)
        return '';

    if (viewer.name && viewer.organizationName)
        return _('Signed in as %s to %s.').format(viewer.name, viewer.organizationName);
    if (viewer.organizationName)
        return _('Signed in to %s.').format(viewer.organizationName);
    if (viewer.name)
        return _('Signed in as %s.').format(viewer.name);

    return _('Signed in to Linear.');
}

// ----------------------------------------------------------------------
// Issues
// ----------------------------------------------------------------------

function normaliseIssues(nodes) {
    if (!Array.isArray(nodes))
        return [];

    let issues = [];

    nodes.forEach(function (node) {
        if (!node)
            return;

        let state = node.state || {};
        let team = node.team || {};
        let project = node.project || {};
        let dueDate = Format.parseTimelessDate(node.dueDate);

        issues.push({
            id: text(node.id),
            identifier: text(node.identifier) || _('Issue'),
            title: text(node.title) || _('Untitled'),
            priority: node.priority === null || node.priority === undefined
                ? null
                : Number(node.priority),
            // The workspace's own label wins: it is already localised, and
            // an admin may have renamed the scale.
            priorityLabel: text(node.priorityLabel),
            dueDate: dueDate,
            url: webUrl(node.url),
            updatedMs: Format.parseTimestamp(node.updatedAt),
            stateName: text(state.name),
            stateType: text(state.type),
            stateColor: text(state.color),
            teamKey: text(team.key),
            teamName: text(team.name),
            projectName: text(project.name),
        });
    });

    return issues;
}

/*
 * Linear treats "no priority" as lowest rather than highest, even though
 * its numeric value is zero. Sorting on the raw number would put every
 * unprioritised issue above the urgent ones.
 */
function priorityRank(priority) {
    let value = Number(priority);
    if (isNaN(value) || value === 0)
        return 5;
    return value;
}

function compareDue(a, b) {
    let aMs = a.dueDate ? a.dueDate.getTime() : null;
    let bMs = b.dueDate ? b.dueDate.getTime() : null;
    if (aMs === bMs)
        return 0;
    // An issue with no due date is not urgent, so it sorts after the ones
    // that have one rather than sharing the top of the list with them.
    if (aMs === null)
        return 1;
    if (bMs === null)
        return -1;
    return aMs - bMs;
}

function compareUpdated(a, b) {
    return (b.updatedMs || 0) - (a.updatedMs || 0);
}

/*
 * Orders issues for display.
 *
 * Sorting happens here rather than being left to the server because the
 * same ordering must apply to cached responses, which may have been
 * written by a different version of the query, and because "no priority
 * sorts last" is a display convention the API does not implement.
 */
function sortIssues(issues, mode) {
    let sorted = issues.slice();

    switch (mode) {
        case 'due':
            sorted.sort(function (a, b) {
                return compareDue(a, b) ||
                    priorityRank(a.priority) - priorityRank(b.priority) ||
                    compareUpdated(a, b);
            });
            break;
        case 'updated':
            sorted.sort(compareUpdated);
            break;
        case 'priority':
        default:
            sorted.sort(function (a, b) {
                return priorityRank(a.priority) - priorityRank(b.priority) ||
                    compareDue(a, b) ||
                    compareUpdated(a, b);
            });
            break;
    }

    return sorted;
}

/*
 * How loud an issue is allowed to be, from 0 to 1. Drives the glow radius
 * and the border alpha on the focused card, so it needs to move smoothly
 * rather than in steps: an issue due in a week should already be slightly
 * warmer than one due next month.
 */
function urgencyFor(issue, nowMs, imminentDays) {
    let urgency = 0;

    if (issue.dueDate) {
        let days = Format.dayDelta(nowMs, issue.dueDate.getTime());
        if (days < 0)
            urgency = 1;
        else if (days === 0)
            urgency = 0.85;
        else if (imminentDays > 0)
            urgency = 0.85 * Math.max(0, 1 - (days - 1) / imminentDays);
    }

    // Urgent priority is loud on its own account, due date or not.
    if (Number(issue.priority) === 1)
        urgency = Math.max(urgency, 0.5);

    return Math.max(0, Math.min(1, urgency));
}

/*
 * The short, shouty line above the focused issue's title. Says whichever
 * one thing is most worth knowing, rather than stacking all of them.
 */
function eyebrowFor(issue, nowMs) {
    if (issue.dueDate) {
        let days = Format.dayDelta(nowMs, issue.dueDate.getTime());
        if (days < 0)
            return _('Overdue');
        if (days === 0)
            return _('Due today');
    }
    if (Number(issue.priority) === 1)
        return _('Urgent');
    if (issue.stateType === 'started')
        return _('In progress');
    if (issue.stateType === 'triage')
        return _('Triage');
    return '';
}

/*
 * Runs of issues under a team heading. Order is inherited from the sort,
 * so a team's position reflects its most pressing issue rather than its
 * name, which is what keeps grouping from burying the urgent work.
 */
function groupByTeam(issues) {
    let groups = [];
    let byKey = Object.create(null);

    issues.forEach(function (issue) {
        let key = issue.teamKey || issue.teamName || '';
        if (!byKey[key]) {
            byKey[key] = {
                key: key,
                label: issue.teamName || issue.teamKey || _('No team'),
                issues: [],
            };
            groups.push(byKey[key]);
        }
        byKey[key].issues.push(issue);
    });

    return groups;
}

// ----------------------------------------------------------------------
// Mentions
// ----------------------------------------------------------------------

function actorName(node) {
    let actor = node.actor || node.externalUserActor || node.botActor;
    if (!actor)
        return '';
    return text(actor.name) || text(actor.displayName);
}

/*
 * What the mention points at, as a person would name it. Issues get their
 * identifier because that is how they are referred to in conversation;
 * everything else gets its title.
 */
function subjectOf(node) {
    if (node.issue) {
        let identifier = text(node.issue.identifier);
        let title = text(node.issue.title);
        if (identifier && title)
            return identifier + ' ' + title;
        return identifier || title;
    }
    /*
     * A pull request is named the way it is named in review: by number.
     * The number is a Float in the schema rather than an Int, so it is
     * rounded before it reaches a string and turns into "#7.0".
     */
    if (node.pullRequest) {
        let number = node.pullRequest.number;
        let label = (typeof number === 'number' && isFinite(number))
            ? '#' + Math.round(number) : '';
        let title = text(node.pullRequest.title);
        if (label && title)
            return label + ' ' + title;
        return label || title;
    }
    if (node.document)
        return text(node.document.title);
    if (node.projectUpdate && node.project)
        return text(node.project.name);
    if (node.project)
        return text(node.project.name);
    if (node.initiative)
        return text(node.initiative.name);
    return '';
}

/*
 * Where clicking the mention should go.
 *
 * Linear's notifications carry a ready-made `url`, but that field is
 * marked internal in the schema and could be withdrawn without notice.
 * Falling back through the comment and then the parent entity means a
 * mention stays clickable even if it disappears.
 *
 * A pull request is the one case where the two answers point at different
 * sites: Linear's own url opens the notification inside Linear, while
 * pullRequest.url goes to the forge where the comment actually is. Linear
 * keeps precedence, so the fallback only changes where clicks land once
 * the internal field is gone - and by then the forge is the better answer
 * anyway.
 *
 * DocumentNotification exposes documentId and nothing else - there is no
 * document object on it to build a link from - so a document notification
 * has no fallback at all and is dropped by the caller when the internal
 * url is missing.
 */
function urlOf(node) {
    let direct = webUrl(node.url);
    if (direct)
        return direct;

    if (node.comment) {
        let commentUrl = webUrl(node.comment.url);
        if (commentUrl)
            return commentUrl;
    }

    let base = '';
    if (node.issue)
        base = webUrl(node.issue.url);
    else if (node.pullRequest)
        base = webUrl(node.pullRequest.url);
    else if (node.document)
        base = webUrl(node.document.url);
    else if (node.project)
        base = webUrl(node.project.url);
    else if (node.initiative)
        base = webUrl(node.initiative.url);

    if (!base)
        return '';

    /*
     * Anchoring on the comment lands the browser on the actual remark
     * rather than at the top of a long thread.
     *
     * The anchor is the first segment of the comment's UUID, not the whole
     * id. That is what Linear itself emits - sixty-six of sixty-six
     * commented notifications in a live inbox, and the comment.url field
     * agrees - and appending the full id produces a link that looks right
     * and lands in the wrong place.
     */
    let commentId = text(node.commentId) || (node.comment ? text(node.comment.id) : '');
    if (commentId)
        return base + '#comment-' + commentId.split('-')[0];

    /*
     * A pull request gets no anchor. pullRequestCommentId is a Linear id
     * rather than the forge's own, so it cannot address a comment on the
     * forge page that base points at; a fabricated #issuecomment- anchor
     * would only look precise while landing at the top of the thread
     * regardless. Linear's own link uses a /review/ path we have no slug
     * for, so the forge page is the honest destination.
     */
    return base;
}

// The types that really are someone saying your name. Only these may be
// described with the mention wording.
const MENTION_TYPES = {
    issueMention: true,
    issueCommentMention: true,
    documentMention: true,
    documentCommentMention: true,
    projectMention: true,
    projectCommentMention: true,
    projectUpdateMention: true,
    projectUpdateCommentMention: true,
    initiativeMention: true,
    initiativeCommentMention: true,
    pullRequestCommentMention: true,
};

/*
 * What happened, in our own words, or '' when we genuinely do not know.
 *
 * Each arm has an actor-less form because the actor is optional on every
 * notification type and a sentence with a hole in it reads worse than a
 * shorter sentence.
 *
 * The empty return is the important part. This used to end with the
 * mention wording as its default, which meant every type it did not
 * recognise - the entire "everything else" bucket that this tab now
 * surfaces - was announced to the user as "so-and-so mentioned you". A row
 * that states something that did not happen is worse than a row that says
 * nothing, so an unrecognised type returns nothing and the caller falls
 * back to Linear's own phrasing instead of guessing.
 */
function describeMention(node) {
    let actor = actorName(node);
    let type = text(node.type);

    switch (type) {
        case 'issueAssignedToYou':
            return actor ? _('%s assigned this to you').format(actor)
                         : _('Assigned to you');
        case 'issueUnassignedFromYou':
            return actor ? _('%s unassigned this from you').format(actor)
                         : _('Unassigned from you');
        case 'issueStatusChanged':
            return actor ? _('%s changed the status').format(actor)
                         : _('The status changed');
        case 'issueNewComment':
            return actor ? _('%s commented').format(actor) : _('A new comment');
        case 'documentThreadResolved':
            return actor ? _('%s resolved a thread').format(actor)
                         : _('A thread was resolved');
        case 'issueSubscribed':
            return actor ? _('%s subscribed you').format(actor)
                         : _('You were subscribed');
        case 'pullRequestReviewRequested':
        case 'pullRequestReviewRerequested':
            return actor ? _('%s requested your review').format(actor)
                         : _('Your review was requested');
        case 'pullRequestApproved':
            return actor ? _('%s approved the pull request').format(actor)
                         : _('The pull request was approved');
        case 'pullRequestCommented':
            return actor ? _('%s commented on the pull request').format(actor)
                         : _('A comment on the pull request');
    }

    if (MENTION_TYPES[type]) {
        let inComment = !!COMMENT_MENTION_TYPES[type];

        if (!actor)
            return inComment ? _('You were mentioned in a comment') : _('You were mentioned');

        return inComment
            ? _('%s mentioned you in a comment').format(actor)
            : _('%s mentioned you').format(actor);
    }

    return '';
}

/*
 * The last resort, for a type neither we nor Linear will name. Deliberately
 * vague: it is reached only when the type is unrecognised and Linear's own
 * phrasing was not asked for, and the one thing we can still say honestly
 * is that the thing changed.
 */
function describeSomething(node) {
    let actor = actorName(node);
    return actor ? _('%s updated this').format(actor) : _('Something changed');
}

/*
 * Documents by id, for joining onto document notifications.
 *
 * DocumentNotification is the one type that carries no object to build a
 * link from - just a documentId - and a document's URL is keyed on its
 * slugId, an unrelated value that cannot be derived from the id. Linear
 * routes a bare slugId but not a bare documentId, so there is no string to
 * construct and the document itself has to be fetched and matched up.
 *
 * Only QUERY_SAFE asks for them. Under QUERY_FULL the internal url field
 * answers this already, so the map arrives empty and nothing here fires.
 */
function indexDocuments(nodes) {
    let index = Object.create(null);
    if (!Array.isArray(nodes))
        return index;

    nodes.forEach(function (node) {
        if (!node)
            return;
        let id = text(node.id);
        if (id)
            index[id] = node;
    });

    return index;
}

function normaliseMentions(nodes, documents) {
    if (!Array.isArray(nodes))
        return [];

    let index = documents || Object.create(null);
    let mentions = [];
    let dropped = [];

    nodes.forEach(function (raw) {
        if (!raw)
            return;

        /*
         * Joins the fetched document onto a document notification, so that
         * subjectOf and urlOf can treat it like any other type rather than
         * needing a special case each. A copy, because the raw payload is
         * also what gets written to the cache.
         */
        let node = raw;
        if (!raw.document && raw.documentId) {
            let found = index[text(raw.documentId)];
            if (found)
                node = Object.assign({}, raw, { document: found });
        }

        let url = urlOf(node);
        /*
         * A row with nowhere to go is worse than no row at all: it looks
         * clickable, does nothing, and displaces something useful.
         *
         * But a row that disappears without a word is how this tab came to
         * be showing nine of seventy-nine notifications in the first place,
         * so the drop is recorded rather than merely performed. Under
         * QUERY_FULL this cannot happen - url is non-null on every
         * notification type - so anything logged here means the fallback
         * query is running against a type that has no public link.
         */
        if (!url) {
            dropped.push(text(node.type) || text(node.__typename) || 'unknown');
            return;
        }

        let issue = node.issue || {};
        let issueState = issue.state || {};
        let subject = subjectOf(node);
        // Empty for a type we do not recognise, which is what lets the
        // fields below prefer Linear's wording over a wrong guess.
        let described = describeMention(node);

        mentions.push({
            id: text(node.id),
            type: text(node.type),
            category: categoryOf(node),
            typename: text(node.__typename),
            // The server's own phrasing when it is there, ours when it is
            // not. Same reasoning as priorityLabel: it is already
            // localised and reflects workspace wording.
            title: text(node.title) || described || describeSomething(node),
            subtitle: text(node.subtitle) || subject,
            /*
             * What happened.
             *
             * Unlike title this prefers our own phrasing over Linear's,
             * because the renderer needs it in both query paths and
             * Linear's title is the name of the thing rather than the thing
             * that happened. It matters now that the list carries more than
             * mentions: an assignment, a status change and a review request
             * all reduce to the same actor and subject, and without this
             * the row gives no way to tell them apart.
             *
             * Where we have no phrasing of our own, Linear's subtitle is
             * the better answer than a guess - it is exactly this field for
             * types we have never heard of.
             */
            action: described || text(node.subtitle) || describeSomething(node),
            url: url,
            actor: actorName(node),
            /*
             * The text of the comment containing the mention.
             *
             * Empty when the mention is in an issue description rather
             * than a comment, and always empty for document mentions,
             * which carry no comment object.
             */
            message: node.comment ? text(node.comment.body) : '',
            // The thing the mention is about, for the context line beneath
            // the message.
            subject: subject,
            createdMs: Format.parseTimestamp(node.createdAt) ||
                Format.parseTimestamp(node.updatedAt),
            unread: !node.readAt,
            // Carried so the state and Linear colour modes still have
            // something to work with on this tab.
            stateType: text(issueState.type),
            stateColor: text(issueState.color),
            identifier: text(issue.identifier),
        });
    });

    if (dropped.length) {
        global.logWarning('linear@ashex: dropped ' + dropped.length +
            ' notification(s) with no link to open: ' + dropped.join(', '));
    }

    return mentions;
}

/*
 * Newest first, cut down to the categories that are switched on and
 * optionally to unread only. Returns the whole matching list rather than a
 * screenful: pageOf() below does the slicing, and the footer needs the full
 * count to say what it is showing a page of.
 *
 * Neither filter can be pushed to the server. Linear offers no filter on
 * read state at all, and NotificationFilter has no category field, so both
 * cuts happen here - which is why the query fetches a window far larger
 * than the page.
 *
 * options: { unreadOnly, categories }
 */
function prepareMentions(mentions, options) {
    let opts = options || {};

    let list = mentions.slice().sort(function (a, b) {
        return (b.createdMs || 0) - (a.createdMs || 0);
    });

    list = list.filter(function (mention) {
        return allowsCategory(opts.categories, mention.category);
    });

    if (opts.unreadOnly)
        list = list.filter(function (mention) { return mention.unread; });

    return list;
}

/*
 * One page out of a prepared list.
 *
 * The index is clamped rather than trusted, because the desklet holds onto
 * it across refreshes: a page that was valid a minute ago can be past the
 * end of a list that has since shrunk, either because notifications were
 * read or because a category was switched off.
 */
function pageOf(list, size, index) {
    let rows = Array.isArray(list) ? list : [];
    let pageSize = Math.max(1, size || 10);
    let pageCount = Math.max(1, Math.ceil(rows.length / pageSize));

    // NaN is the only value with no sensible page; anything merely out of
    // range, Infinity included, clamps to an end rather than to the front.
    let page = Math.floor(index || 0);
    if (isNaN(page) || page < 0)
        page = 0;
    if (page > pageCount - 1)
        page = pageCount - 1;

    let start = page * pageSize;

    return {
        rows: rows.slice(start, start + pageSize),
        page: page,
        pageCount: pageCount,
        // One-based and inclusive, because the only consumer is a "%d-%d of
        // %d" label meant for a person.
        first: rows.length ? start + 1 : 0,
        last: Math.min(start + pageSize, rows.length),
        total: rows.length,
    };
}

function unreadCount(mentions) {
    let count = 0;
    mentions.forEach(function (mention) {
        if (mention.unread)
            count++;
    });
    return count;
}

// ----------------------------------------------------------------------
// Accents
// ----------------------------------------------------------------------

/*
 * Wraps the theme's accent picker so a mention, which has no priority of
 * its own, still gets a stable colour: read mentions go slate so the
 * unread ones own the palette.
 */
function accentForMention(mode, mention, position) {
    if (!mention.unread)
        return ThemeLib.SLATE;
    return ThemeLib.accentFor(mode, mention, position);
}
