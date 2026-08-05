/*
 * Linear - a Cinnamon desklet that keeps your Linear work in view.
 *
 * Two tabs over one request. The Issues tab lists what is assigned to you,
 * loudest first, with the next thing to work on promoted to a card of its
 * own. The Mentions tab lists the places someone has said your name, and
 * clearing one here clears it in Linear's inbox too.
 *
 * The layout is driven entirely by the configured width: below roughly
 * 300 pixels it folds into a single stacked column with abbreviated
 * detail, and as it widens it progressively reveals states, teams, due
 * dates and timestamps alongside the titles.
 */

const Cinnamon = imports.gi.Cinnamon;
const Clutter = imports.gi.Clutter;
const Desklet = imports.ui.desklet;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Mainloop = imports.mainloop;
const Pango = imports.gi.Pango;
const Settings = imports.ui.settings;
const St = imports.gi.St;

/*
 * The UUID this copy is actually installed as.
 *
 * The Spices test-spice script installs a desklet under a "devtest-"
 * prefixed UUID. A module that assumes its own name resolves to the desklet
 * it was copied from and then loads that one's settings instead of its own,
 * which makes the two installs quietly share state. Asking the desklet
 * manager which of the two names it actually knows about costs one loop and
 * avoids all of that.
 */
const CANDIDATE_UUIDS = ['linear@ashex', 'devtest-linear@ashex'];

function resolveUuid() {
    let known = imports.ui.deskletManager.deskletMeta;
    for (let i = 0; i < CANDIDATE_UUIDS.length; i++) {
        let candidate = CANDIDATE_UUIDS[i];
        if (known && known[candidate] && known[candidate].path)
            return candidate;
    }
    return CANDIDATE_UUIDS[0];
}

const UUID = resolveUuid();

/*
 * Loaded through Cinnamon's require rather than by pushing this directory
 * onto imports.searchPath.
 *
 * imports.lib would be a process-wide singleton shared with every other
 * xlet that also happens to have a directory called "lib": whichever one
 * imports it first wins, and every later desklet silently reads the first
 * one's modules. require resolves by full path and caches by full path, so
 * two desklets can both have a lib/format.js without colliding.
 *
 * Note that require inside these modules resolves relative to this
 * directory, not to the file doing the requiring, which is why the modules
 * in lib/ ask for './lib/...' too.
 */
const Auth = require('./lib/auth');
const Format = require('./lib/format');
const I18n = require('./lib/i18n');
const Linear = require('./lib/linear');
const Model = require('./lib/model');
const OAuth = require('./lib/oauth');
const Tabs = require('./lib/tabs');
const TooltipLib = require('./lib/tooltip');
const ThemeLib = require('./lib/theme');

// Point translations at whichever UUID we actually resolved to, before any
// string gets looked up.
I18n.bind(UUID);

const _ = I18n._;
const ngettext = I18n.ngettext;

// Below this the two column rows stop fitting and everything stacks.
const NARROW_WIDTH = 300;
// Above this there is room for supporting detail beside each title.
const WIDE_WIDTH = 460;

const SEPARATOR = '  \u00b7  ';

/*
 * Line budgets for wrapping labels, expressed in lines of their own font
 * size and converted to a character count at render time.
 *
 * These bound the extreme case rather than describing normal layout: an
 * ordinary title or remark wraps and is shown in full, and only text long
 * enough to crowd out the rest of the list is truncated.
 */
const MAX_TITLE_LINES = 3;
const MAX_MESSAGE_LINES = 3;

// The tooltip has room for the whole remark, within reason.
const MAX_TOOLTIP_MESSAGE = 700;

function logError(message) {
    global.logError('[' + UUID + '] ' + message);
}

class LinearDesklet extends Desklet.Desklet {
    constructor(metadata, deskletId) {
        super(metadata, deskletId);

        this._issues = [];
        // Every notification the window returned, not just mentions. The
        // name predates the tab covering the whole inbox, and tools/demo-data.js
        // writes to it by name, so it stays.
        this._mentions = [];
        this._viewer = null;
        this._raw = null;
        this._error = null;
        this._errorCode = null;
        this._lastSuccessMs = 0;
        this._usingCache = false;
        this._rateLimitedUntil = 0;
        this._refreshTimer = 0;
        this._tickTimer = 0;
        /*
         * Which page of the activity list is showing, and the one-shot timer
         * that walks it back to the first. Both live on the desklet rather
         * than on a widget because _render() destroys and rebuilds every
         * child it has; anything stateful kept down there would reset on the
         * next tick.
         */
        this._page = 0;
        this._pageResetTimer = 0;
        this._cancellable = null;
        this._destroyed = false;
        this._inFlight = false;

        this._bindSettings(deskletId);

        this._auth = new Auth.Authenticator({
            instanceId: deskletId,
            method: this.auth_method,
            apiKey: this.api_key,
            clientId: this.oauth_client_id,
            timeout: this.http_timeout,
            onStateChanged: () => {
                this._syncAuthSettings();
                this._render();
            },
        });
        this._connecting = false;
        this._connectMessage = '';

        this._activeTab = this._initialTab();
        this._theme = new ThemeLib.Theme(this._themeOptions());

        this._buildSkeleton();
        this.setHeader(_('Linear'));

        this._menu.addAction(_('Refresh now'), () => this._refresh(true));
        this._menu.addAction(_('Open Linear'), () => this._openUrl(this._linearHome()));
    }

    _bindSettings(deskletId) {
        this.settings = new Settings.DeskletSettings(this, UUID, deskletId);

        /*
         * A different credential, a different number of issues or a wider
         * window on the inbox all mean the answer we have is the wrong
         * answer, and only these three warrant spending a request.
         *
         * The category checkboxes are pointedly not among them. Linear's
         * NotificationFilter has no category field, so the cut is made in
         * model.js after the fetch - which means switching a category on or
         * off is a repaint of data already in hand and costs nothing. Same
         * for the page size, now that the query fetches a window rather
         * than a screenful.
         */
        let refetch = [
            'api_key', 'auth_method', 'max_issues', 'fetch_window',
        ];
        let reschedule = [
            'refresh_minutes', 'http_timeout',
        ];
        let rerender = [
            'sort_mode', 'group_by_team', 'imminent_days',
            'desklet_width', 'scale', 'density',
            'show_header', 'color_mode', 'surface_opacity', 'glow',
            'tint_surface', 'dark_surface',
        ];
        /*
         * Also a repaint, but one that changes which rows exist rather than
         * how they look, so the list goes back to the first page. Clamping
         * alone would leave someone who has just narrowed the list sitting
         * on its last page, looking at the oldest rows they kept.
         */
        let refilter = [
            'unread_only', 'max_mentions',
            'cat_mentions', 'cat_reviews', 'cat_comments', 'cat_assignments',
            'cat_status', 'cat_subscriptions', 'cat_documents', 'cat_reactions',
            'cat_other',
        ];

        refetch.forEach((key) => this.settings.bind(key, key, this._onQueryChanged));
        reschedule.forEach((key) => this.settings.bind(key, key, this._onScheduleChanged));
        rerender.forEach((key) => this.settings.bind(key, key, this._onStyleChanged));
        refilter.forEach((key) => this.settings.bind(key, key, () => this._onFilterChanged()));

        this.settings.bind('page_reset_seconds', 'page_reset_seconds',
            () => this._onPageResetChanged());

        this.settings.bind('default_tab', 'default_tab', () => {});
        this.settings.bind('active_tab', 'active_tab', () => {});
        this.settings.bind('mark_read_on_click', 'mark_read_on_click',
            () => this._onMarkReadChanged());
        this.settings.bind('click_action', 'click_action', () => {});
        this.settings.bind('oauth_port', 'oauth_port', () => {});
        this.settings.bind('oauth_client_id', 'oauth_client_id',
            () => this._auth && this._auth.setClientId(this.oauth_client_id));
    }

    _initialTab() {
        let requested = this.default_tab === 'remember' ? this.active_tab : this.default_tab;
        return requested === 'mentions' ? 'mentions' : 'issues';
    }

    _themeOptions() {
        return {
            scale: this.scale,
            dark: this.dark_surface,
            opacity: this.surface_opacity,
            glow: this.glow,
            tint: this.tint_surface,
            density: this._effectiveDensity(),
            width: this.desklet_width,
        };
    }

    // 'Adapt to width' is the default because a desklet that has been
    // dragged narrow should tighten up rather than clip.
    _effectiveDensity() {
        if (this.density !== 'auto')
            return this.density;
        if (this.desklet_width < NARROW_WIDTH)
            return 'compact';
        if (this.desklet_width > WIDE_WIDTH)
            return 'spacious';
        return 'comfortable';
    }

    get _isNarrow() {
        return this.desklet_width < NARROW_WIDTH;
    }

    get _isWide() {
        return this.desklet_width >= WIDE_WIDTH;
    }

    /*
     * Whether a credential is present to attempt a request with.
     *
     * Says nothing about whether that credential works. A revoked key still
     * counts as configured, so the resulting error is shown rather than a
     * setup prompt.
     */
    get _isConfigured() {
        return !!(this._auth && this._auth.isConfigured);
    }

    get _usingOAuth() {
        return this.auth_method === 'oauth';
    }

    /*
     * Whether the last fetch failed, as distinct from any error being on
     * display. A missing-scope warning does not mean the data failed to
     * load, so it must not turn the list into an error state.
     */
    get _hasFetchError() {
        return !!this._error && this._errorCode !== 'SCOPE';
    }

    // ------------------------------------------------------------------
    // Structure
    // ------------------------------------------------------------------

    _buildSkeleton() {
        this._root = new St.BoxLayout({ vertical: true, reactive: true, track_hover: true });
        this._root.connect('button-release-event',
            (actor, event) => this._onClicked(actor, event));

        /*
         * Paging back to the first page is on an idle timer, and reading is
         * not idling. While the pointer is over the desklet the countdown is
         * held; it starts again from the beginning on the way out.
         *
         * This hangs off _root because _root outlives _render(), which only
         * destroys children. A hover handler attached to anything inside the
         * body would be torn down every sixty seconds by the tick timer.
         */
        this._root.connect('notify::hover', () => {
            if (this._root.get_hover())
                this._clearPageReset();
            else
                this._schedulePageReset();
        });

        this._headerBox = new St.BoxLayout({ vertical: false });
        this._headerTitle = new St.Label({ text: _('Linear') });
        this._headerStatus = new St.Label({ text: '' });

        this._headerBox.add_child(this._headerTitle);
        this._headerBox.add_child(new St.Widget({ x_expand: true }));
        this._headerBox.add_child(this._headerStatus);

        this._tabHolder = new St.BoxLayout({ vertical: true });
        this._bodyBox = new St.BoxLayout({ vertical: true });

        this._root.add_child(this._headerBox);
        this._root.add_child(this._tabHolder);
        this._root.add_child(this._bodyBox);

        this.setContent(this._root);
    }

    _label(text, style, options) {
        let opts = options || {};
        let label = new St.Label({ text: text || '' });
        label.set_style(style);

        let clutterText = label.clutter_text;
        if (opts.wrap) {
            // Ellipsizing and wrapping are mutually exclusive in Pango:
            // leave ellipsizing on and the text is cut at one line no
            // matter how much vertical room it has.
            clutterText.set_ellipsize(Pango.EllipsizeMode.NONE);
            clutterText.set_line_wrap(true);
            clutterText.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
        } else {
            clutterText.set_ellipsize(Pango.EllipsizeMode.END);
        }
        if (opts.expand)
            label.x_expand = true;
        return label;
    }

    _spacer(height) {
        return new St.Widget({ height: height });
    }

    /*
     * A full-width clickable row.
     *
     * St.Button is an St.Bin, which does not fill by default: it centres
     * its child at the child's natural width, leaving row text floating in
     * the middle of a full-width background. x_fill makes the child span
     * the row so the contents align to the left edge.
     */
    _clickableRow() {
        return new St.Button({
            reactive: true,
            track_hover: true,
            can_focus: true,
            x_fill: true,
            y_fill: false,
        });
    }

    /*
     * The width available to text inside a row, after the desklet and row
     * padding and borders.
     *
     * St will not wrap a label left at its natural width, so any label that
     * needs to flow onto a second line must be given an explicit width.
     * Deriving it from the configured desklet width makes it correct on the
     * first paint rather than after a relayout.
     */
    _rowContentWidth(theme) {
        let width = this.desklet_width
            - theme.gap(14) * 2   // desklet padding
            - 2                   // desklet border
            - theme.gap(11) * 2   // row padding
            - 2;                  // row border
        return Math.max(60, Math.round(width));
    }

    // The same, for a mention row, which indents its text past the avatar.
    _mentionContentWidth(theme) {
        let width = this._rowContentWidth(theme);
        if (!this._isNarrow)
            width -= theme.px(22) + theme.gap(8);
        return Math.max(60, Math.round(width));
    }

    // ------------------------------------------------------------------
    // Rendering
    // ------------------------------------------------------------------

    _render() {
        if (this._destroyed || !this._root)
            return;

        this._theme.update(this._themeOptions());
        let theme = this._theme;
        let nowMs = Date.now();

        this._root.set_style(theme.rootStyle());

        this._headerBox.visible = this.show_header;
        if (this.show_header)
            this._renderHeader(theme, nowMs);

        this._tabHolder.destroy_all_children();
        this._bodyBox.destroy_all_children();

        /*
         * An expired session counts as unconfigured for rendering purposes.
         * The stored tokens are real, so _isConfigured is true, but nothing
         * can be fetched with them: showing tabs over an empty list would
         * read as "you have no work" rather than "sign in again".
         */
        if (!this._isConfigured || this._connecting ||
            (this._auth && this._auth.needsReauth)) {
            this._renderSetup(theme);
            this._scheduleTick();
            return;
        }

        this._renderTabs(theme);

        if (this._activeTab === 'mentions')
            this._renderMentions(theme, nowMs);
        else
            this._renderIssues(theme, nowMs);

        this._renderFooter(theme, nowMs);
        this._scheduleTick();
    }

    _renderHeader(theme, nowMs) {
        this._headerTitle.set_style(theme.headerStyle());
        this._headerStatus.set_style(theme.headerDateStyle());

        let status;
        if (this._connecting)
            status = _('Waiting for Linear\u2026');
        else if (!this._isConfigured)
            status = _('Not connected');
        else if (this._auth && this._auth.needsReauth)
            status = _('Sign in again');
        else if (this._inFlight && !this._lastSuccessMs)
            status = _('Checking\u2026');
        else if (this._lastSuccessMs)
            status = _('Updated %s').format(Format.since(nowMs - this._lastSuccessMs));
        else if (this._usingCache)
            status = _('Saved copy');
        else if (this._error)
            status = _('Not updated');
        else
            status = _('Checking\u2026');

        this._headerStatus.set_text(status);
    }

    _renderTabs(theme) {
        // Counted over the visible list, not the raw one: a badge that
        // included categories the user has switched off would send them
        // looking for rows that are not there.
        let unread = Model.unreadCount(this._visibleActivity());

        /*
         * The tab accents are fixed rather than taken from the colour mode:
         * a tab whose colour changed with the contents of the list beneath
         * it would make the selection hard to follow.
         */
        let tabBar = Tabs.buildTabBar(theme, {
            active: this._activeTab,
            tabs: [
                {
                    id: 'issues',
                    label: _('Issues'),
                    accent: ThemeLib.accentFor('position', {}, 6),
                    badge: 0,
                },
                {
                    /*
                     * The id stays 'mentions' though the label does not.
                     * It is the stored value of the default_tab and
                     * active_tab settings and the string tools/demo-data.js
                     * assigns to _activeTab; renaming it would quietly
                     * reset every existing user's tab preference.
                     */
                    id: 'mentions',
                    label: _('Activity'),
                    accent: ThemeLib.accentFor('position', {}, 0),
                    badge: unread,
                },
            ],
            onSelect: (id) => this._selectTab(id),
        });

        this._tabHolder.add_child(tabBar);
        this._tabHolder.add_child(this._spacer(theme.gap(10)));
    }

    /*
     * The first-run prompt. An unconfigured desklet that simply said it had
     * no issues would be indistinguishable from a broken one, so this says
     * what is missing and offers the button that fixes it.
     */
    _renderSetup(theme) {
        let accent = ThemeLib.accentFor('position', {}, 6);

        /*
         * Mid-flow. The browser is open and the desklet is holding a
         * loopback port, so the useful thing to offer is a way out of it
         * rather than the button that started it.
         */
        if (this._connecting) {
            this._bodyBox.add_child(this._label(
                _('Finish signing in to Linear in your browser.'),
                theme.setupStyle(), { wrap: true }));

            let row = new St.BoxLayout({ vertical: false });
            row.add_child(this._buildActionButton(_('Cancel'), accent, theme,
                () => this._cancelConnect()));
            row.add_child(new St.Widget({ x_expand: true }));
            this._bodyBox.add_child(row);
            return;
        }

        if (this._usingOAuth) {
            this._bodyBox.add_child(this._label(
                this._auth && this._auth.needsReauth
                    ? _('Linear needs you to sign in again.')
                    : _('Sign in to Linear to get started.'),
                theme.setupStyle(), { wrap: true }));

            let row = new St.BoxLayout({ vertical: false });
            row.add_child(this._buildActionButton(_('Sign in with Linear'), accent, theme,
                () => this._startConnect()));
            row.add_child(new St.Widget({ x_expand: true }));
            this._bodyBox.add_child(row);

            if (this._connectMessage) {
                this._bodyBox.add_child(this._spacer(theme.gap(8)));
                this._bodyBox.add_child(this._label(this._connectMessage,
                    theme.errorStyle(), { wrap: true }));
            }

            this._bodyBox.add_child(this._spacer(theme.gap(8)));
            this._bodyBox.add_child(this._label(
                _('Opens Linear in your browser. Nothing is stored in the settings window.'),
                theme.tagStyle(), { wrap: true }));
            return;
        }

        this._bodyBox.add_child(this._label(
            _('Add a Linear personal API key to get started.'),
            theme.setupStyle(), { wrap: true }));

        let row = new St.BoxLayout({ vertical: false });
        row.add_child(this._buildActionButton(_('Desklet settings'), accent, theme,
            () => this.configureDesklet(0)));
        row.add_child(new St.Widget({ x_expand: true }));
        this._bodyBox.add_child(row);

        this._bodyBox.add_child(this._spacer(theme.gap(8)));
        this._bodyBox.add_child(this._label(
            _('Create a key in Linear under Settings, Security and access. If your workspace does not allow that, switch to browser sign-in.'),
            theme.tagStyle(), { wrap: true }));
    }

    // ------------------------------------------------------------------
    // Issues
    // ------------------------------------------------------------------

    _renderIssues(theme, nowMs) {
        let sorted = Model.sortIssues(this._issues, this.sort_mode)
            .slice(0, Math.max(1, this.max_issues));

        if (!sorted.length) {
            this._renderEmpty(theme, this._hasFetchError
                ? _('Could not reach Linear')
                : _('Nothing assigned to you.'));
            return;
        }

        if (this.group_by_team) {
            let groups = Model.groupByTeam(sorted);
            if (groups.length > 1) {
                groups.forEach((group, index) => {
                    if (index)
                        this._bodyBox.add_child(this._spacer(theme.gap(6)));
                    this._bodyBox.add_child(this._label(
                        group.label.toUpperCase(), theme.sectionStyle()));
                    this._bodyBox.add_child(this._buildIssueList(group.issues, theme, nowMs));
                });
                return;
            }
        }

        this._bodyBox.add_child(this._buildIssueList(sorted, theme, nowMs));
    }

    _buildIssueList(issues, theme, nowMs) {
        let list = new St.BoxLayout({ vertical: true });

        issues.forEach((issue, position) => {
            let accent = ThemeLib.accentFor(this.color_mode, issue, position);
            list.add_child(this._buildIssueRow(issue, accent, theme, nowMs));
            list.add_child(this._spacer(theme.gap(5)));
        });

        return list;
    }

    _issueMeta(issue) {
        let parts = [];
        if (issue.stateName)
            parts.push(issue.stateName);

        // Priority 0 is "no priority", which adds nothing to a summary line.
        let priority = Number(issue.priority);
        if (!isNaN(priority) && priority > 0)
            parts.push(issue.priorityLabel || Format.priorityLabel(priority));

        if (issue.teamName)
            parts.push(issue.teamName);
        if (issue.projectName)
            parts.push(issue.projectName);

        return parts.join(SEPARATOR);
    }

    _issueTooltip(issue, nowMs) {
        let parts = [issue.identifier + '  ' + issue.title];

        let meta = this._issueMeta(issue);
        if (meta)
            parts.push(meta);
        if (issue.dueDate)
            parts.push(Format.dueText(issue.dueDate, nowMs));
        if (issue.updatedMs)
            parts.push(_('Updated %s').format(Format.since(nowMs - issue.updatedMs)));

        return parts.join('\n');
    }

    /*
     * Builds one issue row.
     *
     * The title takes the full width on its own line, with the identifier,
     * workflow state and due date folded into a single muted line beneath
     * it. Rows are emphasised in proportion to their urgency.
     */
    _buildIssueRow(issue, accent, theme, nowMs) {
        let row = this._clickableRow();
        let urgency = Model.urgencyFor(issue, nowMs, this.imminent_days);

        // Below this the accent would be decoration rather than a signal,
        // and a list where every row glows says nothing at all.
        let emphasised = urgency >= 0.35;
        let styleFor = (hovered) => emphasised
            ? theme.emphasisRowStyle(accent, urgency, hovered)
            : theme.rowStyle(accent, hovered);
        row.set_style(styleFor(false));

        let contentWidth = this._rowContentWidth(theme);
        let inner = new St.BoxLayout({ vertical: true });

        /*
         * Wrapping rather than ellipsising, so a title that needs two lines
         * gets two lines. The cut only exists for the pathological case: a
         * title long enough to push everything else off the desktop is
         * worth truncating, an ordinary one is not.
         */
        let titlePt = theme.pt(this._isNarrow ? 11 : 12);
        let titleLimit = theme.charsPerLine(contentWidth, titlePt) * MAX_TITLE_LINES;

        inner.add_child(this._label(
            Format.truncate(issue.title, titleLimit),
            theme.issueTitleStyle(this._isNarrow) + ' width: ' + contentWidth + 'px;',
            { wrap: true }));

        inner.add_child(this._spacer(theme.gap(3)));

        // The identifier is its own label so it can carry the accent while
        // the rest of the line stays quiet.
        let context = new St.BoxLayout({ vertical: false });
        context.add_child(this._label(issue.identifier, theme.identifierStyle(accent)));

        let trailing = [];
        if (issue.stateName)
            trailing.push(issue.stateName);
        if (issue.dueDate)
            trailing.push(Format.dueText(issue.dueDate, nowMs));
        if (this._isWide && issue.teamName)
            trailing.push(issue.teamName);

        if (trailing.length) {
            context.add_child(this._label(SEPARATOR + trailing.join(SEPARATOR),
                theme.contextStyle(), { expand: true }));
        }

        inner.add_child(context);
        row.set_child(inner);

        this._attachOpen(row, issue.url, styleFor);
        new TooltipLib.Tooltip(row, this._issueTooltip(issue, nowMs));
        return row;
    }

    // ------------------------------------------------------------------
    // Mentions
    // ------------------------------------------------------------------

    /*
     * The categories the user has left switched on, in the shape
     * Model.allowsCategory expects. Read fresh on every call rather than
     * cached, because these are plain rerender settings: flipping one
     * repaints the list without going near the network.
     */
    _categoryPrefs() {
        return {
            mentions: this.cat_mentions,
            reviews: this.cat_reviews,
            comments: this.cat_comments,
            assignments: this.cat_assignments,
            status: this.cat_status,
            subscriptions: this.cat_subscriptions,
            documents: this.cat_documents,
            reactions: this.cat_reactions,
            other: this.cat_other,
        };
    }

    // The whole filtered list, newest first. Not a page of it.
    _visibleActivity() {
        return Model.prepareMentions(this._mentions, {
            unreadOnly: this.unread_only,
            categories: this._categoryPrefs(),
        });
    }

    _renderMentions(theme, nowMs) {
        let visible = this._visibleActivity();

        if (!visible.length) {
            let message;
            if (this._hasFetchError)
                message = _('Could not reach Linear');
            else if (this.unread_only)
                message = _('Nothing unread.');
            else if (this._mentions.length)
                // There is activity; the category filter is hiding all of
                // it. Saying the inbox is empty would send the user looking
                // for a fault instead of a checkbox.
                message = _('Everything is filtered out.');
            else
                message = _('Nothing new.');
            this._renderEmpty(theme, message);
            return;
        }

        /*
         * The stored page index is handed over as a request, not as fact.
         * pageOf clamps it: between one render and the next a notification
         * can be read with "unread only" on, or a category switched off,
         * and the page that was showing may no longer exist.
         */
        let page = Model.pageOf(visible, this.max_mentions, this._page);
        this._page = page.page;

        let list = new St.BoxLayout({ vertical: true });

        page.rows.forEach((mention, position) => {
            let accent = Model.accentForMention(this.color_mode, mention, position);
            list.add_child(this._buildMentionRow(mention, accent, theme, nowMs));
            list.add_child(this._spacer(theme.gap(5)));
        });

        this._bodyBox.add_child(list);

        if (page.pageCount > 1)
            this._renderPager(theme, page);
    }

    /*
     * The pager. Rendered only when there is more than one page, so a short
     * list is not given a control that does nothing.
     *
     * The arrows are omitted at the ends rather than shown insensitive: St
     * has no disabled styling worth the name, and a button that looks
     * clickable and refuses is the same lie as a dead link.
     */
    _renderPager(theme, page) {
        let accent = ThemeLib.accentFor('position', {}, 0);

        this._bodyBox.add_child(this._spacer(theme.gap(4)));

        let bar = new St.BoxLayout({ vertical: false });

        if (page.page > 0) {
            bar.add_child(this._buildActionButton(_('\u2039 Newer'), accent, theme,
                () => this._goToPage(this._page - 1)));
        }

        let label = this._label(
            // Translators: a range of rows and the size of the whole list,
            // as in "11-20 of 79".
            _('%d\u2013%d of %d').format(page.first, page.last, page.total),
            theme.footerStyle() + ' margin: 0 ' + theme.px(8) + 'px;');
        label.x_expand = true;
        label.y_align = Clutter.ActorAlign.CENTER;
        bar.add_child(label);

        if (page.page < page.pageCount - 1) {
            bar.add_child(this._buildActionButton(_('Older \u203a'), accent, theme,
                () => this._goToPage(this._page + 1)));
        }

        this._bodyBox.add_child(bar);
    }

    /*
     * Turning a page costs no network traffic: the whole window is already
     * in hand and only the slice changes. Re-arms the walk back to the
     * first page, so the countdown measures idleness rather than the time
     * since the first arrow was pressed.
     */
    _goToPage(index) {
        this._page = Math.max(0, index);
        this._schedulePageReset();
        this._render();
    }

    /*
     * Builds one mention row: the actor and age on a header line, the text
     * of the mention below it as the row's largest element, and the issue
     * or document it concerns beneath that.
     */
    _buildMentionRow(mention, accent, theme, nowMs) {
        let row = this._clickableRow();
        let styleFor = (hovered) => mention.unread
            ? theme.emphasisRowStyle(accent, 0.45, hovered)
            : theme.rowStyle(accent, hovered);
        row.set_style(styleFor(false));

        let contentWidth = this._mentionContentWidth(theme);
        let inner = new St.BoxLayout({ vertical: false });

        if (!this._isNarrow)
            inner.add_child(this._buildAvatar(mention, accent, theme));

        let column = new St.BoxLayout({ vertical: true, x_expand: true });
        if (!this._isNarrow)
            column.set_style('padding-left: ' + theme.gap(8) + 'px;');

        // Who and when, with the unread dot pinned to the right.
        let headerRow = new St.BoxLayout({ vertical: false });
        headerRow.add_child(this._label(
            mention.actor || mention.title,
            theme.mentionActorStyle(mention.unread), { expand: true }));

        if (mention.createdMs) {
            headerRow.add_child(this._label(Format.sinceShort(nowMs - mention.createdMs),
                theme.tagStyle() + ' margin-left: ' + theme.px(6) + 'px;'));
        }
        if (mention.unread) {
            let dot = new St.Widget({ y_align: Clutter.ActorAlign.CENTER });
            dot.set_style(theme.unreadDotStyle(accent));
            headerRow.add_child(dot);
        }
        column.add_child(headerRow);

        let messagePt = theme.pt(11);
        let messageLimit = theme.charsPerLine(contentWidth, messagePt) * MAX_MESSAGE_LINES;

        /*
         * The headline is the remark where there is one. A mention in an
         * issue description, a review request and an assignment all carry
         * no comment, so the subject takes the slot instead.
         *
         * The row without a remark then needs the action beneath it. Once
         * the list covers the whole inbox rather than mentions alone, an
         * assignment, a status change, a review request and an approval all
         * reduce to the same actor and the same subject, and the row would
         * give no way at all to tell which had happened. It is not used on
         * the branch above because a remark speaks for itself, and because
         * the phrasing would only repeat the actor already in the header.
         */
        let headline;
        let context = '';

        if (mention.message) {
            headline = Format.preview(mention.message, messageLimit);
            context = mention.subject || mention.subtitle;
        } else if (mention.subject) {
            headline = Format.truncate(mention.subject, messageLimit);
            context = mention.action;
        } else {
            // Both fall back to the same composed phrase when Linear
            // supplied no title, so guard against printing it twice.
            headline = mention.title;
            context = mention.action === headline ? '' : mention.action;
        }

        column.add_child(this._spacer(theme.gap(3)));
        column.add_child(this._label(headline,
            theme.mentionMessageStyle(mention.unread) + ' width: ' + contentWidth + 'px;',
            { wrap: true }));

        if (context) {
            column.add_child(this._spacer(theme.gap(2)));
            column.add_child(this._label(
                Format.truncate(context, theme.charsPerLine(contentWidth, theme.pt(8.5))),
                theme.contextStyle()));
        }

        inner.add_child(column);
        row.set_child(inner);

        this._attachOpen(row, mention.url, styleFor, () => this._markRead(mention));
        new TooltipLib.Tooltip(row, this._mentionTooltip(mention, nowMs));

        return row;
    }

    /*
     * The tooltip for a mention: the full text of the remark, which the row
     * itself shows only a truncated line of.
     */
    _mentionTooltip(mention, nowMs) {
        let parts = [mention.title];

        if (mention.message) {
            parts.push('');
            parts.push(Format.messageText(mention.message, MAX_TOOLTIP_MESSAGE));
        }

        let context = mention.subtitle || mention.subject;
        if (context) {
            parts.push('');
            parts.push(context);
        }

        if (mention.createdMs)
            parts.push(Format.since(nowMs - mention.createdMs));

        return parts.join('\n');
    }

    /*
     * The actor's initials. Linear's avatar images sit behind the same API
     * key the desklet authenticates with, so showing them would mean a
     * second authenticated request per row and a cache of other people's
     * faces on disk. Initials carry the same "who" for neither.
     */
    _buildAvatar(mention, accent, theme) {
        let label = new St.Label({ text: Format.initials(mention.actor) });

        let bin = new St.Bin({
            x_align: St.Align.MIDDLE,
            y_align: St.Align.MIDDLE,
            child: label,
        });
        bin.set_style(theme.avatarStyle(accent));

        /*
         * A row is now as tall as the message inside it, and a St.Bin in a
         * vertical box stretches to fill. Left alone the avatar becomes a
         * tall rounded column down the side of the text rather than a disc
         * beside the name it belongs to.
         */
        let holder = new St.BoxLayout({
            vertical: true,
            y_align: Clutter.ActorAlign.START,
            y_expand: false,
        });
        holder.add_child(bin);
        return holder;
    }

    _markRead(mention) {
        if (!this.mark_read_on_click || !mention.unread || !mention.id)
            return;

        /*
         * Marking a notification read is a write, and Linear has no scope
         * covering notifications alone. A session authorized for reading
         * only cannot do it, so say so once rather than letting every click
         * fail silently against the server.
         */
        if (!this._auth.grantsScope('write')) {
            this._error = _('Marking rows read needs more access than was granted.');
            this._errorCode = 'SCOPE';
            this._render();
            return;
        }

        /*
         * Cleared locally first so the row responds to the click
         * immediately rather than after a network round trip. If Linear
         * refuses, the flag goes back and the next refresh would have
         * corrected it anyway.
         */
        mention.unread = false;
        this._patchRawReadState(mention.id);
        this._render();

        this._auth.withCredential((credential, failure) => {
            if (this._destroyed)
                return;
            if (!credential) {
                mention.unread = true;
                logError('could not mark a mention read: ' + failure.error);
                this._render();
                return;
            }

            Linear.markNotificationRead({
                apiKey: credential.apiKey,
                accessToken: credential.accessToken,
                timeout: this.http_timeout,
            }, mention.id, (result) => {
                if (this._destroyed || result.ok)
                    return;
                mention.unread = true;
                logError('could not mark a mention read: ' + result.error);
                this._render();
            });
        });
    }

    /*
     * Keeps the cached copy in step with the optimistic update, so a
     * restart before the next refresh does not resurrect a mention the
     * user has already dealt with.
     */
    _patchRawReadState(notificationId) {
        if (!this._raw || !this._raw.notifications || !this._raw.notifications.nodes)
            return;

        let changed = false;
        this._raw.notifications.nodes.forEach(function (node) {
            if (node && node.id === notificationId && !node.readAt) {
                node.readAt = new Date().toISOString();
                changed = true;
            }
        });

        if (changed)
            Linear.writeCache(this._cacheName(), this._raw);
    }

    // ------------------------------------------------------------------
    // Shared pieces
    // ------------------------------------------------------------------

    /*
     * Makes a widget open a URL, with the hover treatment and the cursor
     * bookkeeping that goes with being clickable.
     */
    _attachOpen(button, url, styleFor, afterOpen) {
        button.connect('enter-event', () => {
            button.set_style(styleFor(true));
            global.set_cursor(Cinnamon.Cursor.POINTING_HAND);
        });
        button.connect('leave-event', () => {
            button.set_style(styleFor(false));
            global.unset_cursor();
        });
        /*
         * The tick timer re-renders while the pointer is still down here,
         * destroying this button without ever sending leave-event, which
         * would strand the pointing-hand cursor across the whole desktop.
         */
        button.connect('destroy', () => {
            if (button.get_hover())
                global.unset_cursor();
        });
        button.connect('clicked', () => {
            this._openUrl(url);
            if (afterOpen)
                afterOpen();
        });
    }

    _buildActionButton(label, accent, theme, onClick) {
        let button = new St.Button({
            label: label,
            reactive: true,
            track_hover: true,
            can_focus: true,
        });

        let styleFor = (hovered) => theme.chipStyle(accent) +
            (hovered ? ' background-color: rgba(255,255,255,0.12);' : '');
        button.set_style(styleFor(false));

        button.connect('enter-event', () => {
            button.set_style(styleFor(true));
            global.set_cursor(Cinnamon.Cursor.POINTING_HAND);
        });
        button.connect('leave-event', () => {
            button.set_style(styleFor(false));
            global.unset_cursor();
        });
        button.connect('destroy', () => {
            if (button.get_hover())
                global.unset_cursor();
        });
        button.connect('clicked', onClick);

        return button;
    }

    _renderEmpty(theme, message) {
        this._bodyBox.add_child(this._label(message, theme.emptyStyle(), { wrap: true }));
    }

    _renderFooter(theme, nowMs) {
        let lines = [];

        if (this._activeTab === 'mentions') {
            let unread = Model.unreadCount(this._visibleActivity());
            if (unread)
                lines.push(ngettext('%d unread', '%d unread', unread).format(unread));
        } else if (this._issues.length) {
            lines.push(ngettext('%d issue assigned', '%d issues assigned',
                this._issues.length).format(this._issues.length));
        }

        if (this._usingCache && !this._lastSuccessMs)
            lines.push(_('showing the last saved copy'));

        if (lines.length) {
            this._bodyBox.add_child(this._spacer(theme.gap(6)));
            this._bodyBox.add_child(this._label(lines.join(SEPARATOR), theme.footerStyle()));
        }

        if (this._error) {
            this._bodyBox.add_child(this._spacer(theme.gap(8)));
            this._bodyBox.add_child(this._label(this._errorText(),
                theme.errorStyle(), { wrap: true }));
        }
    }

    /*
     * Maps an error code to text describing what the user can do about it.
     *
     * Several distinct conditions arrive as generic GraphQL errors, and
     * only some of them call for action, so the code is used rather than
     * the message Linear supplied.
     */
    _errorText() {
        switch (this._errorCode) {
            case 'AUTH':
                return this._usingOAuth
                    ? _('Linear refused this sign-in. Sign in again from the settings.')
                    : _('Linear refused that API key. Check it in the desklet settings.');
            case 'REAUTH':
                return _('Your Linear sign-in has expired. Sign in again from the settings.');
            case 'RATELIMITED':
                return _('Linear is rate limiting this key. Waiting before trying again.');
            case 'NOKEY':
                return this._usingOAuth
                    ? _('Not connected to Linear.')
                    : _('No API key set.');
            case 'SCOPE':
                return _('Marking rows read needs more access than was granted. Sign in again.');
            default:
                return this._error;
        }
    }

    // ------------------------------------------------------------------
    // Connecting
    // ------------------------------------------------------------------

    /*
     * Starts the browser sign-in.
     *
     * Called both from the desklet's own button and from the one in the
     * settings window, so it has to be safe to invoke twice.
     */
    _startConnect() {
        if (this._destroyed || this._connecting)
            return;

        if (!this._usingOAuth) {
            this.configureDesklet(0);
            return;
        }

        this._connecting = true;
        this._connectMessage = '';
        this._render();

        this._auth.connect({
            markRead: this.mark_read_on_click,
            port: this.oauth_port,
        }, (result) => {
            if (this._destroyed)
                return;

            this._connecting = false;

            if (!result.ok) {
                this._connectMessage = result.error;
                this._render();
                return;
            }

            this._connectMessage = '';
            this._error = null;
            this._errorCode = null;
            this._lastSuccessMs = 0;
            this._render();
            this._refresh(true);
            this._scheduleRefresh();
        });

        this._render();
    }

    _cancelConnect() {
        if (!this._connecting)
            return;
        this._auth.cancelConnect();
        this._connecting = false;
        this._connectMessage = '';
        this._render();
    }

    _disconnect() {
        this._auth.disconnect(() => {
            if (this._destroyed)
                return;
            this._issues = [];
            this._mentions = [];
            this._raw = null;
            this._viewer = null;
            this._error = null;
            this._errorCode = null;
            this._lastSuccessMs = 0;
            this._usingCache = false;
            this._connectMessage = '';
            this._syncAuthSettings();
            this._render();
        });
    }

    /*
     * Publishes the connection state into the settings window.
     *
     * oauth_status drives which rows the window reveals: the sign-in
     * button when there is no session, the account line and the sign out
     * button when there is, and neither while a personal API key is in
     * use. The settings window watches the file, so a row appears or
     * disappears without it being reopened.
     */
    _syncAuthSettings() {
        if (this._destroyed || !this.settings)
            return;

        let status = 'hidden';
        if (this._usingOAuth)
            status = this._auth.isConfigured && !this._auth.needsReauth
                ? 'connected' : 'disconnected';

        try {
            if (this.settings.getValue('oauth_status') !== status)
                this.settings.setValue('oauth_status', status);
        } catch (e) {
            logError('could not publish the connection state: ' + e);
        }

        if (status === 'connected')
            this._setAccountDescription(Model.describeAccount(this._viewer));
    }

    /*
     * Writes the account line shown above the sign out button.
     *
     * The text is a description rather than a value, because a value would
     * have to be rendered by an editable widget. Descriptions live in the
     * instance settings file next to the values, and Cinnamon's own
     * setOptions() updates widget metadata there the same way; unlike a
     * value it is read when the window builds its rows, so a change made
     * while the window is open appears the next time it is opened.
     */
    _setAccountDescription(text) {
        if (!text)
            return;

        try {
            let data = this.settings.settingsData;
            if (!data || !data.oauth_account)
                return;
            if (data.oauth_account.description === text)
                return;

            data.oauth_account.description = text;
            this.settings._saveToFile();
        } catch (e) {
            // Cosmetic: the buttons and the desklet itself still report
            // the connection state without it.
            logError('could not record the signed-in account: ' + e);
        }
    }

    /*
     * The settings window buttons. Cinnamon looks these up by the name in
     * settings-schema.json, so they are called on the desklet itself rather
     * than being bound like the other keys.
     */
    onConnectClicked() {
        this._startConnect();
    }

    onDisconnectClicked() {
        this._disconnect();
    }

    _selectTab(id) {
        if (id === this._activeTab)
            return;

        this._activeTab = id;
        // Coming back to a tab starts at the top. The page index is not
        // worth preserving across a trip to the issues list, and a stale
        // one would show page four to someone who just arrived.
        this._page = 0;
        this._clearPageReset();
        // Remembered even when the user has pinned a default, so switching
        // the setting back to "last used" resumes where they left off.
        try {
            this.settings.setValue('active_tab', id);
        } catch (e) {
            logError('could not remember the active tab: ' + e);
        }
        this._render();
    }

    /*
     * Opens a URL in the system browser.
     *
     * Uses the URI launcher rather than a shell command, and rejects any
     * scheme other than http and https. These URLs arrive from a remote
     * API and must not reach a command line.
     */
    _openUrl(url) {
        if (!url)
            return;
        if (!/^https?:\/\//i.test(url)) {
            logError('refusing to open a non-web link');
            return;
        }

        try {
            Gio.AppInfo.launch_default_for_uri(url, null);
        } catch (e) {
            logError('could not open the link: ' + e);
        }
    }

    /*
     * The workspace's own front page, derived from a URL we have already
     * been given. Linear's canonical URLs embed the workspace slug, and
     * guessing it would send the user somewhere that is not their team.
     */
    _linearHome() {
        let sources = [];
        if (this._issues.length)
            sources.push(this._issues[0].url);
        if (this._mentions.length)
            sources.push(this._mentions[0].url);

        for (let i = 0; i < sources.length; i++) {
            let match = /^(https:\/\/linear\.app\/[^/]+)/.exec(sources[i] || '');
            if (match)
                return match[1];
        }
        return 'https://linear.app/';
    }

    // ------------------------------------------------------------------
    // Data
    // ------------------------------------------------------------------

    _cacheName() {
        return String(this.instance_id || 'default');
    }

    _digest(data) {
        this._raw = data;
        this._viewer = Model.normaliseViewer(data.viewer);
        this._issues = Model.normaliseIssues(data.issues && data.issues.nodes);
        this._mentions = Model.normaliseMentions(
            data.notifications && data.notifications.nodes);

        // The account line in the settings window is only knowable once a
        // request has succeeded, so it is refreshed from every response.
        this._syncAuthSettings();
    }

    _refresh(force) {
        if (this._destroyed)
            return;

        if (!this._isConfigured) {
            // Abandon anything already running before clearing, or a
            // response belonging to the credential the user just removed
            // lands afterwards and puts its issues back on the desktop.
            this._abandonFetch();
            this._issues = [];
            this._mentions = [];
            this._raw = null;
            this._error = null;
            this._errorCode = null;
            this._lastSuccessMs = 0;
            this._render();
            return;
        }

        // A refresh already under way will deliver the same thing, so let
        // it finish rather than restarting the network work.
        if (this._inFlight && !force)
            return;

        /*
         * Backing off a rate limit. Linear's budget is generous enough that
         * reaching this means something else is using the same key, and
         * hammering it would only extend the penalty.
         */
        if (!force && this._rateLimitedUntil > Date.now())
            return;

        this._abandonFetch();
        this._cancellable = new Gio.Cancellable();
        this._inFlight = true;

        let cancellable = this._cancellable;

        // Render now so a cold start says it is working, instead of
        // claiming there is no work assigned for as long as the fetch takes.
        this._render();

        /*
         * Far more is fetched than is shown, because neither cut applied to
         * this list can be made on the server. Linear offers no filter on
         * read state at all, and NotificationFilter has no category field,
         * so "unread only" and the category checkboxes both trim the list
         * after it arrives. A window sized to the page would render empty
         * the moment a page's worth of rows turned out to be read, or to
         * belong to a category that is switched off.
         *
         * It is also what makes paging free: the whole window is in hand,
         * so turning a page is a slice rather than a request.
         */
        let fetchWindow = this.fetch_window;

        let request = (credential, allowRetry) => {
            Linear.fetchSnapshot({
                apiKey: credential.apiKey,
                accessToken: credential.accessToken,
                maxIssues: this.max_issues,
                fetchWindow: fetchWindow,
                timeout: this.http_timeout,
                cancellable: cancellable,
            }, (result) => {
                if (this._destroyed || cancellable.is_cancelled())
                    return;

                /*
                 * An access token can lapse between the expiry check and
                 * the request landing, and Linear can invalidate one early.
                 * Both arrive as a 401 and both are fixed by renewing once.
                 * Only once: a second failure is a real problem.
                 */
                if (allowRetry && this._auth.shouldRetryAfterRefresh(result.code)) {
                    this._auth.refresh((ok, failure) => {
                        if (this._destroyed || cancellable.is_cancelled())
                            return;
                        if (!ok) {
                            this._inFlight = false;
                            this._error = failure.error;
                            this._errorCode = failure.code;
                            this._render();
                            return;
                        }
                        this._auth.withCredential((renewed, renewFailure) => {
                            if (this._destroyed || cancellable.is_cancelled())
                                return;
                            if (!renewed) {
                                this._inFlight = false;
                                this._error = renewFailure.error;
                                this._errorCode = renewFailure.code;
                                this._render();
                                return;
                            }
                            request(renewed, false);
                        });
                    });
                    return;
                }

                this._inFlight = false;

                if (result.data) {
                    this._digest(result.data);
                    this._lastSuccessMs = Date.now();
                    this._usingCache = false;
                    Linear.writeCache(this._cacheName(), result.data);
                }

                if (result.ok && !result.error) {
                    this._error = null;
                    this._errorCode = null;
                    this._rateLimitedUntil = 0;
                } else {
                    this._error = result.error || _('Could not reach Linear');
                    this._errorCode = result.code;
                    if (result.code === 'RATELIMITED') {
                        // Trust the reset header when there is one, and fall
                        // back to a minute when there is not.
                        this._rateLimitedUntil = Date.now() +
                            (result.retryAfterMs || 60000);
                    }
                    logError('refresh failed (' + result.code + '): ' + result.error);
                }

                this._render();
            });
        };

        this._auth.withCredential((credential, failure) => {
            if (this._destroyed || cancellable.is_cancelled())
                return;

            if (!credential) {
                this._inFlight = false;
                this._error = failure.error;
                this._errorCode = failure.code;
                this._render();
                return;
            }

            request(credential, true);
        });
    }

    _abandonFetch() {
        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }
        this._inFlight = false;
    }

    /*
     * Shows whatever is already on disk so the desklet has content the
     * moment it appears, instead of an empty box until the network answers.
     * Reading it is asynchronous, so a live response may well arrive first;
     * in that case the stale copy is simply dropped.
     */
    _loadCache() {
        if (!this._isConfigured)
            return;

        Linear.readCache(this._cacheName(), (data) => {
            if (this._destroyed || this._lastSuccessMs || !data)
                return;
            try {
                this._digest(data);
            } catch (e) {
                logError('could not read the saved copy: ' + e);
                return;
            }
            this._usingCache = true;
            this._render();
        });
    }

    // ------------------------------------------------------------------
    // Timers
    // ------------------------------------------------------------------

    _scheduleRefresh() {
        this._clearRefresh();
        // A settings change arriving after removal would otherwise install
        // a timer that re-arms itself forever on a dead desklet.
        if (this._destroyed)
            return;

        // A fixed interval, so let the source repeat itself rather than
        // tearing it down and building a new one on every tick.
        let seconds = Math.max(60, (this.refresh_minutes || 5) * 60);
        this._refreshTimer = Mainloop.timeout_add_seconds(seconds, () => {
            if (this._destroyed) {
                this._refreshTimer = 0;
                return GLib.SOURCE_REMOVE;
            }
            this._refresh(false);
            return GLib.SOURCE_CONTINUE;
        });
    }

    _clearRefresh() {
        if (this._refreshTimer) {
            Mainloop.source_remove(this._refreshTimer);
            this._refreshTimer = 0;
        }
    }

    /*
     * Re-renders without going near the network, which keeps the relative
     * timestamps honest and lets a due date cross into overdue on its own.
     * Slower once the data has been sitting a while, because by then a
     * minute either way makes no visible difference.
     */
    _scheduleTick() {
        this._clearTick();
        if (this._destroyed)
            return;

        let fresh = this._lastSuccessMs &&
            (Date.now() - this._lastSuccessMs) < 3600000;
        let delay = fresh ? 60 : 300;

        /*
         * One-shot rather than repeating, because the interval is not
         * fixed: the next render is scheduled from the one after it.
         */
        this._tickTimer = Mainloop.timeout_add_seconds(delay, () => {
            this._tickTimer = 0;
            if (this._destroyed)
                return GLib.SOURCE_REMOVE;
            this._render();
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearTick() {
        if (this._tickTimer) {
            Mainloop.source_remove(this._tickTimer);
            this._tickTimer = 0;
        }
    }

    /*
     * Walks the activity list back to its first page once the user has
     * stopped paging.
     *
     * A desklet is glanced at, not driven, so a list left on page four is
     * showing week-old rows to someone who wanted to know what just
     * happened. The countdown is restarted by every page turn and held
     * while the pointer is over the desklet, so it measures idleness rather
     * than elapsed time.
     *
     * Deliberately not re-armed by _scheduleTick(): the sixty-second
     * re-render that keeps the relative timestamps honest must not touch
     * the page or the countdown, or a slow reader would be reset on the
     * renderer's schedule instead of their own.
     */
    _schedulePageReset() {
        this._clearPageReset();
        if (this._destroyed)
            return;

        // Nothing to go back to, or the feature is switched off.
        if (this._page === 0 || !this.page_reset_seconds)
            return;

        // Held rather than dropped: the leave-event re-arms it.
        if (this._root && this._root.get_hover())
            return;

        this._pageResetTimer = Mainloop.timeout_add_seconds(this.page_reset_seconds, () => {
            this._pageResetTimer = 0;
            if (this._destroyed)
                return GLib.SOURCE_REMOVE;
            this._page = 0;
            this._render();
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearPageReset() {
        if (this._pageResetTimer) {
            Mainloop.source_remove(this._pageResetTimer);
            this._pageResetTimer = 0;
        }
    }

    // ------------------------------------------------------------------
    // Settings reactions
    // ------------------------------------------------------------------

    _onQueryChanged() {
        this._error = null;
        this._errorCode = null;
        this._rateLimitedUntil = 0;
        this._lastSuccessMs = 0;

        // The credential itself may be what changed, and the authenticator
        // holds its own copy.
        this._auth.setMethod(this.auth_method);
        this._auth.setApiKey(this.api_key);
        this._auth.setTimeout(this.http_timeout);

        this._syncAuthSettings();
        this._render();
        this._refresh(true);
    }

    _onScheduleChanged() {
        this._auth.setTimeout(this.http_timeout);
        this._scheduleRefresh();
    }

    /*
     * Turning on mark-as-read after signing in leaves the session short of
     * the write scope, which would otherwise only surface as a failure on
     * the next click.
     */
    _onMarkReadChanged() {
        if (this.mark_read_on_click && this._usingOAuth &&
            this._auth.isConfigured && !this._auth.grantsScope('write')) {
            this._error = _('Marking rows read needs more access than was granted.');
            this._errorCode = 'SCOPE';
        } else if (this._errorCode === 'SCOPE') {
            this._error = null;
            this._errorCode = null;
        }
        this._render();
    }

    _onStyleChanged() {
        this._render();
    }

    /*
     * A setting that changes which rows are in the list, rather than how
     * they are drawn. Costs no network traffic - both cuts are made locally
     * on data already in hand - but the page index no longer means what it
     * meant, so the list starts again from the top.
     */
    _onFilterChanged() {
        this._page = 0;
        this._clearPageReset();
        this._render();
    }

    /*
     * Re-arms the walk back to the first page against the new interval.
     * Without this a timer already counting down would keep running on the
     * old one, and lowering the setting would appear to do nothing until
     * the next page turn.
     */
    _onPageResetChanged() {
        this._schedulePageReset();
    }

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    _onClicked(actor, event) {
        // A click on an issue is a click on that issue, not on the desklet
        // behind it. Without this, opening an issue could also fire the
        // desklet's own click action.
        if (event && this._originatesFromButton(event))
            return Clutter.EVENT_PROPAGATE;

        // Right-click belongs to the context menu, which Cinnamon opens
        // from the parent actor. Acting on it too means every attempt to
        // reach "Remove this desklet" also kicks off a network refresh.
        if (event && typeof event.get_button === 'function' && event.get_button() !== 1)
            return Clutter.EVENT_PROPAGATE;

        switch (this.click_action) {
            case 'refresh':
                this._refresh(true);
                break;
            case 'open':
                this._openUrl(this._linearHome());
                break;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _originatesFromButton(event) {
        let source = null;
        try {
            source = event.get_source();
        } catch (e) {
            return false;
        }

        // Walk up to the desklet root; a button anywhere along that path
        // means the click was already spoken for.
        let depth = 0;
        while (source && depth < 12) {
            if (source instanceof St.Button)
                return true;
            if (source === this._root)
                return false;
            source = source.get_parent();
            depth++;
        }
        return false;
    }

    on_desklet_added_to_desktop() {
        /*
         * Stored tokens are read from disk before anything else, because
         * whether the desklet is configured at all depends on them. Without
         * this wait, an OAuth user would see the sign-in prompt flash up on
         * every start before their existing session loaded.
         */
        this._auth.load(() => {
            if (this._destroyed)
                return;
            this._syncAuthSettings();
            this._loadCache();
            this._render();
            this._refresh(true);
            this._scheduleRefresh();
        });

        this._render();
    }

    on_desklet_removed() {
        this._destroyed = true;
        this._clearRefresh();
        this._clearTick();
        this._clearPageReset();
        this._abandonFetch();

        // Drops any half-finished sign-in, which would otherwise leave a
        // loopback port bound and a timer armed against a dead desklet.
        if (this._auth)
            this._auth.destroy();

        // Without this the settings manager keeps a live reference to a
        // dead desklet and goes on invoking its callbacks.
        try {
            this.settings.finalize();
        } catch (e) {
            logError('could not release settings: ' + e);
        }
    }
}

function main(metadata, deskletId) {
    return new LinearDesklet(metadata, deskletId);
}
