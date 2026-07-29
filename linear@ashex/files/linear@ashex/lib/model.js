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
 * The notification types that actually mean "someone said your name".
 * Assignments, status changes, reactions and plain replies are all
 * deliberately absent: the issues tab already covers work coming to you,
 * and an inbox that fills with reactions stops being worth glancing at.
 */
var MENTION_TYPES_CORE = [
    'issueMention',
    'issueCommentMention',
    'documentMention',
    'documentCommentMention',
];

var MENTION_TYPES_WIDE = MENTION_TYPES_CORE.concat([
    'projectMention',
    'projectCommentMention',
    'projectUpdateMention',
    'projectUpdateCommentMention',
    'initiativeMention',
    'initiativeCommentMention',
    'pullRequestMention',
    'pullRequestCommentMention',
]);

function mentionTypes(scope) {
    return scope === 'wide' ? MENTION_TYPES_WIDE : MENTION_TYPES_CORE;
}

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
    else if (node.document)
        base = webUrl(node.document.url);
    else if (node.project)
        base = webUrl(node.project.url);
    else if (node.initiative)
        base = webUrl(node.initiative.url);

    if (!base)
        return '';

    // Anchoring on the comment lands the browser on the actual remark
    // rather than the top of a long thread.
    let commentId = text(node.commentId) || (node.comment ? text(node.comment.id) : '');
    if (commentId)
        return base + '#comment-' + commentId;

    return base;
}

function describeMention(node) {
    let actor = actorName(node);
    let inComment = !!COMMENT_MENTION_TYPES[text(node.type)];

    if (!actor)
        return inComment ? _('You were mentioned in a comment') : _('You were mentioned');

    return inComment
        ? _('%s mentioned you in a comment').format(actor)
        : _('%s mentioned you').format(actor);
}

function normaliseMentions(nodes) {
    if (!Array.isArray(nodes))
        return [];

    let mentions = [];

    nodes.forEach(function (node) {
        if (!node)
            return;

        let url = urlOf(node);
        // A mention with nowhere to go is worse than no row at all: it
        // looks clickable, does nothing, and displaces something useful.
        if (!url)
            return;

        let issue = node.issue || {};
        let issueState = issue.state || {};
        let subject = subjectOf(node);

        mentions.push({
            id: text(node.id),
            type: text(node.type),
            typename: text(node.__typename),
            // The server's own phrasing when it is there, ours when it is
            // not. Same reasoning as priorityLabel: it is already
            // localised and reflects workspace wording.
            title: text(node.title) || describeMention(node),
            subtitle: text(node.subtitle) || subject,
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

    return mentions;
}

/*
 * Newest first, optionally unread only. Linear has no server-side filter
 * on read state, so the trimming has to happen after the fact - which is
 * also why the query asks for more rows than the list will show.
 */
function prepareMentions(mentions, unreadOnly, limit) {
    let list = mentions.slice().sort(function (a, b) {
        return (b.createdMs || 0) - (a.createdMs || 0);
    });

    if (unreadOnly)
        list = list.filter(function (mention) { return mention.unread; });

    return list.slice(0, Math.max(1, limit || 10));
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
