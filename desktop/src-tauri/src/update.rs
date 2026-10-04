// Keeps Agent Office up to date. Every few hours (remembering the last check across restarts) it asks GitHub
// for a newer release and downloads it in the background. A notification and a "Restart to update" line in the
// menu-bar menu then install it in one click. Updates are signed; the app only installs ones signed with the
// release key (its public half is in tauri.conf.json). "Check for Updates…" asks GitHub right away and answers in a dialog.
use crate::setup::{support_dir, version};
use crate::store::now_ms;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::{AppHandle, Wry};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::{Update, UpdaterExt};

const RELEASES: &str = "https://github.com/regisBafutwabo/agent-office/releases/latest";
const EVERY_MS: u64 = 4 * 60 * 60 * 1000;
/// When GitHub can't be reached (offline, say), try again sooner than the usual wait.
const RETRY_MS: u64 = 30 * 60 * 1000;

/// A downloaded update waiting for "Restart to update".
pub type Ready = Arc<Mutex<Option<(Update, Vec<u8>)>>>;

/// "Check for Updates…" wakes the background check, which then reports what it found.
pub type CheckNow = Arc<tokio::sync::Notify>;

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct State {
    checked_at: u64,
    /// The newest version GitHub had at the last check.
    latest: Option<String>,
    /// The version we already showed a banner for, so each release is announced once.
    notified: Option<String>,
}

impl State {
    fn newer_than(&self, current: &str) -> Option<&str> {
        self.latest.as_deref().filter(|v| version(v) > version(current))
    }

    /// Time to ask GitHub again: the usual wait is over, or we know of an update but haven't downloaded it
    /// (the app was quit before it was installed, say).
    fn due(&self, now: u64, current: &str, have_download: bool) -> bool {
        now >= self.checked_at + EVERY_MS || (!have_download && self.newer_than(current).is_some())
    }
}

fn state_file() -> PathBuf { support_dir().join("update-check.json") }

fn load() -> State {
    std::fs::read_to_string(state_file()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn save(state: &State) {
    let _ = std::fs::create_dir_all(support_dir());
    if let Ok(text) = serde_json::to_string_pretty(state) { let _ = std::fs::write(state_file(), text); }
}

pub async fn watch(app: AppHandle, menu: Menu<Wry>, item: MenuItem<Wry>, separator: PredefinedMenuItem<Wry>, ready: Ready, check_now: CheckNow) {
    let current = app.package_info().version.to_string();
    let mut state = load();
    let (mut shown, mut retry_at, mut asked) = (false, 0, false);
    loop {
        let now = now_ms();
        let have = ready.lock().unwrap().as_ref().map(|(u, _)| u.version.clone());
        if asked || (state.due(now, &current, have.is_some()) && now >= retry_at) {
            match download(&app, have.as_deref()).await {
                Ok(found) => {
                    if let Some(found) = found { *ready.lock().unwrap() = Some(found); }
                    state.checked_at = now;
                    state.latest = ready.lock().unwrap().as_ref().map(|(u, _)| u.version.clone());
                    save(&state);
                    if asked { answer(&app, &ready, &current); }
                }
                Err(err) => {
                    eprintln!("Couldn't check for Agent Office updates: {err}");
                    retry_at = now + RETRY_MS;
                    if asked { tell(&app, MessageDialogKind::Warning, "Couldn't check for updates", format!("{err}\n\nCheck your internet connection and try again.")); }
                }
            }
        }
        let ready_version = ready.lock().unwrap().as_ref().map(|(u, _)| u.version.clone());
        if let Some(v) = ready_version {
            let _ = item.set_text(format!("Restart to update to {v}"));
            if !shown {
                shown = menu.insert_items(&[&item, &separator], 0).is_ok();
            }
            if asked {
                state.notified = Some(v);   // the dialog already said so: no banner on top
                save(&state);
            } else if state.notified.as_deref() != Some(v.as_str()) {
                let body = format!("Version {v} is ready (you have {current}). Right-click the Agent Office icon near the clock and choose Restart to update.");
                let _ = app.notification().builder().title("Agent Office update").body(body).show();
                state.notified = Some(v);
                save(&state);
            }
        }
        // Short naps rather than one long sleep, so a Mac that slept through the 4 hours still checks soon after waking.
        asked = tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(10 * 60)) => false,
            _ = check_now.notified() => true,
        };
    }
}

/// The answer to "Check for Updates…": up to date, or an update that's downloaded and one click from installing.
fn answer(app: &AppHandle, ready: &Ready, current: &str) {
    let ready_version = ready.lock().unwrap().as_ref().map(|(u, _)| u.version.clone());
    let Some(v) = ready_version else {
        return tell(app, MessageDialogKind::Info, "You're up to date", format!("Agent Office {current} is the newest version."));
    };
    come_forward(app);
    let (app, ready) = (app.clone(), ready.clone());
    app.dialog()
        .message(format!("Version {v} is downloaded and ready to install (you have {current}). Agent Office will restart."))
        .title(format!("Agent Office {v} is available"))
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom("Restart to Update".into(), "Later".into()))
        .show(move |restart| if restart { install(&app, &ready) });
}

fn tell(app: &AppHandle, kind: MessageDialogKind, title: &str, message: String) {
    come_forward(app);
    app.dialog().message(message).title(title).kind(kind).show(|_| {});
}

/// Ask GitHub for a newer release and download it, unless it's the one already downloaded.
async fn download(app: &AppHandle, have: Option<&str>) -> Result<Option<(Update, Vec<u8>)>, String> {
    let update = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    let Some(update) = update.filter(|u| Some(u.version.as_str()) != have) else { return Ok(None) };
    let bytes = update.download(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    Ok(Some((update, bytes)))
}

/// "Restart to update": swap in the new app and relaunch. If that fails (the app is running from the
/// disk image rather than Applications, say), open the release page to update by hand.
pub fn install(app: &AppHandle, ready: &Ready) {
    let Some((update, bytes)) = ready.lock().unwrap().take() else { return };
    match update.install(&bytes) {
        Ok(()) => app.request_restart(),
        Err(err) => {
            let body = format!("Couldn't install {} ({err}). Download it from the release page instead.", update.version);
            let _ = app.notification().builder().title("Agent Office update").body(body).show();
            let _ = app.opener().open_url(RELEASES, None::<&str>);
            *ready.lock().unwrap() = Some((update, bytes));
        }
    }
}

/// Asked from the menu-bar icon, the app has no window, and macOS would open its dialog behind other apps.
fn come_forward(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.run_on_main_thread(|| {
        if let Some(mtm) = objc2::MainThreadMarker::new() {
            #[allow(deprecated)] // activate() needs macOS 14
            objc2_app_kit::NSApplication::sharedApplication(mtm).activateIgnoringOtherApps(true);
        }
    });
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(latest: Option<&str>, checked_at: u64) -> State {
        State { checked_at, latest: latest.map(str::to_string), notified: None }
    }

    #[test]
    fn only_newer_releases_count() {
        assert!(at(Some("0.6.0"), 0).newer_than("0.5.0").is_some());
        assert!(at(Some("0.10.0"), 0).newer_than("0.9.1").is_some());
        assert!(at(Some("0.5.0"), 0).newer_than("0.5.0").is_none());
        assert!(at(Some("0.4.1"), 0).newer_than("0.5.0").is_none());
        assert!(at(None, 0).newer_than("0.5.0").is_none());
    }

    #[test]
    fn checks_every_four_hours_or_when_a_known_update_isnt_downloaded() {
        let now = 10 * EVERY_MS;
        assert!(at(None, 0).due(now, "0.5.0", false), "never checked");
        assert!(!at(None, now - 1000).due(now, "0.5.0", false), "checked a moment ago");
        assert!(at(None, now - EVERY_MS).due(now, "0.5.0", false), "four hours later");
        assert!(at(Some("0.6.0"), now - 1000).due(now, "0.5.0", false), "update known but not downloaded");
        assert!(!at(Some("0.6.0"), now - 1000).due(now, "0.5.0", true), "update already downloaded");
        assert!(!at(Some("0.6.0"), now - 1000).due(now, "0.6.0", false), "already on that version");
    }
}
