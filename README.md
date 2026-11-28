# <img src="desktop/src-tauri/icons/128x128@2x.png" alt="Agent Office logo" width="48" height="48" align="absmiddle"> Agent Office

Watching coding agents work in a terminal is boring. Agent Office turns every session you run in Claude Code, Codex, Cursor, Antigravity, T3 Code and [other tools](docs/features.md#other-coding-agents) into a teammate in a 3D office. They walk to the library to read, sweat through long test runs, grab a coffee when they're done and raise a hand when they need you. One look tells you who is working, who is stuck and who is waiting on you.

https://github.com/user-attachments/assets/0e1a30af-5d29-4682-add7-9b9257750f46

*30 seconds in the demo office: a long test run, a coffee break, a sprint back to the desk and the rooftop party. City footprints © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright).*

> **Preview.** Agent Office is early and Mac-first. It works in any browser on your computer, and VR is in beta. Issues and ideas are welcome.

## Quick start

1. Download the DMG from the [latest release](https://github.com/regisBafutwabo/agent-office/releases/latest) and drag **Agent Office** to **Applications**.
2. Open it and click **Connect Claude Code**. To add Codex, Cursor or Antigravity, use **Customize → Connect agents**.
3. Start a **new** agent session and send a prompt. Its agent walks into the office.

To look around first, open the demo: **Try demo** in the app, or <http://localhost:4747/?demo>.

Building from source, other platforms and troubleshooting are in **[INSTALL.md](INSTALL.md)**.

## What it does

**Watch your agents**

- **Agents at work:** each session takes a desk, walks to the library to research and raises a hand when it needs you. On a break it chats at the café or plays arcade games, and it sprints back to its desk when you call it. [More](docs/features.md#agents-and-subagents)
- **Teams:** subagents are smaller teammates. When an agent in T3 Code hands a task to another agent, even in another tool, that agent sits with it as its subagent. [More](docs/features.md#agents-and-subagents)
- **Characters:** robots or pets, with a face that shows what each agent is doing. [More](docs/features.md#characters)
- **Your own models:** swap the furniture, or the agents themselves, for your own 3D models. [More](docs/features.md#model-packs)
- **Reactions:** bubbles and confetti for passing and failing commands, and desks that remember merges. [More](docs/features.md#reactions-and-desk-memories)
- **VR (beta):** walk through the office in a Meta Quest, jump around, change floors and see who needs you. Built without a headset: if you have one, help make it better. [More](docs/vr.md)

**Act on what needs you**

- **Needs you:** one strip lists every agent waiting on you, from every tool. [More](docs/features.md#everything-that-needs-you)
- **Approve from the office:** answer Claude Code's permission requests with **Allow** or **Deny**. [More](docs/features.md#approving-from-the-office)
- **Jump to the chat:** one click opens the agent's exact chat, thread or terminal tab. [More](docs/features.md#jumping-to-an-agents-chat)
- **While you were away:** come back to a short list of what finished, failed or clashed. [More](docs/features.md#while-you-were-away)

**Catch problems early**

- **Heads-ups:** two agents editing one file, an agent going in circles, a filling context window. [More](docs/features.md#heads-ups)
- **Review changes:** see each checkout's changed files and diffs without leaving the office. [More](docs/features.md#reviewing-what-changed)

**Make it yours**

- **Day, night and cities:** the light follows your clock, over Seoul, San Francisco or a generic city, with drifting clouds, blinking roof lights and the odd helicopter. [More](docs/features.md#day-night-and-cities)
- **Rooftop DJ:** after dark the rooftop parties, to your Spotify or Apple Music if you like. [More](docs/features.md#rooftop-dj)
- **Model packs:** replace furniture or agents with your own glTF models. [More](docs/features.md#model-packs)
- **Wall mode:** a full-screen status board for a spare monitor. [More](docs/features.md#everything-that-needs-you)

## Desktop app (macOS)

A menu-bar app with the office server built in, a 4 MB download. You don't need Node or this repo.

- The menu-bar icon shows how many agents need you, and macOS notifies you when one asks for permission.
- **Connect agents** installs the Claude Code plugin and the Codex, Cursor or Antigravity hooks. Newer app versions update the plugin by themselves.
- If a tool stops reporting (say, after you move a repo it ran from), the office says so and **Reconnect** repairs it.
- **Open Agent Office** shows the office in a window. Closing the window frees its memory; the server keeps running until you quit.
- **Open in browser** opens the office in your browser too, signed in with a one-time link.
- The app updates itself. For a new version right away, choose **Check for Updates…**.

The app is signed and notarized by Apple. To build it yourself, see [INSTALL.md](INSTALL.md).

## Privacy and security

- Everything stays on your computer: the office listens only on `127.0.0.1`.
- Hooks never block or change what an agent does.
- Two keys keep other accounts and web pages out.

Details are in [How it works](docs/how-it-works.md). To report a problem, see [SECURITY.md](SECURITY.md).

## Options

| Setting | Default | What it does |
|---|---|---|
| `AGENT_OFFICE_PORT` | `4747` | Port for the office. If you change it, set it for your agents too, since the hooks read it. |
| `AGENT_OFFICE_HOST` | `127.0.0.1` | Interface to listen on: `127.0.0.1`, `::1` or `localhost` only. To use the office from another device, forward the port over SSH (`ssh -L 4747:127.0.0.1:4747 your-mac`). |
| `AGENT_OFFICE_ALLOWED_HOSTS` | | Extra host names that may address the office, comma-separated (say `my-mac.local`). |
| `AGENT_OFFICE_DATA` | see [How it works](docs/how-it-works.md#keys) | Folder for the keys. Set it for your agents too, since the hooks read it. |
| `?demo` | | Simulated agents instead of live sessions. |
| `?fast` | | Shorter idle timers, for testing. |
| `?time=18:45` | | Preview the **Auto** theme at another hour. |

## Development

Contributors: branch from `main` and open your pull request against `main`. If you use an AI coding agent, it reads the project's rules from [AGENTS.md](AGENTS.md). See [CONTRIBUTING.md](CONTRIBUTING.md) for the full steps.

```bash
npm test                                  # bridge and city bake unit tests
npm run test:e2e                          # the office page in a browser (first run: npx playwright install chromium)
(cd desktop/src-tauri && cargo test)      # desktop app server tests
claude --plugin-dir ./plugin              # try the hooks in one session without installing them
```

## Roadmap

1. ~~Live sessions from the desktop app and terminal~~
2. ~~Approve or deny permission requests from the office, desktop notifications~~
3. ~~Desktop app with a menu-bar icon, model packs and code signing~~
4. Phone and VR. VR is in beta with a Meta Quest on a USB cable ([VR](docs/vr.md)). Next: the phone, answering permission requests in VR and VR without a cable.
5. Give agents tasks from the office (sessions started through the Agent SDK)

## License

[MIT](LICENSE). Agent Office isn't affiliated with Anthropic, OpenAI, Cursor or the other tools it works with. App logos in the office are read from the apps installed on your Mac, not shipped with this repo.
