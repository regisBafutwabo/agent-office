# Other coding agents

Agent Office understands Claude Code's hook events. Other agents send their own hook payloads through one script, `adapters/hook.sh`, and the bridge translates them into the Claude shape (`bridge/adapters.js`). Each session is tagged with the tool it came from, and the office labels it (Codex, Cursor, Gemini CLI, and so on).

```
agent's hook ──> adapters/hook.sh <agent> [event] ──> POST /hook (X-Agent-Office-Agent: <agent>)
                                                         └─> bridge/adapters.js normalize() ──> store ──> office
```

Research was checked against each vendor's docs on 2026-09-27. Fields the docs didn't show exactly are marked **unverified** in `bridge/adapters.js`. Test those against a real session before relying on them.

> Status: the Node bridge (`npm start`) supports adapters. The desktop app's Rust server doesn't yet, so it only shows Claude Code for now.

## How rich is each agent?

| Tier | Agents | What you get |
|---|---|---|
| **1: close to Claude Code** | Codex CLI, Copilot CLI, Qwen Code, Factory Droid, Gemini CLI, Cursor, OpenCode | Sessions, prompts, tool calls. Most also report permission prompts. Codex, Copilot, Qwen and Cursor report subagents. |
| **2: partial** | Goose, VS Code agent hooks (preview), Kiro, Windsurf, Cline, Auggie, Amp | Tool calls and turns. Some lack session start/end, permission prompts or subagents. |
| **3: needs a workaround** | Aider, Codex `notify` only, Cursor CLI, Copilot cloud agent | Only "turn finished", or the agent runs remotely and can't reach your machine. |

Roo Code shut down in May 2026 and isn't supported.

## Setup per agent

Replace `/path/to/agent-office` with where you cloned this repo. Every snippet only adds a hook that reports activity. None of them change what the agent does.

### Codex CLI: `~/.codex/hooks.json`
Same event names as Claude Code. `apply_patch` is shown as an Edit of the patched file, and `Interrupt` as Stop. Codex asks you to trust new hooks once.
```json
{ "hooks": {
  "SessionStart":      [{ "hooks": [{ "type": "command", "command": "/path/to/agent-office/adapters/hook.sh codex" }] }],
  "UserPromptSubmit":  [{ "hooks": [{ "type": "command", "command": "/path/to/agent-office/adapters/hook.sh codex" }] }],
  "PreToolUse":        [{ "matcher": "*", "hooks": [{ "type": "command", "command": "/path/to/agent-office/adapters/hook.sh codex" }] }],
  "PostToolUse":       [{ "matcher": "*", "hooks": [{ "type": "command", "command": "/path/to/agent-office/adapters/hook.sh codex" }] }],
  "PermissionRequest": [{ "hooks": [{ "type": "command", "command": "/path/to/agent-office/adapters/hook.sh codex" }] }],
  "SubagentStart":     [{ "hooks": [{ "type": "command", "command": "/path/to/agent-office/adapters/hook.sh codex" }] }],
  "SubagentStop":      [{ "hooks": [{ "type": "command", "command": "/path/to/agent-office/adapters/hook.sh codex" }] }],
  "Stop":              [{ "hooks": [{ "type": "command", "command": "/path/to/agent-office/adapters/hook.sh codex" }] }],
  "SessionEnd":        [{ "hooks": [{ "type": "command", "command": "/path/to/agent-office/adapters/hook.sh codex" }] }]
} }
```

### Gemini CLI: `~/.gemini/settings.json`
`BeforeAgent` becomes a prompt and `AfterAgent` becomes Stop. Tool-permission notifications show as "needs you". `BeforeModel`/`AfterModel` are ignored because they fire too often. Gemini has no subagent events.
```json
{ "hooks": {
  "SessionStart": [{ "hooks": [{ "type": "command", "command": "/path/to/agent-office/adapters/hook.sh gemini" }] }],
  "BeforeAgent":  [{ "hooks": [{ "type": "command", "command": "/path/to/agent-office/adapters/hook.sh gemini" }] }],
  "BeforeTool":   [{ "matcher": "*", "hooks": [{ "type": "command", "command": "/path/to/agent-office/adapters/hook.sh gemini" }] }],
  "AfterTool":    [{ "matcher": "*", "hooks": [{ "type": "command", "command": "/path/to/agent-office/adapters/hook.sh gemini" }] }],
  "Notification": [{ "hooks": [{ "type": "command", "command": "/path/to/agent-office/adapters/hook.sh gemini" }] }],
  "AfterAgent":   [{ "hooks": [{ "type": "command", "command": "/path/to/agent-office/adapters/hook.sh gemini" }] }],
  "SessionEnd":   [{ "hooks": [{ "type": "command", "command": "/path/to/agent-office/adapters/hook.sh gemini" }] }]
} }
```

### Cursor: `~/.cursor/hooks.json`
The session is the `conversation_id`, and the project is the first workspace root. Subagents are supported. Cursor has no permission-prompt event, so Cursor agents never raise their hand. Cursor also runs Claude Code hooks from `.claude/settings.json` by default, so a project that already has the Claude plugin could double-report. In that case, turn that Cursor setting off.
```json
{ "version": 1, "hooks": {
  "sessionStart":       [{ "command": "/path/to/agent-office/adapters/hook.sh cursor" }],
  "beforeSubmitPrompt": [{ "command": "/path/to/agent-office/adapters/hook.sh cursor" }],
  "preToolUse":         [{ "command": "/path/to/agent-office/adapters/hook.sh cursor" }],
  "postToolUse":        [{ "command": "/path/to/agent-office/adapters/hook.sh cursor" }],
  "subagentStart":      [{ "command": "/path/to/agent-office/adapters/hook.sh cursor" }],
  "subagentStop":       [{ "command": "/path/to/agent-office/adapters/hook.sh cursor" }],
  "stop":               [{ "command": "/path/to/agent-office/adapters/hook.sh cursor" }],
  "sessionEnd":         [{ "command": "/path/to/agent-office/adapters/hook.sh cursor" }]
} }
```

### GitHub Copilot CLI: `~/.copilot/hooks/agent-office.json`
Copilot's payload doesn't name the event, so each hook passes it as the second argument.
```json
{ "version": 1, "hooks": {
  "sessionStart":        [{ "type": "command", "bash": "/path/to/agent-office/adapters/hook.sh copilot sessionStart" }],
  "userPromptSubmitted": [{ "type": "command", "bash": "/path/to/agent-office/adapters/hook.sh copilot userPromptSubmitted" }],
  "preToolUse":          [{ "type": "command", "bash": "/path/to/agent-office/adapters/hook.sh copilot preToolUse" }],
  "postToolUse":         [{ "type": "command", "bash": "/path/to/agent-office/adapters/hook.sh copilot postToolUse" }],
  "permissionRequest":   [{ "type": "command", "bash": "/path/to/agent-office/adapters/hook.sh copilot permissionRequest" }],
  "agentStop":           [{ "type": "command", "bash": "/path/to/agent-office/adapters/hook.sh copilot agentStop" }],
  "sessionEnd":          [{ "type": "command", "bash": "/path/to/agent-office/adapters/hook.sh copilot sessionEnd" }]
} }
```
VS Code agent mode can also read Claude-format hooks (`chat.useClaudeHooks`, preview). The Copilot cloud agent runs remotely and can't reach `127.0.0.1`.

### Qwen Code and Factory Droid
Both use Claude Code's format and event names. Use the Codex snippet with `hook.sh qwen` in `~/.qwen/settings.json`, or `hook.sh factory` in `~/.factory/hooks.json` (Droid puts event names at the top level of the file). Qwen can also POST directly with an `http` hook type, with no script. Point it at `http://127.0.0.1:4747/hook?agent=qwen`.

### Goose: `~/.agents/plugins/agent-office/hooks/hooks.json`
Claude-style events. The project comes from `working_dir` and prompts from `message`. Goose has no subagent events yet. Use the Codex snippet with `hook.sh goose`.

### Kiro: `.kiro/hooks/agent-office.json` (one file per trigger)
Use a command action that runs `hook.sh kiro` on Prompt Submit, Pre/Post Tool Use, Agent Stop and Session Start. The exact trigger strings are unverified.

### Windsurf / Devin Desktop: `~/.codeium/windsurf/hooks.json`
Runs, reads, writes, MCP calls and prompts are supported. Windsurf has no session start/end or permission events, and the `tool_info` fields are unverified.
```json
{ "hooks": {
  "pre_user_prompt":       [{ "command": "/path/to/agent-office/adapters/hook.sh windsurf" }],
  "pre_run_command":       [{ "command": "/path/to/agent-office/adapters/hook.sh windsurf" }],
  "post_run_command":      [{ "command": "/path/to/agent-office/adapters/hook.sh windsurf" }],
  "pre_read_code":         [{ "command": "/path/to/agent-office/adapters/hook.sh windsurf" }],
  "pre_write_code":        [{ "command": "/path/to/agent-office/adapters/hook.sh windsurf" }],
  "post_cascade_response": [{ "command": "/path/to/agent-office/adapters/hook.sh windsurf" }]
} }
```

### Cline
Cline runs executable scripts named after the event, in `~/Documents/Cline/Rules/Hooks/`. Create one per event (`TaskStart`, `TaskResume`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `TaskCancel`), each containing:
```sh
#!/bin/sh
exec /path/to/agent-office/adapters/hook.sh cline
```

### OpenCode and Amp
These use in-process plugins instead of shell hooks. Copy `adapters/opencode/agent-office.ts` to `~/.config/opencode/plugins/`, or `adapters/amp/agent-office.ts` to `~/.config/amp/plugins/`. Both are sketches, and some event property names are unverified.

### Aider
Aider has no hooks. The closest option is `--notifications-command` (fires when Aider waits for input) plus tailing `.aider.chat.history.md`. It needs a small wrapper that isn't written yet.

## Adding another agent

1. Add a translator to `ADAPTERS` in `bridge/adapters.js` that returns a Claude-shaped payload, or `null` to ignore an event.
2. Add a test with a sample payload in `bridge/adapters.test.js`.
3. Add its display name to `AGENT_NAMES` in `web/index.html`, and a setup snippet here.

## Next steps

- Port `adapters.js` to the desktop app's Rust server.
- Test each Tier 1 adapter against a real session and remove the "unverified" notes.
- Approvals from the office work the same way for Codex, Copilot CLI, Gemini CLI, Cursor and Factory, because their hooks can return allow/deny.
