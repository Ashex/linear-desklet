# Privacy Policy

**Last updated:** 27 July 2026

This policy covers the Linear desklet for the Cinnamon desktop.

## The short version

**The author collects nothing, receives nothing, and stores nothing.**

There is no server. The desklet runs entirely on your computer and talks
directly to Linear's API. No data reaches the author, because there is
nowhere for it to go. There is no analytics, no telemetry, no crash
reporting, no update check, and no "anonymous usage statistics".

Everything below is detail supporting that sentence, and can be verified
against the source, which is published in full.

## What data is involved

The desklet asks Linear's API for:

- **Your identity as Linear reports it** — your name and display name, used
  only to confirm which account is connected.
- **Issues assigned to you** — identifier, title, priority, due date,
  workflow state, team, project, last-updated time, and the link back to
  Linear.
- **Notifications where you were mentioned** — the type of mention, when it
  happened, whether you have read it, who mentioned you, the issue or
  document concerned, and the link to it.

That is everything. The desklet does not request your issue descriptions,
the body text of comments, your colleagues' details beyond the name of
whoever mentioned you, your organisation's billing data, or anything from
your computer outside its own settings.

## Where that data goes

**To your screen, and to two files on your own disk. Nowhere else.**

The desklet makes network connections to exactly these places:

| Destination | Why |
|---|---|
| `api.linear.app` | The API itself, and OAuth token exchange and revocation |
| `linear.app` | The consent page, opened in your browser during sign-in |
| `127.0.0.1` (your own machine) | Receives the reply from that consent page |

There are no other destinations. No third-party service, no CDN, no
analytics endpoint, no error-reporting service. You can confirm this
yourself: every URL in the source is one of the three above.

## What is written to your disk

### Response cache

- **Where:** `~/.cache/linear@ashex/snapshot-<instance>.json`
- **What:** the most recent API response — the issue and mention data listed
  above, including titles and links.
- **Why:** so the desklet shows your work the moment it appears, rather
  than an empty box until the network answers, and keeps showing something
  useful when the network fails.
- **Permissions:** created owner-only.
- **Removing it:** delete the file, or the whole `~/.cache/linear@ashex/`
  directory. It is rebuilt on the next refresh.

### OAuth tokens, if you use browser sign-in

- **Where:** `~/.local/state/linear@ashex/tokens-<instance>.json`
- **What:** the access token, the refresh token, when the access token
  expires, and which scopes were granted.
- **Permissions:** created with mode `0600` — readable and writable only by
  your user account. The desklet re-asserts this on every write rather than
  assuming it.
- **Removing it:** click **Disconnect**, which deletes the file and asks
  Linear to revoke the grant. Deleting the desklet's instance also removes
  it.

### Personal API key, if you use one instead

- **Where:** in Cinnamon's own settings file for the desklet,
  `~/.config/cinnamon/spices/linear@ashex/<instance>.json`
- **Stored unencrypted**, with whatever permissions Cinnamon gives that
  file, and visible in plain text in the desklet's settings window.

This is worth stating bluntly: **anything running as your user account can
read that key**, and it grants access to your Linear account. This is not a
choice made by this desklet — it is how the Cinnamon settings system stores
every value, and it affects every Cinnamon xlet that accepts a token.

There is no keyring option, because GJS needs `Secret-1.typelib` for
libsecret and that is not part of a default Linux Mint installation. If
this exposure concerns you, use browser sign-in instead: those tokens go to
the `0600` file above, never into Cinnamon's settings, and are never shown
on screen.

## What is never written or transmitted

- Your credentials are **never written to any log**. The desklet logs
  failures, but never the value of a key or token. On the two occasions it
  logs a storage problem, it reports the filesystem error alone.
- Nothing is written into the desklet's own installation directory.
- No credential is ever sent anywhere except `api.linear.app`.
- No data is sent to the author, under any circumstances, ever.

## About the sign-in listener

During browser sign-in, and only then, the desklet opens a listening socket
on your own machine to receive Linear's reply.

- It is bound to `127.0.0.1` explicitly, so it is **not reachable from your
  local network or the internet** — only from your own computer.
- It exists only for the duration of the sign-in: it closes the instant the
  reply arrives, and gives up after five minutes.
- It serves one small confirmation page and accepts nothing else.
- The exchange uses PKCE, so a code intercepted on that socket is useless
  without a secret that never leaves the desklet's memory.

## Who else is involved

**Linear.** The desklet is an unofficial client for their API. What Linear
collects, logs and retains about your API usage is governed by
[Linear's own privacy policy](https://linear.app/privacy), not this one.
Linear Orbit, Inc. is a separate company with no involvement in this
desklet; "Linear" and "linear.app" are their trademarks, and the data the
desklet displays is held in their service under your own agreement with
them.

**Your browser.** Sign-in opens Linear's consent page in whichever browser
your system is set to use. That browser's own history, cookie and data
handling apply.

**Nobody else.** There are no other processors, sub-processors, partners or
recipients, because there is no service to have any.

## Your control

- **See everything it holds:** read the two files named above. They are
  ordinary JSON.
- **Delete everything:** remove the desklet, then delete
  `~/.cache/linear@ashex/`, `~/.local/state/linear@ashex/` and
  `~/.config/cinnamon/spices/linear@ashex/`.
- **Cut off access at the source:** revoke the API key or the application
  authorization in Linear, under *Settings → Security and access*. That
  works regardless of what is on your disk, and is the only step that
  matters if a machine is lost.
- **Verify any of this:** the source is published. Every network call and
  every file write described here can be found in `lib/linear.js`,
  `lib/oauth.js` and `lib/tokenstore.js`.

## Children

The desklet is a tool for using a workplace issue tracker. It is not
directed at children and collects nothing from anyone.

## Changes

This policy may be revised. The version that applies is the one distributed
with the copy of the desklet you are running. Because there is no service,
a change here can only ever describe what the software does on your own
machine — it can never retroactively affect data that was collected, since
none is.

## Contact

Through the project's public repository. Please do not send credentials,
tokens, or screenshots containing them.
