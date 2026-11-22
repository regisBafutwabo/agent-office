// OpenCode plugin (sketch): copy to .opencode/plugins/ or ~/.config/opencode/plugins/.
// OpenCode has no shell hooks; plugins get its internal events, so we send Claude-shaped events directly.
// Event names from https://opencode.ai/docs/plugins/ ; the property names marked "unverified" need checking.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The office's hook key, a header line in a file only you can read (see bridge/auth.js).
const DATA = process.env.AGENT_OFFICE_DATA ?? join(homedir(), process.platform === "darwin" ? "Library/Application Support/Agent Office" : process.platform === "win32" ? "AppData/Roaming/Agent Office" : ".config/agent-office");
const hookKey = (): Record<string, string> => {
  try { const [name, value] = readFileSync(join(DATA, "hook-token"), "utf8").trim().split(/:\s*/); return value ? { [name]: value } : {}; } catch { return {}; }
};
const URL = `http://127.0.0.1:${process.env.AGENT_OFFICE_PORT ?? 4747}/hook`;

export const AgentOffice = async ({ directory }: { directory: string }) => {
  const send = (hook_event_name: string, session_id: string | undefined, extra: Record<string, unknown> = {}) => {
    if (!session_id) return;
    fetch(URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...hookKey(), "X-Agent-Office-Agent": "opencode", "X-Agent-Office-Project": directory },
      body: JSON.stringify({ hook_event_name, session_id, cwd: directory, ...extra }),
      signal: AbortSignal.timeout(1000),
    }).catch(() => {});
  };
  return {
    event: async ({ event }: { event: { type: string; properties: any } }) => {
      const p = event.properties ?? {};
      const sid = p.sessionID ?? p.info?.id;                                  // unverified
      if (event.type === "session.created") send("SessionStart", sid);
      if (event.type === "session.idle") send("Stop", sid);
      if (event.type === "session.deleted") send("SessionEnd", sid);
      if (event.type === "session.compacted") send("PreCompact", sid);
      if (event.type === "permission.asked") send("Notification", sid, { notification_type: "permission_prompt", message: p.title });
    },
    "tool.execute.before": async (input: any, output: any) =>
      send("PreToolUse", input.sessionID, { tool_name: input.tool, tool_input: output.args }),  // tool names mapped in bridge/adapters.js
    "tool.execute.after": async (input: any) => send("PostToolUse", input.sessionID, { tool_name: input.tool }),
  };
};
