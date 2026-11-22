# Security policy

## Reporting a vulnerability

Please don't open a public issue for a security problem. Report it privately instead:

1. Go to the [Security tab](https://github.com/regisBafutwabo/agent-office/security) of this repository.
2. Click **Report a vulnerability** and describe what you found, how to reproduce it, and what an attacker could do with it.

You'll get a reply within 7 days. Once a fix is released, the advisory is published with credit to you, unless you'd rather stay anonymous.

## Supported versions

Only the [latest release](https://github.com/regisBafutwabo/agent-office/releases/latest) gets security fixes. The desktop app updates itself, so most people are on it within a few hours of a release.

## What counts

Agent Office runs on your own computer and listens only on `127.0.0.1`. These are in scope:

- Reading sessions, prompts or code, or answering permission requests, without the office's `ui-token`.
- Reporting events or asking for permission without the `hook-token`.
- A web page, another account on the same computer, or a DNS-rebinding page reaching the office.
- The review window or a model pack serving a file outside what it should.
- Code running in the office page that the page didn't ship, such as script injected through a session name, prompt or file name.
- The desktop app's updater installing something that isn't a signed release.

Out of scope: anything that needs the attacker to already run code as you on your computer, since they could then read the keys and your agents' files directly.

How the office protects itself is described in [How it works](README.md#how-it-works) and in the [security review](docs/security-review-2026-11-20.md).
