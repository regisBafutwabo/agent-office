# Pre-release security review — 2026-11-20

Reviewed commit: `66aa81b`. Original recommendation: hold public release until the authentication and filesystem issues below were fixed and regression-tested. An independent review agreed with the hold and calibrated most findings as Medium.

**Status (second pass, committed on top of `66aa81b`):** findings 1–4 are fixed in both the Node bridge and the Rust desktop server, with negative and positive regression tests. The second pass closed the release blockers left by the first: the hook upgrade path, browser sign-in (now tested in a browser), one-time codes when the bridge holds the port, the bridge's non-loopback binding, the Windows `zip` advisories, and a strict script policy for the office page. See [Second pass](#second-pass-release-blockers) for what was done and how it was checked, and [Remaining risks](#remaining-risks) for what is still open.

The original review was a source review with safe local reproductions, not a penetration test. No real approval decisions were sent. Every file-access test, original and new, uses disposable files that contain only `AUDIT_FIXTURE_ONLY`.

## Threat model used for severity

- **Same-user processes are out of scope.** They already own the hook settings, the data folder and the agents themselves.
- **Other local accounts are a real boundary.** On a multi-user Mac they can reach loopback, but they cannot read files that are mode 0600 in your home folder.
- **Web pages are a real boundary**, including DNS-rebinding pages and other `localhost` ports.
- **Untrusted repositories and packs** can contain symlinks and active files. Abusing them needs a reader on the API (before the fix) or a navigation by the user.

## 1. Medium (High on shared multi-user machines): unauthenticated localhost read and approval access — fixed

Original locations: `desktop/src-tauri/src/server.rs:226`, `:455`; `bridge/server.js:32`, `:133`, `:157`.

Neither server authenticated callers. Requests without an Origin header were accepted, and Host was not validated:

- Any local account could read state and code.
- Any local account could toggle **Show code** and presence.
- Any local account could send `decide` for held permission requests.
- A request without Origin but with a foreign `Host` (the DNS-rebinding shape) could read `/api/state`, and could read code on the Node bridge.
- A foreign Origin was already refused, which blocked rebinding POSTs and WebSockets.

**Fix (both servers, `bridge/auth.js`, `desktop/src-tauri/src/auth.rs`):**

- **Two per-user keys.** Both are stored in the data folder (`~/Library/Application Support/Agent Office`, `~/.config/agent-office` on Linux, or `$AGENT_OFFICE_DATA`):
  - `ui-token` is the office page's key. It reads state, changes, diffs and packs, and allows setup, logs, faces, the WebSocket and decisions.
  - `hook-token` is the hooks' key, stored as a curl header line. It can only POST `/hook` and `/permission`, and it cannot read anything or decide anything.
- **Key files.** Each file is created with `O_CREAT|O_EXCL` and mode 0600, in a folder created 0700. The servers open the files with `O_NOFOLLOW` and refuse a file owned by another user. If a file has looser permissions, they set it back to 0600. Both servers share the files, so hooks and pages work with whichever server is running.
- **Separate checks per path.** `/hook` and `/permission` need `X-Agent-Office-Token`. Everything under `/api/` (except `/api/app-icon/*` and the one-time `/api/login`) needs `Authorization: Bearer <ui-token>`. `/ws` needs the key offered as the subprotocol `agent-office.token.<key>`, and the server answers `agent-office`. Keys are compared in constant time.
- **Strict Host and Origin.** `Host` must be `localhost`, an IPv4 or IPv6 literal, or a name listed in `AGENT_OFFICE_ALLOWED_HOSTS`, always on the server's own port. A rebinding attack needs its own domain name in Host, so it is refused. If a browser sends `Origin`, it must equal `http://<Host>`. `null`, other ports and other sites are refused.
- **Bootstrap without a public token.** No served asset contains a key, and nothing gives out a key without a secret:
  - The desktop window opens `http://localhost:<port>/#k=<ui-token>`. The URL stays inside the process, and fragments are never sent over HTTP.
  - **Open in browser** goes through `/usr/bin/open`, whose arguments other users can see in `ps`. So it passes only a one-time code (`#code=`), valid for 60 seconds and accepted once, which the page exchanges at `POST /api/login`.
  - `npm start` prints `http://localhost:4747/#k=<ui-token>` to its own terminal, the same pattern Jupyter uses.
  - The page keeps the key in `localStorage`, which is scoped to its origin and port, unlike cookies, which `localhost` shares across ports. The page removes the key from the address bar at once.
- **The permission fallback is preserved.** `permission.sh` uses `curl -sf`. If the key file is missing, a 401 comes back, or nobody is watching, it prints nothing, and Claude Code shows its own dialog.
- **The office page cannot be framed.** It is served with `X-Frame-Options: DENY` and `frame-ancestors 'none'`, because its buttons approve commands.

**Hook and adapter updates:**

- `plugin/hooks/send.sh`, `plugin/hooks/permission.sh` and `adapters/hook.sh` read the key with `curl -H @<file>`, so the key never appears on a command line. If the file is missing, the scripts exit silently, and Cursor and Gemini still get `{}`.
- The OpenCode and Amp plugins read the same file.
- The plugin version is now 0.5.0, so `update_plugin_if_newer` pushes the new scripts. The app also refreshes its installed copy of `hook.sh` for Codex and Cursor at startup (`setup::refresh_hook_script`).

**Tests:**

- `bridge/server.test.js` runs a separate bridge process with its own HOME, data folder, packs folder and free port.
- The Rust tests in `server::tests` use in-process routers on free ports with fixed test keys.
- `bridge/auth.test.js` and `auth::tests` cover file permissions, symlinked key files, Host and Origin parsing, constant-time comparison and single-use codes.
- `scripts/hooks.test.mjs` checks that the key is never in curl's arguments and that the hooks stay silent when the key file is missing.

The negative cases cover:

- Every `/api/*` read with no key, with the hook key (as bearer and as header), and with a wrong key.
- `/hook` and `/permission` with no key and with the page key.
- `/api/setup/<tool>`, `/api/log` and `/api/face` without the page key. The positive setup path is deliberately not exercised in tests, because it would change the machine's hooks.
- A WebSocket with no key, the hook key, a wrong key, a foreign Origin, another port, or a rebinding Host.
- Forged Host values (`evil.example`, `localhost.evil.example`, the wrong port, no port) and forged Origins (another site, another `localhost` port, `null`).
- An intruder socket trying to open while a decision is pending.

The positive cases cover:

- State, changes and diff reads with the page key.
- A LAN-IP Host.
- A full hold-and-deny of a permission request with the page key, and the immediate 204 when nobody is watching.
- Exchanging a one-time code, and the code failing on reuse.

## 2. Medium: filesystem confinement ignored symlinks, and diffs read any path — fixed

Original locations: `desktop/src-tauri/src/changes.rs:166`, `desktop/src-tauri/src/packs.rs:37`, `desktop/src-tauri/src/server.rs:480`; `bridge/changes.js:114`, `bridge/packs.js:27`.

The original review reproduced this on Node: an untracked repository symlink, or a pack symlink, disclosed an outside file. Exploiting it needed someone who could read the API, which was unauthenticated before fix 1. After fix 1, it needs the page's key.

**Fix (both servers):**

- `fileDiff` / `file_diff` only accept a path the card lists, meaning tracked changes since the base, plus untracked files that aren't ignored. Unchanged, ignored, `.git/*` and out-of-tree paths are refused.
- Untracked files are checked with `lstat` first: a symlink is described as `Symbolic link` and never followed. The file's canonical path must be inside the canonical checkout root, and it is opened with `O_NOFOLLOW`.
- Line counts and fingerprints use `lstat` too, so they reveal nothing about a link's target.
- Reads are bounded before allocation. New files are read up to 800 KB, sized from `fstat`. Git diff output is capped at 800 KB: Node uses `maxBuffer` and keeps the partial output, and Rust uses `git_upto`, which stops git. Both are then cut to 200,000 characters and marked `truncated`.
- Git runs with `GIT_LITERAL_PATHSPECS=1`.
- Pack files must canonicalize inside the canonical packs folder, must be regular files, and must be at most 64 MB.

**Tests:** both servers check that a changed file and a new file are shown. They also check that `same.txt` (unchanged), `secret.env` (ignored), `.git/config`, `../outside.txt`, absolute paths and an empty path are refused without leaking fixture text. A symlink to an outside fixture shows `Symbolic link`. On packs, a symlink to an outside texture is refused.

## 3. Medium, conditional on installing and opening an untrusted pack: active pack content on the privileged origin — fixed

Original locations: `desktop/src-tauri/src/server.rs:480`; `bridge/server.js:120`; `bridge/packs.js:27`.

**Fix (both servers):**

- Packs serve only an allowlist of types: `.glb`, `.gltf`, `.bin`, `.png`, `.jpg`/`.jpeg`, `.webp` and `.ktx2`. The `Content-Type` is fixed per extension and never guessed. HTML, SVG, JS, JSON (including `pack.json`) and every other type get a 403.
- Every pack response carries `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox` and `Cross-Origin-Resource-Policy: same-origin`. Even if someone opens the URL directly, the response runs as an opaque-origin document with no script. It can't be same-origin with the office.
- All other responses carry `nosniff` as well.

**Tests:** a `.glb` is served with its type, `nosniff` and `sandbox`. `.html`, `.svg`, `pack.json` and `.js` from a pack get a 403, in both servers and in the `packs` unit tests.

## 4. Medium (local denial of service): a malformed request crashed the Node bridge — fixed

Original location: `bridge/server.js:127`. `GET /%ZZ` made `decodeURIComponent` throw outside error handling, and the Node process exited. The Rust server was not affected.

**Fix:**

- Every bridge request runs inside one `handle()` whose rejection becomes a response. A `URIError` becomes a 400. Anything else is logged and becomes a 500, and only that request ends.
- URLs are parsed against a fixed base, so a malformed `Host` can't throw.
- Hook and permission bodies must be JSON objects, otherwise the answer is 400. This applies to both servers.
- WebSocket messages must be text JSON objects with a string `type`. `focus` and `decide` also check their field types. The server registers a socket `error` handler, so a bad frame ends only that connection.
- Both servers cap a WebSocket message at 64 KB.

**Tests:**

- `/%ZZ`, `/api/app-icon/%ZZ.png` and `/packs/kit/%ZZ` are refused.
- The bodies `{`, `null`, `5`, `"x"`, `[1]` and an empty body get a 400.
- The socket messages `null`, `5`, `"x"`, `[]`, `{"type":5}`, a `focus` with an object id, a `decide` with an object id, non-JSON text and a binary frame are all ignored.
- A 70 KB message closes only that socket.
- After each step, the test checks that the server still answers. The bridge is also checked end to end with real curl.

## 5. Dependency advisories — updated where feasible, triaged otherwise

OSV was queried again on 2026-11-20 for all 560 registry packages in `desktop/src-tauri/Cargo.lock`. `cargo audit` is still unavailable.

**Updated (semver-compatible, lockfile only):**

| Package | Before | After | Advisory |
|---|---|---|---|
| `rustls-webpki` | 0.103.15 | 0.103.16 | RUSTSEC-2026-0382 |
| `tokio` | 1.53.1 | 1.53.3 | RUSTSEC-2026-0386 |
| `rustix` | 1.1.5 | 1.1.6 | RUSTSEC-2026-0486 |
| `webpki-root-certs` | 1.0.9 | 1.0.10 | RUSTSEC-2026-0383 |

- `rustls-webpki` is in the macOS updater tree. Exploitability was not demonstrated, and updater signature verification is a separate defense.
- `tokio` is patched for the unsound `AsyncFd` constructors.
- `rustix` is patched for the xattr buffer issue.
- `webpki-root-certs` updates the distrusted emSign roots. It is not in the macOS tree.

The re-resolution also moved some Windows-only `windows-sys` edges between 0.59, 0.60 and 0.61. This has no effect on macOS.

**Remaining matches (12 packages, none a demonstrated macOS runtime exposure):**

- **`zip` 4.6.1:** 9 advisories, fixed in 9.x. It is pulled in only by `tauri-plugin-updater` 2.12.0, under `cfg(target_os = "windows")`, and is absent from the `aarch64-apple-darwin` tree. The updater checks the minisign signature before it extracts anything, so exploiting it would need a signed malicious archive. This is not a macOS blocker. It is a **Windows release blocker** until an updater release moves to `zip` 9.x. Do not force a major version under the plugin.
- **Unmaintained or unsound notices, mostly on Linux or build paths:**
  - `chrono` 0.4.45 (RUSTSEC-2026-0543, unmaintained; not in the macOS normal-dependency tree)
  - `glib` 0.18.5 and `proc-macro-error` 1.0.4 (GTK and Linux build paths)
  - `zbus_names`, `zvariant` and `zvariant_derive` (Linux D-Bus, unmaintained)
  - `unic-*` 0.9.0 (unmaintained, through Tauri's URL-pattern dependency, on macOS too)

  None needs action for a macOS release. Revisit them when Tauri updates.

`npm audit` reports 0 vulnerabilities for both the root and `desktop/`.

## Other observations

- **The suspected XSS through agent IDs is not supported by the code.** Agent rows put `a.id` into `data-id` and `data-open` without escaping. But `a.id` is generated by `createAgent()` as `'a' + (++seq)` (`web/index.html`, `createAgent`), not taken from the hook's raw `session_id`. Server-supplied names, activity, project and app labels go through `esc()` in the rows checked. This was a targeted check, not a full DOM-XSS audit.
- **Focus handlers** use app allowlists and validate chat and TTY identifiers, which is unchanged. **Updates** go through Tauri's signed-update flow.

## Validation (second pass)

- `npm test`: 116 of 116 pass.
- `cargo test` in `desktop/src-tauri`: 77 of 77 pass.
- `cargo clippy --all-targets`: no warnings in `auth.rs`, `server.rs`, `setup.rs` or `main.rs`.
- `cargo tree -i zip` finds no `zip` for the Windows, Linux and macOS targets.
- The inline scripts in `web/index.html` parse.
- Browser, Tauri and install checks are described above.
- The running office on port 4747 was not contacted during testing. It was only quit and replaced for the install.

## Validation (first pass)

- `npm test`: 108 of 108 pass. This includes the new `bridge/auth.test.js` and `bridge/server.test.js`, the extended `scripts/hooks.test.mjs` and the rewritten `bridge/packs.test.js`.
- `cargo test` in `desktop/src-tauri`: 73 of 73 pass, with the new `auth::tests` and `server::tests`, and the updated `changes` and `packs` tests. `cargo build` and `cargo clippy --all-targets` report no new warnings in the files touched here.
- **End to end with real curl:** an isolated bridge ran on port 14761 with a disposable HOME and data folder.
  - `send.sh` and `adapters/hook.sh codex` delivered events that showed up in `/api/state` when it was read with the page key.
  - `permission.sh` with nobody watching printed nothing.
  - Unauthenticated `/api/state` returned 401, and `/%ZZ` returned 400, after which the bridge still answered.
  - The key files were 0600 inside a 0700 folder.
- The inline scripts in `web/index.html` pass `node --check`.
- The running office on port 4747 was not contacted. No real approval decisions were sent.

## Second pass: release blockers

### A. Upgrading hooks that are already installed — resolved

Hooks from before the keys send none and get a 401. That stays: accepting keyless events, even temporarily, would reopen finding 1. Instead, nothing about the refusal is silent, and permission requests stay safe.

- **Refusals are reported, once per kind.** Both servers record `{agent, reason, count, at}` for each kind of refused hook: `no-key` (hooks that predate the keys) or `wrong-key` (a different data folder, or a rotated key). The agent name is kept only if it matches `[a-z0-9-]{1,32}`, otherwise it becomes `unknown`. Nothing from the request body is kept, and at most 16 kinds are stored. The first refusal of a kind is broadcast to office pages (`hooks-outdated`), included in later snapshots (`outdatedHooks`), and logged. The desktop app also shows a notification. The page shows what to do, including a **Copy command** button for the Claude Code plugin update.
- **Old plugins are found ahead of time.** At startup the app updates a plugin it installed itself (unchanged, plugin 0.5.0). If the plugin was installed from elsewhere and is older than 0.5.0, the app shows a notification with the update command, and the bridge prints it (`bridge/upgrade.js`, `setup::outdated_plugin_notice`).
- **The permission fallback is safe for old and new hooks.** A refused request gets a 401 with an **empty body** on both servers. The old `permission.sh` prints the body only if it isn't empty, and the new one uses `curl -sf`, so in both cases Claude Code shows its own dialog. Nothing is held, so no page can answer a refused request.
- **Codex and Cursor:** the app's copy of `hook.sh` is refreshed at launch, as before. Copies from a clone of the repo are updated by `git pull`. The refusal notice covers both cases.
- INSTALL.md has a troubleshooting entry for each install path: app, clone, Codex or Cursor, OpenCode or Amp, and a mismatched `AGENT_OFFICE_DATA`.

Tests: `bridge/server.test.js` and `server::tests::hooks_without_the_key_get_an_empty_refusal_and_the_office_says_they_need_updating` check the empty 401 body for a keyless `/permission` while a page is watching, the notice and snapshot contents (no payload text), the `wrong-key` and `unknown` cases, the count, and that nothing is held. In the Rust test, the app callback is called once per kind. Another bridge test runs the real `plugin/hooks/permission.sh` with a stale key against a watched office and checks that it prints nothing and exits 0. `bridge/upgrade.test.js` and `setup::tests::a_plugin_from_before_the_hook_key_is_reported` check the version check.

Not tested: a real `claude plugin update` from 0.4.2 to 0.5.0. It would change this machine's Claude Code configuration.

### B. Browser sign-in — tested in a browser

An isolated bridge ran on port 14762 with a disposable HOME, data folder and packs folder. All keys and codes were fixture values. No real session was contacted, and no approval decision was sent.

| Check | T3 Code preview (Chromium 152, Electron 44, incognito profile) | Safari 26.5.2 |
|---|---|---|
| No key: needs-key message, then demo | yes | not checked |
| `#code=` sign-in, code file consumed, address cleaned, live mode | yes | yes: the code file was consumed, the page then sent an authenticated `/api/log`, and a WebSocket stayed open more than 20 s |
| Key kept across reload | yes | not checked |
| Reused code refused, needs-key message | yes | not checked |
| Stale key in `localStorage`: needs-key message, demo | yes | not checked |
| Signing in again with a new code replaces the stale key | yes | not checked |
| `#k=` sign-in, address cleaned, live mode | yes | not checked |
| Hook events appear; an outdated-hook notice shows live and again on reload | yes | not checked |

- **Bug found and fixed:** pasting a `#k=` or `#code=` link into an office tab that was already open only changed the fragment, so the page ignored it. The page now reloads on a `hashchange` that carries `k` or `code`.
- Google Chrome itself isn't installed here, so Chrome for Testing 127 stood in for it.
- **Safari was checked through the server only.** Driving Safari needs Remote Automation, which wasn't enabled, so the Safari rows above are the server-side signals listed.
- **Chrome:** Chrome for Testing 127, from a local Puppeteer cache, with a temporary profile, driven over DevTools: signed in with a `#code=`, went live, showed no script-policy violations, loaded GLTFLoader and blocked an injected handler.
- **The Tauri window:** see [Build and install](#build-and-install).

### C. "Open in browser" while the bridge holds the port — resolved

One-time codes are no longer kept in the desktop process. They are files in the data folder that either server can redeem:

- Each code is an empty file, `login-codes/<sha256 of the code>`, created `O_EXCL` with mode 0600. The `login-codes` folder is checked to be a real folder owned by the user and is set to 0700.
- Redeeming checks the 64-hex format, `lstat`s the file and deletes it. Only one deletion can succeed, so a code works once. The file must be a regular file (not a symlink) owned by the user and less than 60 s old. Expired files are swept when a new code is made.
- The bridge now serves `POST /api/login` too. It is behind the same Host and Origin checks.
- If the app can't write the folder, the browser opens without a code and the page shows the needs-key message.

Tests: in Rust, a code made by the app is redeemed by the app's router, and a file in the bridge's format is redeemed by the app's router. In Node, a file in the app's format is redeemed by the bridge, and a code made by the bridge is redeemed directly. Both suites check the same SHA-256 file-name vector. Both check one use, expiry, symlinks, folder permissions and a foreign Host. In the browser, codes made in the bridge's format signed in both the preview browser and Safari, as above.

### D. The bridge on a non-loopback address — resolved

The bridge now refuses to start unless `AGENT_OFFICE_HOST` is `127.0.0.1`, `127.x.x.x`, `::1` or `localhost`. It exits 1 with a message that recommends SSH port forwarding, which keeps the traffic encrypted and the Host as `localhost`. There is no override. A test checks that `0.0.0.0`, `192.168.1.20` and `::` are refused. The desktop server only ever binds loopback.

### E. `zip` 4.6.1 (Windows) — resolved by removing it

- **Cause:** `zip` came only from `tauri-plugin-updater`'s default `zip` feature. That feature is needed only to unpack `.zip` updates on Windows (Tauri v1-format artifacts) and `.tar.gz` AppImages on Linux.
- **Why it isn't needed:** this app publishes v2 updater artifacts (`createUpdaterArtifacts: true`), meaning raw installers on Windows and Linux. On macOS, `tar` and `flate2` are unconditional dependencies of the plugin, so the `.app.tar.gz` update path doesn't use the feature.
- **Fix:** the updater is now `default-features = false, features = ["rustls-tls", "system-proxy"]`. `zip` (and `arbitrary`, `derive_arbitrary`) are gone from `Cargo.lock`, and `cargo tree -i zip` finds no `zip` for the Windows, Linux and macOS targets.
- **Not done:** no major version was forced, and updater 3.0 is alpha only. A Windows or Linux build and update was not run, because no cross toolchain is installed (the only Rust target here is `aarch64-apple-darwin`). If a Windows release ever ships v1-format `.zip` updates, this feature has to come back, together with a `zip` release that fixes the advisories.

### F. A strict script policy for the office page — done

- **The policy (both servers):** `script-src 'self'` plus the SHA-256 of each inline `<script>`, computed from the page that is served. It also sets `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`, `frame-ancestors 'none'`, and `connect-src 'self' ws://<the validated Host> data: blob:`. Styles keep `'unsafe-inline'` (the page sets many inline styles), with Google Fonts allowed, and images allow `data:` and `blob:` (canvas snapshots and glTF textures).
- **Effect:** markup that slips into the page through `innerHTML` can't run handlers or scripts, so it can't read the key in `localStorage`. The page has no inline event handlers, and a test checks that. The CDN fallback for three.js is now blocked, but it only applies when the page isn't served by an office, and then the policy isn't sent either.
- **Tests:** both servers check that every inline script's hash is in the policy and that `script-src` has no `unsafe-*`, wildcard or remote origin.
- **In the browser:**
  - The page, the GLTFLoader that loads later, and the fonts all loaded.
  - An injected `<img onerror>` was blocked (`script-src-attr`) and did not run.
  - Safari ran the page's scripts under the policy and reported no errors.
- **Not checked in the browser:** loading a real glTF pack, which uses `blob:` images.

### Build and install

The new release build ran **in isolation** before it was installed: a fake HOME, the fixture data folder, and port 14762. The installed app was quit first, because the single-instance lock is a fixed `/tmp` socket.

- **The bridge held the port:**
  - The app logged that the port was busy and that it would use the office already running there.
  - Its window (WKWebView) loaded the bridge's page with `#k=` from the shared key file. It sent an authenticated page report and kept a WebSocket open.
  - **Open in browser**, clicked in the tray menu through System Events, made a code file that the bridge then consumed. The browser was the default one, Dia; its tab itself was not inspected.
- **The app took over the port** once the bridge stopped:
  - The window's WebSocket reconnected to the app's server.
  - `/api/state` returned 200 with the key and 401 without it.
  - A code in the bridge's format was redeemed by the app's server for the right key, and a second use returned 401.
  - The page carried `script-src 'self'` plus three hashes.
  - A keyless `/permission` got a 401 with a 0-byte body and showed up in `outdatedHooks`.
  - Reopening the window from the tray loaded the page from the app's server and opened a second authenticated WebSocket.

## Remaining risks

1. **The key lives in `localStorage`.** The script policy above limits who can read it, but injected CSS (styles allow inline) or a bug in the page's own scripts still could. Browser history may keep the first `#k=` URL; the history file is per-user. Delete `ui-token` and restart the office to rotate the key.
2. **Sessions that were running during an update** keep using the old hooks until they restart. The office says so (A), but it can't show those sessions.
3. **Narrow time-of-check races.** Swapping a parent folder for a symlink between the canonical check and `O_NOFOLLOW` open needs write access to the checkout, the packs folder or the data folder. That is the same user, which is out of scope.
4. **Same-user processes** can still forge events, including `cwd`, and read both keys and any unused sign-in code. This is by design.
5. **A local account can create outdated-hook notices** by sending keyless requests. They can't read anything or hold a request. At most 16 kinds are kept, one notification each.
6. **Malformed input:** the cases listed in finding 4 are tested. This is not a proof that every malformed input is handled, and no fuzzing was done.
7. **Not covered:**
   - Windows and Linux runtime testing (see E)
   - Google Chrome's stable channel (Chrome for Testing 127 stood in)
   - Driving Safari beyond the server-side signals
   - Multi-user impersonation on a real shared Mac
   - A review of the signed and notarized release artifact (the local install below is ad-hoc signed)
   - A Git-history secret scan
