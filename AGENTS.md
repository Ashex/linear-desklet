# AGENTS.md

A Cinnamon **desklet** written in GJS (SpiderMonkey + GObject Introspection),
talking to Linear's GraphQL API. No build step, no package manager, no
dependencies. The shipped artefact is the directory that gets symlinked into
`~/.local/share/cinnamon/desklets/`.

`README.md` is unusually complete and is the user-facing counterpart to this
file; the "Development", "Two things that will bite you" and "OAuth notes"
sections there are authoritative. This file covers what an agent needs on top
of that.

## Layout

```
linear@ashex/
  info.json                       Spices metadata (author only)
  files/linear@ashex/             <- this subdirectory is what gets installed
    desklet.js                    the whole UI: one class, LinearDesklet
    metadata.json                 uuid, version, max-instances
    settings-schema.json          every user setting; also a translation source
    stylesheet.css                only the chrome; everything else is inline
    po/linear@ashex.pot           generated, do not hand-edit
    lib/                          pure-ish logic modules
tools/                            Node-side dev tooling, never shipped
```

The doubled `linear@ashex/files/linear@ashex/` nesting is the Cinnamon Spices
repository convention, not an accident. Paths inside the desklet are relative
to the **inner** directory.

## Commands

```sh
node tools/test-logic.js                      # 259 assertions, exit 1 on failure
node tools/make-pot.js                        # regenerate po/linear@ashex.pot
LINEAR_API_KEY=lin_api_... node tools/smoke-test.js   # validates GraphQL vs live API
./tools/demo.sh on|issues|mentions|grouped|raise|lower|off   # screenshot fixtures
```

- `test-logic.js` is the only test suite and needs no Cinnamon and no network.
  It runs `lib/*.js` inside `vm` contexts via `tools/gjs-shim.js`. Run it after
  every change to `lib/`.
- `make-pot.js` rewrites `POT-Creation-Date` on every run, so it always dirties
  the working tree even when no strings changed. Check `git diff` before
  committing the regenerated `.pot`; if the date line is the only change,
  revert it.
- `smoke-test.js` reads the query strings out of `lib/linear.js` by `vm`-evaluating
  the module with stubs, so it always tests what ships. Run it after any change
  to the GraphQL documents, and periodically regardless: several notification
  fields (`title`, `subtitle`, `url`) are marked internal by Linear and can
  disappear without deprecation.
- `demo.sh` injects fabricated data into the running desklet over the Cinnamon
  D-Bus `Eval` interface. It reaches into private members (`_digest`,
  `_clearRefresh`, `_activeTab`, `_isConfigured`), so renaming any of those
  breaks it silently.

There is no linter, no formatter, no CI configuration in this repo.

## Reloading while developing

`Alt+F2` → `r` restarts Cinnamon. Cinnamon caches xlet modules **by file size**,
so an edit that keeps the byte count identical will not be picked up, and
`reloadExtension` does not reliably rebuild a running desklet. Before debugging
a change that "did nothing", confirm the loaded size against `wc -c` using the
D-Bus snippet in `README.md`. `cinnamon --replace` (backgrounded) is the
reliable escape hatch and preserves windows.

Errors go to Melange (`Alt+F2` → `lg`) or the `_errorLogStack` D-Bus snippet in
`README.md`. `global.logError` is wrapped by a local `logError()` in each file
that prefixes the UUID.

## Module system (the biggest trap)

Modules are loaded with Cinnamon's `require`, never by pushing onto
`imports.searchPath`. `imports.lib` is a **process-wide namespace shared with
every other xlet**; the Agenda desklet also has a `lib/`, and whichever loads
first wins for everyone.

`require` paths resolve relative to the **desklet root, not to the requiring
file**. That is why files inside `lib/` still write `require('./lib/format')`.
Keep that form.

GJS module semantics apply: a top-level `var` or `function` is exported, a
`const`/`let` is not. The codebase uses this deliberately — `var ENDPOINT`,
`var Method`, `var Theme` are public; `const MAX_PAGE`, `const DAY` are private.
Adding a new export means declaring it `var`.

`tools/gjs-shim.js` reproduces this: it wraps each module in `'use strict';`
(matching Cinnamon) and harvests every non-stub top-level binding as an export.
When a lib module starts using a new GI symbol at module scope, the shim needs
a stub for it or `test-logic.js` will throw on load.

## Architecture

Single class `LinearDesklet` in `desklet.js` (~1500 lines) plus eight lib
modules. Data flows one way:

```
Auth.withCredential  ->  Linear.fetchSnapshot (one GraphQL document)
                     ->  Model.normalise*     (defensive, produces flat arrays)
                     ->  desklet._render()    (rebuilds the tree, styles from Theme)
```

- **`lib/auth.js`** — the single place that answers "do we have a usable
  credential". Two methods (`api_key`, `oauth`). Concurrent refreshes are
  collapsed onto one in-flight request. Everything credential-shaped goes
  through `withCredential(cb)`; nothing else touches tokens.
- **`lib/oauth.js`** — authorization code + PKCE, with a one-shot
  `Gio.SocketService` listener on loopback. See the OAuth notes in `README.md`
  before touching: ports are hard-registered with Linear (`CALLBACK_PORTS`
  cannot grow without registering upstream), the listener must bind
  `Gio.InetAddress.new_loopback()` via `add_address()` (never `add_inet_port()`,
  which binds the wildcard), and the PKCE challenge is base64url of the **raw**
  digest unpacked from GLib's hex string.
- **`lib/tokenstore.js`** — OAuth tokens in `~/.local/state/linear@ashex/tokens-<instance>.json`,
  mode `0600`, one file per instance, async I/O only (a sync read stalls the
  whole Cinnamon process). API keys, by contrast, live in Cinnamon's settings
  file in plain text; that is a known, documented exposure.
- **`lib/linear.js`** — GraphQL client, response cache read/write, and a
  libsoup 2/3 fork (`isSoup2()` on `Soup.MAJOR_VERSION`). **The libsoup 2 path
  has never been executed** — this machine ships libsoup 3 only. Note the
  auth quirk: personal API keys go in `Authorization` *verbatim*, OAuth tokens
  get the `Bearer ` prefix; getting this backwards produces an error
  indistinguishable from a bad key. GraphQL returns HTTP 200 on failure, and
  partial success (errors *and* data) is handled and rendered.
  `QUERY_FULL` / `QUERY_SAFE` are the internal-fields query and its fallback.
- **`lib/model.js`** — all defensiveness lives here so the renderer can assume
  complete input. Sorting, urgency, team grouping, mention subject/URL
  composition with locally built fallbacks.
- **`lib/theme.js`** — every colour and dimension, emitted as inline style
  strings because they are chosen at runtime. Ported from the Agenda desklet;
  the appearance settings intentionally mirror Agenda's keys and defaults.
- **`lib/tabs.js`**, **`lib/format.js`**, **`lib/i18n.js`** — tab bar widget,
  date/duration strings, gettext binding.

### Rendering

`_render()` destroys and rebuilds `_tabHolder` and `_bodyBox` children on every
call. There is no diffing and no widget reuse; anything stateful must live on
the desklet, not in a widget. `_render()` is the universal response to a state
change, and it re-arms `_scheduleTick()` (a one-shot timer, 60s when data is
fresh, 300s otherwise) so relative timestamps stay current.

Two independent timers: `_refreshTimer` (repeating, network) and `_tickTimer`
(one-shot, re-render only). Both check `_destroyed` before doing anything.

### Styling

Cinnamon's CSS engine supports only a subset of CSS: solid/rgba colours, border
radius, box shadow, two-stop gradients. Stay inside it. A `NaN` anywhere in a
style string makes St reject the whole string and the widget renders unstyled —
`Theme.update()` guards against that explicitly.

All dimensions go through `theme.px()` / `theme.pt()` / `theme.gap()` so one
scale or density change reflows everything. `gap()` additionally multiplies by
the density factor. Layout is driven by the configured width: below
`NARROW_WIDTH` (300) everything stacks, above `WIDE_WIDTH` (460) supporting
detail appears alongside titles.

**`St.Button` does not fill.** It is an `St.Bin`, which defaults to
`x_fill=false, x_align=MIDDLE`, so a row gets a full-width background with the
text floating in its centre. Every clickable row goes through `_clickableRow()`,
which sets `x_fill: true`. Similarly, Pango ellipsizing and wrapping are
mutually exclusive — `_label(text, style, {wrap: true})` turns ellipsizing off
explicitly, and a label that needs to wrap must be given an explicit width
(`_focusContentWidth()`).

## Conventions

- ES6 classes for the desklet and for `Authenticator` / `Theme` / `CallbackListener`;
  plain functions elsewhere. Private members are `_`-prefixed.
- 4-space indent, single quotes, semicolons, `let` over `const` for locals.
- String concatenation over template literals throughout — match it.
- Comments explain *why*, often at length, and frequently record a bug that was
  already paid for once. Do not delete them; new non-obvious code is expected to
  carry the same kind of note.
- Every user-visible string goes through `_()` / `ngettext()` from `lib/i18n.js`,
  and `settings-schema.json` descriptions/tooltips/option labels are extracted
  too. Adding a string means re-running `make-pot.js`.
- The UUID is resolved at runtime from `imports.ui.deskletManager.deskletMeta`
  against `CANDIDATE_UUIDS` (`linear@ashex`, `devtest-linear@ashex`) rather than
  hardcoded, because the Spices `test-spice` script installs under the prefixed
  name and a hardcoded UUID makes the two installs share settings and
  translations. Do not hardcode it. `I18n.bind(UUID)` must run before any string
  lookup.
- Settings are bound in `_bindSettings()` into three buckets by consequence:
  `refetch` (invalidates the data), `reschedule` (timers), `rerender` (visual
  only). A new setting goes in the right bucket or it will either not take
  effect or trigger needless network traffic.
- Async callbacks all begin by checking `this._destroyed` and, where a
  `Gio.Cancellable` is in scope, `cancellable.is_cancelled()`. Keep that guard
  on anything new.

## Gotchas worth knowing before you touch something

- **One request per refresh** is a design constraint, not an accident: a
  personal key allows 1500 requests/hour. Do not add a second round trip to the
  refresh path.
- **Unread filtering is client-side.** Linear has no server-side read-state
  filter, so `_refresh()` deliberately requests `max(max_mentions * 3, 20)`
  capped at 50 and trims after. Reducing the over-fetch makes "unread only"
  render empty.
- **`mark_read_on_click` requires the `write` scope**, which is workspace-wide
  and therefore not requested unless the setting is on. Toggling it on after
  signing in forces a re-auth; `_onMarkReadChanged()` surfaces that as a
  `SCOPE` error, which is deliberately excluded from `_hasFetchError` so it does
  not claim the issue list failed to load.
- Marking read is optimistic: the local flag flips, `_patchRawReadState()`
  rewrites the on-disk cache so a restart does not resurrect the mention, and
  the flag is restored if the mutation fails.
- **Rate limiting**: a 429 sets `_rateLimitedUntil` from the reset header
  (fallback 60s) and non-forced refreshes are skipped until it passes.
- `on_desklet_removed()` must cancel timers, cancel in-flight requests, call
  `_auth.destroy()` (or a half-finished sign-in leaves a loopback port bound)
  and `settings.finalize()` (or the settings manager keeps calling into a dead
  desklet).
- No avatars by design — Linear's avatar images sit behind the same credential,
  so `Format.initials()` is used instead.
- The README claims `test-logic.js` runs 211 assertions; it is currently 259.
  Treat the number as informational.
