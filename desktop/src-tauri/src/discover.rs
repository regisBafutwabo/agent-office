// Finds agent chats that were already running when the office opened, from the logs each tool keeps on disk.
// Hooks only report what happens next, so without this the office starts empty until each chat does something.
// It also shows chats from tools whose hooks aren't installed. Mirrors bridge/discover.js.
//   Claude Code  ~/.claude/projects/<project>/<session id>.jsonl
//   Codex        ~/.codex/sessions/YYYY/MM/DD/rollout-…-<thread id>.jsonl (first line: session_meta)
//   Cursor       ~/.cursor/projects/<project>/agent-transcripts/<chat id>/<chat id>.jsonl
// Only logs written to in the last FOUND_WINDOW_MS count. The ids match what each tool's hooks send
// (Codex and Cursor ones unverified against their hooks), so a hook takes over the same agent.
use serde_json::Value;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use crate::store::clip;
use crate::transcript::{read_tail, Message};

pub const FOUND_WINDOW_MS: u64 = 30 * 60 * 1000;
const QUIET_MS: u64 = 3 * 60 * 1000; // a log this quiet while mid-turn: probably waiting on you
const TAIL_BYTES: u64 = 256 * 1024;
const CODEX_DAYS: usize = 7; // Codex files a chat under the day it started; look back this many day folders

#[derive(Debug, Clone, PartialEq)]
pub struct Found {
    pub agent: String,
    /// Namespaced like hook session ids: "codex:<id>" (see adapters::normalize).
    pub id: String,
    pub cwd: String,
    /// Floor name when it isn't the cwd's folder name (Ollama's models share one floor).
    pub project: Option<String>,
    pub entrypoint: Option<String>,
    /// When the log was last written.
    pub at: u64,
    pub status: String,
    pub activity: String,
    pub title: Option<String>,
    pub messages: Vec<Message>,
}

fn mtime_ms(p: &Path) -> Option<u64> {
    fs::metadata(p).ok()?.modified().ok()?.duration_since(UNIX_EPOCH).ok().map(|d| d.as_millis() as u64)
}

fn dirs(p: &Path) -> Vec<PathBuf> {
    fs::read_dir(p).map(|r| r.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect()).unwrap_or_default()
}

/// .jsonl files in `dir` written to within the window, with their write time.
fn recent_logs(dir: &Path, now: u64) -> Vec<(PathBuf, u64)> {
    let Ok(rd) = fs::read_dir(dir) else { return vec![] };
    rd.flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
        .filter_map(|p| mtime_ms(&p).map(|t| (p, t)))
        .filter(|(_, t)| now.saturating_sub(*t) <= FOUND_WINDOW_MS)
        .collect()
}

/// The JSON lines in the last 256 KB of a log (the first one is usually cut in half and skipped).
fn tail(p: &Path) -> Vec<Value> {
    let Ok(mut f) = File::open(p) else { return vec![] };
    let size = f.metadata().map(|m| m.len()).unwrap_or(0);
    let len = size.min(TAIL_BYTES);
    let mut buf = Vec::new();
    if f.seek(SeekFrom::Start(size - len)).is_err() || f.take(len).read_to_end(&mut buf).is_err() {
        return vec![];
    }
    String::from_utf8_lossy(&buf).lines().filter(|l| l.starts_with('{')).filter_map(|l| serde_json::from_str(l).ok()).collect()
}

/// The first `n` JSON lines of a log.
fn head(p: &Path, n: usize) -> Vec<Value> {
    let Ok(f) = File::open(p) else { return vec![] };
    BufReader::new(f.take(4 * 1024 * 1024)).lines().take(n).map_while(Result::ok).filter_map(|l| serde_json::from_str(&l).ok()).collect()
}

/// How Claude Code and Cursor name a project folder: every character but letters and digits becomes "-".
pub fn encode(path: &str) -> String {
    path.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

/// Turns an encoded folder name back into a real path by walking the disk ("a-b" could be "a/b" or "a-b").
pub fn decode(name: &str) -> Option<PathBuf> {
    fn walk(dir: &Path, rest: &str, depth: usize) -> Option<PathBuf> {
        if depth > 16 { return None; }
        let mut kids: Vec<(String, PathBuf)> = dirs(dir).into_iter()
            .filter_map(|p| p.file_name().map(|n| (encode(&n.to_string_lossy()), p.clone()))).collect();
        kids.sort_by_key(|(e, _)| std::cmp::Reverse(e.len())); // longest name first: "cheiron-cmc" before "cheiron"
        for (e, p) in kids {
            if rest == e { return Some(p); }
            if let Some(more) = rest.strip_prefix(e.as_str()).and_then(|r| r.strip_prefix('-')) {
                if let Some(found) = walk(&p, more, depth + 1) { return Some(found); }
            }
        }
        None
    }
    let rest = name.strip_prefix('-').unwrap_or(name);
    if rest.is_empty() { None } else { walk(Path::new("/"), rest, 0) }
}

/// Mid-turn but silent for a while: most likely waiting on a permission prompt or a question.
fn settle(status: &str, activity: &str, at: u64, now: u64) -> (String, String) {
    if status != "done" && now.saturating_sub(at) > QUIET_MS {
        ("idle".into(), "Quiet for a few minutes".into())
    } else {
        (status.into(), activity.into())
    }
}

fn claude(home: &Path, now: u64, out: &mut Vec<Found>) {
    for proj in dirs(&home.join(".claude/projects")) {
        let folder = proj.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        for (log, at) in recent_logs(&proj, now) {
            let Some(id) = log.file_stem().map(|s| s.to_string_lossy().to_string()) else { continue };
            let lines = tail(&log);
            let Some(info) = lines.iter().rev().find(|o| o["cwd"].is_string()) else { continue };
            let entrypoint = info["entrypoint"].as_str().map(String::from);
            if entrypoint.as_deref().is_some_and(|e| e.starts_with("sdk")) {
                continue; // background helpers run through the Agent SDK, not chats you opened
            }
            // The session may have cd'd into a subfolder; hooks file it under the project folder, so do the same.
            let cwd = info["cwd"].as_str().unwrap_or("");
            let root = Path::new(cwd).ancestors().find(|a| encode(&a.to_string_lossy()) == folder).unwrap_or(Path::new(cwd));
            let last = lines.iter().rev().find(|o| matches!(o["type"].as_str(), Some("user" | "assistant")) && o["isSidechain"] != true && o["isMeta"] != true);
            let (status, activity) = match last {
                Some(o) if o["type"] == "assistant" => {
                    let tool = o["message"]["content"].as_array().is_some_and(|c| c.iter().any(|x| x["type"] == "tool_use"));
                    if tool { ("working", "Working") } else { ("done", "Finished") }
                }
                Some(_) => ("thinking", "Thinking"),
                None => ("idle", "Session started"),
            };
            let (status, activity) = settle(status, activity, at, now);
            let t = read_tail(&log).unwrap_or_default();
            out.push(Found { agent: "claude-code".into(), id, cwd: root.to_string_lossy().into(), project: None, entrypoint, at, status, activity, title: t.title, messages: t.messages });
        }
    }
}

fn codex(home: &Path, now: u64, out: &mut Vec<Found>) {
    let root = home.join(".codex/sessions");
    let mut days: Vec<PathBuf> = dirs(&root).iter().flat_map(|y| dirs(y)).flat_map(|m| dirs(&m)).collect();
    days.sort();
    for day in days.iter().rev().take(CODEX_DAYS) {
        for (log, at) in recent_logs(day, now) {
            let first = head(&log, 3);
            let Some(meta) = first.iter().find(|o| o["type"] == "session_meta").map(|o| &o["payload"]) else { continue };
            let id = meta["session_id"].as_str().or(meta["id"].as_str()).unwrap_or("");
            // Subagent threads and chats imported from other tools aren't chats you're running.
            let imported = first.iter().any(|o| o["payload"]["turn_id"].as_str().is_some_and(|t| t.starts_with("external-import")));
            if id.is_empty() || imported || meta["thread_source"].as_str().is_some_and(|s| s != "user") {
                continue;
            }
            let last = tail(&log).into_iter().rev()
                .find_map(|o| o["payload"]["type"].as_str().filter(|t| matches!(*t, "task_started" | "task_complete" | "turn_aborted")).map(String::from));
            let (status, activity) = match last.as_deref() {
                Some("task_started") => ("thinking", "Thinking"),
                Some(_) => ("done", "Finished"),
                None => ("idle", "Session started"),
            };
            let (status, activity) = settle(status, activity, at, now);
            out.push(Found { agent: "codex".into(), id: format!("codex:{id}"), cwd: meta["cwd"].as_str().unwrap_or("").into(), project: None,
                             entrypoint: meta["originator"].as_str().map(String::from), at, status, activity, title: None, messages: vec![] });
        }
    }
}

/// Cursor wraps your prompt as "<user_query>\n…\n</user_query>" after a timestamp.
fn cursor_prompt(o: &Value) -> Option<String> {
    let text = o["message"]["content"].as_array()?.iter().find_map(|x| x["text"].as_str())?;
    let q = text.split_once("<user_query>").map(|(_, r)| r.split("</user_query>").next().unwrap_or(r)).unwrap_or(text);
    Some(clip(q, 80)).filter(|q| !q.is_empty())
}

fn cursor(home: &Path, now: u64, out: &mut Vec<Found>) {
    for proj in dirs(&home.join(".cursor/projects")) {
        let folder = proj.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let mut cwd = None;
        for chat in dirs(&proj.join("agent-transcripts")) {
            for (log, at) in recent_logs(&chat, now) {
                let Some(id) = log.file_stem().map(|s| s.to_string_lossy().to_string()) else { continue };
                let cwd = cwd.get_or_insert_with(|| decode(&folder).map(|p| p.to_string_lossy().to_string()).unwrap_or_else(|| format!("/{}", folder.replace('-', "/")))).clone();
                let done = tail(&log).last().is_some_and(|o| o["type"] == "turn_ended");
                let (status, activity) = settle(if done { "done" } else { "thinking" }, if done { "Finished" } else { "Thinking" }, at, now);
                let title = head(&log, 1).first().filter(|o| o["role"] == "user").and_then(cursor_prompt);
                out.push(Found { agent: "cursor".into(), id: format!("cursor:{id}"), cwd, project: None, entrypoint: None, at, status, activity, title, messages: vec![] });
            }
        }
    }
}

/// Every chat whose log was written to in the last 30 minutes.
pub fn scan(home: &Path, now: u64) -> Vec<Found> {
    let mut out = Vec::new();
    claude(home, now, &mut out);
    codex(home, now, &mut out);
    cursor(home, now, &mut out);
    out
}

pub fn scan_home(now: u64) -> Vec<Found> {
    match std::env::var("HOME") {
        Ok(h) if !h.is_empty() => scan(Path::new(&h), now),
        _ => vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::now_ms;
    use serde_json::json;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("agent-office-discover-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn write(p: &Path, lines: &[Value]) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, lines.iter().map(|l| l.to_string() + "\n").collect::<String>()).unwrap();
    }

    #[test]
    fn finds_claude_chats_filed_under_their_project_and_skips_sdk_helpers() {
        let home = tmp("claude");
        let shop = home.join("code/shop");
        fs::create_dir_all(shop.join("src")).unwrap();
        let folder = home.join(".claude/projects").join(encode(&shop.to_string_lossy()));
        write(&folder.join("s1.jsonl"), &[
            json!({ "type": "user", "cwd": shop.join("src"), "entrypoint": "cli", "message": { "content": "fix the cart" } }),
            json!({ "type": "assistant", "cwd": shop.join("src"), "entrypoint": "cli", "message": { "content": [{ "type": "tool_use", "name": "Read" }] } }),
            json!({ "type": "ai-title", "aiTitle": "Fix cart" }),
        ]);
        write(&folder.join("s2.jsonl"), &[json!({ "type": "user", "cwd": shop, "entrypoint": "sdk-cli", "message": { "content": "observe" } })]);
        let found = scan(&home, now_ms());
        assert_eq!(found.len(), 1);
        let f = &found[0];
        assert_eq!((f.id.as_str(), f.cwd.as_str(), f.status.as_str(), f.title.as_deref()), ("s1", shop.to_str().unwrap(), "working", Some("Fix cart")));
        assert_eq!(f.messages[0].text, "fix the cart");
        assert!(scan(&home, now_ms() + FOUND_WINDOW_MS + 60_000).is_empty());
    }

    #[test]
    fn finds_codex_threads_you_started_but_not_imports_or_subagents() {
        let home = tmp("codex");
        let day = home.join(".codex/sessions/2026/10/01");
        let meta = |id: &str, source: &str| json!({ "type": "session_meta", "payload": { "id": id, "session_id": id, "cwd": "/repo", "originator": "codex_cli_rs", "thread_source": source } });
        write(&day.join("rollout-a.jsonl"), &[meta("t1", "user"), json!({ "type": "event_msg", "payload": { "type": "task_started" } }), json!({ "type": "event_msg", "payload": { "type": "task_complete" } })]);
        write(&day.join("rollout-b.jsonl"), &[meta("t2", "subagent")]);
        write(&day.join("rollout-c.jsonl"), &[json!({ "type": "session_meta", "payload": { "id": "t3", "cwd": "/repo" } }), json!({ "type": "event_msg", "payload": { "type": "task_started", "turn_id": "external-import-turn-1" } })]);
        let found = scan(&home, now_ms());
        assert_eq!(found.iter().map(|f| (f.id.as_str(), f.status.as_str())).collect::<Vec<_>>(), vec![("codex:t1", "done")]);
    }

    #[test]
    fn finds_cursor_chats_and_names_them_after_the_first_prompt() {
        let home = tmp("cursor");
        let log = home.join(".cursor/projects/Users-me-shop/agent-transcripts/c1/c1.jsonl");
        write(&log, &[json!({ "role": "user", "message": { "content": [{ "type": "text", "text": "<timestamp>now</timestamp>\n<user_query>\ngit   pull\n</user_query>" }] } })]);
        let found = scan(&home, now_ms());
        assert_eq!((found[0].id.as_str(), found[0].status.as_str(), found[0].title.as_deref()), ("cursor:c1", "thinking", Some("git pull")));
        assert_eq!(found[0].cwd, "/Users/me/shop"); // no such folder here, so the dashes are read as slashes
    }

    #[test]
    fn decodes_folder_names_by_walking_the_disk() {
        let home = tmp("decode");
        fs::create_dir_all(home.join("cheiron-cmc/backend")).unwrap();
        fs::create_dir_all(home.join("cheiron")).unwrap();
        fs::create_dir_all(home.join(".claude-mem/observer")).unwrap();
        let enc = |rel: &str| encode(&home.join(rel).to_string_lossy());
        assert_eq!(decode(&enc("cheiron-cmc/backend")), Some(home.join("cheiron-cmc/backend")));
        assert_eq!(decode(&enc(".claude-mem/observer")), Some(home.join(".claude-mem/observer")));
        assert_eq!(decode(&enc("nope")), None);
    }

    #[test]
    fn a_quiet_log_mid_turn_reads_as_waiting_on_you() {
        assert_eq!(settle("working", "Working", 0, QUIET_MS + 1).0, "idle");
        assert_eq!(settle("done", "Finished", 0, QUIET_MS + 1).0, "done");
    }
}
