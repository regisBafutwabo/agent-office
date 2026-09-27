// "Connect agents" without cloning the repo: the app carries the Claude Code plugin and the adapter hook
// script. It installs the plugin with Claude Code's own CLI, and adds Agent Office hooks to Codex and Cursor
// configs (keeping a backup of the original file and every hook that was already there).
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::process::Command;

const MARKETPLACE_JSON: &str = include_str!("../../../.claude-plugin/marketplace.json");
const PLUGIN_JSON: &str = include_str!("../../../plugin/.claude-plugin/plugin.json");
const HOOKS_JSON: &str = include_str!("../../../plugin/hooks/hooks.json");
const SEND_SH: &str = include_str!("../../../plugin/hooks/send.sh");
const PERMISSION_SH: &str = include_str!("../../../plugin/hooks/permission.sh");
const HOOK_SH: &str = include_str!("../../../adapters/hook.sh");

const PLUGIN_ID: &str = "agent-office@agent-office";
const CODEX_EVENTS: &[&str] = &["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "SubagentStart", "SubagentStop", "Stop", "SessionEnd"];
const CURSOR_EVENTS: &[&str] = &["sessionStart", "beforeSubmitPrompt", "preToolUse", "postToolUse", "subagentStart", "subagentStop", "stop", "sessionEnd"];

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Tool { Claude, Codex, Cursor }

impl Tool {
    pub const ALL: [Tool; 3] = [Tool::Claude, Tool::Codex, Tool::Cursor];
    pub fn id(self) -> &'static str { match self { Tool::Claude => "claude-code", Tool::Codex => "codex", Tool::Cursor => "cursor" } }
    pub fn name(self) -> &'static str { match self { Tool::Claude => "Claude Code", Tool::Codex => "Codex", Tool::Cursor => "Cursor" } }
    pub fn from_id(id: &str) -> Option<Tool> { Tool::ALL.into_iter().find(|t| t.id() == id) }
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Status { Connected, NotConnected, NotInstalled }

impl Status {
    pub fn id(self) -> &'static str { match self { Status::Connected => "connected", Status::NotConnected => "not-connected", Status::NotInstalled => "not-installed" } }
}

fn home() -> PathBuf { PathBuf::from(std::env::var_os("HOME").unwrap_or_default()) }
fn support_dir() -> PathBuf { home().join("Library/Application Support/Agent Office") }
fn hook_script() -> PathBuf { support_dir().join("hook.sh") }
fn codex_hooks() -> PathBuf { home().join(".codex/hooks.json") }
fn cursor_hooks() -> PathBuf { home().join(".cursor/hooks.json") }

pub fn status(tool: Tool) -> Status {
    match tool {
        Tool::Claude => {
            let installed = std::fs::read_to_string(home().join(".claude/plugins/installed_plugins.json"))
                .ok().and_then(|t| serde_json::from_str::<Value>(&t).ok())
                .is_some_and(|v| v["plugins"].get(PLUGIN_ID).is_some());
            if installed { Status::Connected } else if find_claude().is_some() { Status::NotConnected } else { Status::NotInstalled }
        }
        Tool::Codex | Tool::Cursor => {
            let file = if tool == Tool::Codex { codex_hooks() } else { cursor_hooks() };
            if !file.parent().is_some_and(Path::is_dir) { return Status::NotInstalled; }
            let text = std::fs::read_to_string(&file).unwrap_or_default();
            if has_office_hooks(&text, tool.id()) { Status::Connected } else { Status::NotConnected }
        }
    }
}

/// { "tools": [{ "id": "codex", "name": "Codex", "status": "connected" }, …] } for the office page.
pub fn status_json() -> Value {
    json!({ "tools": Tool::ALL.iter().map(|&t| json!({ "id": t.id(), "name": t.name(), "status": status(t).id() })).collect::<Vec<_>>() })
}

/// Returns a short message for the office or the menu bar, or why it couldn't connect.
pub fn connect(tool: Tool) -> Result<String, String> {
    if status(tool) == Status::Connected { return Ok(format!("{} is already connected", tool.name())); }
    match tool {
        Tool::Claude => connect_claude(),
        Tool::Codex => connect_hooks_file(&codex_hooks(), Tool::Codex),
        Tool::Cursor => connect_hooks_file(&cursor_hooks(), Tool::Cursor),
    }
}

fn version(v: &str) -> (u32, u32, u32) {
    let mut n = v.trim().split('.').map(|p| p.parse().unwrap_or(0));
    (n.next().unwrap_or(0), n.next().unwrap_or(0), n.next().unwrap_or(0))
}

/// When this app carries a newer plugin than the one installed from it, update it, so app users never need the repo.
/// Leaves plugins installed from anywhere else (a clone of the repo, say) alone. Returns what it did, if anything.
pub fn update_plugin_if_newer() -> Option<String> {
    let bundled = serde_json::from_str::<Value>(PLUGIN_JSON).ok()?["version"].as_str()?.to_string();
    let read = |p: &str| std::fs::read_to_string(home().join(p)).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok());
    let installed = read(".claude/plugins/installed_plugins.json")?["plugins"][PLUGIN_ID][0]["version"].as_str()?.to_string();
    let from_app = read(".claude/plugins/known_marketplaces.json")?["agent-office"]["source"]["path"].as_str()
        .is_some_and(|p| Path::new(p) == support_dir().join("claude-plugin"));
    if !from_app || version(&bundled) <= version(&installed) { return None; }
    let claude = find_claude()?;
    write_marketplace().ok()?;
    run_claude(&claude, &["plugin", "marketplace", "update", "agent-office"]).ok()?;
    run_claude(&claude, &["plugin", "update", PLUGIN_ID]).ok()?;
    Some(format!("Updated the Claude Code plugin from {installed} to {bundled}. New sessions use it."))
}

fn write_file(path: &Path, text: &str, executable: bool) -> Result<(), String> {
    if let Some(dir) = path.parent() { std::fs::create_dir_all(dir).map_err(|e| format!("Couldn't create {}: {e}", dir.display()))?; }
    std::fs::write(path, text).map_err(|e| format!("Couldn't write {}: {e}", path.display()))?;
    #[cfg(unix)]
    if executable {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// A local copy of the plugin marketplace, the same files as the repo's, for `claude plugin marketplace add`.
fn write_marketplace() -> Result<PathBuf, String> {
    let root = support_dir().join("claude-plugin");
    write_file(&root.join(".claude-plugin/marketplace.json"), MARKETPLACE_JSON, false)?;
    write_file(&root.join("plugin/.claude-plugin/plugin.json"), PLUGIN_JSON, false)?;
    write_file(&root.join("plugin/hooks/hooks.json"), HOOKS_JSON, false)?;
    write_file(&root.join("plugin/hooks/send.sh"), SEND_SH, true)?;
    write_file(&root.join("plugin/hooks/permission.sh"), PERMISSION_SH, true)?;
    Ok(root)
}

/// Apps opened from Finder don't get the shell's PATH, so look where Claude Code installs itself,
/// then ask the login shell, then fall back to the copy inside the Claude desktop app.
fn find_claude() -> Option<PathBuf> {
    let h = home();
    let usual = [h.join(".local/bin/claude"), h.join(".claude/local/claude"), PathBuf::from("/opt/homebrew/bin/claude"), PathBuf::from("/usr/local/bin/claude"), h.join(".npm-global/bin/claude")];
    if let Some(p) = usual.into_iter().find(|p| p.is_file()) { return Some(p); }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    if let Ok(out) = Command::new(shell).args(["-lc", "command -v claude"]).output() {
        let p = PathBuf::from(String::from_utf8_lossy(&out.stdout).trim());
        if p.is_absolute() && p.is_file() { return Some(p); }
    }
    let bundled = h.join("Library/Application Support/Claude/claude-code");
    let newest = std::fs::read_dir(bundled).ok()?.flatten()
        .map(|d| d.path().join("claude.app/Contents/MacOS/claude"))
        .filter(|p| p.is_file())
        .max_by_key(|p| p.metadata().and_then(|m| m.modified()).ok())?;
    Some(newest)
}

fn run_claude(claude: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new(claude).args(args).env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin")
        .output().map_err(|e| format!("Couldn't run Claude Code: {e}"))?;
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    if out.status.success() { Ok(text) } else { Err(text.trim().to_string()) }
}

fn connect_claude() -> Result<String, String> {
    let claude = find_claude().ok_or("Claude Code wasn't found on this Mac. Install Claude Code (or open the Claude app once), then try again.")?;
    let marketplace = write_marketplace()?;
    let dir = marketplace.to_string_lossy();
    // A marketplace with this name may already exist (say, from a clone of the repo); installing from it is fine.
    if let Err(err) = run_claude(&claude, &["plugin", "marketplace", "add", &dir]) {
        if !err.to_lowercase().contains("already") { return Err(format!("Couldn't add the Agent Office plugin: {err}")); }
    }
    run_claude(&claude, &["plugin", "install", PLUGIN_ID]).map_err(|e| format!("Couldn't install the Agent Office plugin: {e}"))?;
    Ok("Claude Code is connected. Start a new session and it walks into the office.".into())
}

fn connect_hooks_file(file: &Path, tool: Tool) -> Result<String, String> {
    write_file(&hook_script(), HOOK_SH, true)?;
    let existing = std::fs::read_to_string(file).ok();
    let merged = merge_hooks(existing.as_deref(), tool, &hook_script())?;
    if let Some(original) = &existing {
        write_file(&file.with_extension("json.agent-office-backup"), original, false)?;
    }
    write_file(file, &merged, false)?;
    Ok(match tool {
        Tool::Codex => "Codex is connected. Codex asks you to trust the new hooks once; new sessions then show up in the office.".into(),
        _ => format!("{} is connected. New sessions show up in the office.", tool.name()),
    })
}

/// Is this an Agent Office hook command for `agent`? Matches the app's own script and a clone of the repo.
fn is_office_command(cmd: &str, agent: &str) -> bool {
    cmd.contains("hook.sh") && (cmd.contains("Agent Office") || cmd.contains("adapters/hook.sh")) && cmd.trim_end().ends_with(&format!(" {agent}"))
}

fn commands(v: &Value) -> Vec<String> {
    let mut out = Vec::new();
    match v {
        Value::Object(m) => {
            if let Some(Value::String(c)) = m.get("command") { out.push(c.clone()); }
            for x in m.values() { out.extend(commands(x)); }
        }
        Value::Array(a) => for x in a { out.extend(commands(x)); },
        _ => {}
    }
    out
}

pub fn has_office_hooks(text: &str, agent: &str) -> bool {
    serde_json::from_str::<Value>(text).is_ok_and(|v| commands(&v).iter().any(|c| is_office_command(c, agent)))
}

/// Adds an Agent Office hook for every event the office understands, replacing older Agent Office hooks for
/// this tool and keeping everything else in the file as it was.
pub fn merge_hooks(existing: Option<&str>, tool: Tool, script: &Path) -> Result<String, String> {
    let mut root: Value = match existing.map(str::trim).filter(|t| !t.is_empty()) {
        Some(t) => serde_json::from_str(t).map_err(|_| format!("Your {} hooks file isn't valid JSON, so it was left alone. Fix it or add the hooks by hand (see docs/adapters.md).", tool.name()))?,
        None => json!({}),
    };
    let obj = root.as_object_mut().ok_or("The hooks file doesn't hold a JSON object, so it was left alone.")?;
    if tool == Tool::Cursor { obj.entry("version").or_insert(json!(1)); }
    let hooks = obj.entry("hooks").or_insert_with(|| Value::Object(Map::new())).as_object_mut().ok_or("\"hooks\" isn't an object, so the file was left alone.")?;
    let cmd = format!("\"{}\" {}", script.display(), tool.id());
    let events = if tool == Tool::Codex { CODEX_EVENTS } else { CURSOR_EVENTS };
    for &event in events {
        let list = hooks.entry(event).or_insert_with(|| json!([]));
        let Some(arr) = list.as_array_mut() else { continue };
        arr.retain(|entry| !commands(entry).iter().any(|c| is_office_command(c, tool.id())));
        arr.push(match tool {
            Tool::Codex if event.ends_with("ToolUse") => json!({ "matcher": "*", "hooks": [{ "type": "command", "command": cmd }] }),
            Tool::Codex => json!({ "hooks": [{ "type": "command", "command": cmd }] }),
            _ => json!({ "command": cmd }),
        });
    }
    serde_json::to_string_pretty(&root).map(|s| s + "\n").map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCRIPT: &str = "/Users/me/Library/Application Support/Agent Office/hook.sh";

    #[test]
    fn adds_hooks_to_an_empty_codex_config() {
        let out = merge_hooks(None, Tool::Codex, Path::new(SCRIPT)).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["hooks"]["PreToolUse"][0]["matcher"], "*");
        assert_eq!(v["hooks"]["Stop"][0]["hooks"][0]["command"], format!("\"{SCRIPT}\" codex"));
        assert!(has_office_hooks(&out, "codex"));
        assert!(!has_office_hooks(&out, "cursor"));
    }

    #[test]
    fn keeps_other_hooks_and_replaces_old_office_ones() {
        let before = r#"{ "version": 1, "hooks": {
            "stop": [{ "command": "say done" }, { "command": "\"/code/agent-office/adapters/hook.sh\" cursor" }],
            "afterFileEdit": [{ "command": "prettier" }] } }"#;
        assert!(has_office_hooks(before, "cursor"));
        let v: Value = serde_json::from_str(&merge_hooks(Some(before), Tool::Cursor, Path::new(SCRIPT)).unwrap()).unwrap();
        let stop = v["hooks"]["stop"].as_array().unwrap();
        assert_eq!(stop.len(), 2);
        assert_eq!(stop[0]["command"], "say done");
        assert_eq!(stop[1]["command"], format!("\"{SCRIPT}\" cursor"));
        assert_eq!(v["hooks"]["afterFileEdit"][0]["command"], "prettier");
        assert_eq!(v["version"], 1);
    }

    #[test]
    fn leaves_a_broken_file_alone() {
        assert!(merge_hooks(Some("{ not json"), Tool::Codex, Path::new(SCRIPT)).is_err());
        assert!(merge_hooks(Some("[]"), Tool::Codex, Path::new(SCRIPT)).is_err());
    }

    #[test]
    fn the_embedded_plugin_is_the_repo_plugin() {
        let v: Value = serde_json::from_str(PLUGIN_JSON).unwrap();
        assert_eq!(v["name"], "agent-office");
        assert!(HOOKS_JSON.contains("send.sh") && HOOKS_JSON.contains("permission.sh"));
        assert_eq!(Tool::from_id("codex"), Some(Tool::Codex));
        assert!(version("0.10.0") > version("0.4.0"));
    }
}
