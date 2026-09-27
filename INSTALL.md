# Installing Agent Office

Setup takes about 10 minutes:

1. Run the office.
2. Connect Claude Code.
3. Open a new session and watch your agent walk in.

## What you need

| | Desktop app (recommended) | Browser only |
|---|---|---|
| Computer | A Mac (Apple silicon or Intel) | macOS, Linux or Windows |
| To run it | Nothing: download the app (Apple silicon), or build it with Node 18+ and Rust | Node 18+ |
| Menu-bar icon and notifications | Yes | No |
| **Open chat** button and app logos | Yes | macOS only |

You also need [Claude Code](https://claude.com/claude-code) itself, either the Claude desktop app or the `claude` terminal command.

## 1. Get the code

```bash
git clone https://github.com/regisBafutwabo/agent-office.git
cd agent-office
```

The repo is private for now, so you need to be added to it first. You need this folder even if you download the app: step 3 installs the Claude Code plugin from it, and the hooks for other agents run a script from it.

## 2. Run the office

Pick one of the two options below.

### Option A: Desktop app (macOS)

This option gives you a 4 MB menu-bar app with the office server built in. It needs no Node or terminal.

**Download it (Apple silicon Macs):**

1. Get `Agent-Office_0.1.0_aarch64.dmg` from the [latest release](https://github.com/regisBafutwabo/agent-office/releases/latest).
2. Open it and drag **Agent Office** to Applications.
3. Open the app once. It isn't code-signed yet, so macOS blocks it.
4. Go to **System Settings → Privacy & Security** and click **Open Anyway**.

An office icon appears in the menu bar. Click it and choose **Open Agent Office**.

To start it automatically, add it in **System Settings → General → Login Items**.

**Or build it yourself (Intel Macs, or to run the latest code):**

1. Install the build tools, if you don't have them:

   ```bash
   xcode-select --install
   brew install node rustup
   rustup default stable
   ```

2. Build the app:

   ```bash
   cd desktop
   npm install
   npm run build
   ```

   The first build takes a few minutes. It produces:
   - `desktop/src-tauri/target/release/bundle/macos/Agent Office.app`
   - a `.dmg` in `desktop/src-tauri/target/release/bundle/dmg/`, for sharing

3. Move it to Applications and open it:

   ```bash
   cp -R "src-tauri/target/release/bundle/macos/Agent Office.app" /Applications/
   open "/Applications/Agent Office.app"
   ```

### Option B: Browser only (any OS)

```bash
npm install
npm start
```

Then open <http://localhost:4747>. The office runs as long as that terminal is open.

Don't run both options at once: they use the same port. If you do, the desktop app takes the port over as soon as it's free.

## 3. Connect Claude Code

Install the plugin once. It adds hooks that report what each session is doing.

```bash
claude plugin marketplace add "$(pwd)"      # run this from the agent-office folder
claude plugin install agent-office@agent-office
```

If you have access to the GitHub repo, `claude plugin marketplace add regisBafutwabo/agent-office` works too. Then you don't need a local folder for this step.

Now **open a new Claude Code session** and send a prompt, either in the desktop app or in a terminal with `claude`. Sessions that were already open don't have the hooks, so start a new one.

Your agent rides up in the lift and takes a desk on its project's floor.

## 4. Check that it works

- The office header says **Live** and counts your sessions.
- The agent appears under **Agents**, with a ↗ button that takes you back to its chat.

If nothing shows up, ask the office what it knows:

```bash
curl -s http://localhost:4747/api/state
```

- `"sessions":[]`: the hooks aren't reaching the office. See [Troubleshooting](#troubleshooting).
- Sessions are listed: reload the office page.

To look around without Claude Code, open <http://localhost:4747/?demo>.

## 5. Allow what macOS asks for (first use)

- **Notifications:** the desktop app asks once. Allow it to get an alert when an agent needs your permission.
- **Controlling Terminal or iTerm:** asked the first time you click **Open in Terminal**. Allow it so the office can select the right tab.

## Other coding agents (optional)

Codex, Cursor, Gemini CLI, Copilot CLI and others report through `adapters/hook.sh` in this folder. For example, Codex needs every hook in `~/.codex/hooks.json` to run:

```
"/full/path/to/agent-office/adapters/hook.sh" codex
```

Quote the path if it has spaces. Codex asks you to trust new hooks once. Copy-paste setups for every tool are in [docs/adapters.md](docs/adapters.md).

## Updating

```bash
git pull
claude plugin marketplace update agent-office
claude plugin update agent-office@agent-office
```

After that:
- **Desktop app:** download the newest release, or rebuild it (`cd desktop && npm run build`), and replace the copy in Applications.
- **Browser only:** restart `npm start`.

Start new Claude Code sessions to pick up new plugin versions.

## Uninstalling

```bash
claude plugin uninstall agent-office@agent-office
claude plugin marketplace remove agent-office
```

Then:
1. Quit Agent Office from its menu-bar icon.
2. Delete `/Applications/Agent Office.app`.
3. Remove any `adapters/hook.sh` lines you added to other agents' configs.

## Troubleshooting

**My agent doesn't appear.**
- Start a *new* session after installing the plugin.
- Check that `claude plugin list` shows `agent-office` as enabled.
- Check that the office is running (menu-bar icon, or `npm start`).

**"Port 4747 is already in use".**
Another copy of the office is running. Quit it, or stop the other `npm start`.

To use a different port, set `AGENT_OFFICE_PORT` for both the office and Claude Code, because the hooks read it too.

**The office says "Demo".**
It couldn't reach the server within a few seconds. Make sure you opened <http://localhost:4747>, not a saved file or the claude.ai preview.

**Open chat brings the app forward but not the chat.**
- **Claude:** the exact-chat link needs plugin 0.4.0 or newer and a session started after installing it.
- **Codex:** only threads in the Codex app open directly. Codex in a terminal opens the terminal tab instead.

**Logos show letters instead of app icons.**
Icons come from apps installed on your Mac. The browser-only office on Linux or Windows, and the claude.ai preview, show letters.

**Permission requests don't show Allow and Deny in the office.**
The office only holds a request while an office page is visible, for up to 45 seconds. Otherwise Claude Code asks you as usual.
