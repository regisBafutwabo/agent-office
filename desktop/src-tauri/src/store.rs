// Turns raw Claude Code hook payloads into a small, UI-friendly model of sessions and subagents.
// Mirrors bridge/store.js so the browser office works the same with either server.
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::discover::{Found, FOUND_WINDOW_MS};
use crate::transcript::{read_transcript, Context, Message, Transcript, MESSAGE_CHARS};

const STALE_MS: u64 = 6 * 60 * 60 * 1000; // forget sessions that went silent (crashed without SessionEnd)
const RECENT_MAX: usize = 200;
const TRANSCRIPT_RECHECK_MS: u64 = 5_000; // between prompts and stops, re-read the transcript at most this often
const TASK_WAIT_MS: u64 = 2 * 60 * 1000; // how long a launched Task/Agent call waits for its subagent to show up
const LATE_HOOK_MS: u64 = 10 * 1000; // hooks post in parallel: a stopped subagent's last tool event can land after its SubagentStop

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

/// No project folder: a tool's background helper (Codex's app runs one in "/" when it opens), not a chat you started.
fn is_helper_dir(cwd: &str) -> bool {
    cwd.is_empty() || cwd == "/"
}

fn str_of<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

/// A short human description of what a tool call is doing.
/// A tool call that merges work: a PR merge (gh or a GitHub MCP tool), or merging a branch. Mirrors isMerge in bridge/store.js:
/// pulling main into a branch is only syncing, and `gh pr merge --auto` merges later, so neither counts.
pub fn is_merge(tool: &str, input: &Value) -> bool {
    if tool.starts_with("mcp__") {
        return tool.contains("merge_pull_request") || tool.ends_with("merge_pr");
    }
    if tool != "Bash" {
        return false;
    }
    let is_sync = |r: &str| matches!(r, "main" | "master" | "trunk" | "develop") || r.starts_with("origin/") || r.starts_with("upstream/");
    let cmd = str_of(input, "command").replace("&&", ";").replace("||", ";").replace(['|', '\n'], ";");
    cmd.split(';').any(|part| {
        let mut w: Vec<&str> = part.split_whitespace().collect();
        while w.first().is_some_and(|t| t.split_once('=').is_some_and(|(k, _)| !k.is_empty() && k.chars().all(|c| c.is_alphanumeric() || c == '_'))) {
            w.remove(0);
        }
        match w.first().copied() {
            Some("gh") => w.get(1) == Some(&"pr") && w.get(2) == Some(&"merge") && !w.contains(&"--auto") && !w.contains(&"--disable-auto"),
            Some("git") => {
                let mut i = 1;
                while i < w.len() && w[i].starts_with('-') {
                    i += if w[i] == "-C" || w[i] == "-c" { 2 } else { 1 };
                }
                if w.get(i) != Some(&"merge") {
                    return false;
                }
                let args = &w[i + 1..];
                if args.contains(&"--abort") || args.contains(&"--quit") {
                    return false;
                }
                let refs: Vec<&str> = args.iter().filter(|x| !x.starts_with('-')).map(|x| x.trim_matches(|c| c == '"' || c == '\'')).collect();
                args.contains(&"--continue") || (!refs.is_empty() && !refs.iter().any(|r| is_sync(r)))
            }
            _ => false,
        }
    })
}

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
    /// What the parent asked it to do (the Task/Agent call's description).
    pub task: Option<String>,
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
    /// The Claude desktop app's chat id, so "Open chat" lands on this exact conversation.
    pub chat: Option<String>,
    /// The chat's title (from its transcript), or its first prompt until it has one.
    pub title: Option<String>,
    /// A merge ran since the last prompt (see is_merge).
    pub merged: bool,
    /// The chat's last few messages (see transcript.rs).
    pub messages: Vec<Message>,
    /// How full the context window is (see transcript.rs).
    pub context: Option<Context>,
    #[serde(skip)]
    pub transcript_title: Option<String>,
    #[serde(skip)]
    pub first_prompt: Option<String>,
    #[serde(skip)]
    pub transcript_checked_at: u64,
    /// Task/Agent calls whose subagent hasn't started yet (see claim_task).
    #[serde(skip)]
    pub pending_tasks: Vec<PendingTask>,
    /// Known only from its log (see discover.rs) until its first hook arrives.
    #[serde(skip)]
    pub from_log: bool,
}

#[derive(Clone, Debug)]
pub struct PendingTask {
    kind: String,
    task: String,
    at: u64,
}

/// SubagentStart has no task description, but the parent's Task/Agent call just before it does.
/// Hand each new subagent the oldest remembered call of its type.
fn claim_task(s: &mut Session, kind: &str, now: u64) -> Option<String> {
    s.pending_tasks.retain(|t| now - t.at < TASK_WAIT_MS);
    let i = s.pending_tasks.iter().position(|t| !t.kind.is_empty() && t.kind == kind)
        .or_else(|| s.pending_tasks.iter().position(|t| t.kind.is_empty() || kind.is_empty()))?;
    let t = s.pending_tasks.remove(i);
    if t.task.is_empty() { None } else { Some(t.task) }
}

/// Where a hook came from (headers sent by the hook scripts).
#[derive(Default, Clone, Copy)]
pub struct Origin<'a> {
    pub app: Option<&'a str>,
    pub term: Option<&'a str>,
    pub tty: Option<&'a str>,
    pub chat: Option<&'a str>,
}

#[derive(Default)]
pub struct Store {
    pub sessions: Vec<Session>,
    recent: VecDeque<Value>,
    /// Reads a transcript's title and messages; tests swap in a fake.
    pub read: Option<fn(&str) -> Option<Transcript>>,
    /// Sessions that reported SessionEnd: their logs are still fresh, but they mustn't come back.
    ended: HashSet<String>,
    /// Thread ids confirmed as Codex by its adapter or log discovery.
    codex_ids: HashSet<String>,
    /// (session id, agent id) → when that subagent reported SubagentStop.
    stopped_subs: HashMap<(String, String), u64>,
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
    fn claim_codex(&mut self, agent: &str, id: &str) -> Option<String> {
        if agent != "codex" { return None; }
        let raw = id.strip_prefix("codex:")?;
        self.codex_ids.insert(raw.into());
        if !self.sessions.iter().any(|s| s.id == raw && s.agent == "claude-code") { return None; }
        self.sessions.retain(|s| !(s.id == raw && s.agent == "claude-code"));
        self.recent.retain(|e| e["sessionId"].as_str() != Some(raw));
        Some(raw.into())
    }

    pub fn snapshot(&mut self) -> Value {
        self.prune();
        let skip = self.recent.len().saturating_sub(80);
        json!({ "sessions": self.sessions, "recent": self.recent.iter().skip(skip).collect::<Vec<_>>() })
    }

    pub fn prune(&mut self) {
        let now = now_ms();
        // Found in a log and never heard from: gone once the log goes quiet (it may have been a closed chat).
        self.sessions.retain(|s| now.saturating_sub(s.last_event_at) <= if s.from_log { FOUND_WINDOW_MS } else { STALE_MS });
        self.stopped_subs.retain(|_, at| now.saturating_sub(*at) <= LATE_HOOK_MS);
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
            "session": { "id": s.id, "agent": s.agent, "cwd": s.cwd, "project": s.project, "title": s.title, "entrypoint": s.entrypoint,
                         "permissionMode": s.permission_mode, "status": s.status, "activity": s.activity },
        });
        self.recent.push_back(event.clone());
        if self.recent.len() > RECENT_MAX {
            self.recent.pop_front();
        }
        Some(event)
    }

    /// Found agents a poll no longer reports (Ollama unloaded the model) leave now, not after the usual quiet spell.
    /// Returns their ids.
    pub fn retire(&mut self, agent: &str, keep: &[String]) -> Vec<String> {
        let gone: Vec<String> = self.sessions.iter().filter(|s| s.agent == agent && s.from_log && !keep.contains(&s.id)).map(|s| s.id.clone()).collect();
        self.sessions.retain(|s| !gone.contains(&s.id));
        gone
    }

    /// A chat found in its log (discover.rs): add it, or refresh it while no hook has reported on it.
    /// Returns a SessionFound event when something on screen changes; hooks always win over logs.
    pub fn adopt(&mut self, f: Found) -> Option<Value> {
        if f.agent == "claude-code" && self.codex_ids.contains(&f.id) { return None; }
        let replaces = if !is_helper_dir(&f.cwd) { self.claim_codex(&f.agent, &f.id) } else { None };
        if self.ended.contains(&f.id) {
            return None;
        }
        let (idx, new) = match self.sessions.iter().position(|s| s.id == f.id) {
            Some(i) if !self.sessions[i].from_log => return None,
            Some(i) => {
                let s = &mut self.sessions[i];
                s.last_event_at = s.last_event_at.max(f.at);
                let title = f.title.or(s.transcript_title.take());
                let messages = if f.messages.is_empty() { s.messages.clone() } else { f.messages };
                let changed = s.status != f.status || s.activity != f.activity || s.messages != messages || s.title != title;
                (s.status, s.activity, s.messages) = (f.status, f.activity, messages);
                (s.transcript_title, s.title) = (title.clone(), title);
                if !changed { return None; }
                (i, false)
            }
            None if is_helper_dir(&f.cwd) => return None,
            None => {
                let folder = Path::new(&f.cwd).file_name().map(|n| n.to_string_lossy().to_string());
                let project = f.project.clone().or(folder).filter(|s| !s.is_empty()).unwrap_or_else(|| "session".into());
                self.sessions.push(Session {
                    id: f.id, agent: f.agent, cwd: f.cwd, project, entrypoint: entrypoint_label(f.entrypoint.as_deref()), started_at: f.at, last_event_at: f.at,
                    status: f.status, activity: f.activity, permission_mode: "default".into(), subagents: vec![], tool: None,
                    app: None, term: None, tty: None, chat: None, title: f.title.clone(), merged: false, messages: f.messages, context: None,
                    transcript_title: f.title, first_prompt: None, transcript_checked_at: 0, pending_tasks: vec![], from_log: true,
                });
                (self.sessions.len() - 1, true)
            }
        };
        let s = &self.sessions[idx];
        let mut event = json!({
            "type": "SessionFound", "sessionId": s.id, "at": now_ms(), "agentId": null, "agentType": null,
            "message": if new { Value::from("Already running") } else { Value::Null },
            "session": { "id": s.id, "agent": s.agent, "cwd": s.cwd, "project": s.project, "title": s.title, "merged": false, "entrypoint": s.entrypoint,
                         "permissionMode": s.permission_mode, "status": s.status, "activity": s.activity, "app": null, "term": null, "chat": null, "messages": s.messages },
        });
        if let Some(id) = replaces { event["replacesSessionId"] = id.into(); }
        if new {                                   // only the arrival goes in the feed, not every refresh
            self.recent.push_back(event.clone());
            if self.recent.len() > RECENT_MAX {
                self.recent.pop_front();
            }
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
        if agent == "claude-code" && self.codex_ids.contains(sid) { return None; }
        let root = project_dir.filter(|d| !d.is_empty()).unwrap_or(str_of(p, "cwd"));
        let replaces = if !is_helper_dir(root) { self.claim_codex(agent, sid) } else { None };
        let now = now_ms();
        let pm = str_of(p, "permission_mode");
        let idx = match self.sessions.iter().position(|s| s.id == sid) {
            Some(i) => i,
            None => {
                let cwd = project_dir.filter(|d| !d.is_empty()).unwrap_or(str_of(p, "cwd")).to_string();
                if is_helper_dir(&cwd) {
                    return None;
                }
                let project = Path::new(&cwd).file_name().map(|f| f.to_string_lossy().to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| "session".into());
                self.sessions.push(Session {
                    id: sid.into(), agent: agent.into(), cwd, project, entrypoint: entrypoint_label(entrypoint), started_at: now, last_event_at: now,
                    status: "idle".into(), activity: "Session started".into(),
                    permission_mode: if pm.is_empty() { "default".into() } else { pm.into() }, subagents: vec![], tool: None,
                    app: None, term: None, tty: None, chat: None,
                    title: None, merged: false, messages: vec![], context: None, transcript_title: None, first_prompt: None, transcript_checked_at: 0, pending_tasks: vec![],
                    from_log: false,
                });
                self.sessions.len() - 1
            }
        };
        let agent_id = str_of(p, "agent_id");
        let agent_type = str_of(p, "agent_type");
        let read = self.read.unwrap_or(read_transcript);
        let chat_changed;
        {
            let s = &mut self.sessions[idx];
            s.last_event_at = now;
            s.from_log = false;
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
            if let Some(c) = origin.chat.filter(|c| crate::focus::valid_chat(c)) { s.chat = Some(c.into()); }
            // The chat's title and last messages from its transcript; until it has a title, its first prompt stands in.
            let before = s.messages.clone();
            let prompt = str_of(p, "prompt");
            if kind == "UserPromptSubmit" && !prompt.is_empty() {
                if s.first_prompt.is_none() { s.first_prompt = Some(clip(prompt, 80)); }
                // The hook can fire before the prompt reaches the transcript: show it right away.
                let text = clip(prompt, MESSAGE_CHARS);
                if s.messages.last().is_none_or(|m| m.role != "user" || m.text != text) {
                    s.messages.push(Message { role: "user".into(), text });
                }
            }
            let tp = str_of(p, "transcript_path");
            let due = matches!(kind, "SessionStart" | "UserPromptSubmit" | "Stop") || now.saturating_sub(s.transcript_checked_at) > TRANSCRIPT_RECHECK_MS;
            if !tp.is_empty() && due {
                s.transcript_checked_at = now;
                if let Some(t) = read(tp) {
                    if t.title.is_some() { s.transcript_title = t.title; }
                    if !t.messages.is_empty() && kind != "UserPromptSubmit" { s.messages = t.messages; }
                    if t.context.is_some() { s.context = t.context; }
                }
            }
            s.title = s.transcript_title.clone().or_else(|| s.first_prompt.clone());
            chat_changed = s.messages != before;
            // Internal helper agents (e.g. the desktop app's prompt suggestions) only report SubagentStop. They never did visible work, so skip them.
            if kind == "SubagentStop" && !agent_id.is_empty() && !s.subagents.iter().any(|a| a.id == agent_id) {
                return None;
            }
            // A straggler from a subagent that just stopped mustn't bring it back, stuck "thinking". A later one is a real resume.
            let stopped = self.stopped_subs.get(&(sid.to_string(), agent_id.to_string()));
            if !agent_id.is_empty() && kind != "SubagentStart" && stopped.is_some_and(|at| now.saturating_sub(*at) < LATE_HOOK_MS) {
                return None;
            }
        }

        let mut e = Map::new();
        if let Some(id) = replaces { e.insert("replacesSessionId".into(), id.into()); }
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
                    let task = claim_task(s, agent_type, now);
                    s.subagents.push(Subagent {
                        id: agent_id.into(), kind: if agent_type.is_empty() { "subagent".into() } else { agent_type.into() }, task,
                        status: "thinking".into(), activity: "Starting".into(), started_at: now,
                    });
                    s.subagents.len() - 1
                }
            })
        };
        if let Some(i) = sub {
            e.insert("agentTask".into(), s.subagents[i].task.clone().map_or(Value::Null, Value::from));
        }
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
                s.merged = false;
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
                    if tool == "Task" || tool == "Agent" {
                        let input = p.get("tool_input").unwrap_or(&Value::Null);
                        s.pending_tasks.retain(|t| now - t.at < TASK_WAIT_MS);
                        s.pending_tasks.push(PendingTask { kind: str_of(input, "subagent_type").into(), task: clip(str_of(input, "description"), 40), at: now });
                    }
                }
            }
            "PostToolUse" | "PostToolUseFailure" => {
                let failed = kind == "PostToolUseFailure";
                e.insert("tool".into(), tool.into());
                e.insert("summary".into(), summary.clone().into());
                e.insert("failed".into(), failed.into());
                set_status(s, sub, "thinking", if failed { format!("{tool} failed") } else { "Thinking".into() });
                if !failed && is_merge(tool, p.get("tool_input").unwrap_or(&Value::Null)) {
                    e.insert("merged".into(), true.into());
                    s.merged = true;
                }
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
                s.activity = if s.merged { "Finished · merged".into() } else { "Finished".into() };
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
                    self.stopped_subs.insert((sid.to_string(), agent_id.to_string()), now);
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
            "id": s.id, "agent": s.agent, "cwd": s.cwd, "project": s.project, "title": s.title, "merged": s.merged, "entrypoint": s.entrypoint,
            "permissionMode": s.permission_mode, "status": s.status, "activity": s.activity, "app": s.app, "term": s.term, "chat": s.chat,
            "context": s.context,
        }));
        if chat_changed {
            if let Some(Value::Object(o)) = e.get_mut("session") { o.insert("messages".into(), json!(s.messages)); }
        }
        if remove_session {
            self.ended.insert(self.sessions.remove(idx).id);
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

    #[test]
    fn codex_replaces_imported_claude_ghost_in_either_order() {
        for claude_first in [true, false] {
            let mut st = Store::default();
            let p = json!({ "session_id": "t1", "cwd": "/repo", "hook_event_name": "UserPromptSubmit", "prompt": "Fix UI" });
            if claude_first { st.ingest(&p, None, None); }
            let mut codex = p.clone(); codex["session_id"] = "codex:t1".into();
            let e = st.ingest_from(&codex, Some("codex-tui"), None, "codex", Origin::default()).unwrap();
            assert_eq!(e["replacesSessionId"].as_str(), if claude_first { Some("t1") } else { None });
            assert!(st.ingest(&p, None, None).is_none());
            assert_eq!(st.sessions.len(), 1);
            assert_eq!((st.sessions[0].id.as_str(), st.sessions[0].agent.as_str()), ("codex:t1", "codex"));
            assert!(st.recent.iter().all(|e| e["sessionId"] != "t1"));
            codex["hook_event_name"] = "SessionEnd".into();
            st.ingest_from(&codex, None, None, "codex", Origin::default());
            assert!(st.ingest(&p, None, None).is_none());
            assert!(st.sessions.is_empty());
        }
    }

    #[test]
    fn codex_discovery_keeps_independent_claude_sessions() {
        let mut st = Store::default();
        st.ingest(&json!({ "session_id": "t1", "cwd": "/repo", "hook_event_name": "SessionStart" }), None, None);
        st.ingest(&json!({ "session_id": "real-claude", "cwd": "/repo", "hook_event_name": "SessionStart" }), Some("cli"), None);
        let f = Found { id: "codex:t1".into(), agent: "codex".into(), cwd: "/repo".into(), project: None, entrypoint: None,
            at: now_ms(), status: "working".into(), activity: "Working".into(), title: None, messages: vec![] };
        assert_eq!(st.adopt(f).unwrap()["replacesSessionId"], "t1");
        assert_eq!(st.sessions.len(), 2);
        assert!(st.sessions.iter().any(|s| s.id == "real-claude"));
    }

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
    fn a_tool_event_that_lands_after_its_subagent_stop_does_not_bring_it_back() {
        let mut st = Store::default();
        let sub = |ev: &str| base(json!({ "hook_event_name": ev, "agent_id": "x1", "agent_type": "default", "tool_name": "Bash", "tool_input": { "command": "ls" } }));
        st.ingest(&sub("PreToolUse"), None, None);
        st.ingest(&sub("SubagentStop"), None, None);
        assert!(st.ingest(&sub("PostToolUse"), None, None).is_none());
        assert!(st.sessions[0].subagents.is_empty());
        st.ingest(&sub("SubagentStart"), None, None); // resumed for real
        assert_eq!(st.sessions[0].subagents.len(), 1);
    }

    #[test]
    fn names_subagents_after_the_task_they_were_given() {
        let mut st = Store::default();
        let launch = |t: &str, d: &str| base(json!({ "hook_event_name": "PreToolUse", "tool_name": "Agent", "tool_input": { "subagent_type": t, "description": d } }));
        st.ingest(&launch("Explore", "Find cart code"), None, None);
        st.ingest(&launch("Plan", "Plan checkout"), None, None);
        let e = st.ingest(&base(json!({ "hook_event_name": "SubagentStart", "agent_id": "p1", "agent_type": "Plan" })), None, None).unwrap();
        assert_eq!(e["agentTask"], "Plan checkout");
        st.ingest(&base(json!({ "hook_event_name": "SubagentStart", "agent_id": "x1", "agent_type": "Explore" })), None, None);
        assert_eq!(st.sessions[0].subagents[1].task.as_deref(), Some("Find cart code"));
        st.ingest(&base(json!({ "hook_event_name": "SubagentStart", "agent_id": "x2", "agent_type": "Explore" })), None, None);
        assert_eq!(st.sessions[0].subagents[2].task, None);
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
        assert!(st.ingest_from(&json!({ "hook_event_name": "SessionStart", "session_id": "codex:h1", "cwd": "/" }), None, None, "codex", Origin::default()).is_none());
        assert!(!st.sessions.iter().any(|s| s.id == "codex:h1"));
    }

    #[test]
    fn names_a_session_after_its_chat_title_or_first_prompt() {
        fn untitled(_: &str) -> Option<Transcript> { None }
        fn titled(_: &str) -> Option<Transcript> { Some(Transcript { title: Some("Fix cart total rounding".into()), messages: vec![], context: None }) }
        let mut st = Store::default();
        st.read = Some(untitled);
        let tp = "/Users/me/.claude/projects/shop/s1.jsonl";
        let e = st.ingest(&base(json!({ "hook_event_name": "UserPromptSubmit", "prompt": "fix the   cart total", "transcript_path": tp })), None, None).unwrap();
        assert_eq!(e["session"]["title"], "fix the cart total");
        st.read = Some(titled);
        let e = st.ingest(&base(json!({ "hook_event_name": "Stop", "transcript_path": tp })), None, None).unwrap();
        assert_eq!(e["session"]["title"], "Fix cart total rounding");
    }

    #[test]
    fn spots_merges_but_not_syncing_with_main_or_auto_merge() {
        let bash = |c: &str| is_merge("Bash", &json!({ "command": c }));
        assert!(bash("gh pr merge 42 --squash --delete-branch"));
        assert!(bash("cd repo && GH_PROMPT_DISABLED=1 gh pr merge --merge"));
        assert!(bash("git merge --no-ff feature/cart"));
        assert!(bash("git -C ../shop merge --continue"));
        assert!(is_merge("mcp__github__merge_pull_request", &json!({})));
        assert!(!bash("gh pr merge 42 --auto --squash"));
        assert!(!bash("git merge origin/main"));
        assert!(!bash("git merge main"));
        assert!(!bash("git merge --abort"));
        assert!(!bash("git merge-base HEAD main"));
        assert!(!bash("echo \"gh pr merge\""));
        assert!(!is_merge("Read", &json!({ "file_path": "merge.ts" })));
    }

    #[test]
    fn marks_the_session_merged_until_the_next_prompt() {
        fn untitled(_: &str) -> Option<Transcript> { None }
        let mut st = Store::default();
        st.read = Some(untitled);
        let e = st.ingest(&base(json!({ "hook_event_name": "PostToolUse", "tool_name": "Bash", "tool_input": { "command": "gh pr merge 7 --squash" } })), None, None).unwrap();
        assert_eq!((e["merged"].clone(), e["session"]["merged"].clone()), (json!(true), json!(true)));
        assert_eq!(st.ingest(&base(json!({ "hook_event_name": "Stop" })), None, None).unwrap()["session"]["activity"], "Finished · merged");
        assert_eq!(st.ingest(&base(json!({ "hook_event_name": "UserPromptSubmit", "prompt": "next" })), None, None).unwrap()["session"]["merged"], false);
    }

    fn found(id: &str, status: &str) -> Found {
        Found { agent: "claude-code".into(), id: id.into(), cwd: "/Users/me/code/shop".into(), project: None, entrypoint: Some("claude-desktop".into()),
                at: now_ms(), status: status.into(), activity: "Working".into(), title: Some("Fix cart".into()), messages: vec![] }
    }

    #[test]
    fn adopts_chats_found_in_logs_until_a_hook_takes_over() {
        fn untitled(_: &str) -> Option<Transcript> { None }
        let mut st = Store::default();
        st.read = Some(untitled);
        let e = st.adopt(found("s1", "working")).unwrap();
        assert_eq!((e["type"].as_str(), e["message"].as_str(), e["session"]["title"].as_str()), (Some("SessionFound"), Some("Already running"), Some("Fix cart")));
        assert_eq!((st.sessions[0].project.as_str(), st.sessions[0].entrypoint.as_str()), ("shop", "desktop"));
        assert!(st.adopt(found("s1", "working")).is_none());                       // nothing changed
        assert!(st.adopt(found("s1", "done")).unwrap()["message"].is_null());    // a refresh, not a new arrival
        st.ingest(&base(json!({ "hook_event_name": "UserPromptSubmit", "prompt": "next" })), None, None);
        assert!(st.adopt(found("s1", "done")).is_none());                          // hooks win from now on
        assert_eq!((st.sessions.len(), st.sessions[0].status.as_str(), st.sessions[0].title.as_deref()), (1, "thinking", Some("Fix cart")));
    }

    #[test]
    fn ended_chats_stay_gone_and_unheard_ones_leave_when_their_log_goes_quiet() {
        let mut st = Store::default();
        st.adopt(found("s1", "done"));
        st.ingest(&base(json!({ "hook_event_name": "SessionEnd" })), None, None);
        assert!(st.adopt(found("s1", "done")).is_none());
        let mut old = found("s2", "done");
        old.at = now_ms() - FOUND_WINDOW_MS - 1;
        st.adopt(old);
        st.prune();
        assert!(st.sessions.is_empty());
    }

    #[test]
    fn sends_the_chat_only_when_it_changes_and_shows_a_new_prompt_right_away() {
        fn hi(_: &str) -> Option<Transcript> { Some(Transcript { title: None, messages: vec![Message { role: "assistant".into(), text: "Hi".into() }], context: None }) }
        let mut st = Store::default();
        st.read = Some(hi);
        let tp = json!({ "transcript_path": "/Users/me/.claude/projects/shop/s1.jsonl" });
        let with = |extra: Value| { let mut v = base(tp.clone()); v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone()); v };
        let e = st.ingest(&with(json!({ "hook_event_name": "SessionStart" })), None, None).unwrap();
        assert_eq!(e["session"]["messages"][0]["text"], "Hi");
        let e = st.ingest(&with(json!({ "hook_event_name": "PreToolUse", "tool_name": "Read", "tool_input": {} })), None, None).unwrap();
        assert!(e["session"].get("messages").is_none());
        let e = st.ingest(&with(json!({ "hook_event_name": "UserPromptSubmit", "prompt": "next" })), None, None).unwrap();
        assert_eq!(e["session"]["messages"][1], json!({ "role": "user", "text": "next" }));
    }
}
