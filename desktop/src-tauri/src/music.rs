// Now playing, for the rooftop DJ: the song on this Mac's Spotify, else Apple Music (macOS).
// Same as bridge/music.js. It only asks an app that's already running, so it never opens one,
// and nothing leaves the machine. macOS asks once before the office may read Spotify or Music.
use serde_json::{json, Value};
use std::process::Command;

const NOW_PLAYING_SCRIPT: &str = r#"function run() {
  for (const [id, source] of [['com.spotify.client', 'spotify'], ['com.apple.Music', 'music']]) {
    try {
      const app = Application(id);
      if (!app.running()) continue;
      if (app.playerState() !== 'playing') continue;
      const t = app.currentTrack();
      return JSON.stringify({ source, title: t.name(), artist: t.artist(), album: t.album() });
    } catch (e) {}
  }
  return '';
}"#;

fn clip(v: &Value) -> String {
    v.as_str().map(|s| s.trim().chars().take(120).collect()).unwrap_or_default()
}

/// The script's output as { source, title, artist, album }, or null when nothing is playing.
pub fn parse(out: &str) -> Value {
    let Ok(v) = serde_json::from_str::<Value>(out) else { return Value::Null };
    let source = v["source"].as_str().filter(|s| *s == "spotify" || *s == "music");
    let title = clip(&v["title"]);
    match source {
        Some(source) if !title.is_empty() => json!({ "source": source, "title": title, "artist": clip(&v["artist"]), "album": clip(&v["album"]) }),
        _ => Value::Null,
    }
}

/// What's playing right now, or null. Blocks for a moment, so call it off the async runtime.
pub fn now_playing() -> Value {
    if !cfg!(target_os = "macos") {
        return Value::Null;
    }
    Command::new("osascript").args(["-l", "JavaScript", "-e", NOW_PLAYING_SCRIPT]).output()
        .ok().filter(|o| o.status.success())
        .map(|o| parse(String::from_utf8_lossy(&o.stdout).trim()))
        .unwrap_or(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_song_spotify_or_music_is_playing() {
        assert_eq!(parse(r#"{"source":"spotify","title":" Buttons ","artist":"DDG","album":"Hit"}"#),
            json!({ "source": "spotify", "title": "Buttons", "artist": "DDG", "album": "Hit" }));
        assert_eq!(parse(r#"{"source":"music","title":"x","artist":null}"#)["artist"], "");
        assert_eq!(parse(&format!(r#"{{"source":"music","title":"{}"}}"#, "a".repeat(300)))["title"].as_str().unwrap().len(), 120);
    }

    #[test]
    fn nothing_playing_an_unknown_app_or_garbage_means_no_song() {
        assert!(parse("").is_null());
        assert!(parse(r#"{"source":"spotify","title":""}"#).is_null());
        assert!(parse(r#"{"source":"winamp","title":"x"}"#).is_null());
        assert!(parse("not json").is_null());
    }
}
