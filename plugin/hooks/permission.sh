#!/bin/sh
# Ask Agent Office whether to allow a tool call. The office only holds the request while someone is
# looking at it; otherwise (or if the office isn't running) this prints nothing and Claude Code shows its
# normal permission dialog. Always exits 0: only the printed JSON can allow or deny.
RESPONSE=$(curl -s -m 65 -X POST \
  -H 'Content-Type: application/json' \
  -H "X-Agent-Office-Entrypoint: ${CLAUDE_CODE_ENTRYPOINT:-unknown}" \
  -H "X-Agent-Office-Project: ${CLAUDE_PROJECT_DIR:-}" \
  --data-binary @- \
  "http://127.0.0.1:${AGENT_OFFICE_PORT:-4747}/permission" 2>/dev/null)
[ -n "$RESPONSE" ] && printf '%s' "$RESPONSE"
exit 0
