/*
 * linear.js - the Linear GraphQL client.
 *
 * One request per refresh: the viewer, the assigned issues and the
 * mentions all arrive in a single document. A personal API key is allowed
 * 1500 requests an hour, and asking three times per tick would spend that
 * budget three times as fast for no benefit.
 *
 * Authentication is the personal API key passed verbatim in the
 * Authorization header, with no "Bearer" prefix. Linear accepts the
 * prefixed form only for OAuth access tokens, and sending it here fails
 * with an authentication error that looks exactly like a bad key.
 */

const ByteArray = imports.byteArray;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Soup = imports.gi.Soup;

// Relative to the desklet directory, not to this file.
const _ = require('./lib/i18n')._;

var ENDPOINT = 'https://api.linear.app/graphql';

// Linear caps a single page at 250. Nothing here needs to come close.
const MAX_PAGE = 100;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/*
 * The full snapshot query: the viewer, the assigned issues and the
 * mentions in a single document.
 *
 * The notification url, title and subtitle fields are marked internal in
 * Linear's schema. They are what the Linear inbox renders from, and may be
 * withdrawn without a deprecation cycle; QUERY_SAFE is the fallback that
 * asks for none of them.
 *
 * The per-type fragments are asymmetric because the schema is:
 *
 *   IssueNotification     issue, comment, parentComment, team
 *   ProjectNotification   project, document, projectUpdate, comment
 *   DocumentNotification  documentId and commentId only
 *
 * A document mention therefore has no title or link of its own and relies
 * on the internal fields. Under QUERY_SAFE there is no documented way to
 * link one, so those rows are discarded rather than shown as dead links.
 */
var QUERY_FULL =
    'query DeskletSnapshot($issues: Int!, $mentions: Int!, $types: [String!]!) {' +
    '  viewer { id name displayName organization { id name urlKey } }' +
    '  issues(' +
    '    first: $issues' +
    '    filter: {' +
    '      assignee: { isMe: { eq: true } }' +
    '      state: { type: { nin: ["completed", "canceled"] } }' +
    '    }' +
    '    sort: [' +
    '      { priority: { order: Ascending, nulls: last } }' +
    '      { dueDate: { order: Ascending, nulls: last } }' +
    '      { updatedAt: { order: Descending } }' +
    '    ]' +
    '  ) {' +
    '    nodes {' +
    '      id identifier title priority priorityLabel dueDate url updatedAt' +
    '      state { name type color }' +
    '      team { key name }' +
    '      project { name }' +
    '    }' +
    '  }' +
    '  notifications(first: $mentions, orderBy: updatedAt, filter: { type: { in: $types } }) {' +
    '    nodes {' +
    '      __typename' +
    '      id type createdAt updatedAt readAt url title subtitle' +
    '      actor { name displayName }' +
    '      ... on IssueNotification {' +
    '        commentId' +
    '        issue { id identifier title url state { name type color } }' +
    '        comment { id url body }' +
    '      }' +
    '      ... on DocumentNotification {' +
    '        commentId' +
    '        documentId' +
    '      }' +
    '      ... on ProjectNotification {' +
    '        commentId' +
    '        project { id name url }' +
    '        comment { id url body }' +
    '      }' +
    '    }' +
    '  }' +
    '}';

/*
 * The same snapshot built only from fields Linear documents publicly, and
 * without the rich sort argument. Everything dropped here has a composed
 * fallback in model.js, so the desklet degrades in wording rather than in
 * function.
 */
var QUERY_SAFE =
    'query DeskletSnapshotSafe($issues: Int!, $mentions: Int!, $types: [String!]!) {' +
    '  viewer { id name displayName organization { id name urlKey } }' +
    '  issues(' +
    '    first: $issues' +
    '    orderBy: updatedAt' +
    '    filter: {' +
    '      assignee: { isMe: { eq: true } }' +
    '      state: { type: { nin: ["completed", "canceled"] } }' +
    '    }' +
    '  ) {' +
    '    nodes {' +
    '      id identifier title priority dueDate url updatedAt' +
    '      state { name type color }' +
    '      team { key name }' +
    '      project { name }' +
    '    }' +
    '  }' +
    '  notifications(first: $mentions, orderBy: updatedAt, filter: { type: { in: $types } }) {' +
    '    nodes {' +
    '      __typename' +
    '      id type createdAt updatedAt readAt' +
    '      actor { name displayName }' +
    '      ... on IssueNotification {' +
    '        commentId' +
    '        issue { id identifier title url state { name type color } }' +
    '        comment { id url body }' +
    '      }' +
    '      ... on DocumentNotification {' +
    '        commentId' +
    '        documentId' +
    '      }' +
    '      ... on ProjectNotification {' +
    '        commentId' +
    '        project { id name url }' +
    '        comment { id url body }' +
    '      }' +
    '    }' +
    '  }' +
    '}';

var MUTATION_MARK_READ =
    'mutation MarkNotificationRead($id: String!, $readAt: DateTime!) {' +
    '  notificationUpdate(id: $id, input: { readAt: $readAt }) {' +
    '    success' +
    '  }' +
    '}';

var _session = null;

function session() {
    if (_session)
        return _session;

    /*
     * Cinnamon 5.6 and later ship libsoup 3, where the session and message
     * APIs both changed shape. The 2.4 branch is kept for older Mint
     * releases; MAJOR_VERSION is undefined on the oldest typelibs, which
     * are 2.4 by definition.
     */
    if (Soup.MAJOR_VERSION === undefined || Soup.MAJOR_VERSION === 2) {
        _session = new Soup.SessionAsync();
        Soup.Session.prototype.add_feature.call(_session, new Soup.ProxyResolverDefault());
    } else {
        _session = new Soup.Session();
    }
    _session.user_agent = 'linear-desklet/1.0';
    return _session;
}

function isSoup2() {
    return Soup.MAJOR_VERSION === undefined || Soup.MAJOR_VERSION === 2;
}

function describeStatus(status) {
    switch (status) {
        // Soup reports zero when the request never reached a server at all.
        case 0: return _('Linear is unreachable');
        case 400: return _('Linear rejected the request');
        case 401:
        case 403: return _('That API key was refused');
        case 408: return _('Linear timed out');
        case 429: return _('Rate limited by Linear');
        default:
            if (status >= 500)
                return _('Linear is having trouble (HTTP %d)').format(status);
            if (status >= 400)
                return _('Linear rejected the request (HTTP %d)').format(status);
            return _('Unexpected reply from Linear (HTTP %d)').format(status);
    }
}

function headerValue(message, name) {
    try {
        let headers = isSoup2() ? message.response_headers : message.get_response_headers();
        return headers ? headers.get_one(name) : null;
    } catch (e) {
        return null;
    }
}

/*
 * How long to wait before trying again after a rate limit. Linear's docs
 * describe the reset header as UTC milliseconds, but implementations in
 * the wild treat it as seconds, so the magnitude decides: anything that
 * would land before 2001 as milliseconds is obviously a seconds value.
 */
function retryDelayFrom(message) {
    let raw = headerValue(message, 'X-RateLimit-Requests-Reset');
    let reset = Number(raw);
    if (!raw || isNaN(reset) || reset <= 0)
        return 0;

    let resetMs = reset > 1e12 ? reset : reset * 1000;
    let delay = resetMs - Date.now();
    if (delay <= 0)
        return 0;

    // An hour is the longest a leaky bucket of this size can need.
    return Math.min(delay, 3600000);
}

/*
 * Classifies a GraphQL error well enough to decide what to do about it.
 * An authentication failure wants the user's attention, a rate limit wants
 * patience, and a validation failure means the query itself no longer
 * matches the schema and the reduced form should be tried instead.
 */
function classifyErrors(errors) {
    let messages = [];
    let code = 'GRAPHQL';

    errors.forEach(function (error) {
        if (!error)
            return;
        if (error.message)
            messages.push(String(error.message));

        let extensions = error.extensions || {};
        let raw = String(extensions.code || extensions.type || '').toUpperCase();

        if (raw.indexOf('AUTHENTICATION') !== -1 || raw.indexOf('FORBIDDEN') !== -1)
            code = 'AUTH';
        else if (raw.indexOf('RATELIMIT') !== -1)
            code = 'RATELIMITED';
        else if (raw.indexOf('GRAPHQL_VALIDATION') !== -1 || raw.indexOf('BAD_USER_INPUT') !== -1)
            code = 'VALIDATION';
    });

    let joined = messages.join('; ');

    // Not every deployment sets an extensions code, so fall back to the
    // wording. Checked only when nothing better was found.
    if (code === 'GRAPHQL' && joined) {
        let lower = joined.toLowerCase();
        if (lower.indexOf('authenticat') !== -1)
            code = 'AUTH';
        else if (lower.indexOf('rate limit') !== -1)
            code = 'RATELIMITED';
        else if (lower.indexOf('cannot query') !== -1 ||
                 lower.indexOf('unknown argument') !== -1 ||
                 lower.indexOf('unknown type') !== -1 ||
                 lower.indexOf('did you mean') !== -1)
            code = 'VALIDATION';
    }

    return { code: code, message: joined };
}

/*
 * Lets the HTTP status sharpen a body classification without weakening
 * it. Linear can attach a parseable errors array to a 429 or 401 whose
 * wording matches no keyword, and the status is then the only reliable
 * signal: 429 is a rate limit whatever the body says, and a 401 that
 * classified as nothing more specific is an authentication failure. A
 * stronger body classification is never downgraded to a weaker one.
 */
function mergeStatusIntoCode(code, status) {
    if (status === 429)
        return 'RATELIMITED';
    if (status === 401 && code === 'GRAPHQL')
        return 'AUTH';
    return code;
}

function post(authorization, query, variables, timeoutSeconds, cancellable, onDone) {
    let http = session();
    http.timeout = timeoutSeconds;
    http.idle_timeout = timeoutSeconds;

    let payload = JSON.stringify({ query: query, variables: variables });

    let message;
    try {
        message = Soup.Message.new('POST', ENDPOINT);
    } catch (e) {
        message = null;
    }
    if (!message) {
        onDone({ ok: false, code: 'INTERNAL', error: _('Could not build the request') });
        return;
    }

    function finish(body, status) {
        /*
         * The body is parsed before the status is consulted.
         *
         * GraphQL reports a malformed or outdated query as HTTP 400 with
         * the reason in the body, so a non-200 status alone does not mean
         * the request failed in transport. Reading the body first is what
         * lets a schema mismatch be classified as VALIDATION, which is the
         * code that triggers the fallback to the reduced query.
         */
        let parsed = null;
        if (body) {
            try {
                parsed = JSON.parse(body);
            } catch (e) {
                parsed = null;
            }
        }

        if (parsed && parsed.errors && parsed.errors.length) {
            let classified = classifyErrors(parsed.errors);
            let code = mergeStatusIntoCode(classified.code, status);
            onDone({
                // Partial success is possible: errors alongside usable data,
                // which is still worth rendering.
                ok: !!parsed.data,
                data: parsed.data || null,
                code: code,
                error: classified.message || describeStatus(status),
                retryAfterMs: code === 'RATELIMITED'
                    ? retryDelayFrom(message) : 0,
            });
            return;
        }

        if (status !== 200) {
            /*
             * No usable body, so this really is a transport-level failure.
             * 401 is reported separately because it is the one an OAuth
             * caller can act on: the access token has lapsed, and a refresh
             * is worth trying before telling the user anything is wrong.
             */
            let code = 'HTTP';
            if (status === 429)
                code = 'RATELIMITED';
            else if (status === 401)
                code = 'AUTH';

            onDone({
                ok: false,
                code: code,
                error: describeStatus(status),
                retryAfterMs: status === 429 ? retryDelayFrom(message) : 0,
            });
            return;
        }

        if (!parsed) {
            onDone({ ok: false, code: 'PARSE', error: _('Linear sent a reply we could not read') });
            return;
        }

        if (!parsed.data) {
            onDone({ ok: false, code: 'EMPTY', error: _('Linear sent an empty reply') });
            return;
        }

        onDone({ ok: true, data: parsed.data, code: null, error: null });
    }

    if (isSoup2()) {
        message.request_headers.append('Authorization', authorization);
        message.request_headers.append('Content-Type', 'application/json');
        message.set_request('application/json', Soup.MemoryUse.COPY, payload);

        http.queue_message(message, function (httpSession, response) {
            if (cancellable && cancellable.is_cancelled())
                return;
            let raw = response.response_body ? response.response_body.data : null;
            finish(raw ? raw.toString() : '', response.status_code);
        });
        return;
    }

    message.get_request_headers().append('Authorization', authorization);
    message.set_request_body_from_bytes('application/json',
        new GLib.Bytes(ByteArray.fromString(payload)));

    http.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable,
        function (httpSession, result) {
            if (cancellable && cancellable.is_cancelled())
                return;

            /*
             * The try covers only the transport: finishing the read and
             * decoding the bytes. finish() runs the caller's callback,
             * and an exception thrown in there must propagate rather than
             * be reported to the user as a second, spurious network
             * failure.
             */
            let status = message.get_status();
            let body = '';
            let oversized = false;
            try {
                let bytes = httpSession.send_and_read_finish(result);
                let data = bytes ? bytes.get_data() : null;
                if (data && data.length > MAX_BODY_BYTES) {
                    oversized = true;
                } else if (data && data.length) {
                    body = ByteArray.toString(data);
                } else if (status === 200) {
                    // An empty 200 carries nothing to parse; status zero
                    // reports it as Linear being unreachable.
                    status = 0;
                }
            } catch (e) {
                onDone({
                    ok: false,
                    code: 'NETWORK',
                    error: e.message ? String(e.message) : _('Linear is unreachable'),
                });
                return;
            }

            if (oversized) {
                onDone({ ok: false, code: 'HTTP', error: _('Linear sent too much data') });
                return;
            }
            finish(body, status);
        });
}

/*
 * Builds the Authorization header value for a credential.
 *
 * A personal API key is sent verbatim; an OAuth access token takes the
 * "Bearer" prefix. Linear accepts the prefixed form only for OAuth tokens,
 * and rejects a mismatch as an authentication failure.
 */
function authorizationFor(options) {
    if (options.accessToken) {
        let token = String(options.accessToken).trim();
        if (token)
            return 'Bearer ' + token;
    }

    let apiKey = String(options.apiKey || '').trim();
    return apiKey || '';
}

/*
 * Fetches a snapshot, falling back to the reduced query if the full one no
 * longer validates against the schema. The fallback is attempted once and
 * only for a validation failure: retrying an authentication error or a
 * rate limit would just spend another request to be told the same thing.
 */
function fetchSnapshot(options, onDone) {
    let authorization = authorizationFor(options);
    if (!authorization) {
        onDone({ ok: false, code: 'NOKEY', error: _('Not connected to Linear') });
        return;
    }

    let variables = {
        issues: Math.max(1, Math.min(MAX_PAGE, options.maxIssues || 10)),
        mentions: Math.max(1, Math.min(MAX_PAGE, options.maxMentions || 30)),
        types: options.mentionTypes || [],
    };

    let timeout = Math.max(5, options.timeout || 15);
    let cancellable = options.cancellable || null;

    post(authorization, QUERY_FULL, variables, timeout, cancellable, function (result) {
        if (result.code !== 'VALIDATION') {
            onDone(result);
            return;
        }

        global.logWarning('linear@ashex: the full query no longer validates, ' +
            'retrying without Linear\'s internal fields');

        post(authorization, QUERY_SAFE, variables, timeout, cancellable, function (fallback) {
            onDone(fallback);
        });
    });
}

/*
 * Marks one notification read, which is what opening it in Linear itself
 * would do. Fire and forget: the row has already been updated locally, so
 * a failure here costs nothing but a log line and corrects itself on the
 * next refresh.
 */
function markNotificationRead(options, notificationId, onDone) {
    let authorization = authorizationFor(options);
    if (!authorization || !notificationId) {
        onDone({ ok: false, code: 'NOKEY', error: _('Not connected to Linear') });
        return;
    }

    post(authorization, MUTATION_MARK_READ, {
        id: notificationId,
        readAt: new Date().toISOString(),
    }, Math.max(5, options.timeout || 15), options.cancellable || null, function (result) {
        if (!result.ok) {
            onDone(result);
            return;
        }
        let update = result.data && result.data.notificationUpdate;
        onDone({
            ok: !!(update && update.success),
            code: update && update.success ? null : 'REFUSED',
            error: update && update.success ? null : _('Linear did not accept the change'),
        });
    });
}

// ----------------------------------------------------------------------
// Cache
// ----------------------------------------------------------------------

/*
 * The last good snapshot, so the desklet has content the moment it appears
 * and keeps it through a dropped network rather than claiming there is no
 * work assigned. Written under the user's cache directory: the install
 * directory is wiped on update and is not ours to write to.
 */
function cacheDirectory() {
    return GLib.build_filenamev([GLib.get_user_cache_dir(), 'linear@ashex']);
}

function cachePath(name) {
    let safe = String(name || 'default').replace(/[^A-Za-z0-9_-]/g, '_');
    return GLib.build_filenamev([cacheDirectory(), 'snapshot-' + safe + '.json']);
}

function readCache(name, onDone) {
    let file = Gio.File.new_for_path(cachePath(name));

    file.load_contents_async(null, function (source, result) {
        let data = null;
        try {
            let [ok, contents] = source.load_contents_finish(result);
            if (ok)
                data = JSON.parse(ByteArray.toString(contents));
        } catch (e) {
            // A missing cache file is the normal case on first run.
            data = null;
        }
        onDone(data);
    });
}

function writeCache(name, data) {
    let file = Gio.File.new_for_path(cachePath(name));
    let body;
    try {
        body = JSON.stringify(data);
    } catch (e) {
        return;
    }

    /*
     * PRIVATE keeps the file readable only by its owner. A cached snapshot
     * holds issue titles and the text of comments naming the user, which
     * is nobody else's business on a shared machine.
     */
    let flags = Gio.FileCreateFlags.REPLACE_DESTINATION | Gio.FileCreateFlags.PRIVATE;

    function write() {
        file.replace_contents_bytes_async(
            GLib.Bytes.new(ByteArray.fromString(body)),
            null, false, flags, null,
            function (source, result) {
                try {
                    source.replace_contents_finish(result);
                } catch (e) {
                    global.logWarning('linear@ashex: could not cache the snapshot: ' + e);
                }
            });
    }

    let directory = Gio.File.new_for_path(cacheDirectory());
    directory.make_directory_async(GLib.PRIORITY_DEFAULT, null, function (source, result) {
        try {
            source.make_directory_finish(result);
        } catch (e) {
            // Already there is the usual outcome, and is not an error.
        }
        write();
    });
}
