#!/bin/sh
# Forward any coding agent's hook payload to Agent Office, which translates it (bridge/adapters.js).
#
#   In the agent's hook config:  /path/to/agent-office/adapters/hook.sh <agent> [event]
#     <agent>  codex | cursor | gemini | copilot | factory | qwen | goose | kiro | windsurf | cline
#     [event]  only needed when the payload doesn't name the event (Copilot CLI)
#
# Never slows the agent down or changes what it does: 1 second timeout, always exits 0.
AGENT="${1:-unknown}"
EVENT="${2:-}"
PROJECT="${CLAUDE_PROJECT_DIR:-${GEMINI_PROJECT_DIR:-${QWEN_PROJECT_DIR:-${FACTORY_PROJECT_DIR:-}}}}"
# App, terminal and tty let the office bring this agent's window or terminal tab to the front.
curl -s -m 1 -X POST \
  -H 'Content-Type: application/json' \
  -H "X-Agent-Office-Agent: $AGENT" \
  -H "X-Agent-Office-Event: $EVENT" \
  -H "X-Agent-Office-Project: $PROJECT" \
  -H "X-Agent-Office-App: ${__CFBundleIdentifier:-}" \
  -H "X-Agent-Office-Term: ${TERM_PROGRAM:-}" \
  -H "X-Agent-Office-Tty: $(ps -o tty= -p $$ 2>/dev/null | tr -d ' ')" \
  --data-binary @- \
  "http://127.0.0.1:${AGENT_OFFICE_PORT:-4747}/hook" >/dev/null 2>&1
# Gemini CLI and Cursor read a JSON reply from stdout; an empty object means "no opinion".
case "$AGENT" in gemini|cursor) echo '{}' ;; esac
exit 0
