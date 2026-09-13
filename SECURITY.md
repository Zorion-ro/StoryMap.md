# Security policy

## Supported versions

StoryMap.md is at `0.1.0`. Only the latest release receives fixes.

## Reporting a vulnerability

**Please do not open a public issue, pull request or discussion for a security
problem, and please do not post details anywhere public before we have had a
chance to respond.** Public disclosure before a fix exists puts users at risk.

Report it privately through GitHub:

1. go to the **Security** tab of
   [this repository](https://github.com/Zorion-ro/StoryMap.md/security);
2. choose **Report a vulnerability**, which opens a private advisory visible only
   to you and the maintainers.

If that option is not available to you, please contact the maintainers privately
through the [Zorion-ro](https://github.com/Zorion-ro) organisation profile and
ask for a private channel — without describing the vulnerability in the request.

Please include what you can: affected version, the steps to reproduce, and what
an attacker gains. A proof of concept helps enormously.

We will acknowledge your report and tell you whether we consider it a
vulnerability. If we do, we will agree a disclosure timeline with you and credit
you in the advisory unless you would rather we did not.

## Scope

StoryMap.md is a local developer tool. It:

- binds `127.0.0.1` by default and applies no authentication, so binding it to a
  public interface with `--host` exposes your repository to that network — that
  is expected behaviour, not a vulnerability;
- serves only its own packaged CSS and JavaScript from disk, never arbitrary
  repository files;
- can change work items through its JSON API. Without `--api-token` that API
  answers only requests addressed to a loopback host name, refuses cross-origin
  requests and non-JSON mutations, and refuses writes when bound beyond
  loopback;
- writes work items and map files from the browser only through
  `POST /api/stories/bulk`, which accepts a request only when it is
  `application/json`, carries no foreign `Origin`, and names a loopback address
  or the `--host` address in its `Host` header;
- makes no network calls, stores no credentials and sends no telemetry.

Things we would very much like to hear about: path traversal out of the
configured project directories, any route that serves a file outside the
packaged assets, HTML injection from work-item or map content, a way to make the JSON API write
from a web page or a non-loopback client without the token, and anything that
lets a crafted repository run code when it is merely read.
