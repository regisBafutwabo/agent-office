// Turns raw Claude Code hook payloads into a small, UI-friendly model of sessions and subagents.
// Mirrors bridge/store.js so the browser office works the same with either server.
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::VecDeque;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

const STALE_MS: u64 = 6 * 60 * 60 * 1000; // forget sessions that went silent (crashed without SessionEnd)
const RECENT_MAX: usize = 200;

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub fn clip(s: &str, n: usize) -> String {
    let collapsed = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() > n {
        let mut t: String = collapsed.chars().take(n - 1).collect();
        t.push('…');
        t
    } else {
        collapsed
    }
}

pub fn entrypoint_label(raw: Option<&str>) -> String {
    match raw {
        None | Some("") | Some("unknown") => "unknown".into(),
        Some(r) if r.contains("desktop") => "desktop".into(),
        Some("cli") => "terminal".into(),
        Some(r) if r.starts_with("sdk") => "sdk".into(),
        Some(r) => r.into(),
    }
}

fn str_of<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

/// A short human description of what a tool call is doing.
pub fn summarize_tool(name: &str, input: &Value, cwd: &str) -> String {
    let rel = |p: &str| -> String {
        if p.is_empty() {
            return String::new();
        }
        if !cwd.is_empty() {
            if let Ok(r) = Path::new(p).strip_prefix(cwd) {
                let r = r.to_string_lossy().to_string();
                if !r.is_empty() {
                    return r;
                }
            }
        }
        p.to_string()
    };
    match name {
        "Bash" => clip(str_of(input, "command"), 120),
        "Read" | "Edit" | "Write" | "NotebookEdit" => {
            let p = str_of(input, "file_path");
            rel(if p.is_empty() { str_of(input, "notebook_path") } else { p })
        }
        "Grep" => {
            let mut s = format!("\"{}\"", clip(str_of(input, "pattern"), 60));
            let p = str_of(input, "path");
            if !p.is_empty() {
                s.push_str(&format!(" in {}", rel(p)));
            }
            s
        }
        "Glob" => clip(str_of(input, "pattern"), 80),
        "WebFetch" => clip(str_of(input, "url"), 100),
        "WebSearch" => format!("\"{}\"", clip(str_of(input, "query"), 80)),
        "Task" | "Agent" => {
            let t = str_of(input, "subagent_type");
            clip(&format!("{}: {}", if t.is_empty() { "agent" } else { t }, str_of(input, "description")), 100)
        }
        "TodoWrite" => "updating the task list".into(),
        _ => match name.strip_prefix("mcp__") {
            Some(rest) => {
                let mut it = rest.splitn(2, "__");
                format!("{} · {}", it.next().unwrap_or(""), it.next().unwrap_or(""))
            }
            None => String::new(),
        },
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Subagent {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub status: String,
    pub activity: String,
    pub started_at: u64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    /// Which tool the session runs in: claude-code, codex, cursor, gemini…
    pub agent: String,
    pub cwd: String,
    pub project: String,
    pub entrypoint: String,
    pub started_at: u64,
    pub last_event_at: u64,
    pub status: String,
    pub activity: String,
    pub permission_mode: String,
    pub subagents: Vec<Subagent>,
    pub tool: Option<String>,
    /// Where the agent runs, for "Open in …": macOS bundle id, TERM_PROGRAM and tty.
    pub app: Option<String>,
    pub term: Option<String>,
    pub tty: Option<String>,
}

/// Where a hook came from (headers sent by the hook scripts).
#[derive(Default, Clone, Copy)]
pub struct Origin<'a> {
    pub app: Option<&'a str>,
    pub term: Option<&'a str>,
    pub tty: Option<&'a str>,
}

#[derive(Default)]
pub struct Store {
    pub sessions: Vec<Session>,
    recent: VecDeque<Value>,
}

fn set_status(s: &mut Session, sub: Option<usize>, status: &str, activity: String) {
    match sub {
        Some(i) => {
            s.subagents[i].status = status.into();
            s.subagents[i].activity = activity;
        }
        None => {
            s.status = status.into();
            s.activity = activity;
        }
    }
}

impl Store {
    pub fn snapshot(&mut self) -> Value {
        self.prune();
        let skip = self.recent.len().saturating_sub(80);
        json!({ "sessions": self.sessions, "recent": self.recent.iter().skip(skip).collect::<Vec<_>>() })
    }

    pub fn prune(&mut self) {
        let now = now_ms();
        self.sessions.retain(|s| now.saturating_sub(s.last_event_at) <= STALE_MS);
    }

    /// Sessions and subagents currently waiting on the user.
    pub fn waiting_count(&self) -> usize {
        self.sessions.iter().map(|s| (s.status == "waiting") as usize + s.subagents.iter().filter(|a| a.status == "waiting").count()).sum()
    }

    /// A permission request answered from the office: the session (or subagent) stops waiting.
    pub fn resolve_waiting(&mut self, session_id: &str, agent_id: Option<&str>, activity: &str) -> Option<Value> {
        let s = self.sessions.iter_mut().find(|s| s.id == session_id)?;
        match agent_id {
            Some(aid) => {
                let a = s.subagents.iter_mut().find(|a| a.id == aid)?;
                a.status = "thinking".into();
                a.activity = activity.into();
            }
            None => {
                s.status = "thinking".into();
                s.activity = activity.into();
            }
        }
        let event = json!({
            "type": "PermissionResolved", "sessionId": session_id, "at": now_ms(), "agentId": agent_id, "agentType": null, "message": activity,
            "session": { "id": s.id, "agent": s.agent, "cwd": s.cwd, "project": s.project, "entrypoint": s.entrypoint,
                         "permissionMode": s.permission_mode, "status": s.status, "activity": s.activity },
        });
        self.recent.push_back(event.clone());
        if self.recent.len() > RECENT_MAX {
            self.recent.pop_front();
        }
        Some(event)
    }

    /// Returns the normalized event, or None if the payload is unusable or not worth showing.
    /// `project_dir` is CLAUDE_PROJECT_DIR from the hook; it stays put when the session cds into a subfolder.
    #[cfg(test)]
    pub fn ingest(&mut self, p: &Value, entrypoint: Option<&str>, project_dir: Option<&str>) -> Option<Value> {
        self.ingest_from(p, entrypoint, project_dir, "claude-code", Origin::default())
    }

    /// Same as `ingest`, for a payload already translated from another tool by adapters.rs.
    pub fn ingest_from(&mut self, p: &Value, entrypoint: Option<&str>, project_dir: Option<&str>, agent: &str, origin: Origin) -> Option<Value> {
        let kind = str_of(p, "hook_event_name");
        let sid = str_of(p, "session_id");
        if kind.is_empty() || sid.is_empty() {
            return None;
        }
        let now = now_ms();
        let pm = str_of(p, "permission_mode");
        let idx = match self.sessions.iter().position(|s| s.id == sid) {
            Some(i) => i,
            None => {
                let cwd = project_dir.filter(|d| !d.is_empty()).unwrap_or(str_of(p, "cwd")).to_string();
                let project = Path::new(&cwd).file_name().map(|f| f.to_string_lossy().to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| "session".into());
                self.sessions.push(Session {
                    id: sid.into(), agent: agent.into(), cwd, project, entrypoint: entrypoint_label(entrypoint), started_at: now, last_event_at: now,
                    status: "idle".into(), activity: "Session started".into(),
                    permission_mode: if pm.is_empty() { "default".into() } else { pm.into() }, subagents: vec![], tool: None,
                    app: None, term: None, tty: None,
                });
                self.sessions.len() - 1
            }
        };
        let agent_id = str_of(p, "agent_id");
        let agent_type = str_of(p, "agent_type");
        {
            let s = &mut self.sessions[idx];
            s.last_event_at = now;
            if !pm.is_empty() {
                s.permission_mode = pm.into();
            }
            let label = entrypoint_label(entrypoint);
            if label != "unknown" {
                s.entrypoint = label;
            }
            if let Some(a) = origin.app.filter(|a| !a.is_empty()) { s.app = Some(a.into()); }
            if let Some(t) = origin.term.filter(|t| !t.is_empty()) { s.term = Some(t.into()); }
            if let Some(t) = origin.tty.filter(|t| crate::focus::valid_tty(t)) { s.tty = Some(t.into()); }
            // Internal helper agents (e.g. the desktop app's prompt suggestions) only report SubagentStop. They never did visible work, so skip them.
            if kind == "SubagentStop" && !agent_id.is_empty() && !s.subagents.iter().any(|a| a.id == agent_id) {
                return None;
            }
        }

        let mut e = Map::new();
        e.insert("type".into(), kind.into());
        e.insert("sessionId".into(), sid.into());
        e.insert("at".into(), now.into());
        e.insert("agentId".into(), if agent_id.is_empty() { Value::Null } else { agent_id.into() });
        e.insert("agentType".into(), if agent_type.is_empty() { Value::Null } else { agent_type.into() });

        let cwd = self.sessions[idx].cwd.clone();
        let s = &mut self.sessions[idx];
        let sub = if agent_id.is_empty() {
            None
        } else {
            Some(match s.subagents.iter().position(|a| a.id == agent_id) {
                Some(i) => i,
                None => {
                    s.subagents.push(Subagent {
                        id: agent_id.into(), kind: if agent_type.is_empty() { "subagent".into() } else { agent_type.into() },
                        status: "thinking".into(), activity: "Starting".into(), started_at: now,
                    });
                    s.subagents.len() - 1
                }
            })
        };
        let tool = str_of(p, "tool_name");
        let summary = summarize_tool(tool, p.get("tool_input").unwrap_or(&Value::Null), &cwd);
        let label = if summary.is_empty() { tool.to_string() } else { format!("{tool} {summary}") };
        let mut remove_session = false;

        match kind {
            "SessionStart" => {
                let source = str_of(p, "source");
                e.insert("source".into(), source.into());
                s.status = "idle".into();
                s.activity = if source == "resume" { "Session resumed".into() } else { "Session started".into() };
            }
            "UserPromptSubmit" => {
                let prompt = clip(str_of(p, "prompt"), 160);
                s.status = "thinking".into();
                s.activity = if prompt.is_empty() { "New prompt".into() } else { prompt.clone() };
                e.insert("prompt".into(), prompt.into());
            }
            "PreToolUse" => {
                e.insert("tool".into(), tool.into());
                e.insert("summary".into(), summary.clone().into());
                set_status(s, sub, "working", label);
                if sub.is_none() {
                    s.tool = Some(tool.into());
                }
            }
            "PostToolUse" | "PostToolUseFailure" => {
                let failed = kind == "PostToolUseFailure";
                e.insert("tool".into(), tool.into());
                e.insert("summary".into(), summary.clone().into());
                e.insert("failed".into(), failed.into());
                set_status(s, sub, "thinking", if failed { format!("{tool} failed") } else { "Thinking".into() });
                if sub.is_none() {
                    s.tool = None;
                }
            }
            "PermissionRequest" => {
                e.insert("tool".into(), tool.into());
                e.insert("summary".into(), summary.clone().into());
                set_status(s, sub, "waiting", format!("Needs permission: {label}"));
            }
            "Notification" => {
                let message = clip(str_of(p, "message"), 160);
                let nt = str_of(p, "notification_type");
                e.insert("message".into(), message.clone().into());
                e.insert("notificationType".into(), if nt.is_empty() { Value::Null } else { nt.into() });
                if nt == "permission_prompt" {
                    s.status = "waiting".into();
                    s.activity = if message.is_empty() { "Needs your permission".into() } else { message };
                } else if nt == "idle_prompt" {
                    s.status = "idle".into();
                    s.activity = "Waiting for your input".into();
                }
            }
            "Stop" => {
                s.status = "done".into();
                s.activity = "Finished".into();
                s.tool = None;
            }
            "SubagentStart" => {
                if let Some(i) = sub {
                    s.subagents[i].status = "thinking".into();
                    s.subagents[i].activity = "Starting".into();
                }
            }
            "SubagentStop" => {
                e.insert("message".into(), clip(str_of(p, "last_assistant_message"), 160).into());
                if let Some(i) = sub {
                    s.subagents.remove(i);
                }
            }
            "PreCompact" => {
                s.status = "working".into();
                s.activity = "Compacting context".into();
            }
            "SessionEnd" => {
                e.insert("reason".into(), str_of(p, "reason").into());
                remove_session = true;
            }
            _ => {}
        }
        e.insert("session".into(), json!({
            "id": s.id, "agent": s.agent, "cwd": s.cwd, "project": s.project, "entrypoint": s.entrypoint,
            "permissionMode": s.permission_mode, "status": s.status, "activity": s.activity, "app": s.app, "term": s.term,
        }));
        if remove_session {
            self.sessions.remove(idx);
        }
        let event = Value::Object(e);
        self.recent.push_back(event.clone());
        if self.recent.len() > RECENT_MAX {
            self.recent.pop_front();
        }
        Some(event)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base(extra: Value) -> Value {
        let mut v = json!({ "session_id": "s1", "cwd": "/Users/me/code/shop", "permission_mode": "default" });
        v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        v
    }

    #[test]
    fn labels_where_the_session_runs() {
        assert_eq!(entrypoint_label(Some("claude-desktop")), "desktop");
        assert_eq!(entrypoint_label(Some("cli")), "terminal");
        assert_eq!(entrypoint_label(None), "unknown");
    }

    #[test]
    fn summarizes_tool_calls_relative_to_the_project() {
        assert_eq!(summarize_tool("Read", &json!({ "file_path": "/Users/me/code/shop/src/a.ts" }), "/Users/me/code/shop"), "src/a.ts");
        assert_eq!(summarize_tool("Bash", &json!({ "command": "npm   test" }), ""), "npm test");
        assert_eq!(summarize_tool("mcp__github__create_issue", &json!({}), ""), "github · create_issue");
    }

    #[test]
    fn tracks_a_session_through_a_prompt_a_tool_call_and_a_stop() {
        let mut st = Store::default();
        st.ingest(&base(json!({ "hook_event_name": "SessionStart", "source": "startup" })), Some("cli"), None);
        st.ingest(&base(json!({ "hook_event_name": "UserPromptSubmit", "prompt": "fix the cart" })), None, None);
        let pre = st.ingest(&base(json!({ "hook_event_name": "PreToolUse", "tool_name": "Edit", "tool_input": { "file_path": "/Users/me/code/shop/cart.ts" } })), None, None).unwrap();
        assert_eq!(pre["summary"], "cart.ts");
        let s = &st.sessions[0];
        assert_eq!((s.project.as_str(), s.entrypoint.as_str(), s.status.as_str()), ("shop", "terminal", "working"));
        st.ingest(&base(json!({ "hook_event_name": "Stop" })), None, None);
        assert_eq!(st.sessions[0].status, "done");
    }

    #[test]
    fn routes_subagent_tool_calls_and_removes_the_subagent_when_it_stops() {
        let mut st = Store::default();
        st.ingest(&base(json!({ "hook_event_name": "SubagentStart", "agent_id": "x1", "agent_type": "Explore" })), None, None);
        st.ingest(&base(json!({ "hook_event_name": "PreToolUse", "agent_id": "x1", "agent_type": "Explore", "tool_name": "Grep", "tool_input": { "pattern": "cart" } })), None, None);
        assert_eq!(st.sessions[0].subagents[0].status, "working");
        assert_eq!(st.sessions[0].status, "idle");
        st.ingest(&base(json!({ "hook_event_name": "SubagentStop", "agent_id": "x1" })), None, None);
        assert!(st.sessions[0].subagents.is_empty());
    }

    #[test]
    fn permission_prompts_count_as_waiting_and_session_end_forgets_the_session() {
        let mut st = Store::default();
        st.ingest(&base(json!({ "hook_event_name": "Notification", "notification_type": "permission_prompt", "message": "Claude needs your permission to use Bash" })), None, None);
        assert_eq!(st.waiting_count(), 1);
        st.ingest(&base(json!({ "hook_event_name": "SessionEnd", "reason": "exit" })), None, None);
        assert!(st.sessions.is_empty());
    }

    #[test]
    fn files_the_session_under_the_project_folder() {
        let mut st = Store::default();
        st.ingest(&base(json!({ "hook_event_name": "SessionStart", "cwd": "/Users/me/code/shop/src/cart" })), Some("cli"), Some("/Users/me/code/shop"));
        assert_eq!(st.sessions[0].project, "shop");
    }

    #[test]
    fn skips_helper_agents_that_only_report_subagent_stop() {
        let mut st = Store::default();
        assert!(st.ingest(&base(json!({ "hook_event_name": "SubagentStop", "agent_id": "helper" })), None, None).is_none());
        assert!(st.ingest(&json!({ "hook_event_name": "Stop" }), None, None).is_none());
    }
}
