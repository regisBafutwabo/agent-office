// Agent Office desktop app: a menu-bar app that runs the office server while Claude Code works,
// and opens the 3D office in a window only when you want to look. Closing the window frees its memory;
// the server and menu-bar icon keep running.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod adapters;
mod discover;
mod focus;
mod music;
mod server;
mod setup;
mod store;
mod transcript;
mod update;

use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent, Wry,
};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

const PORT: u16 = 4747;
const TRAY_ID: &str = "main";
const WINDOW_ID: &str = "office";

fn office_url() -> String {
    std::env::var("AGENT_OFFICE_PORT").ok().and_then(|p| p.parse::<u16>().ok()).map_or(format!("http://localhost:{PORT}/"), |p| format!("http://localhost:{p}/"))
}

fn port() -> u16 {
    std::env::var("AGENT_OFFICE_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(PORT)
}

/// Show the office window, creating it if it was closed.
fn open_office(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(WINDOW_ID) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    let url = office_url().parse().expect("office URL is valid");
    match WebviewWindowBuilder::new(app, WINDOW_ID, WebviewUrl::External(url))
        .title("Agent Office")
        .inner_size(1440.0, 900.0)
        .min_inner_size(900.0, 600.0)
        .build()
    {
        Ok(window) => {
            let handle = app.clone();
            window.on_window_event(move |event| {
                if let WindowEvent::Destroyed = event {
                    // back to a menu-bar-only app once the window is gone
                    #[cfg(target_os = "macos")]
                    let _ = handle.set_activation_policy(tauri::ActivationPolicy::Accessory);
                    let _ = &handle;
                }
            });
        }
        Err(err) => eprintln!("Could not open the office window: {err}"),
    }
}

fn update_tray(app: &AppHandle, status: &MenuItem<Wry>, store: &store::Store) {
    let sessions = store.sessions.len();
    let waiting = store.waiting_count();
    let text = match (sessions, waiting) {
        (0, _) => "No Claude Code sessions yet".to_string(),
        (n, 0) => format!("{n} session{} · all good", if n == 1 { "" } else { "s" }),
        (n, w) => format!("{n} session{} · {w} need{} you", if n == 1 { "" } else { "s" }, if w == 1 { "s" } else { "" }),
    };
    let _ = status.set_text(text);
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_title(if waiting > 0 { Some(waiting.to_string()) } else { None });
    }
}

/// "Connect agents" menu: one line per tool, clickable until it's connected.
fn connect_label(tool: setup::Tool, status: setup::Status) -> (String, bool) {
    match status {
        setup::Status::Connected => (format!("{} ✓ connected", tool.name()), false),
        setup::Status::NotConnected => (format!("Connect {}", tool.name()), true),
        setup::Status::NotInstalled => (format!("{} (not installed)", tool.name()), false),
    }
}

fn refresh_connect_menu(items: &[MenuItem<Wry>]) {
    for (item, tool) in items.iter().zip(setup::Tool::ALL) {
        let (text, enabled) = connect_label(tool, setup::status(tool));
        let _ = item.set_text(text);
        let _ = item.set_enabled(enabled);
    }
}

/// Native notification when an agent needs permission or finishes (once per session per 10 seconds, since
/// Claude Code reports the same prompt as both PermissionRequest and Notification).
/// Nothing while you're looking at the office. With the window open, the office plays each agent's own
/// tune, so the banner stays quiet; with it closed, macOS plays a sound instead.
/// The banner shows the agent's face when the office has sent a picture of it.
fn maybe_notify(app: &AppHandle, recent: &Mutex<HashMap<String, u64>>, e: &Value) {
    let kind = e["type"].as_str().unwrap_or("");
    let needs_you = kind == "PermissionRequest" || (kind == "Notification" && e["notificationType"].as_str() == Some("permission_prompt"));
    let done = kind == "Stop";
    if !needs_you && !done {
        return;
    }
    let window = app.get_webview_window(WINDOW_ID);
    if done && window.as_ref().is_some_and(|w| w.is_focused().unwrap_or(false)) {
        return;
    }
    let sid = e["sessionId"].as_str().unwrap_or("").to_string();
    let now = store::now_ms();
    {
        let mut seen = recent.lock().unwrap();
        let key = format!("{}:{sid}", if done { "done" } else { "needs" });
        if seen.get(&key).is_some_and(|&t| now.saturating_sub(t) < 10_000) {
            return;
        }
        seen.insert(key, now);
    }
    let project = e["session"]["project"].as_str().unwrap_or("A session");
    let (title, body, sound) = if done {
        let what = e["session"]["title"].as_str().filter(|t| !t.is_empty()).unwrap_or("Finished responding");
        (format!("✓ {project} is done"), what.to_string(), "Glass")
    } else {
        (format!("{project} needs you"), e["session"]["activity"].as_str().unwrap_or("Needs your permission").to_string(), "Submarine")
    };
    let sound = (!window.as_ref().is_some_and(|w| w.is_visible().unwrap_or(false))).then_some(sound);
    let face = server::face_path(&sid, if done { "done" } else { "waiting" }).filter(|p| p.exists());
    // notify-rust directly, since the notification plugin can't put a picture on a macOS banner.
    #[cfg(target_os = "macos")]
    let _ = notify_rust::set_application(if tauri::is_dev() { "com.apple.Terminal" } else { &app.config().identifier });
    std::thread::spawn(move || {
        let mut note = notify_rust::Notification::new();
        note.summary(&title).body(&body);
        if let Some(path) = face.as_ref().and_then(|p| p.to_str()) {
            note.image_path(path);
        }
        if let Some(sound) = sound {
            note.sound_name(sound);
        }
        let _ = note.show();
    });
}

fn main() {
    tauri::Builder::default()
        // Opening the app again (or a second build of it) just brings the running office forward.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| open_office(app)))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let status = MenuItem::with_id(app, "status", "No Claude Code sessions yet", false, None::<&str>)?;
            let open = MenuItem::with_id(app, "open", "Open Agent Office", true, None::<&str>)?;
            let browser = MenuItem::with_id(app, "browser", "Open in browser", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Agent Office", true, None::<&str>)?;
            let check_updates = MenuItem::with_id(app, "check-updates", "Check for Updates…", true, None::<&str>)?;
            let update_item = MenuItem::with_id(app, "update", "Download update", true, None::<&str>)?;
            let update_separator = PredefinedMenuItem::separator(app)?;
            let connect_items = setup::Tool::ALL.iter()
                .map(|t| MenuItem::with_id(app, format!("connect:{}", t.id()), t.name(), false, None::<&str>))
                .collect::<Result<Vec<_>, _>>()?;
            let connect_refs: Vec<&dyn tauri::menu::IsMenuItem<Wry>> = connect_items.iter().map(|i| i as &dyn tauri::menu::IsMenuItem<Wry>).collect();
            let connect = Submenu::with_items(app, "Connect agents", true, &connect_refs)?;
            let menu = Menu::with_items(app, &[&status, &PredefinedMenuItem::separator(app)?, &open, &browser, &connect, &PredefinedMenuItem::separator(app)?, &check_updates, &quit])?;
            // The app menu (shown while the office window is open) gets it too, under About like any Mac app.
            #[cfg(target_os = "macos")]
            {
                let app_menu = Menu::default(app.handle())?;
                if let Some(first) = app_menu.items()?.first().and_then(|i| i.as_submenu().cloned()) {
                    first.insert(&MenuItem::with_id(app, "check-updates", "Check for Updates…", true, None::<&str>)?, 1)?;
                }
                app.set_menu(app_menu)?;
            }
            // Checking Claude Code can ask the login shell where it lives, so do it off the main thread.
            let (items, app_handle) = (connect_items.clone(), app.handle().clone());
            std::thread::spawn(move || {
                if let Some(message) = setup::update_plugin_if_newer() {
                    let _ = app_handle.notification().builder().title("Agent Office").body(message).show();
                }
                refresh_connect_menu(&items);
            });
            let menu_items = connect_items.clone();
            let ready = update::Ready::default();
            let check_now = update::CheckNow::default();
            tauri::async_runtime::spawn(update::watch(app.handle().clone(), menu.clone(), update_item, update_separator, ready.clone(), check_now.clone()));

            TrayIconBuilder::with_id(TRAY_ID)
                .icon(tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?)
                .icon_as_template(true)
                .tooltip("Agent Office")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "open" => open_office(app),
                    "update" => update::install(app, &ready),
                    // Clicks in the app menu arrive here too: Tauri hands every menu's events to every listener.
                    "check-updates" => check_now.notify_one(),
                    id if id.starts_with("connect:") => {
                        let Some(tool) = setup::Tool::from_id(&id["connect:".len()..]) else { return };
                        let (app, items) = (app.clone(), menu_items.clone());
                        std::thread::spawn(move || {
                            let (title, body) = match setup::connect(tool) {
                                Ok(m) => (format!("{} connected", tool.name()), m),
                                Err(m) => (format!("Couldn't connect {}", tool.name()), m),
                            };
                            let _ = app.notification().builder().title(title).body(body).show();
                            refresh_connect_menu(&items);
                        });
                    }
                    "browser" => {
                        let _ = app.opener().open_url(office_url(), None::<&str>);
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        open_office(tray.app_handle());
                    }
                })
                .build(app)?;

            let handle = app.handle().clone();
            let notified = Mutex::new(HashMap::new());
            let on_change: server::OnChange = Box::new(move |store, event| {
                if event["type"] == "SetupChanged" {
                    let items = connect_items.clone();
                    std::thread::spawn(move || refresh_connect_menu(&items));
                    return;
                }
                update_tray(&handle, &status, store);
                maybe_notify(&handle, &notified, event);
            });
            tauri::async_runtime::spawn(server::run(port(), on_change));
            open_office(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while starting Agent Office")
        .run(|_app, event| {
            // Keep running in the menu bar when the last window closes; only Quit exits.
            if let RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}
