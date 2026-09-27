// "Open in …": bring the app, window or terminal tab where an agent runs to the front (macOS).
// Only apps on this list are ever opened, the tty is validated before it goes into AppleScript,
// and nothing runs through a shell, so a web page can't use this to launch anything else.
use std::path::Path;
use std::process::Command;

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
pub fn focus(app: Option<&str>, term: Option<&str>, tty: Option<&str>, cwd: &str) -> Result<String, String> {
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
    fn unknown_apps_are_refused() {
        assert!(focus(Some("com.evil.app"), None, None, "/").is_err());
        assert_eq!(app_name("com.openai.codex"), Some("Codex"));
        assert_eq!(app_from_term("iTerm.app"), Some("com.googlecode.iterm2"));
    }
}
