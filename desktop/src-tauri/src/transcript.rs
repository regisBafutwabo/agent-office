// What the office shows from a Claude Code transcript (the .jsonl in the hook payload's transcript_path):
// the chat's title and its last few messages. Mirrors bridge/transcript.js; only the end of the file is read.
//   Title: the latest "custom-title" wins, else the latest "ai-title"; both repeat as the chat goes on.
//   Messages: your prompts and Claude's text replies. Tool calls, tool results, thinking and subagent
//   (sidechain) turns are left out; the live feed already shows tool calls.
//   Context: how much of the context window the chat fills, from the last main-chain reply's token usage.
use serde::Serialize;
use serde_json::Value;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path};

// Read the last 256 KB; if big tool outputs crowd the messages out, look further back (up to 4 MB).
const TAIL_BYTES: [u64; 3] = [256 * 1024, 1024 * 1024, 4 * 1024 * 1024];
pub const MESSAGES_MAX: usize = 12;
pub const MESSAGE_CHARS: usize = 600;
/// Transcripts don't say how big the window is: 200k unless the chat already holds more, then the 1M window.
pub const CONTEXT_WINDOWS: [u64; 2] = [200_000, 1_000_000];

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Message {
    pub role: String,
    pub text: String,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
pub struct Context {
    pub used: u64,
    pub max: u64,
}

#[derive(Default, Debug)]
pub struct Transcript {
    pub title: Option<String>,
    pub messages: Vec<Message>,
    pub context: Option<Context>,
}

/// Everything the model read for that reply plus what it wrote is what the next turn starts from.
fn context_of(o: &Value) -> Option<Context> {
    if o["type"] != "assistant" || o["isSidechain"] == true { return None; }
    let u = &o["message"]["usage"];
    let used: u64 = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"].iter().filter_map(|k| u[*k].as_u64()).sum();
    if used == 0 { return None; }
    Some(Context { used, max: CONTEXT_WINDOWS.into_iter().find(|w| used <= *w).unwrap_or(used) })
}

/// Keeps line breaks (replies are often lists), trims runs of blank lines, cuts long messages.
pub fn clip_text(s: &str) -> String {
    let mut out = String::new();
    let mut blank = 0;
    for line in s.replace('\r', "").lines() {
        let line = line.trim_end();
        if line.is_empty() { blank += 1; } else { blank = 0; }
        if blank <= 1 { out.push_str(line); out.push('\n'); }
    }
    let t = out.trim();
    if t.chars().count() > MESSAGE_CHARS {
        let mut c: String = t.chars().take(MESSAGE_CHARS - 1).collect();
        c.truncate(c.trim_end().len());
        c.push('…');
        c
    } else {
        t.to_string()
    }
}

fn texts(c: &Value) -> String {
    c.as_array().map(|a| a.iter().filter(|x| x["type"] == "text").filter_map(|x| x["text"].as_str()).collect::<Vec<_>>().join("\n")).unwrap_or_default()
}

fn message_of(o: &Value) -> Option<Message> {
    let kind = o["type"].as_str()?;
    if (kind != "user" && kind != "assistant") || o["isMeta"] == true || o["isSidechain"] == true || o["message"].is_null() {
        return None;
    }
    let c = &o["message"]["content"];
    let text = if kind == "user" {
        if c.as_array().is_some_and(|a| a.iter().any(|x| x["type"] == "tool_result")) {
            return None;
        }
        let t = c.as_str().map(String::from).unwrap_or_else(|| texts(c));
        if t.trim_start().starts_with('<') { return None; } // slash commands, hook and system notes
        t
    } else {
        texts(c)
    };
    if text.trim().is_empty() { return None; }
    Some(Message { role: kind.into(), text: clip_text(&text) })
}

pub fn parse_transcript(text: &str) -> Transcript {
    let (mut custom, mut ai, mut messages, mut context) = (None::<String>, None::<String>, Vec::new(), None);
    for line in text.lines() {
        if !line.starts_with('{') {
            continue;
        }
        let Ok(o) = serde_json::from_str::<Value>(line) else { continue }; // first line of the tail is usually cut in half
        let s = |k: &str| o[k].as_str().filter(|s| !s.is_empty()).map(String::from);
        match o["type"].as_str() {
            Some("custom-title") if s("customTitle").is_some() => custom = s("customTitle"),
            Some("ai-title") if s("aiTitle").is_some() => ai = s("aiTitle"),
            _ => {
                if let Some(m) = message_of(&o) { messages.push(m); }
                context = context_of(&o).or(context);
            }
        }
    }
    let title = custom.or(ai).map(|t| t.split_whitespace().collect::<Vec<_>>().join(" ")).filter(|t| !t.is_empty());
    let skip = messages.len().saturating_sub(MESSAGES_MAX);
    Transcript { title, messages: messages.split_off(skip), context }
}

/// Only transcripts in the user's home folder: the path comes from a hook payload.
pub fn read_transcript(p: &str) -> Option<Transcript> {
    let path = Path::new(p);
    let home = std::env::var("HOME").ok().filter(|h| !h.is_empty())?;
    if !path.is_absolute() || !p.ends_with(".jsonl") || !path.starts_with(&home) || path.components().any(|c| c == Component::ParentDir) {
        return None;
    }
    read_tail(path)
}

/// Reads a transcript the office found itself (see discover.rs), so no path check.
pub fn read_tail(path: &Path) -> Option<Transcript> {
    let mut f = File::open(path).ok()?;
    let size = f.metadata().ok()?.len();
    let mut t = Transcript::default();
    for max in TAIL_BYTES {
        let len = size.min(max);
        f.seek(SeekFrom::Start(size - len)).ok()?;
        let mut buf = Vec::with_capacity(len as usize);
        (&mut f).take(len).read_to_end(&mut buf).ok()?;
        t = parse_transcript(&String::from_utf8_lossy(&buf));
        if t.messages.len() >= MESSAGES_MAX || len == size {
            break;
        }
    }
    Some(t)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_the_latest_custom_title_falling_back_to_the_ai_title() {
        let ai = r#"{"type":"ai-title","aiTitle":"Locate storage"}"#;
        assert_eq!(parse_transcript(&format!("half a line\"}}\n{ai}\n")).title.as_deref(), Some("Locate storage"));
        let text = format!("{}\n{ai}\n{}\n", r#"{"type":"custom-title","customTitle":"Old"}"#, r#"{"type":"custom-title","customTitle":"Checkout  bug"}"#);
        assert_eq!(parse_transcript(&text).title.as_deref(), Some("Checkout bug"));
        assert_eq!(parse_transcript("{\"type\":\"user\"}\n").title, None);
    }

    #[test]
    fn keeps_prompts_and_text_replies_only() {
        let lines = [
            json!({ "type": "user", "message": { "content": "fix the cart" } }),
            json!({ "type": "assistant", "message": { "content": [{ "type": "thinking", "thinking": "hmm" }, { "type": "tool_use", "name": "Read" }] } }),
            json!({ "type": "user", "message": { "content": [{ "type": "tool_result", "content": "file" }] } }),
            json!({ "type": "user", "isMeta": true, "message": { "content": "meta" } }),
            json!({ "type": "user", "message": { "content": "<command-name>/clear</command-name>" } }),
            json!({ "type": "assistant", "isSidechain": true, "message": { "content": [{ "type": "text", "text": "subagent talk" }] } }),
            json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": "Fixed it.\n\n\n\n- rounding" }] } }),
        ];
        let text = lines.iter().map(|l| l.to_string()).collect::<Vec<_>>().join("\n");
        let m = parse_transcript(&format!("cut in half\"}}\n{text}")).messages;
        assert_eq!(m, vec![
            Message { role: "user".into(), text: "fix the cart".into() },
            Message { role: "assistant".into(), text: "Fixed it.\n\n- rounding".into() },
        ]);
    }

    #[test]
    fn reads_how_full_the_context_window_is_from_the_last_main_chain_reply() {
        let usage = |n: u64, side: bool| json!({ "type": "assistant", "isSidechain": side, "message": { "content": [], "usage": { "input_tokens": 2, "cache_read_input_tokens": n, "output_tokens": 8 } } }).to_string();
        assert_eq!(parse_transcript(r#"{"type":"user","message":{"content":"hi"}}"#).context, None);
        let text = [usage(40_000, false), usage(90_000, false), usage(5, true)].join("\n");
        assert_eq!(parse_transcript(&text).context, Some(Context { used: 90_010, max: 200_000 }));
        assert_eq!(parse_transcript(&usage(300_000, false)).context, Some(Context { used: 300_010, max: 1_000_000 }));
    }

    #[test]
    fn ignores_paths_outside_home() {
        assert!(read_transcript("/etc/passwd").is_none());
        assert!(read_transcript("relative/s1.jsonl").is_none());
    }
}
