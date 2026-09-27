#!/bin/sh
# Forward this hook's JSON payload to the Agent Office bridge.
# Must never slow down or break Claude Code: short timeout, no output, always exit 0.
# App, terminal and tty let the office bring this agent's window or terminal tab to the front.
curl -s -m 1 -X POST \
  -H 'Content-Type: application/json' \
  -H "X-Agent-Office-Entrypoint: ${CLAUDE_CODE_ENTRYPOINT:-unknown}" \
  -H "X-Agent-Office-Project: ${CLAUDE_PROJECT_DIR:-}" \
  -H "X-Agent-Office-App: ${__CFBundleIdentifier:-}" \
  -H "X-Agent-Office-Term: ${TERM_PROGRAM:-}" \
  -H "X-Agent-Office-Tty: $(ps -o tty= -p $$ 2>/dev/null | tr -d ' ')" \
  --data-binary @- \
  "http://127.0.0.1:${AGENT_OFFICE_PORT:-4747}/hook" >/dev/null 2>&1
exit 0
