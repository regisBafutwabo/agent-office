// "Open in …": bring the app, window or terminal tab where an agent runs to the front (macOS).
// Only apps on this list are ever opened, the tty is validated before it goes into AppleScript,
// and nothing runs through a shell, so a web page can't use this to launch anything else.
use std::collections::HashMap;
use std::path::Path;
use std::process::Command;
use std::sync::{Mutex, OnceLock};

/// Bundle id → display name for the coding tools we know how to bring forward.
pub const APPS: &[(&str, &str)] = &[
    ("com.apple.Terminal", "Terminal"),
    ("com.googlecode.iterm2", "iTerm"),
    ("dev.warp.Warp-Stable", "Warp"),
    ("com.mitchellh.ghostty", "Ghostty"),
    ("net.kovidgoyal.kitty", "kitty"),
    ("com.github.wez.wezterm", "WezTerm"),
    ("org.alacritty", "Alacritty"),
    ("com.todesktop.230313mzl4w4u92", "Cursor"),
    ("com.microsoft.VSCode", "VS Code"),
    ("com.exafunction.windsurf", "Windsurf"),
    ("dev.zed.Zed", "Zed"),
    ("com.anthropic.claudefordesktop", "Claude"),
    ("com.openai.codex", "Codex"),
    ("com.openai.chat", "ChatGPT"),
];
/// Editors that can open the project folder, which focuses that project's window (where its agent chat is).
const EDITORS: &[&str] = &["com.todesktop.230313mzl4w4u92", "com.microsoft.VSCode", "com.exafunction.windsurf", "dev.zed.Zed"];

pub fn app_name(bundle: &str) -> Option<&'static str> {
    APPS.iter().find(|(id, _)| *id == bundle).map(|(_, name)| *name)
}

/// Older sessions (or tools that don't pass the bundle id) still say which terminal they're in.
fn app_from_term(term: &str) -> Option<&'static str> {
    match term {
        "Apple_Terminal" => Some("com.apple.Terminal"),
        "iTerm.app" => Some("com.googlecode.iterm2"),
        "WarpTerminal" => Some("dev.warp.Warp-Stable"),
        "ghostty" => Some("com.mitchellh.ghostty"),
        "WezTerm" => Some("com.github.wez.wezterm"),
        _ => None,
    }
}

/// "ttys003" style names only; anything else is ignored.
pub fn valid_tty(tty: &str) -> bool {
    let rest = tty.strip_prefix("ttys").or_else(|| tty.strip_prefix("tty"));
    rest.is_some_and(|r| !r.is_empty() && r.len() <= 4 && r.chars().all(|c| c.is_ascii_digit()))
}

/// The Claude desktop app's id for a chat (CLAUDE_CODE_HOST_SESSION_ID): "local_" and up to 64 letters, digits or dashes.
pub fn valid_chat(chat: &str) -> bool {
    chat.strip_prefix("local_").is_some_and(|r| (1..=64).contains(&r.len()) && r.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
}

/// A Codex thread id (its hook session id, which the office stores as "codex:<uuid>").
fn codex_thread(id: &str) -> Option<&str> {
    let uuid = id.strip_prefix("codex:")?;
    let groups: Vec<&str> = uuid.split('-').collect();
    let shape_ok = groups.iter().map(|g| g.len()).eq([8, 4, 4, 4, 12]);
    (shape_ok && groups.iter().all(|g| g.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()))).then_some(uuid)
}

/// The link that opens this exact chat in its desktop app, as (bundle id, url). None when the agent runs somewhere
/// else (a terminal or an editor), where the tab or project window is the best we can do.
pub fn chat_link(agent: &str, id: &str, chat: Option<&str>, app: Option<&str>, term: Option<&str>) -> Option<(&'static str, String)> {
    if let Some(c) = chat.filter(|c| valid_chat(c)) {
        return Some(("com.anthropic.claudefordesktop", format!("claude://code/continue?session={c}&source=agent_office")));
    }
    let thread = codex_thread(id).filter(|_| agent == "codex" && term.is_none_or(str::is_empty) && app.is_none_or(|a| a.is_empty() || a == "com.openai.codex"))?;
    Some(("com.openai.codex", format!("codex://threads/{thread}")))
}

fn osascript(script: &str) -> Result<String, String> {
    let out = Command::new("osascript").args(["-e", script]).output().map_err(|e| e.to_string())?;
    if out.status.success() { Ok(String::from_utf8_lossy(&out.stdout).trim().to_string()) } else { Err(String::from_utf8_lossy(&out.stderr).trim().to_string()) }
}

fn open_app(bundle: &str, folder: Option<&str>) -> Result<(), String> {
    let mut cmd = Command::new("open");
    cmd.args(["-b", bundle]);
    if let Some(f) = folder { cmd.arg(f); }
    let status = cmd.status().map_err(|e| e.to_string())?;
    if status.success() { Ok(()) } else { Err(format!("macOS couldn't open {}", app_name(bundle).unwrap_or(bundle))) }
}

/// Returns a short message for the office ("Opened the Terminal tab"), or why it couldn't.
pub fn focus(agent: &str, id: &str, chat: Option<&str>, app: Option<&str>, term: Option<&str>, tty: Option<&str>, cwd: &str) -> Result<String, String> {
    if let Some((bundle, url)) = chat_link(agent, id, chat, app, term) {
        let status = Command::new("open").arg(&url).status().map_err(|e| e.to_string())?;
        let name = app_name(bundle).unwrap_or("the app");
        return if status.success() { Ok(format!("Opened the chat in {name}")) } else { Err(format!("macOS couldn't open {name}")) };
    }
    let bundle = app.filter(|a| app_name(a).is_some()).or_else(|| term.and_then(app_from_term))
        .ok_or_else(|| "This agent's app isn't known yet. Start a new session and try again.".to_string())?;
    let name = app_name(bundle).unwrap_or("the app");
    let tty = tty.filter(|t| valid_tty(t)).map(|t| format!("/dev/{t}"));

    if let (Some(dev), "com.apple.Terminal") = (&tty, bundle) {
        let found = osascript(&format!(r#"tell application "Terminal"
  activate
  repeat with w in windows
    repeat with t in tabs of w
      if tty of t is "{dev}" then
        set selected tab of w to t
        set index of w to 1
        return "found"
      end if
    end repeat
  end repeat
  return "missing"
end tell"#))?;
        return Ok(if found == "found" { "Opened the Terminal tab".into() } else { "Opened Terminal (that tab is closed)".into() });
    }
    if let (Some(dev), "com.googlecode.iterm2") = (&tty, bundle) {
        let found = osascript(&format!(r#"tell application "iTerm2"
  activate
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if tty of s is "{dev}" then
          select w
          tell t to select
          tell s to select
          return "found"
        end if
      end repeat
    end repeat
  end repeat
  return "missing"
end tell"#))?;
        return Ok(if found == "found" { "Opened the iTerm tab".into() } else { "Opened iTerm (that tab is closed)".into() });
    }
    if EDITORS.contains(&bundle) && !cwd.is_empty() && Path::new(cwd).is_dir() {
        open_app(bundle, Some(cwd))?;
        return Ok(format!("Opened the project in {name}"));
    }
    open_app(bundle, None)?;
    Ok(format!("Opened {name}"))
}

/// Asks macOS for an installed app's icon (by bundle id) and writes it to `out` as PNG.
const ICON_SCRIPT: &str = r#"ObjC.import('AppKit');
function run(argv) {
  const url = $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier(argv[0]);
  if (!url || url.isNil()) return 'missing';
  const img = $.NSWorkspace.sharedWorkspace.iconForFile(url.path);
  const rep = $.NSBitmapImageRep.imageRepWithData(img.TIFFRepresentation);
  rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $()).writeToFileAtomically(argv[1], true);
  return 'ok';
}"#;

/// App ids look like "com.openai.codex"; anything else is refused before it reaches macOS.
pub fn valid_bundle(id: &str) -> bool {
    (3..=120).contains(&id.len()) && id.contains('.') && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
}

/// A 128px PNG of an installed app's icon, straight from macOS, so the office shows the real, current logos
/// without shipping anyone's artwork. None if the app isn't installed. Cached for the life of the app.
pub fn app_icon(bundle: &str) -> Option<Vec<u8>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<Vec<u8>>>>> = OnceLock::new();
    if !valid_bundle(bundle) { return None; }
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(hit) = cache.lock().unwrap().get(bundle) { return hit.clone(); }
    let dir = std::env::temp_dir().join("agent-office-icons");
    let _ = std::fs::create_dir_all(&dir);
    let (full, small) = (dir.join(format!("{bundle}-full.png")), dir.join(format!("{bundle}.png")));
    let ok = Command::new("osascript").args(["-l", "JavaScript", "-e", ICON_SCRIPT, bundle]).arg(&full).output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "ok").unwrap_or(false)
        && Command::new("sips").args(["-Z", "128"]).arg(&full).arg("--out").arg(&small).output().map(|o| o.status.success()).unwrap_or(false);
    let png = if ok { std::fs::read(&small).ok() } else { None };
    cache.lock().unwrap().insert(bundle.to_string(), png.clone());
    png
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_plain_tty_names_are_accepted() {
        assert!(valid_tty("ttys003"));
        assert!(!valid_tty("??"));
        assert!(!valid_tty("ttys003\" & do shell script \"rm"));
        assert!(!valid_tty("ttys"));
    }

    #[test]
    fn chat_links_open_the_exact_chat_and_nothing_else() {
        let (bundle, url) = chat_link("claude-code", "s1", Some("local_ab-12"), Some("com.anthropic.claudefordesktop"), None).unwrap();
        assert_eq!((bundle, url.as_str()), ("com.anthropic.claudefordesktop", "claude://code/continue?session=local_ab-12&source=agent_office"));
        assert!(chat_link("claude-code", "s1", Some("local_x&open=evil"), None, None).is_none());
        let id = "codex:01a0e0d8-2f30-7311-b7ee-864db5ef85bd";
        assert_eq!(chat_link("codex", id, None, None, None).unwrap().1, "codex://threads/01a0e0d8-2f30-7311-b7ee-864db5ef85bd");
        assert!(chat_link("codex", id, None, None, Some("Apple_Terminal")).is_none());
        assert!(chat_link("codex", "codex:../../x", None, None, None).is_none());
    }

    #[test]
    fn only_app_ids_reach_the_icon_lookup() {
        assert!(valid_bundle("com.openai.codex"));
        assert!(!valid_bundle("../../etc/passwd"));
        assert!(!valid_bundle("a'); doShellScript('x"));
    }

    #[test]
    fn unknown_apps_are_refused() {
        assert!(focus("claude-code", "s1", None, Some("com.evil.app"), None, None, "/").is_err());
        assert_eq!(app_name("com.openai.codex"), Some("Codex"));
        assert_eq!(app_from_term("iTerm.app"), Some("com.googlecode.iterm2"));
    }
}
