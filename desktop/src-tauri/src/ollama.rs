// Ollama has no hooks and keeps no chat logs, so the office asks the Ollama server itself which models are
// loaded (GET /api/ps) and reads the end of its log to tell whether one is answering. Each loaded model is an
// agent on an "Ollama" floor, and it leaves when Ollama unloads the model. Ollama doesn't know which tool or
// project sent a prompt, so these agents never raise a hand or show the chat. Mirrors bridge/ollama.js.
//   Models  http://127.0.0.1:11434/api/ps
//   Log     ~/.ollama/logs/server.log (the Mac app's; llama.cpp runner lines, absent on older versions)
use serde_json::Value;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::Path;
use std::time::Duration;

use crate::discover::Found;

const ADDR: ([u8; 4], u16) = ([127, 0, 0, 1], 11434);
const TIMEOUT: Duration = Duration::from_secs(1);
const LOG_TAIL: u64 = 64 * 1024;

fn read_tail(p: &Path) -> String {
    let Ok(mut f) = File::open(p) else { return String::new() };
    let size = f.metadata().map(|m| m.len()).unwrap_or(0);
    let len = size.min(LOG_TAIL);
    let mut buf = Vec::new();
    if f.seek(SeekFrom::Start(size - len)).is_err() || f.take(len).read_to_end(&mut buf).is_err() {
        return String::new();
    }
    String::from_utf8_lossy(&buf).into_owned()
}

/// The runner logs "processing task" when a prompt starts and "stop processing" / "all slots are idle" when it ends.
pub fn answering(log: &str) -> bool {
    let (mut start, mut stop) = (None, None);
    for (i, l) in log.lines().enumerate() {
        if l.contains("processing task") {
            start = Some(i);
        } else if l.contains("stop processing") || l.contains("all slots are idle") {
            stop = Some(i);
        }
    }
    start > stop
}

/// /api/ps models as found agents. The log doesn't say which model is answering; Ollama pushes a model's
/// expires_at forward each time it's used, so it's the one that expires last.
pub fn models(ps: &Value, log: &str, home: &Path, now: u64) -> Vec<Found> {
    let list: Vec<&Value> = ps["models"].as_array().map(|a| a.iter().filter(|m| m["name"].as_str().is_some_and(|n| !n.is_empty())).collect()).unwrap_or_default();
    // RFC 3339 times from one server share a format and offset, so they sort as text.
    let latest = list.iter().enumerate().max_by(|(i, a), (j, b)| a["expires_at"].as_str().cmp(&b["expires_at"].as_str()).then(j.cmp(i))).map(|(i, _)| i);
    let busy = answering(log);
    list.iter().enumerate().map(|(i, m)| {
        let name = m["name"].as_str().unwrap_or_default();
        let on = busy && Some(i) == latest;
        Found {
            agent: "ollama".into(), id: format!("ollama:{name}"), cwd: home.join(".ollama").to_string_lossy().into(), project: Some("Ollama".into()),
            entrypoint: None, at: now, status: if on { "working" } else { "idle" }.into(),
            activity: if on { "Answering a prompt" } else { "Loaded, waiting for a prompt" }.into(), title: Some(name.into()), messages: vec![],
        }
    }).collect()
}

/// GET /api/ps over a plain HTTP/1.0 connection (Ollama only listens on this machine by default).
fn fetch_ps() -> Option<Value> {
    let mut conn = TcpStream::connect_timeout(&SocketAddr::from(ADDR), TIMEOUT).ok()?;
    conn.set_read_timeout(Some(TIMEOUT)).ok()?;
    conn.set_write_timeout(Some(TIMEOUT)).ok()?;
    conn.write_all(b"GET /api/ps HTTP/1.0\r\nHost: 127.0.0.1:11434\r\nAccept: application/json\r\n\r\n").ok()?;
    let mut buf = Vec::new();
    conn.take(1024 * 1024).read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf);
    let (head, body) = text.split_once("\r\n\r\n")?;
    head.split_whitespace().nth(1).filter(|code| *code == "200")?;
    serde_json::from_str(body).ok()
}

/// Every model Ollama has loaded right now; none when Ollama isn't running.
pub fn poll(home: &Path, now: u64) -> Vec<Found> {
    fetch_ps().map(|ps| models(&ps, &read_tail(&home.join(".ollama/logs/server.log")), home, now)).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const BUSY: &str = "srv  update_slots: all slots are idle\nslot launch_slot_: id  0 | task 0 | processing task, is_child = 0\nslot print_timing: id  0 | task 0 | n_gen = 100\n";

    fn ps() -> Value {
        json!({ "models": [{ "name": "qwen3.5:9b", "expires_at": "2026-10-07T12:26:04+09:00" }, { "name": "llama3.2:3b", "expires_at": "2026-10-07T12:21:00+09:00" }] })
    }

    #[test]
    fn reads_from_the_log_whether_a_prompt_is_being_answered() {
        let done = format!("{BUSY}slot      release: id  0 | task 0 | stop processing: n_tokens = 612\nsrv  update_slots: all slots are idle\n[GIN] GET \"/api/ps\"\n");
        assert!(answering(BUSY));
        assert!(!answering(&done));
        assert!(!answering("")); // older Ollama versions don't log these lines
    }

    #[test]
    fn each_loaded_model_is_an_agent_and_the_one_used_last_is_answering() {
        let found = models(&ps(), BUSY, Path::new("/Users/me"), 1);
        let got: Vec<_> = found.iter().map(|f| (f.id.as_str(), f.status.as_str(), f.title.as_deref(), f.project.as_deref(), f.cwd.as_str())).collect();
        assert_eq!(got, vec![
            ("ollama:qwen3.5:9b", "working", Some("qwen3.5:9b"), Some("Ollama"), "/Users/me/.ollama"),
            ("ollama:llama3.2:3b", "idle", Some("llama3.2:3b"), Some("Ollama"), "/Users/me/.ollama"),
        ]);
        assert!(models(&json!({}), BUSY, Path::new("/Users/me"), 1).is_empty());
    }
}
