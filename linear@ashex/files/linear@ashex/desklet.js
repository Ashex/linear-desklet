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
const Tooltips = imports.ui.tooltips;

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

function logError(message) {
    global.logError('[' + UUID + '] ' + message);
}

class LinearDesklet extends Desklet.Desklet {
    constructor(metadata, deskletId) {
        super(metadata, deskletId);

        this._issues = [];
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
            onStateChanged: () => this._render(),
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

        // A different credential, a different set of mention types or a
        // different page size all mean the answer we have is the wrong answer.
        let refetch = [
            'api_key', 'auth_method', 'max_issues', 'max_mentions', 'mention_scope',
        ];
        let reschedule = [
            'refresh_minutes', 'http_timeout',
        ];
        let rerender = [
            'show_focus_card', 'sort_mode', 'group_by_team', 'imminent_days',
            'unread_only', 'desklet_width', 'scale', 'density', 'show_header',
            'color_mode', 'surface_opacity', 'glow', 'tint_surface',
            'dark_surface',
        ];

        refetch.forEach((key) => this.settings.bind(key, key, this._onQueryChanged));
        reschedule.forEach((key) => this.settings.bind(key, key, this._onScheduleChanged));
        rerender.forEach((key) => this.settings.bind(key, key, this._onStyleChanged));

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
     * Whether there is a credential to try. Not whether it works: a revoked
     * key is still "configured", and the error it produces is more useful
     * than a setup prompt that ignores what the user already did.
     */
    get _isConfigured() {
        return !!(this._auth && this._auth.isConfigured);
    }

    get _usingOAuth() {
        return this.auth_method === 'oauth';
    }

    /*
     * Whether the last fetch failed, as opposed to any error being on
     * display. A scope complaint is not a reason to tell someone their
     * issue list could not be loaded when it loaded perfectly well.
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
     * A clickable row or card.
     *
     * St.Button is an St.Bin, and an St.Bin does not fill: left alone it
     * centres its child at the child's natural width. A row built that way
     * gets a full-width background with its text floating in the middle of
     * it, and a list of them looks like it was centred on purpose. Filling
     * horizontally while leaving the vertical alignment to centre the
     * content is what makes the rows line up on the left edge.
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
     * The usable text width inside the focused card. St will not wrap a
     * label that has been allowed to take its natural width, so anything
     * that needs to flow onto a second line has to be told how much room
     * it actually has. Deriving it from the configured width means it is
     * right on the very first paint rather than after a relayout.
     */
    _focusContentWidth(theme) {
        let width = this.desklet_width
            - theme.gap(14) * 2   // desklet padding
            - 2                   // desklet border
            - theme.gap(14) * 2   // card padding
            - 2                   // card border
            - theme.px(3)         // accent bar
            - theme.gap(12);      // gutter between bar and text column
        return Math.max(60, Math.round(width));
    }

    // The identifier column. Wide enough for a three-letter team key and a
    // four-digit number, which covers nearly every workspace.
    _identifierWidth(theme) {
        return theme.px(this._isWide ? 62 : 56);
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
        let unread = Model.unreadCount(this._mentions);

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
                    id: 'mentions',
                    label: _('Mentions'),
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

        let rest = sorted;

        if (this.show_focus_card) {
            let focus = sorted[0];
            rest = sorted.slice(1);
            this._renderFocusCard(focus, theme, nowMs);
            if (rest.length)
                this._bodyBox.add_child(this._spacer(theme.gap(10)));
        }

        if (!rest.length)
            return;

        // Grouping is applied to whatever the focused card did not take, so
        // the loudest issue stays at the top rather than being buried under
        // its team's heading.
        if (this.group_by_team) {
            let groups = Model.groupByTeam(rest);
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

        this._bodyBox.add_child(this._buildIssueList(rest, theme, nowMs));
    }

    _buildIssueList(issues, theme, nowMs) {
        let list = new St.BoxLayout({ vertical: true });

        issues.forEach((issue, position) => {
            let accent = ThemeLib.accentFor(this.color_mode, issue, position + 1);
            list.add_child(this._buildIssueRow(issue, accent, theme, nowMs));
            list.add_child(this._spacer(theme.gap(5)));
        });

        return list;
    }

    _renderFocusCard(issue, theme, nowMs) {
        let accent = ThemeLib.accentFor(this.color_mode, issue, 0);
        let urgency = Model.urgencyFor(issue, nowMs, this.imminent_days);
        let contentWidth = this._focusContentWidth(theme);

        let card = this._clickableRow();

        let styleFor = (hovered) => theme.focusCardStyle(accent,
            hovered ? Math.min(1, urgency + 0.15) : urgency);
        card.set_style(styleFor(false));

        let inner = new St.BoxLayout({ vertical: false });

        let barHeight = theme.px(this._isNarrow ? 44 : 56);
        let bar = new St.Widget();
        bar.set_style(theme.accentBarStyle(accent, barHeight));
        inner.add_child(bar);

        let column = new St.BoxLayout({ vertical: true, x_expand: true });
        column.set_style('padding-left: ' + theme.gap(12) + 'px;' +
            ' width: ' + contentWidth + 'px;');

        let eyebrow = Model.eyebrowFor(issue, nowMs);
        column.add_child(this._label(
            eyebrow ? eyebrow + SEPARATOR + issue.identifier : issue.identifier,
            theme.eyebrowStyle(accent)));
        column.add_child(this._spacer(theme.gap(6)));
        column.add_child(this._label(issue.title,
            theme.focusTitleStyle(this._isNarrow) + ' width: ' + contentWidth + 'px;',
            { wrap: true }));

        let meta = this._issueMeta(issue);
        if (meta) {
            column.add_child(this._spacer(theme.gap(4)));
            column.add_child(this._label(meta,
                theme.metaStyle() + ' width: ' + contentWidth + 'px;'));
        }

        if (issue.dueDate) {
            column.add_child(this._spacer(theme.gap(8)));
            let dueRow = new St.BoxLayout({ vertical: false });
            dueRow.add_child(this._label(Format.dueText(issue.dueDate, nowMs),
                theme.chipStyle(accent)));
            dueRow.add_child(new St.Widget({ x_expand: true }));
            column.add_child(dueRow);
        }

        inner.add_child(column);
        card.set_child(inner);

        this._attachOpen(card, issue.url, styleFor);
        new Tooltips.Tooltip(card, this._issueTooltip(issue, nowMs));

        this._bodyBox.add_child(card);
    }

    _issueMeta(issue) {
        let parts = [];
        if (issue.stateName)
            parts.push(issue.stateName);

        // "No priority" says nothing worth a slot in a one-line summary.
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

    _buildIssueRow(issue, accent, theme, nowMs) {
        let row = this._clickableRow();
        let styleFor = (hovered) => theme.rowStyle(accent, hovered);
        row.set_style(styleFor(false));

        let identifier = this._label(issue.identifier,
            theme.identifierStyle(accent, this._isNarrow ? null : this._identifierWidth(theme)));
        let due = issue.dueDate ? Format.dueTextShort(issue.dueDate, nowMs) : '';

        if (this._isNarrow) {
            /*
             * Stacked rows put the title on its own line, so the due date
             * rides alongside the identifier rather than floating on a
             * third line of its own.
             */
            let inner = new St.BoxLayout({ vertical: true });

            let topLine = new St.BoxLayout({ vertical: false });
            topLine.add_child(identifier);
            topLine.add_child(new St.Widget({ x_expand: true }));
            if (due)
                topLine.add_child(this._label(due, theme.tagStyle()));

            inner.add_child(topLine);
            inner.add_child(this._label(issue.title, theme.rowTitleStyle(false)));
            row.set_child(inner);

            this._attachOpen(row, issue.url, styleFor);
            new Tooltips.Tooltip(row, this._issueTooltip(issue, nowMs));
            return row;
        }

        let inner = new St.BoxLayout({ vertical: false });
        inner.add_child(identifier);

        let title = this._label(issue.title, theme.rowTitleStyle(false), { expand: true });
        title.x_expand = true;
        inner.add_child(title);

        // Between the title and the due date, where it reads as an aside
        // rather than competing with the issue itself.
        if (this._isWide && issue.stateName) {
            inner.add_child(this._label(issue.stateName,
                theme.tagStyle() + ' margin-left: ' + theme.px(6) + 'px;'));
        }

        if (due) {
            inner.add_child(this._label(due,
                theme.tagStyle() + ' margin-left: ' + theme.px(6) + 'px;'));
        }

        row.set_child(inner);
        this._attachOpen(row, issue.url, styleFor);
        new Tooltips.Tooltip(row, this._issueTooltip(issue, nowMs));
        return row;
    }

    // ------------------------------------------------------------------
    // Mentions
    // ------------------------------------------------------------------

    _renderMentions(theme, nowMs) {
        let mentions = Model.prepareMentions(this._mentions, this.unread_only, this.max_mentions);

        if (!mentions.length) {
            let message;
            if (this._hasFetchError)
                message = _('Could not reach Linear');
            else if (this.unread_only)
                message = _('No unread mentions.');
            else
                message = _('Nobody has mentioned you.');
            this._renderEmpty(theme, message);
            return;
        }

        let list = new St.BoxLayout({ vertical: true });

        mentions.forEach((mention, position) => {
            let accent = Model.accentForMention(this.color_mode, mention, position);
            list.add_child(this._buildMentionRow(mention, accent, theme, nowMs));
            list.add_child(this._spacer(theme.gap(5)));
        });

        this._bodyBox.add_child(list);
    }

    _buildMentionRow(mention, accent, theme, nowMs) {
        let row = this._clickableRow();
        let styleFor = (hovered) => mention.unread
            ? theme.unreadRowStyle(accent, hovered)
            : theme.rowStyle(accent, hovered);
        row.set_style(styleFor(false));

        let inner = new St.BoxLayout({ vertical: false });

        if (!this._isNarrow)
            inner.add_child(this._buildAvatar(mention, accent, theme));

        let column = new St.BoxLayout({ vertical: true, x_expand: true });
        if (!this._isNarrow)
            column.set_style('padding-left: ' + theme.gap(8) + 'px;');

        let titleRow = new St.BoxLayout({ vertical: false });
        let title = this._label(mention.title, theme.rowTitleStyle(!mention.unread),
            { expand: true });
        title.x_expand = true;
        titleRow.add_child(title);

        if (mention.createdMs) {
            titleRow.add_child(this._label(Format.sinceShort(nowMs - mention.createdMs),
                theme.tagStyle() + ' margin-left: ' + theme.px(6) + 'px;'));
        }
        if (mention.unread) {
            let dot = new St.Widget({ y_align: Clutter.ActorAlign.CENTER });
            dot.set_style(theme.unreadDotStyle(accent));
            titleRow.add_child(dot);
        }

        column.add_child(titleRow);

        if (mention.subtitle)
            column.add_child(this._label(mention.subtitle, theme.tagStyle()));

        inner.add_child(column);
        row.set_child(inner);

        this._attachOpen(row, mention.url, styleFor, () => this._markRead(mention));

        let tooltip = [mention.title];
        if (mention.subtitle)
            tooltip.push(mention.subtitle);
        if (mention.createdMs)
            tooltip.push(Format.since(nowMs - mention.createdMs));
        new Tooltips.Tooltip(row, tooltip.join('\n'));

        return row;
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
        return bin;
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
            this._error = _('Marking mentions read needs more access than was granted.');
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
            let unread = Model.unreadCount(this._mentions);
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
     * The error, phrased as something the user can act on. A rate limit and
     * a rejected key both produce a GraphQL error, but only one of them is
     * worth getting out of the chair for.
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
                return _('Marking mentions read needs more access than was granted. Sign in again.');
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
            this._render();
        });
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
     * Opens a Linear URL in whatever handles web links. Deliberately uses
     * the URI launcher rather than a shell command: these URLs come from a
     * remote API, and nothing from an API should ever reach a command line.
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
        this._viewer = data.viewer || null;
        this._issues = Model.normaliseIssues(data.issues && data.issues.nodes);
        this._mentions = Model.normaliseMentions(
            data.notifications && data.notifications.nodes);
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
         * More mentions are fetched than are shown, because Linear cannot
         * filter by read state on the server: with "unread only" on, a page
         * of exactly ten could contain ten read mentions and render empty.
         */
        let mentionPage = Math.min(50, Math.max(this.max_mentions * 3, 20));

        let request = (credential, allowRetry) => {
            Linear.fetchSnapshot({
                apiKey: credential.apiKey,
                accessToken: credential.accessToken,
                maxIssues: this.max_issues,
                maxMentions: mentionPage,
                mentionTypes: Model.mentionTypes(this.mention_scope),
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
            this._error = _('Marking mentions read needs more access than was granted.');
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
