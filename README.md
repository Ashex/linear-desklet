# Linear desklet for Cinnamon

Your Linear work on the desktop: the issues assigned to you, and your Linear
inbox beside them.

![The Linear desklet showing the issues assigned to you, next to is a Linear desklet showing where you have been mentioned](https://github.com/Ashex/linear-desklet/blob/main/desklet.webp?raw=true)
## Features

- **Issues tab** — everything assigned to you that is not completed or
  cancelled. Titles are the largest thing on screen and wrap rather than
  truncate; identifier, state and due date sit quietly beneath. Rows glow in
  proportion to how urgent they are, so anything overdue stands out at a
  glance. Optionally grouped by team.
- **Activity tab** — your Linear inbox: mentions, review requests and pull
  request comments, replies on things you follow, assignments, status changes
  and the rest. Nine checkboxes decide which categories appear; reactions are
  off by default. Each row shows **what the person actually wrote**, with
  markdown stripped, and a line saying what happened where there is no remark
  to show; hovering shows it in full. Unread rows carry an accent border and a
  dot, and the tab carries an unread count. Opening one marks it read in
  Linear, exactly as opening it in the app would.
- **Two ways to sign in** — a personal API key, or a browser sign-in for
  workspaces where an admin has switched personal keys off.
- **One request per refresh.** The viewer, the issues and the notifications
  arrive in a single GraphQL document, so the default five-minute interval uses
  about 12 of the 1,500 requests an hour a personal key allows.
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

The authentication process uses a localhost callback URI, in case the callback 
URI is on a port used on your machine, switch to another under *Settings > Advanced*.

If you prefer to use your own oauth app, specify the OAuth Client ID under *Settings > Advanced*

### Personal API key

Paste a key from *Settings → Security and access → Personal API keys*.

**The key is stored in plain text** in
`~/.config/cinnamon/spices/linear@ashex/<instance>.json`, readable by
anything running as your user, and visible in the settings window.

OAuth tokens are kept out of that file: they go to
`~/.local/state/linear@ashex/tokens-<instance>.json`, created `0600`.
libsecret would be better, but GJS needs `Secret-1.typelib`, which is not
part of a default Mint install.

### Which OAuth scopes are requested

`read` only, unless *Mark a row read when you open it* is on, which also
needs `write`. Linear has no notification-specific scope and `write` is
workspace-wide, so it is not requested unless that feature is actually
wanted. Turning it on after signing in prompts you to sign in again.

## Settings

| Group | What is in it |
|---|---|
| Linear account | Sign-in method, API key or Connect/Disconnect |
| Issues | How many to show, whether to highlight the first, sort order, team grouping, how early a due date counts as imminent |
| Activity | Which notification categories to include, rows per page, how long before the list returns to the first page, how far back to fetch, unread only, whether opening one marks it read |
| Size and layout | Width, scale, density, header, which tab to open on |
| Appearance | Colour mode, surface opacity, neon glow, accent tinting, dark or light surface |
| Behaviour | Refresh interval, network timeout, what clicking the background does |
| Advanced | Sign-in port, your own OAuth Client ID |


## Known limitations

- **Some notification fields are marked internal by Linear.** The `title`,
  `subtitle` and `url` fields on notifications are what Linear's own inbox
  renders from, but they carry no compatibility promise. The client asks for
  them, and falls back to a reduced query plus locally composed wording if they
  ever stop validating. `tools/smoke-test.js` reports which path is in use.
- **Filtering happens client-side, both kinds.** Linear has no server-side
  filter on read state, and `NotificationFilter` has no `category` field, so
  "unread only" and the category checkboxes both trim the list after it
  arrives. The query therefore fetches a window far larger than one page —
  which is also what makes paging free.
- **Notification types are not an enum.** `Notification.type` is a plain
  `String`, so filtering the query by type fails silently when a name is wrong
  or when Linear adds one: the list simply comes back shorter, with no error.
  The desklet filters on `category` instead, and anything it does not
  recognise is shown rather than hidden.
- **Document notifications need the internal fields.** `DocumentNotification`
  exposes only a `documentId`, with no document object to build a link from,
  so those rows cannot be linked under the reduced fallback query and are
  dropped rather than shown as dead links. Every other kind has a public
  fallback.
- **The libsoup 2 code path is untested.** This was developed on a machine with
  libsoup 3 only (no `Soup-2.4.typelib`), so the Mint 20/21 branch has never been executed.
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
