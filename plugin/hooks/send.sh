#!/bin/sh
# Forward this hook's JSON payload to the Agent Office bridge.
# Must never slow down or break Claude Code: short timeout, no output, always exit 0.
curl -s -m 1 -X POST \
  -H 'Content-Type: application/json' \
  -H "X-Agent-Office-Entrypoint: ${CLAUDE_CODE_ENTRYPOINT:-unknown}" \
  --data-binary @- \
  "http://127.0.0.1:${AGENT_OFFICE_PORT:-4747}/hook" >/dev/null 2>&1
exit 0
