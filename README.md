# Linear desklet for Cinnamon

Your Linear work on the desktop: the issues assigned to you, and the places
someone has mentioned you. 


## Features

- **Issues tab** — everything assigned to you that is not completed or
  cancelled. The most pressing issue is promoted to a card with an accent bar
  and a glow that intensifies as its due date approaches. Optionally grouped
  by team.
- **Mentions tab** — only true mentions, in issues, comments and documents
  (optionally projects and pull requests too). Unread mentions carry an accent
  border and a dot; the tab carries an unread count. Opening one marks it read
  in Linear, exactly as opening it in the app would.
- **Two ways to sign in** — a personal API key, or a browser sign-in for
  workspaces where an admin has switched personal keys off.
- **One request per refresh.** The viewer, the issues and the mentions arrive
  in a single GraphQL document, so the default five-minute interval uses about
  12 of the 1,500 requests an hour a personal key allows.
- **Survives a bad network.** The last good response is cached, so a dropped
  connection shows stale data with a note rather than an empty desklet.
- **Four colour modes** — by priority, by workflow state, by the colour Linear
  itself uses for the state, or a fixed rainbow by list position. Borrowed
  Linear colours are brightened until they clear a 4.5:1 contrast ratio
  against the desklet surface.

## Requirements

Cinnamon 5.6 or newer (for libsoup 3). Developed and verified against
**Cinnamon 6.6.7**.

## Install

```sh
git clone <this-repo> ~/git/linear-desklet
ln -s ~/git/linear-desklet/linear@ashex/files/linear@ashex \
      ~/.local/share/cinnamon/desklets/linear@ashex
```

Then add it from *System Settings → Desklets*.

## Signing in

Two options, chosen in the desklet's settings.

### Browser sign-in (OAuth)

Click **Sign in with Linear**. Your browser opens Linear's consent page, and
the desklet briefly listens on `127.0.0.1` to receive the reply. Nothing is
pasted, and no long-lived credential appears in the settings window.

Use this if your workspace does not allow personal API keys — an admin can
switch off member key creation under *Settings → Administration → API*, and
that setting does not apply to admins, so "it works for me" is not evidence
it works for everyone.

The flow uses PKCE, so there is no client secret and the client ID in
`lib/oauth.js` is public by design. Access tokens last 24 hours and are
renewed automatically with a rotating refresh token.

### Personal API key

Paste a key from *Settings → Security and access → Personal API keys*.
Simpler, never expires.

**The key is stored in plain text** in
`~/.config/cinnamon/spices/linear@ashex/<instance>.json`, readable by
anything running as your user, and visible in the settings window. This is
the same exposure every other token-using Cinnamon xlet has. Use a key you
are willing to revoke.

OAuth tokens are kept out of that file: they go to
`~/.local/state/linear@ashex/tokens-<instance>.json`, created `0600`.
libsecret would be better, but GJS needs `Secret-1.typelib`, which is not
part of a default Mint install.

### Which scopes are requested

`read` only, unless *Mark a mention read when you open it* is on, which also
needs `write`. Linear has no notification-specific scope and `write` is
workspace-wide, so it is not requested unless that feature is actually
wanted. Turning it on after signing in prompts you to sign in again.

## Settings

| Group | What is in it |
|---|---|
| Linear account | Sign-in method, API key or Connect/Disconnect |
| Issues | How many to show, whether to highlight the first, sort order, team grouping, how early a due date counts as imminent |
| Mentions | Which mention types to include, how many, unread only, whether opening one marks it read |
| Size and layout | Width, scale, density, header, which tab to open on |
| Appearance | Colour mode, surface opacity, neon glow, accent tinting, dark or light surface |
| Behaviour | Refresh interval, network timeout, what clicking the background does |
| Advanced | Sign-in port, your own OAuth application ID |

The appearance keys deliberately mirror Agenda's, with the same defaults, so
the two desklets stay visually matched when you adjust one.

## Development

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

Cinnamon caches xlet modules by file size. Editing a file usually changes its
size and so triggers a reload, but `reloadExtension` does **not** reliably
rebuild a running desklet, and manually invalidating `fileUtils.LoadedModules`
corrupts the registry (`getModuleByIndex(...) is undefined`). When a change
does not appear to take effect, confirm it before debugging a phantom:

```sh
dbus-send --session --print-reply --dest=org.Cinnamon /org/Cinnamon \
  org.Cinnamon.Eval string:'
    let F = imports.misc.fileUtils;
    F.LoadedModules.filter(m => m && m.path && m.path.includes("linear@ashex"))
     .map(m => m.path.split("/").pop() + " " + m.size).join(", ")'
```

If those sizes disagree with `wc -c`, restart the shell: `cinnamon --replace`
in the background. Windows are preserved.

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

## Known limitations

- **Some notification fields are marked internal by Linear.** The `title`,
  `subtitle` and `url` fields on notifications are what Linear's own inbox
  renders from, but they carry no compatibility promise. The client asks for
  them, and falls back to a reduced query plus locally composed wording if they
  ever stop validating. `tools/smoke-test.js` reports which path is in use.
- **Unread filtering happens client-side.** Linear has no server-side filter on
  read state, so the query deliberately fetches more mentions than it shows.
- **The libsoup 2 code path is untested.** It is written to match the shape used
  by the `bbcwx` and `yfquotes` desklets, but this machine ships libsoup 3 only
  (no `Soup-2.4.typelib`), so the Mint 20/21 branch has never been executed.
- **No avatars.** Linear's avatar images sit behind the same API key, so showing
  them would mean a second authenticated request per row and a cache of other
  people's faces on disk. Initials are used instead.
- **OAuth tokens are not in a keyring.** `Secret-1.typelib` is not part of a
  default Mint install, so they live in a `0600` file instead.

## Licence and terms

MIT License. That licence covers this desklet's own source code and nothing
else.

- [Terms of Use](TERMS.md)
- [Privacy Policy](PRIVACY.md)

The short version of both: this runs entirely on your own machine, talks
only to `api.linear.app`, and the author operates no server and receives no
data. Your credentials, your workspace's rules and your machine's security
are yours to look after. Provided as is, with no warranty.

**"Linear" and "linear.app" are trademarks of Linear Orbit, Inc., who also
own the copyright in the Linear service.** This is an unofficial,
third-party client, not made by, endorsed by or affiliated with them. Their
name is used only to describe what the desklet connects to. No Linear
artwork is bundled; the icon is original. The issues and mentions the
desklet displays belong to you and your organisation, not to the author,
who never sees them.
