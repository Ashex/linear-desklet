/*
 * oauth.js - the OAuth 2.0 authorization code flow with PKCE.
 *
 * The alternative to a personal API key, whose creation a workspace admin
 * can disable for members under Settings, Administration, API. That
 * setting does not apply to OAuth.
 *
 * The flow, in full:
 *
 *   1. Generate a random verifier, its S256 challenge, and a random state.
 *   2. Bind a one-shot HTTP listener on the loopback interface.
 *   3. Open Linear's consent page in the browser.
 *   4. Linear redirects back to the listener with a code.
 *   5. Exchange the code, with the verifier, for tokens.
 *
 * PKCE removes the need for a client secret, so the client id below can be
 * published with the source. It also binds the authorization code to this
 * process: a code intercepted on the loopback interface cannot be
 * exchanged without the verifier, which is never transmitted.
 *
 * The listener binds 127.0.0.1 explicitly rather than using
 * add_inet_port(), which binds the wildcard address and would expose the
 * callback to the local network for as long as the flow is open.
 */

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;

// Relative to the desklet directory, not to this file.
const _ = require('./lib/i18n')._;

var AUTHORIZE_URL = 'https://linear.app/oauth/authorize';
var TOKEN_URL = 'https://api.linear.app/oauth/token';
var REVOKE_URL = 'https://api.linear.app/oauth/revoke';

/*
 * The desklet's own OAuth application.
 *
 * Public by design: under PKCE there is no client secret, and the client id
 * identifies the application rather than authenticating it. Anyone
 * preferring their own application can override this in the settings.
 */
var DEFAULT_CLIENT_ID = '8829d394481b67b823c233f5b7b68954';

/*
 * The callback ports registered on that application.
 *
 * Linear matches redirect URIs exactly and does not implement RFC 8252's
 * rule allowing any port on a loopback address, so every port the desklet
 * might use has to be registered up front. Hence a fixed list rather than
 * an ephemeral port: the desklet tries each in turn and uses the first that
 * binds, which resolves a conflict without the user noticing one happened.
 *
 * All five sit above 61000, clear of the Linux default ephemeral range
 * (net.ipv4.ip_local_port_range, usually 32768-60999), so they cannot
 * collide with a transient outbound connection. Known assignments in the
 * range, such as 62078 (lockdownd) and 64738 (Mumble), are avoided.
 */
var CALLBACK_PORTS = [61823, 62445, 63177, 64231, 65021];

var CALLBACK_PATH = '/callback';

// Long enough to find the browser window, log in and read the consent
// screen; short enough that a forgotten flow does not hold a port all day.
var FLOW_TIMEOUT_SECONDS = 300;

// A request line carrying a code and state is a few hundred bytes. Anything
// beyond this is not our callback.
var MAX_REQUEST_LINE = 8192;

function redirectUriFor(port) {
    return 'http://127.0.0.1:' + port + CALLBACK_PATH;
}

/*
 * Cryptographically secure random bytes.
 *
 * GLib's random_int_range is a Mersenne Twister: fine for jitter, not for a
 * value whose whole job is to be unguessable. The state parameter defends
 * against a forged callback and the PKCE verifier against a stolen code, so
 * both need a real entropy source.
 */
function randomBytes(count) {
    let file = Gio.File.new_for_path('/dev/urandom');
    let stream = null;
    try {
        stream = file.read(null);
        let bytes = stream.read_bytes(count, null);
        let data = bytes.get_data();
        if (!data || data.length < count)
            throw new Error('short read from /dev/urandom');
        return data;
    } finally {
        if (stream) {
            try { stream.close(null); } catch (e) {}
        }
    }
}

// base64url per RFC 4648 section 5: the URL-safe alphabet, no padding.
function base64url(bytes) {
    return GLib.base64_encode(bytes)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

function randomToken(byteCount) {
    return base64url(randomBytes(byteCount || 32));
}

/*
 * The S256 challenge: base64url of the SHA-256 digest of the verifier.
 *
 * GLib only hands back a hex string, so the digest has to be unpacked into
 * bytes before encoding. Encoding the hex string itself would produce a
 * challenge twice the right length that Linear would reject.
 *
 * Verified against the RFC 7636 appendix B test vector.
 */
function challengeFor(verifier) {
    let hex = GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256,
        new GLib.Bytes(verifier));

    let digest = [];
    for (let i = 0; i < hex.length; i += 2)
        digest.push(parseInt(hex.substr(i, 2), 16));

    return base64url(digest);
}

function encodeQuery(params) {
    let parts = [];
    Object.keys(params).forEach(function (key) {
        if (params[key] === null || params[key] === undefined)
            return;
        parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(params[key])));
    });
    return parts.join('&');
}

/*
 * Pulls the query parameters out of an HTTP request line, which arrives as
 * "GET /callback?code=...&state=... HTTP/1.1".
 */
function parseRequestLine(line) {
    let match = /^GET\s+(\S+)\s+HTTP\/[\d.]+\s*$/i.exec(String(line || '').trim());
    if (!match)
        return null;

    let target = match[1];
    let separator = target.indexOf('?');
    let path = separator === -1 ? target : target.substring(0, separator);
    let query = separator === -1 ? '' : target.substring(separator + 1);

    let params = Object.create(null);
    query.split('&').forEach(function (pair) {
        if (!pair)
            return;
        let equals = pair.indexOf('=');
        let key = equals === -1 ? pair : pair.substring(0, equals);
        let value = equals === -1 ? '' : pair.substring(equals + 1);
        try {
            params[decodeURIComponent(key.replace(/\+/g, ' '))] =
                decodeURIComponent(value.replace(/\+/g, ' '));
        } catch (e) {
            // A malformed escape is not our callback; ignore the parameter
            // rather than failing the whole request.
        }
    });

    return { path: path, params: params };
}

/*
 * The page the browser lands on when the flow finishes.
 *
 * Self-contained: no network references, because at this point the browser
 * is pointed at a socket that is about to close. Deliberately plain, so it
 * reads as a system message rather than something asking to be trusted.
 */
function resultPage(title, message) {
    return '<!DOCTYPE html>\n<html lang="en">\n<head>\n' +
        '<meta charset="utf-8">\n' +
        '<title>' + title + '</title>\n' +
        '<style>\n' +
        'body{background:#12121a;color:rgba(255,255,255,.96);' +
        'font-family:system-ui,-apple-system,"Segoe UI",Ubuntu,sans-serif;' +
        'display:flex;align-items:center;justify-content:center;' +
        'height:100vh;margin:0}\n' +
        '.card{background:rgba(255,255,255,.055);border:1px solid rgba(255,255,255,.1);' +
        'border-radius:14px;padding:32px 40px;max-width:32em;text-align:center;' +
        'box-shadow:0 10px 28px rgba(0,0,0,.55)}\n' +
        'h1{font-size:1.25rem;margin:0 0 .5em}\n' +
        'p{color:rgba(255,255,255,.62);margin:0;line-height:1.5}\n' +
        '</style>\n</head>\n<body>\n<div class="card">\n' +
        '<h1>' + title + '</h1>\n<p>' + message + '</p>\n' +
        '</div>\n</body>\n</html>\n';
}

function httpResponse(status, body) {
    // Byte length, not character length: the page is ASCII today, but a
    // translated message need not be, and a wrong Content-Length truncates.
    let bytes = GLib.Bytes.new(imports.byteArray.fromString(body));
    return 'HTTP/1.1 ' + status + '\r\n' +
        'Content-Type: text/html; charset=utf-8\r\n' +
        'Content-Length: ' + bytes.get_size() + '\r\n' +
        'Cache-Control: no-store\r\n' +
        'Connection: close\r\n' +
        '\r\n' + body;
}

/*
 * A single-use HTTP listener on the loopback interface.
 *
 * Tries the registered ports in order and keeps the first that binds. Calls
 * back exactly once, with either the callback parameters or an error, and
 * stops listening the moment it does.
 */
var CallbackListener = class CallbackListener {
    constructor() {
        this._service = null;
        this._port = 0;
        this._onDone = null;
        this._finished = false;
    }

    get port() {
        return this._port;
    }

    /*
     * Binds and starts listening. Returns the port in use, or throws if
     * every registered port is taken.
     *
     * A preferred port is tried first and the rest kept as fallbacks, so
     * choosing one in the settings pins it without making a conflict fatal.
     */
    listen(onDone, preferredPort) {
        this._onDone = onDone;

        let ports = CALLBACK_PORTS.slice();
        let preferred = Number(preferredPort);
        if (preferred && ports.indexOf(preferred) !== -1) {
            ports = [preferred].concat(ports.filter(function (port) {
                return port !== preferred;
            }));
        }

        let lastError = null;

        for (let i = 0; i < ports.length; i++) {
            let port = ports[i];
            let service = new Gio.SocketService();

            try {
                let address = new Gio.InetSocketAddress({
                    // Explicitly loopback. add_inet_port() would bind the
                    // wildcard address and expose this to the local network.
                    address: Gio.InetAddress.new_loopback(Gio.SocketFamily.IPV4),
                    port: port,
                });
                service.add_address(address, Gio.SocketType.STREAM,
                    Gio.SocketProtocol.TCP, null);
            } catch (e) {
                lastError = e;
                try { service.close(); } catch (x) {}
                continue;
            }

            service.connect('incoming', (svc, connection) => {
                this._onIncoming(connection);
                return true;
            });
            service.start();

            this._service = service;
            this._port = port;
            return port;
        }

        throw new Error(lastError
            ? 'no callback port available: ' + lastError.message
            : 'no callback port available');
    }

    _onIncoming(connection) {
        let params = null;
        let path = '';

        try {
            let input = new Gio.DataInputStream({
                base_stream: connection.get_input_stream(),
            });
            // Only the request line matters; everything the flow returns is
            // in the query string, and reading further would mean parsing
            // headers we have no use for.
            input.set_newline_type(Gio.DataStreamNewlineType.ANY);
            let [line] = input.read_line_utf8(null);

            if (line && line.length <= MAX_REQUEST_LINE) {
                let parsed = parseRequestLine(line);
                if (parsed) {
                    path = parsed.path;
                    params = parsed.params;
                }
            }
        } catch (e) {
            params = null;
        }

        // A browser fetching /favicon.ico on the same port would otherwise
        // end the flow before the real callback arrived.
        let isCallback = params && path === CALLBACK_PATH;

        let body;
        let status;
        if (isCallback && params.code) {
            status = '200 OK';
            body = resultPage(_('Linear connected'),
                _('You can close this tab and go back to your desktop.'));
        } else if (isCallback && params.error) {
            status = '200 OK';
            body = resultPage(_('Authorization was refused'),
                _('Linear did not grant access. You can close this tab.'));
        } else {
            status = '404 Not Found';
            body = resultPage(_('Not found'), _('Nothing is served here.'));
        }

        try {
            let output = connection.get_output_stream();
            output.write_all(httpResponse(status, body), null);
            output.flush(null);
        } catch (e) {
            // The browser may already be gone; the code still counts.
        }

        try { connection.close(null); } catch (e) {}

        if (isCallback)
            this._finish(params, null);
    }

    _finish(params, error) {
        if (this._finished)
            return;
        this._finished = true;

        let callback = this._onDone;
        this._onDone = null;
        this.stop();

        if (callback)
            callback(params, error);
    }

    fail(error) {
        this._finish(null, error);
    }

    stop() {
        if (!this._service)
            return;
        try {
            this._service.stop();
            this._service.close();
        } catch (e) {
            // Already torn down.
        }
        this._service = null;
    }
};

/*
 * Builds the consent URL.
 *
 * Scope is deliberately the caller's decision: the desklet only needs read
 * access, and asks for write solely when the user has chosen to have
 * mentions marked read. Requesting workspace-wide write for a widget that
 * mostly displays things would be asking for more than it needs.
 */
function authorizeUrl(options) {
    return AUTHORIZE_URL + '?' + encodeQuery({
        client_id: options.clientId,
        redirect_uri: options.redirectUri,
        response_type: 'code',
        scope: options.scope,
        state: options.state,
        code_challenge: options.challenge,
        code_challenge_method: 'S256',
        // Without this, a user who has already authorized once is bounced
        // straight through, with no chance to pick a different workspace.
        prompt: 'consent',
        actor: 'user',
    });
}

/*
 * Posts a form-encoded body to Linear's token endpoint.
 *
 * Kept here rather than in linear.js because that module speaks GraphQL and
 * JSON; this is the one place in the desklet that sends a form.
 */
function postForm(session, url, fields, timeoutSeconds, cancellable, onDone) {
    const Soup = imports.gi.Soup;
    const ByteArray = imports.byteArray;

    let isSoup2 = Soup.MAJOR_VERSION === undefined || Soup.MAJOR_VERSION === 2;
    let payload = encodeQuery(fields);

    let message;
    try {
        message = Soup.Message.new('POST', url);
    } catch (e) {
        message = null;
    }
    if (!message) {
        onDone({ ok: false, error: _('Could not build the request') });
        return;
    }

    function finish(text, status) {
        let parsed = null;
        try {
            parsed = JSON.parse(text);
        } catch (e) {
            parsed = null;
        }

        if (status !== 200) {
            /*
             * OAuth error bodies carry a machine-readable code. Surfacing
             * invalid_grant specifically matters: it is what a revoked or
             * expired refresh token looks like, and the answer is to
             * reconnect rather than to retry.
             */
            let code = parsed && parsed.error ? String(parsed.error) : '';
            let description = parsed && parsed.error_description
                ? String(parsed.error_description) : '';
            onDone({
                ok: false,
                code: code,
                error: description || code || _('Linear rejected the request'),
            });
            return;
        }

        if (!parsed || !parsed.access_token) {
            onDone({ ok: false, error: _('Linear sent a reply we could not read') });
            return;
        }

        onDone({ ok: true, tokens: parsed });
    }

    if (isSoup2) {
        message.request_headers.append('Content-Type',
            'application/x-www-form-urlencoded');
        message.set_request('application/x-www-form-urlencoded',
            Soup.MemoryUse.COPY, payload);

        session.queue_message(message, function (httpSession, response) {
            if (cancellable && cancellable.is_cancelled())
                return;
            let raw = response.response_body ? response.response_body.data : null;
            finish(raw ? raw.toString() : '', response.status_code);
        });
        return;
    }

    message.set_request_body_from_bytes('application/x-www-form-urlencoded',
        new GLib.Bytes(ByteArray.fromString(payload)));

    session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable,
        function (httpSession, result) {
            if (cancellable && cancellable.is_cancelled())
                return;
            let status = message.get_status();
            try {
                let bytes = httpSession.send_and_read_finish(result);
                let data = bytes ? bytes.get_data() : null;
                finish(data ? ByteArray.toString(data) : '', status);
            } catch (e) {
                onDone({
                    ok: false,
                    error: e.message ? String(e.message) : _('Linear is unreachable'),
                });
            }
        });
}

/*
 * Turns Linear's token response into what gets stored.
 *
 * expires_in is converted to an absolute instant at the point of receipt,
 * because a relative lifetime is meaningless once written to disk.
 */
function normaliseTokens(raw, fallbackScope) {
    let lifetime = Number(raw.expires_in);
    if (isNaN(lifetime) || lifetime <= 0)
        lifetime = 86400;

    return {
        accessToken: String(raw.access_token || ''),
        refreshToken: raw.refresh_token ? String(raw.refresh_token) : '',
        // A minute of slack, so a token is refreshed just before it lapses
        // rather than after a request has already failed on it.
        expiresAtMs: Date.now() + (lifetime - 60) * 1000,
        scope: raw.scope ? String(raw.scope) : (fallbackScope || ''),
        tokenType: raw.token_type ? String(raw.token_type) : 'Bearer',
    };
}

/*
 * Runs the whole flow: listener, browser, code exchange.
 *
 * Calls back once with { ok, tokens } or { ok: false, error }. Returns a
 * handle whose cancel() abandons a flow the user has walked away from.
 */
function authorize(options, onDone) {
    let session = options.session;
    let clientId = String(options.clientId || '').trim() || DEFAULT_CLIENT_ID;
    let scope = options.scope || 'read';
    let timeout = Math.max(5, options.timeout || 15);

    let verifier = randomToken(32);
    let state = randomToken(24);
    let listener = new CallbackListener();
    let timeoutId = 0;
    let settled = false;

    function settle(result) {
        if (settled)
            return;
        settled = true;

        if (timeoutId) {
            GLib.source_remove(timeoutId);
            timeoutId = 0;
        }
        listener.stop();
        onDone(result);
    }

    let port;
    try {
        port = listener.listen(function (params, error) {
            if (error) {
                settle({ ok: false, error: error.message || String(error) });
                return;
            }

            /*
             * The state check. Without it, anything able to reach the
             * loopback port could hand the desklet a code of its own
             * choosing and bind the desklet to an attacker's account.
             */
            if (params.state !== state) {
                settle({ ok: false, error: _('The reply from Linear did not match this request.') });
                return;
            }

            if (params.error) {
                settle({
                    ok: false,
                    denied: params.error === 'access_denied',
                    error: params.error === 'access_denied'
                        ? _('Authorization was refused.')
                        : String(params.error_description || params.error),
                });
                return;
            }

            if (!params.code) {
                settle({ ok: false, error: _('Linear did not return an authorization code.') });
                return;
            }

            postForm(session, TOKEN_URL, {
                code: params.code,
                redirect_uri: redirectUriFor(port),
                client_id: clientId,
                code_verifier: verifier,
                grant_type: 'authorization_code',
            }, timeout, null, function (result) {
                if (!result.ok) {
                    settle({ ok: false, error: result.error });
                    return;
                }
                settle({ ok: true, tokens: normaliseTokens(result.tokens, scope) });
            });
        }, options.port);
    } catch (e) {
        onDone({
            ok: false,
            error: _('Could not open a callback port. Another program may be using all of them.'),
        });
        return { cancel: function () {} };
    }

    timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, FLOW_TIMEOUT_SECONDS, function () {
        timeoutId = 0;
        settle({ ok: false, timedOut: true, error: _('Timed out waiting for Linear.') });
        return GLib.SOURCE_REMOVE;
    });

    let url = authorizeUrl({
        clientId: clientId,
        redirectUri: redirectUriFor(port),
        scope: scope,
        state: state,
        challenge: challengeFor(verifier),
    });

    try {
        Gio.AppInfo.launch_default_for_uri(url, null);
    } catch (e) {
        settle({
            ok: false,
            error: _('Could not open a browser to authorize with Linear.'),
        });
        return { cancel: function () {} };
    }

    return {
        port: port,
        url: url,
        cancel: function () {
            settle({ ok: false, cancelled: true, error: _('Authorization was cancelled.') });
        },
    };
}

/*
 * Trades a refresh token for a new access token.
 *
 * Linear rotates refresh tokens, so the response carries a replacement that
 * must be stored; the old one stops working. There is a 30 minute grace
 * period for replaying a request whose response was lost, which is why a
 * network failure here is reported as a plain error rather than treated as
 * a revoked grant.
 */
function refresh(options, onDone) {
    let refreshToken = String(options.refreshToken || '').trim();
    if (!refreshToken) {
        onDone({ ok: false, needsReauth: true, error: _('No refresh token stored.') });
        return;
    }

    postForm(options.session, TOKEN_URL, {
        refresh_token: refreshToken,
        client_id: String(options.clientId || '').trim() || DEFAULT_CLIENT_ID,
        grant_type: 'refresh_token',
    }, Math.max(5, options.timeout || 15), options.cancellable || null, function (result) {
        if (!result.ok) {
            /*
             * invalid_grant means the token has been revoked or has already
             * been rotated past. No amount of retrying fixes that, so say
             * so plainly and let the desklet ask for a reconnection.
             */
            let needsReauth = result.code === 'invalid_grant' ||
                result.code === 'invalid_request';
            onDone({ ok: false, needsReauth: needsReauth, error: result.error });
            return;
        }

        let tokens = normaliseTokens(result.tokens, options.scope);
        // A response without a replacement refresh token means the existing
        // one stays valid; dropping it here would strand the next refresh.
        if (!tokens.refreshToken)
            tokens.refreshToken = refreshToken;

        onDone({ ok: true, tokens: tokens });
    });
}

/*
 * Best-effort revocation, so disconnecting in the desklet also drops the
 * grant on Linear's side rather than leaving it listed indefinitely.
 */
function revoke(options, onDone) {
    let token = String(options.token || '').trim();
    if (!token) {
        onDone({ ok: true });
        return;
    }

    postForm(options.session, REVOKE_URL, {
        token: token,
        client_id: String(options.clientId || '').trim() || DEFAULT_CLIENT_ID,
    }, Math.max(5, options.timeout || 15), null, function (result) {
        // Revocation endpoints answer 200 with an empty body, which
        // postForm reads as a missing access token. Either way the local
        // copy is being discarded, so nothing here is worth failing over.
        onDone({ ok: true, error: result.ok ? null : result.error });
    });
}

function needsRefresh(tokens) {
    if (!tokens || !tokens.accessToken)
        return false;
    return !tokens.expiresAtMs || Date.now() >= tokens.expiresAtMs;
}

// Whether a stored grant covers a scope the desklet now wants. Used to tell
// someone who has turned on mark-as-read that a reconnection is needed.
function hasScope(tokens, scope) {
    if (!tokens || !tokens.scope)
        return false;
    return tokens.scope.split(/[\s,]+/).indexOf(scope) !== -1;
}
