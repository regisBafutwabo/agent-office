//! What a session's checkout holds that its base branch doesn't: the file list for the agent card and one file's
//! diff on request. Mirrors bridge/changes.js. Read-only: Git never takes a lock here, so it can't get in an agent's way.
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, UNIX_EPOCH};

const GIT_TIMEOUT: Duration = Duration::from_secs(5);
/// Every card and agent on one checkout shares a reading this fresh.
const CACHE: Duration = Duration::from_secs(2);
const MAX_FILES: usize = 300;
/// Characters of one file's diff.
const MAX_DIFF: usize = 200_000;
/// Untracked files larger than this don't get their lines counted.
const COUNT_BYTES: u64 = 256 * 1024;
const EDIT_LINES: usize = 6;
const EDIT_CHARS: usize = 160;
const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const BASES: [&str; 6] = ["origin/main", "origin/master", "origin/develop", "main", "master", "develop"];

/// The lines an edit took out and put in, without the unchanged ones around them, short enough for a card.
pub fn edit_of(tool: &str, input: &Value) -> Option<Value> {
    let lines = |s: &str| {
        let mut l: Vec<String> = s.replace('\r', "").split('\n').map(String::from).collect();
        if l.last().is_some_and(|x| x.is_empty()) { l.pop(); }
        l
    };
    let (mut del, mut add) = match tool {
        "Edit" => (lines(input["old_string"].as_str().unwrap_or("")), lines(input["new_string"].as_str()?)),
        "Write" => (Vec::new(), lines(input["content"].as_str()?)),
        _ => return None,
    };
    while !del.is_empty() && !add.is_empty() && del[0] == add[0] { del.remove(0); add.remove(0); }
    while !del.is_empty() && !add.is_empty() && del.last() == add.last() { del.pop(); add.pop(); }
    let cut = |list: &[String]| -> Vec<String> {
        list.iter().take(EDIT_LINES).map(|l| if l.chars().count() > EDIT_CHARS { l.chars().take(EDIT_CHARS - 1).chain(['…']).collect() } else { l.clone() }).collect()
    };
    let more = del.len().saturating_sub(EDIT_LINES) + add.len().saturating_sub(EDIT_LINES);
    Some(json!({ "del": cut(&del), "add": cut(&add), "more": more }))
}

/// `git diff --numstat -z --no-renames`: "added<TAB>removed<TAB>path<NUL>", with "-" for both counts on a binary file.
pub fn parse_numstat(out: &str) -> Vec<(String, Option<u64>, Option<u64>)> {
    out.split('\0').filter_map(|rec| {
        let mut p = rec.splitn(3, '\t');
        let (a, d, path) = (p.next()?, p.next()?, p.next()?);
        let n = |s: &str| if s == "-" { Some(None) } else { s.parse::<u64>().ok().map(Some) };
        Some((path.to_string(), n(a)?, n(d)?))
    }).collect()
}

/// `git diff --name-status -z --no-renames`: "M<NUL>path<NUL>A<NUL>path<NUL>".
pub fn parse_name_status(out: &str) -> HashMap<String, &'static str> {
    let parts: Vec<&str> = out.split('\0').collect();
    parts.chunks(2).filter(|c| c.len() == 2).map(|c| (c[1].to_string(), match c[0].chars().next() { Some('A') => "added", Some('D') => "deleted", _ => "modified" })).collect()
}

/// A path from the page is only ever a file inside the checkout.
pub fn inside_root(root: &Path, rel: &str) -> Option<PathBuf> {
    let p = Path::new(rel);
    if rel.is_empty() || rel.contains('\0') || !p.components().all(|c| matches!(c, Component::Normal(_))) { return None; }
    Some(root.join(p))
}

/// Git's output, or whether it ran out of time.
fn git(cwd: &Path, args: &[&str]) -> Result<String, bool> {
    let mut child = Command::new("git").args(args).current_dir(cwd).env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|_| false)?;
    let mut out = child.stdout.take().ok_or(false)?;
    let reader = std::thread::spawn(move || { let mut buf = Vec::new(); let _ = out.read_to_end(&mut buf); buf });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if started.elapsed() < GIT_TIMEOUT => std::thread::sleep(Duration::from_millis(10)),
            _ => { let _ = child.kill(); let _ = child.wait(); return Err(true); }
        }
    };
    let buf = reader.join().map_err(|_| false)?;
    if status.success() { Ok(String::from_utf8_lossy(&buf).into_owned()) } else { Err(false) }
}
fn quiet(cwd: &Path, args: &[&str]) -> String {
    git(cwd, args).map(|s| s.trim().to_string()).unwrap_or_default()
}

/// (what to diff against, the branch it stands for). On the base branch itself that is only what isn't committed.
fn base_of(root: &Path) -> (String, Option<String>) {
    let head = quiet(root, &["rev-parse", "--verify", "-q", "HEAD"]);
    if head.is_empty() { return (EMPTY_TREE.into(), None); }
    let remote = quiet(root, &["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]);
    for r in std::iter::once(remote.as_str()).chain(BASES).filter(|r| !r.is_empty()) {
        let sha = quiet(root, &["merge-base", "HEAD", r]);
        if !sha.is_empty() { return if sha == head { ("HEAD".into(), None) } else { (sha, Some(r.to_string())) }; }
    }
    ("HEAD".into(), None)
}

/// A fingerprint that changes when the file does, so "reviewed" can mean "reviewed this version".
fn sig_of(abs: &Path, add: &Value, del: &Value) -> String {
    match std::fs::metadata(abs) {
        Ok(m) => format!("{add}:{del}:{}:{}", m.len(), m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis()).unwrap_or(0)),
        Err(_) => format!("{add}:{del}:gone"),
    }
}
fn count_lines(abs: &Path) -> Option<u64> {
    if std::fs::metadata(abs).ok()?.len() > COUNT_BYTES { return None; }
    let buf = std::fs::read(abs).ok()?;
    if buf.contains(&0) { return None; }
    Some(buf.iter().filter(|b| **b == b'\n').count() as u64 + u64::from(buf.last().is_some_and(|b| *b != b'\n')))
}

fn read(cwd: &Path) -> Result<Value, bool> {
    let top = quiet(cwd, &["rev-parse", "--show-toplevel"]);
    if top.is_empty() { return Ok(json!({ "ok": false, "error": "Not a git checkout" })); }
    let root = std::fs::canonicalize(&top).map_err(|_| false)?;
    let branch = quiet(&root, &["rev-parse", "--abbrev-ref", "HEAD"]);
    let prefix = quiet(cwd, &["rev-parse", "--show-prefix"]);
    let (base_sha, base) = base_of(&root);
    let numstat = git(&root, &["diff", "--numstat", "-z", "--no-renames", &base_sha, "--"])?;
    let names = git(&root, &["diff", "--name-status", "-z", "--no-renames", &base_sha, "--"])?;
    let others = git(&root, &["ls-files", "--others", "--exclude-standard", "-z"])?;
    let status = parse_name_status(&names);
    let mut files: Vec<Value> = parse_numstat(&numstat).into_iter()
        .map(|(p, add, del)| json!({ "path": p, "status": status.get(&p).copied().unwrap_or("modified"), "add": add, "del": del })).collect();
    for p in others.split('\0').filter(|p| !p.is_empty()) {
        files.push(json!({ "path": p, "status": "untracked", "add": count_lines(&root.join(p)), "del": 0 }));
    }
    let truncated = files.len() > MAX_FILES;
    files.truncate(MAX_FILES);
    for f in &mut files {
        let sig = sig_of(&root.join(f["path"].as_str().unwrap_or("")), &f["add"], &f["del"]);
        f["sig"] = sig.into();
    }
    Ok(json!({ "ok": true, "root": root.to_string_lossy(), "branch": if branch == "HEAD" || branch.is_empty() { Value::Null } else { branch.into() }, "prefix": prefix,
        "base": base, "baseSha": base_sha, "files": files, "truncated": truncated, "at": crate::store::now_ms() }))
}

static CACHED: Mutex<Option<HashMap<String, (Instant, Value)>>> = Mutex::new(None);
static ROOTS: Mutex<Option<HashMap<String, Option<String>>>> = Mutex::new(None);

/// The checkout a folder belongs to, to tell which sessions share one.
pub fn root_of(cwd: &str) -> Option<String> {
    if let Some(hit) = ROOTS.lock().unwrap().get_or_insert_with(HashMap::new).get(cwd) { return hit.clone(); }
    let top = quiet(Path::new(cwd), &["rev-parse", "--show-toplevel"]);
    let root = if top.is_empty() { None } else { std::fs::canonicalize(&top).ok().map(|p| p.to_string_lossy().into_owned()) };
    ROOTS.lock().unwrap().get_or_insert_with(HashMap::new).insert(cwd.to_string(), root.clone());
    root
}

/// Blocking: call it off the async runtime, and never while holding the store.
pub fn changes(cwd: &str) -> Value {
    if let Some((at, v)) = CACHED.lock().unwrap().get_or_insert_with(HashMap::new).get(cwd) {
        if at.elapsed() < CACHE { return v.clone(); }
    }
    let v = read(Path::new(cwd)).unwrap_or_else(|timed_out| json!({ "ok": false, "error": if timed_out { "Git took too long" } else { "Git could not read this checkout" } }));
    let mut guard = CACHED.lock().unwrap();
    let cache = guard.get_or_insert_with(HashMap::new);
    if cache.len() > 64 { cache.clear(); }
    cache.insert(cwd.to_string(), (Instant::now(), v.clone()));
    v
}

pub fn file_diff(cwd: &str, rel: &str) -> Value {
    let c = changes(cwd);
    if c["ok"] != true { return c; }
    let root = PathBuf::from(c["root"].as_str().unwrap_or(""));
    let Some(abs) = inside_root(&root, rel) else { return json!({ "ok": false, "error": "Not a file in this checkout" }) };
    let mut text = git(&root, &["diff", "--no-renames", c["baseSha"].as_str().unwrap_or("HEAD"), "--", rel]).unwrap_or_default();
    if text.is_empty() {
        // untracked: the whole file is new
        let Ok(buf) = std::fs::read(&abs) else { return json!({ "ok": false, "error": "That file is gone" }) };
        text = if buf.contains(&0) { "Binary file".into() } else {
            let body = String::from_utf8_lossy(&buf);
            format!("@@ new file @@\n{}", body.strip_suffix('\n').unwrap_or(&body).split('\n').map(|l| format!("+{l}")).collect::<Vec<_>>().join("\n"))
        };
    }
    let truncated = text.chars().count() > MAX_DIFF;
    json!({ "ok": true, "path": rel, "text": if truncated { text.chars().take(MAX_DIFF).collect::<String>() } else { text }, "truncated": truncated })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_edit_keeps_only_the_lines_that_changed_cut_to_fit_a_card() {
        assert_eq!(edit_of("Edit", &json!({ "old_string": "a\nb\nc", "new_string": "a\nB\nc" })), Some(json!({ "del": ["b"], "add": ["B"], "more": 0 })));
        assert_eq!(edit_of("Write", &json!({ "content": "one\ntwo\n" })).unwrap()["add"], json!(["one", "two"]));
        let long: Vec<String> = (0..10).map(|i| "x".repeat(if i == 0 { 400 } else { 3 })).collect();
        let e = edit_of("Write", &json!({ "content": long.join("\n") })).unwrap();
        assert_eq!(e["add"].as_array().unwrap().len(), 6);
        assert_eq!(e["more"], 4);
        assert_eq!(e["add"][0].as_str().unwrap().chars().count(), 160);
        assert_eq!(edit_of("Bash", &json!({ "command": "ls" })), None);
        assert_eq!(edit_of("Edit", &json!({ "file_path": "a.txt" })), None);
    }

    #[test]
    fn reads_git_numstat_and_name_status_output_binary_files_included() {
        assert_eq!(parse_numstat("3\t1\tsrc/a b.js\0-\t-\tlogo.png\0"), vec![("src/a b.js".to_string(), Some(3), Some(1)), ("logo.png".to_string(), None, None)]);
        let st = parse_name_status("M\0src/a b.js\0A\0new.js\0D\0old.js\0");
        assert_eq!((st["src/a b.js"], st["new.js"], st["old.js"]), ("modified", "added", "deleted"));
    }

    #[test]
    fn a_path_from_the_page_cannot_leave_the_checkout() {
        let root = Path::new("/repo");
        assert_eq!(inside_root(root, "../etc/passwd"), None);
        assert_eq!(inside_root(root, "/etc/passwd"), None);
        assert_eq!(inside_root(root, ""), None);
        assert_eq!(inside_root(root, "src/a.js"), Some(PathBuf::from("/repo/src/a.js")));
    }

    #[test]
    fn lists_committed_uncommitted_and_untracked_work_since_the_base_branch() {
        let dir = std::env::temp_dir().join(format!("office-changes-{}-{}", std::process::id(), crate::store::now_ms()));
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        let dir = std::fs::canonicalize(&dir).unwrap();
        let run = |args: &[&str]| assert!(Command::new("git").args(args).current_dir(&dir)
            .envs([("GIT_AUTHOR_NAME", "t"), ("GIT_AUTHOR_EMAIL", "t@t"), ("GIT_COMMITTER_NAME", "t"), ("GIT_COMMITTER_EMAIL", "t@t")]).output().unwrap().status.success());
        run(&["init", "-q", "-b", "main"]);
        std::fs::write(dir.join("a.txt"), "one\ntwo\n").unwrap();
        std::fs::write(dir.join("gone.txt"), "x\n").unwrap();
        run(&["add", "."]); run(&["commit", "-q", "-m", "base"]); run(&["checkout", "-q", "-b", "feature"]);
        std::fs::write(dir.join("b.txt"), "new\n").unwrap();
        run(&["add", "b.txt"]); run(&["commit", "-q", "-m", "add b"]);
        std::fs::write(dir.join("a.txt"), "one\nTWO\nthree\n").unwrap();
        std::fs::remove_file(dir.join("gone.txt")).unwrap();
        std::fs::write(dir.join("sub/c.txt"), "u1\nu2").unwrap();
        let root = dir.to_string_lossy().into_owned();
        let c = changes(&dir.join("sub").to_string_lossy());
        assert_eq!((c["ok"].clone(), c["root"].as_str(), c["branch"].as_str(), c["base"].as_str(), c["prefix"].as_str()), (json!(true), Some(root.as_str()), Some("feature"), Some("main"), Some("sub/")));
        let by: Vec<Value> = c["files"].as_array().unwrap().iter().map(|f| json!([f["path"], f["status"], f["add"], f["del"]])).collect();
        assert_eq!(json!(by), json!([["a.txt", "modified", 2, 1], ["b.txt", "added", 1, 0], ["gone.txt", "deleted", 0, 1], ["sub/c.txt", "untracked", 2, 0]]));
        assert!(file_diff(&root, "a.txt")["text"].as_str().unwrap().lines().any(|l| l == "-two"));
        assert!(file_diff(&root, "sub/c.txt")["text"].as_str().unwrap().lines().any(|l| l == "+u2"));
        assert_eq!(file_diff(&root, "../x")["ok"], false);
        assert_eq!(root_of(&root).as_deref(), Some(root.as_str()));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
