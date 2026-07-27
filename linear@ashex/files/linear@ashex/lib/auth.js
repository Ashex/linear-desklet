/*
 * auth.js - decides what credential the desklet is currently using, and
 * keeps it valid.
 *
 * Two ways in:
 *
 *   A personal API key, pasted by the user. Simple, no expiry, but a
 *   workspace admin can switch off member API key creation entirely
 *   (Settings, Administration, API), which leaves members of those
 *   workspaces unable to make one at all.
 *
 *   OAuth, which no admin setting blocks in the same way. Access tokens
 *   last 24 hours and are renewed with a rotating refresh token.
 *
 * Everything that needs a credential goes through withCredential(), so the
 * "is this still valid, and if not can it be renewed" question is answered
 * in exactly one place rather than at every call site. Refreshes are
 * collapsed: a burst of callers arriving while a renewal is in flight all
 * wait on the same request instead of each starting their own.
 */

const GLib = imports.gi.GLib;

// Relative to the desklet directory, not to this file.
const Linear = require('./lib/linear');
const OAuth = require('./lib/oauth');
const TokenStore = require('./lib/tokenstore');

const _ = require('./lib/i18n')._;

var Method = {
    API_KEY: 'api_key',
    OAUTH: 'oauth',
};

/*
 * The scopes to ask for.
 *
 * read is always needed. write is requested only when the user has asked
 * for mentions to be marked read, because Linear has no notification
 * specific scope and write is workspace wide: an ordinary read only widget
 * should not hold permission to modify issues.
 */
function scopesFor(markReadEnabled) {
    return markReadEnabled ? 'read,write' : 'read';
}

var Authenticator = class Authenticator {
    constructor(options) {
        this._instanceId = options.instanceId;
        this._method = options.method || Method.API_KEY;
        this._apiKey = options.apiKey || '';
        this._clientId = options.clientId || '';
        this._timeout = options.timeout || 15;

        this._tokens = null;
        this._loaded = false;
        this._loading = false;
        this._refreshing = false;
        this._waiting = [];
        this._flow = null;
        this._destroyed = false;

        // Set when a refresh fails in a way no retry can fix, so the desklet
        // can say "reconnect" instead of showing a network error forever.
        this._needsReauth = false;
        this._onStateChanged = options.onStateChanged || function () {};
    }

    // ------------------------------------------------------------------
    // Configuration
    // ------------------------------------------------------------------

    setMethod(method) {
        let next = method === Method.OAUTH ? Method.OAUTH : Method.API_KEY;
        if (next === this._method)
            return;
        this._method = next;
        this._needsReauth = false;
    }

    setApiKey(apiKey) {
        this._apiKey = String(apiKey || '').trim();
    }

    setClientId(clientId) {
        this._clientId = String(clientId || '').trim();
    }

    setTimeout(seconds) {
        this._timeout = seconds;
    }

    get method() {
        return this._method;
    }

    get needsReauth() {
        return this._needsReauth;
    }

    get tokens() {
        return this._tokens;
    }

    /*
     * Whether there is a credential to try at all. Distinct from whether it
     * works: a revoked key still counts as configured, and the resulting
     * error is more useful than a setup prompt.
     */
    get isConfigured() {
        if (this._method === Method.OAUTH)
            return !!(this._tokens && this._tokens.accessToken);
        return !!this._apiKey;
    }

    // Which account the stored grant belongs to, when Linear told us.
    get accountLabel() {
        return this._tokens && this._tokens.accountLabel
            ? this._tokens.accountLabel : '';
    }

    grantsScope(scope) {
        if (this._method !== Method.OAUTH)
            return true;
        return OAuth.hasScope(this._tokens, scope);
    }

    // ------------------------------------------------------------------
    // Stored tokens
    // ------------------------------------------------------------------

    /*
     * Reads whatever is on disk. Callers wait rather than racing: at
     * startup the desklet asks for a credential immediately, and without
     * this the first refresh would run before the token file had been read
     * and report a missing grant.
     */
    load(onDone) {
        if (this._loaded) {
            if (onDone)
                onDone();
            return;
        }

        if (onDone)
            this._waiting.push(onDone);

        if (this._loading)
            return;
        this._loading = true;

        TokenStore.load(this._instanceId, (tokens) => {
            this._loading = false;
            this._loaded = true;
            if (!this._destroyed)
                this._tokens = tokens;

            let waiting = this._waiting;
            this._waiting = [];
            waiting.forEach(function (callback) { callback(); });
        });
    }

    _store(tokens, onDone) {
        this._tokens = tokens;
        this._loaded = true;
        TokenStore.save(this._instanceId, tokens, function () {
            if (onDone)
                onDone();
        });
    }

    // ------------------------------------------------------------------
    // Credentials
    // ------------------------------------------------------------------

    /*
     * Hands a usable credential to the callback, renewing it first if the
     * access token has expired.
     *
     * The callback receives { apiKey } or { accessToken }, shaped to drop
     * straight into the Linear client, or an error describing what the user
     * needs to do about it.
     */
    withCredential(onReady) {
        if (this._method !== Method.OAUTH) {
            if (!this._apiKey) {
                onReady(null, { code: 'NOKEY', error: _('No API key set.') });
                return;
            }
            onReady({ apiKey: this._apiKey }, null);
            return;
        }

        this.load(() => {
            if (this._destroyed)
                return;

            if (!this._tokens || !this._tokens.accessToken) {
                onReady(null, { code: 'NOKEY', error: _('Not connected to Linear.') });
                return;
            }

            if (this._needsReauth) {
                onReady(null, {
                    code: 'REAUTH',
                    error: _('Linear needs you to connect again.'),
                });
                return;
            }

            if (!OAuth.needsRefresh(this._tokens)) {
                onReady({ accessToken: this._tokens.accessToken }, null);
                return;
            }

            this.refresh((ok, failure) => {
                if (this._destroyed)
                    return;
                if (!ok) {
                    onReady(null, failure);
                    return;
                }
                onReady({ accessToken: this._tokens.accessToken }, null);
            });
        });
    }

    /*
     * Renews the access token.
     *
     * Concurrent callers share one request. Two refreshes racing would be
     * worse than wasteful: Linear rotates refresh tokens, so the second
     * would present a token the first had already consumed and the grant
     * would be lost.
     */
    refresh(onDone) {
        if (this._refreshing) {
            this._refreshQueue = this._refreshQueue || [];
            this._refreshQueue.push(onDone);
            return;
        }

        if (!this._tokens || !this._tokens.refreshToken) {
            onDone(false, { code: 'REAUTH', error: _('Not connected to Linear.') });
            return;
        }

        this._refreshing = true;
        this._refreshQueue = this._refreshQueue || [];
        this._refreshQueue.push(onDone);

        let settle = (ok, failure) => {
            this._refreshing = false;
            let queue = this._refreshQueue || [];
            this._refreshQueue = [];
            queue.forEach(function (callback) {
                if (callback)
                    callback(ok, failure);
            });
        };

        OAuth.refresh({
            session: Linear.session(),
            refreshToken: this._tokens.refreshToken,
            clientId: this._clientId,
            scope: this._tokens.scope,
            timeout: this._timeout,
        }, (result) => {
            if (this._destroyed)
                return;

            if (!result.ok) {
                if (result.needsReauth) {
                    // The grant is gone: revoked in Linear, or the refresh
                    // token already rotated past. Nothing to retry.
                    this._needsReauth = true;
                    this._onStateChanged();
                    settle(false, {
                        code: 'REAUTH',
                        error: _('Linear needs you to connect again.'),
                    });
                    return;
                }
                settle(false, { code: 'NETWORK', error: result.error });
                return;
            }

            // Carry across what the token response does not repeat.
            let tokens = result.tokens;
            if (this._tokens && this._tokens.accountLabel)
                tokens.accountLabel = this._tokens.accountLabel;

            this._store(tokens, () => {
                this._needsReauth = false;
                settle(true, null);
            });
        });
    }

    /*
     * Reports whether a failed request is worth retrying after a renewal.
     *
     * An access token can lapse between the expiry check and the request
     * landing, and Linear can invalidate one early. Both look like a 401,
     * and both are fixed by refreshing once.
     */
    shouldRetryAfterRefresh(code) {
        return this._method === Method.OAUTH &&
            code === 'AUTH' &&
            !this._needsReauth &&
            !!(this._tokens && this._tokens.refreshToken);
    }

    // ------------------------------------------------------------------
    // Connecting
    // ------------------------------------------------------------------

    /*
     * Runs the browser flow and stores the result.
     *
     * onDone receives { ok } or { ok: false, error }, already phrased for
     * display: the desklet shows this text directly.
     */
    connect(options, onDone) {
        if (this._flow) {
            onDone({ ok: false, error: _('Already waiting for Linear.') });
            return;
        }

        let scope = scopesFor(options && options.markRead);

        this._flow = OAuth.authorize({
            session: Linear.session(),
            clientId: this._clientId,
            scope: scope,
            timeout: this._timeout,
            port: options ? options.port : 0,
        }, (result) => {
            this._flow = null;
            if (this._destroyed)
                return;

            if (!result.ok) {
                onDone({ ok: false, error: result.error });
                return;
            }

            let tokens = result.tokens;
            // Linear does not always echo the granted scopes back, and the
            // desklet needs to know what it holds in order to warn about
            // mark-as-read later.
            if (!tokens.scope)
                tokens.scope = scope;

            this._store(tokens, () => {
                this._needsReauth = false;
                this._onStateChanged();
                onDone({ ok: true });
            });
        });

        return this._flow;
    }

    get isConnecting() {
        return !!this._flow;
    }

    cancelConnect() {
        if (this._flow) {
            this._flow.cancel();
            this._flow = null;
        }
    }

    /*
     * Forgets the grant, and tells Linear to drop it too.
     *
     * The local copy goes regardless of whether revocation succeeds: the
     * user asked to disconnect, and leaving a working refresh token on disk
     * after that would be the wrong answer.
     */
    disconnect(onDone) {
        this.cancelConnect();

        let token = this._tokens ? this._tokens.refreshToken || this._tokens.accessToken : '';

        this._tokens = null;
        this._needsReauth = false;
        this._loaded = true;

        TokenStore.clear(this._instanceId, () => {
            if (!token) {
                this._onStateChanged();
                if (onDone)
                    onDone();
                return;
            }

            OAuth.revoke({
                session: Linear.session(),
                token: token,
                clientId: this._clientId,
                timeout: this._timeout,
            }, () => {
                if (this._destroyed)
                    return;
                this._onStateChanged();
                if (onDone)
                    onDone();
            });
        });
    }

    destroy() {
        this._destroyed = true;
        this.cancelConnect();
        this._waiting = [];
        this._refreshQueue = [];
    }
};
