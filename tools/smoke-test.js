#!/usr/bin/env node
/*
 * Checks the desklet's GraphQL documents against the live Linear API.
 *
 * Several fields the queries depend on are marked internal in Linear's
 * schema and carry no compatibility promise, and the notification types
 * differ in which object-valued fields they expose. This reports a
 * mismatch as a failed check rather than leaving it to surface as an empty
 * desklet.
 *
 * The queries are read out of lib/linear.js rather than copied, so what is
 * tested is what ships.
 *
 *   LINEAR_API_KEY=lin_api_... node tools/smoke-test.js
 *
 * The key is never printed, and nothing is written to disk.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ENDPOINT = 'https://api.linear.app/graphql';
const SOURCE = path.join(__dirname, '..', 'linear@ashex', 'files', 'linear@ashex',
    'lib', 'linear.js');

const apiKey = (process.env.LINEAR_API_KEY || process.argv[2] || '').trim();

if (!apiKey) {
    console.error('No API key.\n');
    console.error('  LINEAR_API_KEY=lin_api_... node tools/smoke-test.js\n');
    console.error('Create one in Linear under Settings, Security and access,');
    console.error('Personal API keys.');
    process.exit(2);
}

/*
 * Loads the client module far enough to read its query text. Soup, Gio and
 * the rest are stubbed because none of them are touched at module scope;
 * only the string constants are wanted here.
 */
function loadQueries() {
    let source = fs.readFileSync(SOURCE, 'utf8');

    let sandbox = {
        imports: {
            byteArray: {},
            gi: {
                Gio: {},
                GLib: {},
                Soup: { MAJOR_VERSION: 3 },
            },
        },
        global: { logError: function () {}, logWarning: function () {} },
        // Cinnamon injects this; the client only uses it to reach i18n.
        require: function () {
            return { _: function (text) { return text; } };
        },
    };

    let context = vm.createContext(sandbox);
    vm.runInContext("'use strict';" + source, context, { filename: 'linear.js' });

    return {
        full: sandbox.QUERY_FULL,
        safe: sandbox.QUERY_SAFE,
        markRead: sandbox.MUTATION_MARK_READ,
    };
}

const MENTION_TYPES = [
    'issueMention',
    'issueCommentMention',
    'documentMention',
    'documentCommentMention',
];

async function post(query, variables) {
    let response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
            // Verbatim, with no "Bearer" prefix. Linear accepts the
            // prefixed form only for OAuth access tokens.
            'Authorization': apiKey,
            'Content-Type': 'application/json',
            'User-Agent': 'linear-desklet-smoke-test/1.0',
        },
        body: JSON.stringify({ query: query, variables: variables }),
    });

    let text = await response.text();
    let parsed = null;
    try {
        parsed = JSON.parse(text);
    } catch (e) {
        parsed = null;
    }

    return {
        status: response.status,
        headers: response.headers,
        body: parsed,
        raw: text,
    };
}

function heading(text) {
    console.log('\n' + text);
    console.log('-'.repeat(text.length));
}

function report(label, ok, detail) {
    console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + label +
        (detail ? '  (' + detail + ')' : ''));
    return ok;
}

let failures = 0;

function expect(label, ok, detail) {
    if (!report(label, ok, detail))
        failures++;
    return ok;
}

async function run() {
    const queries = loadQueries();

    if (!queries.full || !queries.safe || !queries.markRead) {
        console.error('Could not read the queries out of lib/linear.js.');
        process.exit(2);
    }

    const variables = { issues: 5, mentions: 10, types: MENTION_TYPES };

    // ------------------------------------------------------------------
    heading('Authentication and the full query');

    let result = await post(queries.full, variables);

    console.log('  HTTP ' + result.status);

    let limit = result.headers.get('x-ratelimit-requests-limit');
    let remaining = result.headers.get('x-ratelimit-requests-remaining');
    if (limit)
        console.log('  rate limit: ' + remaining + ' of ' + limit + ' requests remaining');

    if (result.status === 401 || result.status === 403) {
        console.error('\n  That key was refused. Check it has not been revoked.');
        process.exit(1);
    }
    if (result.status === 429) {
        console.error('\n  Rate limited. Wait and try again.');
        process.exit(1);
    }

    let usingFallback = false;

    if (result.body && result.body.errors && result.body.errors.length) {
        console.log('\n  The full query returned errors:');
        result.body.errors.forEach(function (error) {
            console.log('    - ' + error.message);
            if (error.extensions && error.extensions.code)
                console.log('      code: ' + error.extensions.code);
        });

        if (!result.body.data) {
            console.log('\n  Falling back to the reduced query, which is what the');
            console.log('  desklet itself would do.');
            usingFallback = true;
            result = await post(queries.safe, variables);

            if (result.body && result.body.errors) {
                console.log('\n  The reduced query also failed:');
                result.body.errors.forEach(function (error) {
                    console.log('    - ' + error.message);
                });
            }
            expect('the reduced query works', !!(result.body && result.body.data));
        }
    } else {
        expect('the full query validates against the live schema', result.status === 200);
    }

    let data = result.body && result.body.data;
    if (!data) {
        console.error('\n  No data came back. Nothing further can be checked.');
        process.exit(1);
    }

    // ------------------------------------------------------------------
    heading('Viewer');

    expect('viewer resolves', !!data.viewer);
    if (data.viewer) {
        // The name is the one piece of identity worth confirming out loud:
        // it proves the key belongs to the account the user expects.
        console.log('  authenticated as: ' + (data.viewer.name || data.viewer.displayName));
    }

    // ------------------------------------------------------------------
    heading('Issues assigned to you');

    let issues = (data.issues && data.issues.nodes) || [];
    expect('the issues connection resolves', !!data.issues);
    console.log('  returned ' + issues.length + ' issue(s)');

    if (issues.length) {
        let issue = issues[0];
        expect('identifier is present', !!issue.identifier, issue.identifier);
        expect('title is present', !!issue.title);
        expect('url is present', /^https:\/\//.test(issue.url || ''));
        expect('state resolves', !!(issue.state && issue.state.type),
            issue.state ? issue.state.type : '');
        expect('team resolves', !!(issue.team && issue.team.name));

        if (!usingFallback) {
            expect('priorityLabel resolves', typeof issue.priorityLabel === 'string',
                issue.priorityLabel);
        }

        let dated = issues.filter(function (node) { return node.dueDate; });
        if (dated.length) {
            expect('dueDate is a plain calendar date',
                /^\d{4}-\d{2}-\d{2}$/.test(dated[0].dueDate), dated[0].dueDate);
        } else {
            console.log('  note  none of these issues has a due date, so the');
            console.log('        TimelessDate format could not be confirmed');
        }

        let states = new Set(issues.map(function (node) {
            return node.state && node.state.type;
        }));
        expect('completed and cancelled issues are filtered out',
            !states.has('completed') && !states.has('canceled'),
            Array.from(states).join(', '));
    } else {
        console.log('  note  nothing is assigned to you, so the issue fields');
        console.log('        could not be confirmed');
    }

    // ------------------------------------------------------------------
    heading('Mentions');

    let mentions = (data.notifications && data.notifications.nodes) || [];
    expect('the notifications connection resolves', !!data.notifications);
    console.log('  returned ' + mentions.length + ' mention(s)');

    if (mentions.length) {
        let mention = mentions[0];
        expect('__typename is present', !!mention.__typename, mention.__typename);
        expect('type is present', !!mention.type, mention.type);
        expect('readAt is present or explicitly null', 'readAt' in mention,
            mention.readAt ? 'read' : 'unread');

        let types = new Set(mentions.map(function (node) { return node.type; }));
        expect('only mention types came back',
            Array.from(types).every(function (type) {
                return MENTION_TYPES.indexOf(type) !== -1;
            }), Array.from(types).join(', '));

        /*
         * The fields this whole script exists for. Their absence is not a
         * failure - the desklet composes replacements - but it is the thing
         * worth knowing about.
         */
        if (!usingFallback) {
            let hasInternals = mentions.some(function (node) {
                return node.title && node.url;
            });
            if (hasInternals) {
                report('Linear\'s internal title and url fields still resolve', true);
            } else {
                console.log('  note  the internal title/url fields came back empty;');
                console.log('        the desklet will compose its own text');
            }
        }

        let reachable = mentions.filter(function (node) {
            let fromIssue = node.issue && node.issue.url;
            let fromDocument = node.document && node.document.url;
            let fromComment = node.comment && node.comment.url;
            return node.url || fromComment || fromIssue || fromDocument;
        });
        expect('every mention has somewhere to link to',
            reachable.length === mentions.length,
            reachable.length + ' of ' + mentions.length);
    } else {
        console.log('  note  no mentions in your inbox, so the notification');
        console.log('        fields could not be confirmed');
    }

    // ------------------------------------------------------------------
    heading('Schema check');

    /*
     * Verifies every field the notification fragments request against the
     * live schema.
     *
     * A fragment asking for a field its type does not expose makes the
     * whole query fail with HTTP 400 on every refresh. Introspection
     * catches that regardless of what is in the inbox, whereas the data
     * checks above are skipped when there is nothing to inspect.
     */
    let introspection = await post(
        'query {' +
        '  issueNotification: __type(name: "IssueNotification") { fields { name } }' +
        '  documentNotification: __type(name: "DocumentNotification") { fields { name } }' +
        '  projectNotification: __type(name: "ProjectNotification") { fields { name } }' +
        '  comment: __type(name: "Comment") { fields { name } }' +
        '}', {});

    let types = introspection.body && introspection.body.data;

    if (!types) {
        console.log('  note  introspection unavailable, so the fragments could');
        console.log('        not be checked against the schema');
    } else {
        // What each fragment asks for, kept beside the query it mirrors.
        let expectations = [
            ['IssueNotification', types.issueNotification,
                ['commentId', 'issue', 'comment']],
            ['DocumentNotification', types.documentNotification,
                ['commentId', 'documentId']],
            ['ProjectNotification', types.projectNotification,
                ['commentId', 'project', 'comment']],
        ];

        // Asked for on every notification, whatever its concrete type.
        let interfaceFields = ['id', 'type', 'createdAt', 'updatedAt', 'readAt',
            'url', 'title', 'subtitle', 'actor'];

        expectations.forEach(function (entry) {
            let name = entry[0];
            let type = entry[1];
            let wanted = entry[2];

            if (!type || !type.fields) {
                expect(name + ' exists in the schema', false);
                return;
            }

            let available = new Set(type.fields.map(function (f) { return f.name; }));
            let missing = wanted.concat(interfaceFields).filter(function (field) {
                return !available.has(field);
            });

            expect(name + ' has every field the query asks for',
                missing.length === 0,
                missing.length ? 'missing: ' + missing.join(', ') : 'all present');
        });

        /*
         * DocumentNotification exposes documentId and commentId but no
         * document or comment object, unlike the other notification types.
         * The query relies on that, so a change here is worth reporting.
         */
        let documentFields = types.documentNotification
            ? new Set(types.documentNotification.fields.map(function (f) { return f.name; }))
            : new Set();
        if (documentFields.size) {
            expect('DocumentNotification still has no document object, as assumed',
                !documentFields.has('document'),
                documentFields.has('document')
                    ? 'it now does; the query could use it'
                    : 'confirmed');
        }
    }

    // ------------------------------------------------------------------
    heading('Mark-read mutation');

    /*
     * Validated without altering anything, by sending an id that cannot
     * exist. A schema change names the offending field in the error, while
     * an unknown id produces a lookup failure, so the two are
     * distinguishable and only the former is a problem.
     */
    let mutation = await post(queries.markRead, {
        id: 'this-id-does-not-exist',
        readAt: new Date().toISOString(),
    });

    let mutationErrors = (mutation.body && mutation.body.errors) || [];
    let schemaComplaint = mutationErrors.some(function (error) {
        let message = String(error.message || '').toLowerCase();
        return message.indexOf('cannot query') !== -1 ||
            message.indexOf('unknown argument') !== -1 ||
            message.indexOf('unknown type') !== -1 ||
            message.indexOf('did you mean') !== -1;
    });

    expect('notificationUpdate still has the shape the desklet expects',
        !schemaComplaint,
        mutationErrors.length ? mutationErrors[0].message : 'accepted');

    // ------------------------------------------------------------------
    heading('Result');

    if (failures) {
        console.log('  ' + failures + ' check(s) failed.');
        process.exit(1);
    }

    console.log('  Everything the desklet depends on is working.');
    if (usingFallback) {
        console.log('  Note: the full query no longer validates, so the desklet');
        console.log('  will run on its reduced query and compose its own wording.');
    }
}

run().catch(function (error) {
    console.error('\nThe smoke test could not complete: ' + error.message);
    process.exit(2);
});
