/*
 * demo-data.js - loads fabricated issues and mentions into the running
 * desklet, for screenshots.
 *
 * The data is pushed directly into the render path. Nothing is fetched and
 * nothing is written to the response cache, so no real workspace name,
 * issue title or colleague appears in a published image.
 *
 * Driven through Cinnamon's DBus Eval, with the command in
 * global.__linearDemoCommand:
 *
 *   on              load the data and hold it on screen
 *   issues          switch to the Issues tab
 *   mentions        switch to the Mentions tab
 *   grouped         Issues, grouped by team
 *   off             discard it and return the desklet to normal
 *
 * While demo mode is on the periodic refresh is disarmed. Without that,
 * the first tick would find no credential, clear everything and leave a
 * setup prompt in the middle of a screenshot session.
 */

(function () {
    let command = String(global.__linearDemoCommand || 'on');

    let M = imports.ui.deskletManager;
    let definition = M.definitions.filter(function (d) {
        return d && d.uuid === 'linear@ashex';
    })[0];

    if (!definition || !definition.desklet)
        return 'the Linear desklet is not on the desktop';

    let desklet = definition.desklet;

    // Anchored to local noon so adding whole days never slips across a
    // daylight saving boundary into the wrong calendar day.
    function isoDay(offset) {
        let date = new Date();
        date.setHours(12, 0, 0, 0);
        date.setDate(date.getDate() + offset);
        let month = String(date.getMonth() + 1);
        if (month.length < 2)
            month = '0' + month;
        let day = String(date.getDate());
        if (day.length < 2)
            day = '0' + day;
        return date.getFullYear() + '-' + month + '-' + day;
    }

    function agoIso(ms) {
        return new Date(Date.now() - ms).toISOString();
    }

    const MINUTE = 60000;
    const HOUR = 3600000;
    const DAY = 86400000;

    /*
     * Fabricated content, spread to cover the states worth showing: an
     * urgent issue due today for the emphasis glow, a range of workflow
     * states for the accent colours, several teams for the grouped view,
     * and both read and unread mentions for the badge and dot.
     */
    let payload = {
        viewer: {
            id: 'demo-viewer',
            name: 'Sam Ellery',
            displayName: 'sam',
        },
        issues: {
            nodes: [
                {
                    id: 'demo-1',
                    identifier: 'ENG-412',
                    title: 'Session drops the tray icon after resuming from suspend',
                    priority: 1,
                    priorityLabel: 'Urgent',
                    dueDate: isoDay(0),
                    url: 'https://linear.app/demo/issue/ENG-412/tray-icon',
                    updatedAt: agoIso(42 * MINUTE),
                    state: { name: 'In Progress', type: 'started', color: '#f2c94c' },
                    team: { key: 'ENG', name: 'Engineering' },
                    project: { name: 'Desktop Client' },
                },
                {
                    id: 'demo-2',
                    identifier: 'ENG-388',
                    title: 'Add keyboard shortcuts to the inbox',
                    priority: 2,
                    priorityLabel: 'High',
                    dueDate: isoDay(2),
                    url: 'https://linear.app/demo/issue/ENG-388/shortcuts',
                    updatedAt: agoIso(5 * HOUR),
                    state: { name: 'Todo', type: 'unstarted', color: '#e2e2e2' },
                    team: { key: 'ENG', name: 'Engineering' },
                    project: { name: 'Desktop Client' },
                },
                {
                    id: 'demo-3',
                    identifier: 'PLT-57',
                    title: 'Rotate the signing key before it expires',
                    priority: 2,
                    priorityLabel: 'High',
                    dueDate: isoDay(5),
                    url: 'https://linear.app/demo/issue/PLT-57/rotate-signing-key',
                    updatedAt: agoIso(DAY),
                    state: { name: 'Todo', type: 'unstarted', color: '#e2e2e2' },
                    team: { key: 'PLT', name: 'Platform' },
                    project: null,
                },
                {
                    id: 'demo-4',
                    identifier: 'DES-19',
                    title: 'Icon set for workflow states',
                    priority: 3,
                    priorityLabel: 'Medium',
                    dueDate: null,
                    url: 'https://linear.app/demo/issue/DES-19/workflow-icons',
                    updatedAt: agoIso(2 * DAY),
                    state: { name: 'In Review', type: 'started', color: '#5e6ad2' },
                    team: { key: 'DES', name: 'Design' },
                    project: { name: 'Design System' },
                },
                {
                    id: 'demo-5',
                    identifier: 'ENG-401',
                    title: 'Cache feed responses between restarts',
                    priority: 0,
                    priorityLabel: 'No priority',
                    dueDate: null,
                    url: 'https://linear.app/demo/issue/ENG-401/cache-feeds',
                    updatedAt: agoIso(4 * DAY),
                    state: { name: 'Backlog', type: 'backlog', color: '#bec2c8' },
                    team: { key: 'ENG', name: 'Engineering' },
                    project: null,
                },
            ],
        },
        notifications: {
            nodes: [
                {
                    __typename: 'IssueNotification',
                    id: 'demo-n1',
                    type: 'issueCommentMention',
                    category: 'mentions',
                    createdAt: agoIso(18 * MINUTE),
                    readAt: null,
                    actor: { name: 'Priya Raman', displayName: 'priya' },
                    commentId: 'demo-c1',
                    issue: {
                        id: 'demo-1',
                        identifier: 'ENG-412',
                        title: 'Session drops the tray icon after resuming from suspend',
                        url: 'https://linear.app/demo/issue/ENG-412/tray-icon',
                        state: { name: 'In Progress', type: 'started', color: '#f2c94c' },
                    },
                    comment: {
                        id: 'demo-c1',
                        url: 'https://linear.app/demo/issue/ENG-412#comment-demo-c1',
                        // Contains markdown, so the rendered row shows the
                        // output of the markdown stripper.
                        body: '@[Sam Ellery](u-demo) does this reproduce on ' +
                            '**Wayland**? I can only trigger it on X11 with ' +
                            'two monitors attached.',
                    },
                },
                {
                    /*
                     * Reached through an initiative rather than a document.
                     * DocumentNotification carries only a documentId and no
                     * document object, so this shape can only come from
                     * InitiativeNotification or ProjectNotification.
                     */
                    __typename: 'InitiativeNotification',
                    id: 'demo-n2',
                    type: 'documentMention',
                    category: 'mentions',
                    createdAt: agoIso(3 * HOUR),
                    readAt: null,
                    actor: { name: 'Toni Okafor', displayName: 'toni' },
                    document: {
                        id: 'demo-d1',
                        title: 'Release checklist for 1.2',
                        url: 'https://linear.app/demo/document/release-checklist',
                    },
                    // Carries no comment object at all, so this row
                    // exercises the fallback path.
                },
                {
                    __typename: 'IssueNotification',
                    id: 'demo-n3',
                    type: 'issueMention',
                    category: 'mentions',
                    createdAt: agoIso(DAY + 2 * HOUR),
                    readAt: agoIso(20 * HOUR),
                    actor: { name: 'Mara Lindqvist', displayName: 'mara' },
                    issue: {
                        id: 'demo-3',
                        identifier: 'PLT-57',
                        title: 'Rotate the signing key before it expires',
                        url: 'https://linear.app/demo/issue/PLT-57/rotate-signing-key',
                        state: { name: 'Todo', type: 'unstarted', color: '#e2e2e2' },
                    },
                },
                {
                    __typename: 'IssueNotification',
                    id: 'demo-n4',
                    type: 'issueCommentMention',
                    category: 'mentions',
                    createdAt: agoIso(3 * DAY),
                    readAt: agoIso(2 * DAY),
                    actor: { name: 'Ade Balogun', displayName: 'ade' },
                    commentId: 'demo-c2',
                    issue: {
                        id: 'demo-4',
                        identifier: 'DES-19',
                        title: 'Icon set for workflow states',
                        url: 'https://linear.app/demo/issue/DES-19/workflow-icons',
                        state: { name: 'In Review', type: 'started', color: '#5e6ad2' },
                    },
                    comment: {
                        id: 'demo-c2',
                        url: 'https://linear.app/demo/issue/DES-19#comment-demo-c2',
                        body: 'Pushed the updated set to [the Figma file]' +
                            '(https://figma.com/demo) - let me know if the ' +
                            'triage colour still reads as amber to you.',
                    },
                },

                /*
                 * Everything below is a category the tab did not used to
                 * show at all. Between them they take the list past one
                 * page at the default size, which is what makes the pager
                 * appear at all.
                 */
                {
                    __typename: 'PullRequestNotification',
                    id: 'demo-n5',
                    type: 'pullRequestReviewRequested',
                    category: 'reviews',
                    createdAt: agoIso(42 * MINUTE),
                    readAt: null,
                    actor: { name: 'Grace Hopper', displayName: 'grace' },
                    pullRequest: {
                        id: 'demo-pr1',
                        title: 'Drop the notification type filter',
                        url: 'https://github.com/demo/linear-desklet/pull/41',
                        number: 41,
                    },
                },
                {
                    __typename: 'PullRequestNotification',
                    id: 'demo-n6',
                    type: 'pullRequestCommented',
                    category: 'reviews',
                    createdAt: agoIso(2 * HOUR),
                    readAt: null,
                    actor: { name: 'Grace Hopper', displayName: 'grace' },
                    pullRequestCommentId: '3b68a540-4594-46cf-867f-9b1fe7160e26',
                    pullRequest: {
                        id: 'demo-pr1',
                        title: 'Drop the notification type filter',
                        url: 'https://github.com/demo/linear-desklet/pull/41',
                        number: 41,
                    },
                },
                {
                    __typename: 'PullRequestNotification',
                    id: 'demo-n7',
                    type: 'pullRequestApproved',
                    category: 'reviews',
                    createdAt: agoIso(5 * HOUR),
                    readAt: agoIso(4 * HOUR),
                    actor: { name: 'Ade Balogun', displayName: 'ade' },
                    pullRequest: {
                        id: 'demo-pr2',
                        title: 'Paginate the activity list',
                        url: 'https://github.com/demo/linear-desklet/pull/40',
                        number: 40,
                    },
                },
                {
                    __typename: 'IssueNotification',
                    id: 'demo-n8',
                    type: 'issueNewComment',
                    category: 'commentsAndReplies',
                    createdAt: agoIso(6 * HOUR),
                    readAt: null,
                    actor: { name: 'Sam Ellery', displayName: 'sam' },
                    commentId: 'demo-c3',
                    issue: {
                        id: 'demo-1',
                        identifier: 'ENG-412',
                        title: 'Session drops the tray icon after resuming from suspend',
                        url: 'https://linear.app/demo/issue/ENG-412/tray-icon',
                        state: { name: 'In Progress', type: 'started', color: '#f2c94c' },
                    },
                    comment: {
                        id: 'demo-c3',
                        url: 'https://linear.app/demo/issue/ENG-412#comment-demo-c3',
                        body: 'Reproduced on Wayland with a single monitor, so it '
                            + 'is not the multi-head path after all.',
                    },
                },
                {
                    __typename: 'IssueNotification',
                    id: 'demo-n9',
                    type: 'issueAssignedToYou',
                    category: 'assignments',
                    createdAt: agoIso(9 * HOUR),
                    readAt: null,
                    actor: { name: 'Mara Lindqvist', displayName: 'mara' },
                    issue: {
                        id: 'demo-5',
                        identifier: 'OPS-88',
                        title: 'Renew the staging certificate',
                        url: 'https://linear.app/demo/issue/OPS-88/renew-staging-cert',
                        state: { name: 'Todo', type: 'unstarted', color: '#e2e2e2' },
                    },
                },
                {
                    __typename: 'IssueNotification',
                    id: 'demo-n10',
                    type: 'issueStatusChanged',
                    category: 'statusChanges',
                    createdAt: agoIso(14 * HOUR),
                    readAt: agoIso(13 * HOUR),
                    actor: { name: 'Toni Okafor', displayName: 'toni' },
                    issue: {
                        id: 'demo-4',
                        identifier: 'DES-19',
                        title: 'Icon set for workflow states',
                        url: 'https://linear.app/demo/issue/DES-19/workflow-icons',
                        state: { name: 'In Review', type: 'started', color: '#5e6ad2' },
                    },
                },
                {
                    __typename: 'IssueNotification',
                    id: 'demo-n11',
                    type: 'issueSubscribed',
                    category: 'subscriptions',
                    createdAt: agoIso(2 * DAY),
                    readAt: agoIso(2 * DAY),
                    actor: { name: 'Priya Raman', displayName: 'priya' },
                    issue: {
                        id: 'demo-3',
                        identifier: 'PLT-57',
                        title: 'Rotate the signing key before it expires',
                        url: 'https://linear.app/demo/issue/PLT-57/rotate-signing-key',
                        state: { name: 'Todo', type: 'unstarted', color: '#e2e2e2' },
                    },
                },
                {
                    __typename: 'PullRequestNotification',
                    id: 'demo-n12',
                    type: 'pullRequestCommentMention',
                    category: 'reviews',
                    createdAt: agoIso(4 * DAY),
                    readAt: agoIso(4 * DAY),
                    actor: { name: 'Sam Ellery', displayName: 'sam' },
                    pullRequestCommentId: 'be54fd6a-b643-411d-8eaa-215bee2098c8',
                    pullRequest: {
                        id: 'demo-pr3',
                        title: 'Cache the last good snapshot',
                        url: 'https://github.com/demo/linear-desklet/pull/38',
                        number: 38,
                    },
                },
                {
                    __typename: 'IssueNotification',
                    id: 'demo-n13',
                    type: 'issueNewComment',
                    category: 'commentsAndReplies',
                    createdAt: agoIso(5 * DAY),
                    readAt: agoIso(5 * DAY),
                    actor: { name: 'Ade Balogun', displayName: 'ade' },
                    commentId: 'demo-c4',
                    issue: {
                        id: 'demo-5',
                        identifier: 'OPS-88',
                        title: 'Renew the staging certificate',
                        url: 'https://linear.app/demo/issue/OPS-88/renew-staging-cert',
                        state: { name: 'Todo', type: 'unstarted', color: '#e2e2e2' },
                    },
                    comment: {
                        id: 'demo-c4',
                        url: 'https://linear.app/demo/issue/OPS-88#comment-demo-c4',
                        body: 'The old one expires on the 30th, so this wants '
                            + 'doing before the freeze.',
                    },
                },
                {
                    /*
                     * A category the desklet does not name, so it rides the
                     * "everything else" catch-all. Present to prove that an
                     * unrecognised kind still renders rather than vanishing.
                     */
                    __typename: 'ProjectNotification',
                    id: 'demo-n14',
                    type: 'projectUpdateCreated',
                    category: 'postsAndUpdates',
                    createdAt: agoIso(6 * DAY),
                    readAt: agoIso(6 * DAY),
                    actor: { name: 'Mara Lindqvist', displayName: 'mara' },
                    project: {
                        id: 'demo-p1',
                        name: 'Desklet 1.2',
                        url: 'https://linear.app/demo/project/desklet-12',
                    },
                },
            ],
        },
    };

    function enterDemo() {
        /*
         * The desklet decides whether to draw content or a setup prompt by
         * asking whether it has a credential. It has none here, so the
         * answer is shadowed for the duration.
         */
        Object.defineProperty(desklet, '_isConfigured', {
            get: function () { return true; },
            configurable: true,
        });

        // Otherwise the next tick finds no credential, clears everything,
        // and replaces the screenshot with a setup prompt.
        desklet._clearRefresh();

        desklet._digest(payload);
        desklet._lastSuccessMs = Date.now();
        desklet._usingCache = false;
        desklet._error = null;
        desklet._errorCode = null;
        desklet._connecting = false;
        desklet._connectMessage = '';
    }

    function leaveDemo() {
        delete desklet._isConfigured;

        desklet._issues = [];
        desklet._mentions = [];
        desklet._raw = null;
        desklet._viewer = null;
        desklet._lastSuccessMs = 0;
        desklet._usingCache = false;
        desklet._error = null;
        desklet._errorCode = null;
        desklet._activeTab = 'issues';
        desklet.group_by_team = false;

        desklet._scheduleRefresh();
    }

    let inDemo = Object.prototype.hasOwnProperty.call(desklet, '_isConfigured');

    switch (command) {
        case 'off':
            if (!inDemo)
                return 'not in demo mode';
            leaveDemo();
            desklet._render();
            return 'demo data cleared, refresh timer re-armed';

        case 'issues':
            if (!inDemo)
                enterDemo();
            desklet.group_by_team = false;
            desklet._activeTab = 'issues';
            break;

        case 'grouped':
            if (!inDemo)
                enterDemo();
            desklet.group_by_team = true;
            desklet._activeTab = 'issues';
            break;

        case 'mentions':
            if (!inDemo)
                enterDemo();
            desklet.group_by_team = false;
            desklet._activeTab = 'mentions';
            break;

        default:
            enterDemo();
            desklet.group_by_team = false;
            desklet._activeTab = 'issues';
            break;
    }

    desklet._render();

    return 'demo: ' + desklet._issues.length + ' issues, ' +
        desklet._mentions.length + ' mentions, tab=' + desklet._activeTab +
        ', grouped=' + desklet.group_by_team;
})();
