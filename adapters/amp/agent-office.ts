// Amp plugin (sketch): copy to .amp/plugins/ or ~/.config/amp/plugins/. See https://ampcode.com/manual/plugin-api
// Amp's events carry a thread id but no working directory, so pass the project with AGENT_OFFICE_PROJECT or the current dir.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The office's hook key, a header line in a file only you can read (see bridge/auth.js).
const DATA = process.env.AGENT_OFFICE_DATA ?? join(homedir(), process.platform === "darwin" ? "Library/Application Support/Agent Office" : process.platform === "win32" ? "AppData/Roaming/Agent Office" : ".config/agent-office");
const hookKey = (): Record<string, string> => {
  try { const [name, value] = readFileSync(join(DATA, "hook-token"), "utf8").trim().split(/:\s*/); return value ? { [name]: value } : {}; } catch { return {}; }
};
const URL = `http://127.0.0.1:${process.env.AGENT_OFFICE_PORT ?? 4747}/hook`;
const cwd = process.env.AGENT_OFFICE_PROJECT ?? process.cwd();
let thread = "";

function send(hook_event_name: string, extra: Record<string, unknown> = {}) {
  if (!thread) return;
  fetch(URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...hookKey(), "X-Agent-Office-Agent": "amp", "X-Agent-Office-Project": cwd },
    body: JSON.stringify({ hook_event_name, session_id: thread, cwd, ...extra }),
    signal: AbortSignal.timeout(1000),
  }).catch(() => {});
}

export default {
  "session.start": (e: any) => { thread = e.thread?.id ?? thread; send("SessionStart"); },
  "agent.start": (e: any) => send("UserPromptSubmit", { prompt: typeof e.message === "string" ? e.message : "" }),
  "tool.call": (e: any) => { send("PreToolUse", { tool_name: e.tool, tool_input: e.input }); return { action: "allow" }; },
  "tool.result": (e: any) => send(e.status === "error" ? "PostToolUseFailure" : "PostToolUse", { tool_name: e.tool }),
  "agent.end": () => send("Stop"),
};
