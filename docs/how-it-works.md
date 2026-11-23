# How it works

```
Claude Code (desktop app / terminal), Codex, Cursor, …
   │  hooks: plugin/hooks for Claude Code, adapters/hook.sh for the others
   ▼
bridge/server.js  ── keeps live state of every session and subagent
  (or the desktop app's built-in Rust server: desktop/src-tauri)
   │  WebSocket
   ▼
web/              ── the 3D office (Three.js): index.html, office.css and the scripts in web/js/
```

## Hooks

- The hook script posts each event to `http://127.0.0.1:4747/hook`.
- It gives up after one second, and never blocks or changes what the agent does.

## Privacy

- The office listens only on `127.0.0.1`, so nothing leaves your machine.
- Prompts and file names are shown in the office, so treat it like your terminal.
- To keep code out of the office, turn off **Customize → Show code in agent cards and reviews**.

## Keys

Two keys guard the office. Each is a file only you can read, in the data folder: `~/Library/Application Support/Agent Office`, or `~/.config/agent-office` on Linux.

| Key | Held by | Can |
|---|---|---|
| `hook-token` | Agent hooks | Report events and ask for permission, nothing else |
| `ui-token` | Office pages | Read sessions and code, and answer permission requests |

- Other accounts on the same computer, and web pages, get neither key.
- Hooks from before 0.5.0 send no key, so the office refuses their events. Update the plugin and start new sessions (see [INSTALL.md](../INSTALL.md#updating)).

## Other protections

- **DNS rebinding:** the office refuses requests whose `Host` isn't `localhost`, an IP address, or a name you allow with `AGENT_OFFICE_ALLOWED_HOSTS`.
- **Page scripts:** the office page runs only its own scripts, and other sites can't frame it.
- **Model packs:** a pack can serve only model and texture files (`.glb`, `.gltf`, `.bin`, `.png`, `.jpg`, `.webp`, `.ktx2`), never pages or scripts, and never a file a symlink points to outside the pack.
- **Review window:** it shows only the files the agent's card lists.

To report a security problem, see [SECURITY.md](../SECURITY.md). The [security review](security-review-2026-11-20.md) has the full analysis.
