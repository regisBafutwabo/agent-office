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
# The office only takes events carrying its hook key: a curl header line in a file only you can read (see
# bridge/auth.js). curl reads it from the file, so the key never shows up in the process list.
case "$(uname -s 2>/dev/null)" in
  Darwin) OFFICE_DATA="$HOME/Library/Application Support/Agent Office" ;;
  MINGW*|MSYS*|CYGWIN*) OFFICE_DATA="${APPDATA:-$HOME/AppData/Roaming}/Agent Office" ;;
  *) OFFICE_DATA="$HOME/.config/agent-office" ;;
esac
OFFICE_KEY="${AGENT_OFFICE_DATA:-$OFFICE_DATA}/hook-token"
# App, terminal, tty and T3 Code thread let the office bring this agent's window or terminal tab to the front.
[ -r "$OFFICE_KEY" ] && curl -s -m 1 -X POST \
  -H 'Content-Type: application/json' \
  -H @"$OFFICE_KEY" \
  -H "X-Agent-Office-Agent: $AGENT" \
  -H "X-Agent-Office-Event: $EVENT" \
  -H "X-Agent-Office-Project: $PROJECT" \
  -H "X-Agent-Office-App: ${__CFBundleIdentifier:-}" \
  -H "X-Agent-Office-Term: ${TERM_PROGRAM:-}" \
  -H "X-Agent-Office-Tty: $(ps -o tty= -p $$ 2>/dev/null | tr -d ' ')" \
  -H "X-Agent-Office-T3-Thread: ${T3CODE_THREAD_ID:-}" \
  --data-binary @- \
  "http://127.0.0.1:${AGENT_OFFICE_PORT:-4747}/hook" >/dev/null 2>&1
# Gemini CLI and Cursor read a JSON reply from stdout; an empty object means "no opinion".
case "$AGENT" in gemini|cursor) echo '{}' ;; esac
exit 0
