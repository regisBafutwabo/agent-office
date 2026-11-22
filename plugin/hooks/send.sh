#!/bin/sh
# Forward this hook's JSON payload to the Agent Office bridge.
# Must never slow down or break Claude Code: short timeout, no output, always exit 0.
# Codex can import Claude plugins as well as running its own Agent Office adapter.
# Do not report that session a second time as Claude. A real Claude process launched
# from Codex sets its own entrypoint (or CLAUDECODE), so it must still report normally.
if [ -n "${CODEX_THREAD_ID:-}${CODEX_SESSION_ID:-}${CODEX_APP_TOOLS_PIPE_PATH:-}" ] &&
   [ -z "${CLAUDE_CODE_ENTRYPOINT:-}" ] && [ "${CLAUDECODE:-}" != "1" ]; then
  exit 0
fi

# The office only takes events carrying its hook key: a curl header line in a file only you can read (see
# bridge/auth.js). curl reads it from the file, so the key never shows up in the process list.
case "$(uname -s 2>/dev/null)" in
  Darwin) OFFICE_DATA="$HOME/Library/Application Support/Agent Office" ;;
  MINGW*|MSYS*|CYGWIN*) OFFICE_DATA="${APPDATA:-$HOME/AppData/Roaming}/Agent Office" ;;
  *) OFFICE_DATA="$HOME/.config/agent-office" ;;
esac
OFFICE_KEY="${AGENT_OFFICE_DATA:-$OFFICE_DATA}/hook-token"
[ -r "$OFFICE_KEY" ] || exit 0   # the office has never run here

# App, terminal, tty, chat id and T3 Code thread let the office bring this agent's chat, window or terminal tab to the front.
curl -s -m 1 -X POST \
  -H 'Content-Type: application/json' \
  -H @"$OFFICE_KEY" \
  -H "X-Agent-Office-Entrypoint: ${CLAUDE_CODE_ENTRYPOINT:-unknown}" \
  -H "X-Agent-Office-Project: ${CLAUDE_PROJECT_DIR:-}" \
  -H "X-Agent-Office-App: ${__CFBundleIdentifier:-}" \
  -H "X-Agent-Office-Term: ${TERM_PROGRAM:-}" \
  -H "X-Agent-Office-Tty: $(ps -o tty= -p $$ 2>/dev/null | tr -d ' ')" \
  -H "X-Agent-Office-Chat: ${CLAUDE_CODE_HOST_SESSION_ID:-}" \
  -H "X-Agent-Office-T3-Thread: ${T3CODE_THREAD_ID:-}" \
  --data-binary @- \
  "http://127.0.0.1:${AGENT_OFFICE_PORT:-4747}/hook" >/dev/null 2>&1
exit 0
