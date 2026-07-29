# Development

```sh
node tools/test-logic.js     # 211 assertions over the pure logic modules
node tools/make-pot.js       # regenerate po/linear@ashex.pot

LINEAR_API_KEY=lin_api_... node tools/smoke-test.js
```

`tools/test-logic.js` runs the date, sorting, urgency, notification-fallback
and style-generation code under Node with a small GJS shim
(`tools/gjs-shim.js`), reproducing Cinnamon's `'use strict'` wrapper and its
relative `require`. It needs no Cinnamon and no network.

`tools/smoke-test.js` checks the shipped GraphQL documents against the live
API. It reads them out of `lib/linear.js` rather than copying them, so what it
validates is what ships. **Run it after any Linear API change** — see the note
on internal fields below. It prints no secrets.

After editing, reload with `Alt+F2` → `r`, and watch for errors in Melange
(`Alt+F2` → `lg`) or with:

```sh
dbus-send --session --print-reply --dest=org.Cinnamon /org/Cinnamon \
  org.Cinnamon.Eval string:'JSON.stringify(imports.ui.main._errorLogStack.slice(-5))'
```

### Two things that will bite you

**Do not put this desklet's modules on `imports.searchPath`.** `imports.lib`
is a single namespace shared by every xlet in the Cinnamon process. Agenda also
has a `lib/` directory, and whichever desklet imports it first wins — the other
then silently reads the first one's modules and fails with
`No JS module 'linear' found in search path`. Everything here is loaded through
Cinnamon's `require`, which resolves and caches by full path. Note that
`require` inside `lib/*.js` resolves relative to the **desklet root**, not to
the requiring file, which is why those modules ask for `./lib/...` too.

**`St.Button` does not fill.** It is an `St.Bin`, and an `St.Bin` defaults to
`x_fill=false` with `x_align=MIDDLE`: left alone it centres its child at the
child's natural width, so a row gets a full-width background with its text
floating in the middle of it. Every clickable row and card goes through
`_clickableRow()`, which sets `x_fill: true`.

### Reloading during development

```sh
./tools/reload.sh          # reload after a code change
./tools/reload.sh --check  # compare cached module sizes against disk
```

That syntax-checks first, then unloads and reloads the desklet in place.
The desktop is not restarted, no windows are disturbed, and settings are
kept.

Two ways of reloading that look reasonable and are not:

**Removing the desklet from `org.cinnamon enabled-desklets` and adding it
back deletes its settings.** Cinnamon's `_unloadDesklet` calls
`_removeDeskletConfigFile` on removal, so a configured API key is gone with
no warning and no undo.

**`Extension.reloadExtension()` reloads the modules but keeps the old
desklet object.** `_createDesklets` returns early when
`definitions[i].desklet` is already set, so new code loads while the running
instance keeps the old prototype - you edit, reload, see no change, and
debug a phantom. What works is unloading with `deleteConfig = false` and
loading again in a separate main-loop turn, which is what `reload.sh` does.

`cinnamon --replace` also works, but restarts the whole desktop and is
disruptive enough to be worth avoiding.

Cinnamon caches xlet modules by file size, and manually invalidating
`fileUtils.LoadedModules` corrupts the registry
(`getModuleByIndex(...) is undefined`). If a change seems not to take
effect, `./tools/reload.sh --check` compares what is cached against what is
on disk, before you go looking for the bug somewhere else.


### Tooltips

Cinnamon's stock `Tooltips.Tooltip` is not usable for the amount of text a
mention carries: it hangs its top-left corner off the pointer, never wraps,
and clamps horizontally but not vertically. A long remark therefore grows
into one enormous line that runs off the side of the screen, and a tall
tooltip near the bottom disappears past it.

`lib/tooltip.js` replaces it. It inherits Cinnamon's `TooltipBase`, which
already handles when to appear, and supplies its own `show`: measure, wrap
past a comfortable reading measure, centre under the pointer, and keep the
box inside the monitor - flipping above the pointer when there is no room
below. Panels are measured directly, because Cinnamon 6 has no
`getWorkAreaForMonitor`.

Two traps, both of which produce a tooltip sized for the *previous* row:

- **A St.Label reports a stale preferred width until it is allocated.**
  Call `clutter_text.allocate_preferred_size()` after setting the text and
  before measuring. Cinnamon's own tooltip does this in `set_text`.
- **An actor that has never been shown has never been allocated at all**,
  so the first measurement is near zero however it is taken. The label is
  shown - parked off-screen - before being measured.

Also: `max-width` in a style string constrains the box but does **not**
wrap; wrapping needs `line_wrap` on the `clutter_text` as well. And do not
try to trigger a hover by emitting a synthetic `enter-event` with a null
event object, which segfaults the shell.

### Schema drift

The notification fragments are **not symmetrical, and cannot be made so**.
Confirmed by introspecting the live schema:

| Type | Object-valued fields available |
|---|---|
| `IssueNotification` | `issue`, `comment`, `parentComment`, `team` |
| `ProjectNotification` | `project`, `document`, `projectUpdate`, `comment` |
| `DocumentNotification` | **none** — only `documentId` and `commentId` |

Asking for `document { … }` on a `DocumentNotification` returns HTTP 400 on
every refresh. Because Linear reports this as a transport-level status, and
because an empty inbox hides it entirely, it is easy to mistake for an
authentication problem. `tools/smoke-test.js` now checks every fragment
field against introspection, and `tools/test-logic.js` guards the specific
case.

The corollary: a document mention has no title or link of its own, so it
depends on the internal `url` and `title` fields. Under the reduced fallback
query there is no documented way to link one, and those rows are dropped
rather than rendered as something that looks clickable and is not.

### OAuth notes

- **Linear matches redirect URIs exactly, including the port.** It does not
  implement RFC 8252 §7.3, which would allow any port on a loopback address.
  Every port the desklet can use is therefore registered on the OAuth
  application in advance, and `CALLBACK_PORTS` in `lib/oauth.js` must not gain
  entries without registering them too. This is why the port setting is a fixed
  list rather than a free number.
- Ports sit above 61000, clear of the Linux default ephemeral range
  (`net.ipv4.ip_local_port_range`, usually 32768–60999), so they cannot collide
  with a transient outbound socket. The desklet tries each in turn.
- The listener binds with `add_address()` and `Gio.InetAddress.new_loopback()`.
  `add_inet_port()` binds the **wildcard** address and would expose the callback
  to the local network for the duration of the flow.
- `Gio.SocketService` rather than `Soup.Server`: libsoup's server API differs
  between 2 and 3, and the desklet already carries one version fork for the
  client.
- The PKCE challenge is base64url of the **raw** SHA-256 digest. GLib only
  returns a hex string, so it has to be unpacked to bytes first; encoding the
  hex directly yields a 64-character challenge that Linear rejects. There is a
  test against the RFC 7636 test vector — keep it.

### Using your own OAuth application

Register one in a Linear workspace you administer, add callback URLs for
whichever ports you intend to use, enable the **Public** toggle if it will be
authorized from other workspaces, and put its client ID in the desklet's
advanced settings.