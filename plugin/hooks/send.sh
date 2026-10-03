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

# App, terminal, tty and chat id let the office bring this agent's chat, window or terminal tab to the front.
curl -s -m 1 -X POST \
  -H 'Content-Type: application/json' \
  -H "X-Agent-Office-Entrypoint: ${CLAUDE_CODE_ENTRYPOINT:-unknown}" \
  -H "X-Agent-Office-Project: ${CLAUDE_PROJECT_DIR:-}" \
  -H "X-Agent-Office-App: ${__CFBundleIdentifier:-}" \
  -H "X-Agent-Office-Term: ${TERM_PROGRAM:-}" \
  -H "X-Agent-Office-Tty: $(ps -o tty= -p $$ 2>/dev/null | tr -d ' ')" \
  -H "X-Agent-Office-Chat: ${CLAUDE_CODE_HOST_SESSION_ID:-}" \
  --data-binary @- \
  "http://127.0.0.1:${AGENT_OFFICE_PORT:-4747}/hook" >/dev/null 2>&1
exit 0
