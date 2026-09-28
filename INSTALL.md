# Installing Agent Office

There are two ways to get it:

- **[Desktop app](#desktop-app-mac)** (Mac, recommended): download it, open it, and click **Connect**. No terminal, no repo. About 2 minutes.
- **[From source](#from-source)**: the office in a browser on any OS, or build the Mac app yourself.

## What you need

| | Desktop app | From source |
|---|---|---|
| Computer | A Mac with Apple silicon (Intel Macs: build from source) | macOS, Linux or Windows |
| Tools | None | Node 18+ (plus Rust to build the app) |
| Menu-bar icon, notifications, one-click Connect | Yes | Only if you build the app |
| **Open chat** button and app logos | Yes | macOS only |

You also need [Claude Code](https://claude.com/claude-code) itself, either the Claude desktop app or the `claude` terminal command. Codex, Cursor and other coding agents are optional.

## Desktop app (Mac)

1. **Download** `Agent-Office_<version>_aarch64.dmg` from the [latest release](https://github.com/regisBafutwabo/agent-office/releases/latest).
2. **Install:** open the .dmg and drag **Agent Office** to Applications.
3. **Open it from Applications.** If macOS blocks it, follow [Allow the first launch](#allow-the-first-launch) below.
4. **Connect your agents.** The office opens with a **Connect your coding agents** card. Click **Connect Claude Code**, plus **Connect Codex** or **Connect Cursor** if you use them.
5. **Start a new Claude Code session** and send a prompt. Its agent rides up in the lift and takes a desk on its project's floor.

You can also connect agents later from the menu-bar icon (**Connect agents**) or in the office's **Customize → Connect agents**.

To start the app automatically, add it in **System Settings → General → Login Items**.

### Allow the first launch

The app is ad-hoc signed, without Apple Developer ID signing or notarization, so macOS may say Apple cannot verify it. For the app downloaded from this repository's releases:

1. Open **Finder → Applications → Agent Office** once to trigger the warning, then dismiss it with **Done** or **Cancel**.
2. Open **Apple menu → System Settings → Privacy & Security**.
3. Scroll down to **Security**. Find the message about **Agent Office** being blocked and click **Open Anyway**.
4. Authenticate if prompted, then click **Open** in the confirmation dialog.
5. When the office opens, click **Connect Claude Code** (and **Connect Codex** or **Connect Cursor** if needed), then start a new agent session.

If **Open Anyway** is missing, try opening Agent Office from Applications again, then return to Privacy & Security. Once approved, you can open the app normally from Applications.

On macOS Monterey or Big Sur, use **System Preferences → Security & Privacy → General** instead. See [Apple's first-launch instructions](https://support.apple.com/en-us/102445).

### What Connect does

- **Claude Code:** installs the Agent Office plugin with Claude Code's own `claude plugin install`. The plugin's hooks report what each session is doing to the office on your Mac.
- **Codex and Cursor:** adds Agent Office hooks to `~/.codex/hooks.json` or `~/.cursor/hooks.json`.
  - Hooks you already have are kept.
  - The original file is saved next to it as `hooks.json.agent-office-backup`.
  - Codex asks you to trust the new hooks once.

The hooks never change what your agents do, and nothing leaves your Mac. The files the app installs live in `~/Library/Application Support/Agent Office`.

When a newer version of the app carries a newer plugin, the app updates the plugin by itself.

## From source

1. **Get the code:**

   ```bash
   git clone https://github.com/regisBafutwabo/agent-office.git
   cd agent-office
   ```

2. **Run the office.** Pick one option.

   **Browser only (any OS):**

   ```bash
   npm install
   npm start
   ```

   Then open <http://localhost:4747>. The office runs as long as that terminal is open.

   **Or build the Mac app:**

   ```bash
   xcode-select --install          # if you don't have the build tools
   brew install node rustup
   rustup default stable
   cd desktop
   npm install
   npm run build
   cp -R "src-tauri/target/release/bundle/macos/Agent Office.app" /Applications/
   open "/Applications/Agent Office.app"
   ```

   The first build takes a few minutes. It also produces a `.dmg` in `desktop/src-tauri/target/release/bundle/dmg/` for sharing. From here on, follow the [desktop app](#desktop-app-mac) steps from step 4.

3. **Connect Claude Code** (browser only; the app has a button for this):

   ```bash
   claude plugin marketplace add "$(pwd)"      # run this from the agent-office folder
   claude plugin install agent-office@agent-office
   ```

   To connect other agents by hand, copy the setup for your tool from [docs/adapters.md](docs/adapters.md).

4. **Start a new Claude Code session** and send a prompt.

Don't run the browser office and the desktop app at once: they use the same port. If you do, the app takes the port over as soon as it's free.

## Check that it works

- The office header says **Live** and counts your sessions.
- Your agent appears under **Agents**, with a ↗ button that takes you back to its chat.

If nothing shows up, ask the office what it knows:

```bash
curl -s http://localhost:4747/api/state
```

- `"sessions":[]`: the hooks aren't reaching the office. See [Troubleshooting](#troubleshooting).
- Sessions are listed: reload the office page.

To look around without any agents, open <http://localhost:4747/?demo>.

## macOS permission prompts

- **Notifications:** the desktop app asks once. Allow it to get an alert when an agent needs your permission.
- **Controlling Terminal or iTerm:** asked the first time you click **Open in Terminal**. Allow it so the office can select the right tab.

## Updating

**Desktop app:** download the newest release and replace the app in Applications. The plugin updates itself.

**From source:**

```bash
git pull
claude plugin marketplace update agent-office
claude plugin update agent-office@agent-office
```

Then restart `npm start`, or rebuild the app.

Start new Claude Code sessions to pick up a new plugin version.

## Uninstalling

1. Remove the Claude Code plugin:

   ```bash
   claude plugin uninstall agent-office@agent-office
   claude plugin marketplace remove agent-office
   ```

2. For Codex and Cursor, restore `hooks.json.agent-office-backup`, or delete the lines that mention `Agent Office/hook.sh` (or `adapters/hook.sh`).
3. Quit Agent Office from its menu-bar icon.
4. Delete `/Applications/Agent Office.app` and `~/Library/Application Support/Agent Office`.

## Troubleshooting

**My agent doesn't appear.**
- Start a *new* session after connecting. Sessions that were already open don't have the hooks.
- Check that the office is running (menu-bar icon, or `npm start`).
- Check that **Customize → Connect agents** says ✓ Connected for your tool.

**Connect Claude Code says Claude Code wasn't found.**
The app looks for the `claude` command, then for the copy inside the Claude desktop app. Open the Claude app once (or install Claude Code) and click **Connect** again.

**Connect Codex says the hooks file isn't valid JSON.**
The app never overwrites a file it can't read. Fix the file, or add the hooks by hand from [docs/adapters.md](docs/adapters.md).

**"Port 4747 is already in use".**
Another copy of the office is running. Quit it, or stop the other `npm start`.

To use a different port, set `AGENT_OFFICE_PORT` for both the office and your agents, because the hooks read it too.

**The office says "Demo".**
It couldn't reach the server within a few seconds. Make sure you opened <http://localhost:4747>, not a saved file or the claude.ai preview.

**Open chat brings the app forward but not the chat.**
- **Claude:** needs plugin 0.4.0 or newer and a session started after connecting.
- **Codex:** only threads in the Codex app open directly. Codex in a terminal opens the terminal tab instead.

**Logos show letters instead of app icons.**
Icons come from apps installed on your Mac. The browser office on Linux or Windows, and the claude.ai preview, show letters.

**Permission requests don't show Allow and Deny in the office.**
The office only holds a request while an office page is visible, for up to 45 seconds. Otherwise Claude Code asks you as usual.
