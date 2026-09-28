// The conversation's title, read from the end of a Claude Code transcript (the .jsonl in the hook payload's transcript_path).
// Mirrors bridge/title.js: the latest "custom-title" wins, else the latest "ai-title"; both repeat, so the tail is enough.
use serde_json::Value;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path};

const TAIL_BYTES: u64 = 256 * 1024;

/// Latest custom title, else latest AI title.
pub fn title_from_text(text: &str) -> Option<String> {
    let (mut custom, mut ai) = (None, None);
    for line in text.lines() {
        if !line.contains("-title\"") {
            continue;
        }
        let Ok(o) = serde_json::from_str::<Value>(line) else { continue }; // first line of the tail is usually cut in half
        let get = |k: &str| o.get(k).and_then(Value::as_str).filter(|s| !s.is_empty()).map(String::from);
        match o.get("type").and_then(Value::as_str) {
            Some("custom-title") => {
                if let Some(t) = get("customTitle") { custom = Some(t); }
            }
            Some("ai-title") => {
                if let Some(t) = get("aiTitle") { ai = Some(t); }
            }
            _ => {}
        }
    }
    let t = custom.or(ai)?.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.is_empty() { None } else { Some(t) }
}

/// Only transcripts in the user's home folder: the path comes from a hook payload.
pub fn transcript_title(p: &str) -> Option<String> {
    let path = Path::new(p);
    let home = std::env::var("HOME").ok().filter(|h| !h.is_empty())?;
    if !path.is_absolute() || !p.ends_with(".jsonl") || !path.starts_with(&home) || path.components().any(|c| c == Component::ParentDir) {
        return None;
    }
    let mut f = File::open(path).ok()?;
    let size = f.metadata().ok()?.len();
    let len = size.min(TAIL_BYTES);
    f.seek(SeekFrom::Start(size - len)).ok()?;
    let mut buf = Vec::with_capacity(len as usize);
    f.take(len).read_to_end(&mut buf).ok()?;
    title_from_text(&String::from_utf8_lossy(&buf))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_latest_custom_title_falling_back_to_the_ai_title() {
        let ai = r#"{"type":"ai-title","aiTitle":"Locate storage"}"#;
        assert_eq!(title_from_text(&format!("half a line\"}}\n{ai}\n")).as_deref(), Some("Locate storage"));
        let text = format!("{}\n{ai}\n{}\n", r#"{"type":"custom-title","customTitle":"Old"}"#, r#"{"type":"custom-title","customTitle":"Checkout  bug"}"#);
        assert_eq!(title_from_text(&text).as_deref(), Some("Checkout bug"));
        assert_eq!(title_from_text("{\"type\":\"user\"}\n"), None);
    }

    #[test]
    fn ignores_paths_outside_home() {
        assert_eq!(transcript_title("/etc/passwd"), None);
        assert_eq!(transcript_title("relative/s1.jsonl"), None);
    }
}
