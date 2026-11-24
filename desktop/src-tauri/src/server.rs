// The office server built into the app: receives hook events, serves the 3D office, streams live state,
// and answers permission requests you allow or deny from the office.
// Same endpoints as bridge/server.js, so phones and VR headsets can connect to it too.
use crate::adapters;
use crate::auth::{self, Credentials};
use crate::changes;
use crate::discover;
use crate::focus;
use crate::music;
use crate::ollama;
use crate::packs;
use crate::setup;
use crate::store::{self, Origin, Store};
use axum::{
    body::Bytes,
    extract::{ws::{Message, WebSocket, WebSocketUpgrade}, Path, Query, Request, State},
    http::{header, HeaderMap, HeaderValue, StatusCode, Uri},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use rust_embed::RustEmbed;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{broadcast, oneshot};

#[derive(RustEmbed)]
#[folder = "../../web/"]
struct Web;

static THREE_JS: &[u8] = include_bytes!("../../../node_modules/three/build/three.min.js");
static GLTF_LOADER: &[u8] = include_bytes!("../../../node_modules/three/examples/js/loaders/GLTFLoader.js");
static SKELETON_UTILS: &[u8] = include_bytes!("../../../node_modules/three/examples/js/utils/SkeletonUtils.js");

/// How often to look for chats in the agents' logs (see discover.rs).
const LOG_SCAN: Duration = Duration::from_secs(10);

/// How long a watched office holds a permission request before Claude Code shows its own dialog.
const APPROVAL_HOLD: Duration = Duration::from_secs(45);

/// The largest message an office page may send over its WebSocket.
const MAX_WS_MESSAGE: usize = 64 * 1024;

/// Called after every accepted event, with the store still locked, so the app can update its tray and notify.
pub type OnChange = Box<dyn Fn(&Store, &Value) + Send + Sync>;

struct Pending {
    approval: Value,
    tx: oneshot::Sender<&'static str>,
}

struct Shared {
    store: Mutex<Store>,
    tx: broadcast::Sender<String>,
    on_change: OnChange,
    pending: Mutex<HashMap<String, Pending>>,
    /// Office pages currently on screen; permission requests are only held while this is above zero.
    watchers: AtomicUsize,
    seq: AtomicU64,
    /// The page's and the hooks' keys (auth.rs): only office pages read state or answer for you; hooks only report.
    creds: Credentials,
    port: u16,
    /// Host names besides localhost and IP addresses that may address this office (AGENT_OFFICE_ALLOWED_HOSTS).
    extra_hosts: Vec<String>,
    /// What the rooftop DJ plays: your Spotify or Apple Music song, or null.
    music: Mutex<Value>,
    /// Office pages that turned on "Play my music"; Spotify and Music are only asked while this is above zero.
    music_listeners: AtomicUsize,
    /// Kinds of hooks refused for a missing or wrong key ({agent, reason, count, at}), so the office can say they
    /// need updating instead of silently showing no sessions.
    outdated: Mutex<Vec<Value>>,
}
type AppState = Arc<Shared>;

fn broadcast(st: &Shared, msg: Value) {
    let _ = st.tx.send(msg.to_string());
}

pub fn router(port: u16, creds: Credentials, on_change: OnChange) -> Router {
    let (tx, _) = broadcast::channel(256);
    let state = Arc::new(Shared {
        store: Mutex::new(Store::default()),
        tx,
        on_change,
        pending: Mutex::new(HashMap::new()),
        watchers: AtomicUsize::new(0),
        seq: AtomicU64::new(0),
        creds,
        port,
        extra_hosts: std::env::var("AGENT_OFFICE_ALLOWED_HOSTS").unwrap_or_default().split(',').map(|h| h.trim().to_ascii_lowercase()).filter(|h| !h.is_empty()).collect(),
        music: Mutex::new(Value::Null),
        music_listeners: AtomicUsize::new(0),
        outdated: Mutex::new(Vec::new()),
    });
    {
        // Chats that were already running when the office opened move in before the first page loads.
        let mut store = state.store.lock().unwrap();
        for f in discover::scan_home(store::now_ms()) {
            let (id, subs) = (f.id.clone(), f.subs.clone());
            if let Some(e) = store.adopt(f) { (state.on_change)(&store, &e); }
            store.adopt_subs(&id, &subs);
        }
    }
    tokio::spawn(watch_music(state.clone()));
    tokio::spawn(watch_logs(state.clone()));
    Router::new()
        .route("/hook", post(hook))
        .route("/permission", post(permission))
        .route("/api/state", get(state_json))
        .route("/api/auth", get(|| async { StatusCode::NO_CONTENT }))
        .route("/api/login", post(login))
        .route("/api/changes", get(changes_json))
        .route("/api/changes/diff", get(changes_diff))
        .route("/api/log", post(client_log))
        .route("/api/app-icon/{file}", get(app_icon))
        .route("/api/setup", get(setup_status))
        .route("/api/setup/{tool}", post(setup_connect))
        .route("/api/face/{session}/{mood}", post(save_face))
        .route("/api/update", get(update_status).post(update_install))
        .route("/ws", get(ws))
        .route("/vendor/three.min.js", get(three))
        .route("/vendor/GLTFLoader.js", get(|| async { ([(header::CONTENT_TYPE, "text/javascript")], GLTF_LOADER) }))
        .route("/vendor/SkeletonUtils.js", get(|| async { ([(header::CONTENT_TYPE, "text/javascript")], SKELETON_UTILS) }))
        .route("/api/packs", get(|| async { Json(Value::Array(packs::list(&packs::dir()))) }))
        .route("/packs/{*file}", get(pack_file))
        .fallback(get(asset))
        .layer(middleware::from_fn_with_state(state.clone(), guard))
        .with_state(state)
}

/// Where the office's picture of an agent's face is kept, for the "done" and "needs you" banners.
pub fn face_path(session: &str, mood: &str) -> Option<PathBuf> {
    let safe = !session.is_empty() && session.len() <= 128 && session.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    (safe && matches!(mood, "done" | "waiting")).then(|| std::env::temp_dir().join("agent-office-faces").join(format!("{session}-{mood}.png")))
}

async fn save_face(Path((session, mood)): Path<(String, String)>, body: Bytes) -> StatusCode {
    let Some(path) = face_path(&session, &mood) else { return StatusCode::BAD_REQUEST };
    if body.len() > 512 * 1024 || !body.starts_with(b"\x89PNG") {
        return StatusCode::BAD_REQUEST;
    }
    let saved = path.parent().is_some_and(|dir| std::fs::create_dir_all(dir).is_ok()) && std::fs::write(&path, &body).is_ok();
    if saved { StatusCode::NO_CONTENT } else { StatusCode::INTERNAL_SERVER_ERROR }
}

/// Serve on 127.0.0.1 (and ::1, so http://localhost works everywhere). If the port is taken by another
/// office (say `npm start`), the window uses that one meanwhile and this server takes over once it stops.
pub async fn run(port: u16, creds: Credentials, on_change: OnChange) {
    let app = router(port, creds, on_change);
    let mut waiting = false;
    let listener = loop {
        match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
            Ok(listener) => break listener,
            Err(err) => {
                if !waiting {
                    eprintln!("Port {port} is busy ({err}); using the office already running there and taking over when it stops.");
                    waiting = true;
                }
                tokio::time::sleep(Duration::from_secs(3)).await;
            }
        }
    };
    if let Ok(v6) = tokio::net::TcpListener::bind(("::1", port)).await {
        let app6 = app.clone();
        tokio::spawn(async move {
            let _ = axum::serve(v6, app6).await;
        });
    }
    println!("Agent Office is running at http://localhost:{port}{}", if waiting { " (took over the port)" } else { "" });
    if let Err(err) = axum::serve(listener, app).await {
        eprintln!("Agent Office server stopped: {err}");
    }
}

/// Every few seconds while an office page wants your music, check what's playing and tell the pages when the song changes.
async fn watch_music(st: AppState) {
    let mut tick = tokio::time::interval(Duration::from_secs(5));
    loop {
        tick.tick().await;
        let now = if st.music_listeners.load(Ordering::SeqCst) == 0 {
            Value::Null
        } else {
            tokio::task::spawn_blocking(music::now_playing).await.unwrap_or(Value::Null)
        };
        let changed = {
            let mut music = st.music.lock().unwrap();
            let changed = *music != now;
            *music = now.clone();
            changed
        };
        if changed {
            broadcast(&st, json!({ "type": "music", "music": now }));
        }
    }
}

fn ollama_models() -> Vec<discover::Found> {
    match std::env::var("HOME") {
        Ok(h) if !h.is_empty() => ollama::poll(std::path::Path::new(&h), store::now_ms()),
        _ => vec![],
    }
}

/// Keeps chats known only from their logs up to date, adds new ones, and walks out the ones whose log went quiet.
async fn watch_logs(st: AppState) {
    let mut tick = tokio::time::interval(LOG_SCAN);
    tick.tick().await; // the first scan already ran in router()
    loop {
        tick.tick().await;
        let (found, models, archived) = tokio::task::spawn_blocking(|| (discover::scan_home(store::now_ms()), ollama_models(), discover::archived_home())).await.unwrap_or_default();
        let mut store = st.store.lock().unwrap();
        let keep: Vec<String> = models.iter().map(|f| f.id.clone()).collect();
        for f in found.into_iter().chain(models) {
            let (id, subs) = (f.id.clone(), f.subs.clone());
            let found = store.adopt(f);
            for e in found.into_iter().chain(store.adopt_subs(&id, &subs)) {
                (st.on_change)(&store, &e);
                broadcast(&st, json!({ "type": "event", "event": e }));
            }
        }
        for id in store.drop_archived(&archived) {
            broadcast(&st, json!({ "type": "event", "event": { "type": "SessionEnd", "sessionId": id, "at": store::now_ms(), "reason": "Archived in the Claude app" } }));
        }
        // Models Ollama has loaded are agents too (ollama.rs); one walks out as soon as Ollama unloads it.
        for id in store.retire("ollama", &keep) {
            broadcast(&st, json!({ "type": "event", "event": { "type": "SessionEnd", "sessionId": id, "at": store::now_ms(), "reason": "Ollama unloaded the model" } }));
        }
        let before: Vec<String> = store.sessions.iter().map(|s| s.id.clone()).collect();
        store.prune();
        for id in before.iter().filter(|id| !store.sessions.iter().any(|s| &s.id == *id)) {
            broadcast(&st, json!({ "type": "event", "event": { "type": "SessionEnd", "sessionId": id, "at": store::now_ms(), "reason": "No news for a while" } }));
        }
    }
}

enum Key { None, Page, Hook }

/// Which key a path needs. Everything under /api/ but app icons (plain <img> tags, nothing private) and the
/// one-time-code login needs the page's; the page itself, its scripts and pack models are public.
fn key_for(path: &str) -> Key {
    match path {
        "/hook" | "/permission" => Key::Hook,
        "/ws" => Key::Page,
        "/api/login" => Key::None,
        p if p.starts_with("/api/") && !p.starts_with("/api/app-icon/") => Key::Page,
        _ => Key::None,
    }
}

/// Every request must name this office in Host (a rebound web domain can't), come from this office if a browser
/// sent it (Origin), and carry the key its path needs. Responses are never sniffed into another type.
async fn guard(State(st): State<AppState>, req: Request, next: Next) -> Response {
    let h = req.headers();
    let get = |name: header::HeaderName| h.get(name).and_then(|v| v.to_str().ok());
    let host = get(header::HOST);
    // An Origin that isn't text counts as foreign, not as missing.
    let origin = h.get(header::ORIGIN).map(|v| v.to_str().unwrap_or("\0"));
    if !auth::host_ok(host, st.port, &st.extra_hosts) || !auth::origin_ok(origin, host) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let allowed = match key_for(req.uri().path()) {
        Key::None => true,
        Key::Hook => auth::same(h.get(auth::HOOK_HEADER).and_then(|v| v.to_str().ok()), &st.creds.hook),
        Key::Page if req.uri().path() == "/ws" => auth::same(auth::ws_token(get(header::SEC_WEBSOCKET_PROTOCOL)), &st.creds.ui),
        Key::Page => auth::same(auth::bearer(get(header::AUTHORIZATION)), &st.creds.ui),
    };
    if !allowed {
        if matches!(key_for(req.uri().path()), Key::Hook) {
            refused_hook(&st, h, req.uri().query());
        }
        // No body: an old permission hook prints whatever comes back, and nothing means Claude Code asks as usual.
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let mut res = next.run(req).await;
    res.headers_mut().entry(header::X_CONTENT_TYPE_OPTIONS).or_insert(HeaderValue::from_static("nosniff"));
    res
}

/// Hooks installed before the office had keys send none, so their events are refused. Say so once per kind of hook,
/// to the pages and the app (a notification), so updating doesn't silently empty the office. Nothing the request
/// carried is kept but which agent it named. bridge/server.js does the same.
fn refused_hook(st: &Shared, h: &HeaderMap, query: Option<&str>) {
    let from_query = query.and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("agent=")));
    let named = h.get("x-agent-office-agent").and_then(|v| v.to_str().ok()).or(from_query).unwrap_or("claude-code").to_ascii_lowercase();
    let agent = if !named.is_empty() && named.len() <= 32 && named.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') { named } else { "unknown".into() };
    let reason = if h.contains_key(auth::HOOK_HEADER) { "wrong-key" } else { "no-key" };
    let notice = {
        let mut seen = st.outdated.lock().unwrap();
        if let Some(n) = seen.iter_mut().find(|n| n["agent"] == agent.as_str() && n["reason"] == reason) {
            n["count"] = json!(n["count"].as_u64().unwrap_or(0) + 1);
            n["at"] = json!(store::now_ms());
            return;
        }
        if seen.len() >= 16 { return; }
        seen.push(json!({ "agent": agent, "reason": reason, "count": 1, "at": store::now_ms() }));
        json!({ "type": "hooks-outdated", "hooks": *seen })
    };
    eprintln!("Refused {agent} events sent {}.", if reason == "no-key" { "without the office's key: those hooks predate it" } else { "with a key this office doesn't know" });
    broadcast(st, notice);
    let store = st.store.lock().unwrap();
    (st.on_change)(&store, &json!({ "type": "HooksOutdated", "agent": agent, "reason": reason }));
}

/// The app's "Open in browser" link carries a one-time code (auth::launch_code); the page trades it for its key.
async fn login(State(st): State<AppState>, body: Bytes) -> Response {
    let code = serde_json::from_slice::<Value>(&body).ok().and_then(|v| v["code"].as_str().map(String::from));
    match code {
        Some(code) if auth::redeem(&st.creds.dir, &code) => Json(json!({ "token": st.creds.ui })).into_response(),
        _ => StatusCode::UNAUTHORIZED.into_response(),
    }
}

/// Other agents (Codex, Cursor, Gemini CLI…) send their own payloads through adapters/hook.sh with the tool's
/// name in X-Agent-Office-Agent (or ?agent=); translate them to the Claude shape first.
fn ingest(st: &Shared, headers: &HeaderMap, query: &HashMap<String, String>, body: &Bytes) -> Result<Option<Value>, StatusCode> {
    let raw = serde_json::from_slice::<Value>(body).ok().filter(Value::is_object).ok_or(StatusCode::BAD_REQUEST)?;
    let header = |name: &str| headers.get(name).and_then(|v| v.to_str().ok()).filter(|v| !v.is_empty());
    let agent = header("x-agent-office-agent").or(query.get("agent").map(String::as_str)).unwrap_or("claude-code").to_lowercase();
    let Some(payload) = adapters::normalize(&agent, &raw, header("x-agent-office-event")) else { return Ok(None) };
    let mut store = st.store.lock().unwrap();
    let origin = Origin { app: header("x-agent-office-app"), term: header("x-agent-office-term"), tty: header("x-agent-office-tty"), chat: header("x-agent-office-chat"), t3_thread: header("x-agent-office-t3-thread") };
    let event = store.ingest_from(&payload, header("x-agent-office-entrypoint"), header("x-agent-office-project"), &agent, origin);
    if let Some(e) = &event {
        (st.on_change)(&store, e);
        broadcast(st, json!({ "type": "event", "event": e }));
    }
    Ok(event)
}

async fn hook(State(st): State<AppState>, Query(query): Query<HashMap<String, String>>, headers: HeaderMap, body: Bytes) -> StatusCode {
    match ingest(&st, &headers, &query, &body) {
        Ok(_) => StatusCode::NO_CONTENT,
        Err(code) => code,
    }
}

/// Removes a held request when the handler finishes, including when the hook gives up and disconnects.
struct PendingGuard {
    st: AppState,
    id: String,
    decision: &'static str,
}
impl Drop for PendingGuard {
    fn drop(&mut self) {
        self.st.pending.lock().unwrap().remove(&self.id);
        broadcast(&self.st, json!({ "type": "approval-resolved", "id": self.id, "decision": self.decision }));
    }
}

/// PermissionRequest hook: hold the request while someone is watching the office, so they can allow or deny it there.
/// Returning no content means "no decision": Claude Code then shows its normal permission dialog.
async fn permission(State(st): State<AppState>, Query(query): Query<HashMap<String, String>>, headers: HeaderMap, body: Bytes) -> Response {
    let event = match ingest(&st, &headers, &query, &body) {
        Ok(Some(e)) => e,
        Ok(None) => return StatusCode::NO_CONTENT.into_response(),
        Err(code) => return code.into_response(),
    };
    if st.watchers.load(Ordering::SeqCst) == 0 {
        return StatusCode::NO_CONTENT.into_response();
    }
    let id = format!("a{}{}", store::now_ms(), st.seq.fetch_add(1, Ordering::SeqCst));
    let approval = json!({
        "id": id, "sessionId": event["sessionId"], "agentId": event["agentId"], "tool": event["tool"],
        "summary": event["summary"], "expiresAt": store::now_ms() + APPROVAL_HOLD.as_millis() as u64,
    });
    let (tx, rx) = oneshot::channel();
    st.pending.lock().unwrap().insert(id.clone(), Pending { approval: approval.clone(), tx });
    let mut guard = PendingGuard { st: st.clone(), id, decision: "defer" };
    broadcast(&st, json!({ "type": "approval", "approval": approval }));

    let decision = match tokio::time::timeout(APPROVAL_HOLD, rx).await {
        Ok(Ok(d)) => d,
        _ => "defer",
    };
    guard.decision = decision;
    if decision == "defer" {
        return StatusCode::NO_CONTENT.into_response();
    }
    {
        let text = if decision == "allow" { "Allowed from the office" } else { "Denied from the office" };
        let mut store = st.store.lock().unwrap();
        if let Some(e) = store.resolve_waiting(event["sessionId"].as_str().unwrap_or(""), event["agentId"].as_str(), text) {
            (st.on_change)(&store, &e);
            broadcast(&st, json!({ "type": "event", "event": e }));
        }
    }
    let decision_json = if decision == "allow" {
        json!({ "behavior": "allow" })
    } else {
        json!({ "behavior": "deny", "message": "Denied from Agent Office" })
    };
    Json(json!({ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": decision_json } })).into_response()
}

/// Real app icons for the office (floor signs, lift, agent list): /api/app-icon/com.openai.codex.png
async fn app_icon(Path(file): Path<String>) -> Response {
    let bundle = file.trim_end_matches(".png").to_string();
    match tokio::task::spawn_blocking(move || focus::app_icon(&bundle)).await.ok().flatten() {
        Some(png) => ([(header::CONTENT_TYPE, "image/png"), (header::CACHE_CONTROL, "max-age=86400")], png).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

/// Which coding tools report to the office, for the office's "Connect agents" buttons.
/// A downloaded app update, so the office can offer it until you close the offer or restart.
async fn update_status() -> Json<Value> {
    Json(json!({ "version": crate::update::waiting(), "current": env!("CARGO_PKG_VERSION") }))
}

/// "Restart to update" on the office page: the same install as the menu-bar menu's.
async fn update_install() -> StatusCode {
    if tokio::task::spawn_blocking(crate::update::install_waiting).await.unwrap_or(false) { StatusCode::ACCEPTED } else { StatusCode::CONFLICT }
}

async fn setup_status() -> Json<Value> {
    Json(tokio::task::spawn_blocking(setup::status_json).await.unwrap_or_else(|_| json!({ "tools": [] })))
}

/// One click from the office: install the Claude Code plugin, or add hooks to Codex or Cursor.
/// Only office pages can call this (guard), and it only ever runs the fixed setup for a known tool.
async fn setup_connect(State(st): State<AppState>, Path(tool): Path<String>) -> Response {
    let Some(tool) = setup::Tool::from_id(&tool) else { return StatusCode::NOT_FOUND.into_response() };
    let result = tokio::task::spawn_blocking(move || setup::connect(tool)).await.unwrap_or_else(|_| Err("Setup stopped unexpectedly".into()));
    {
        let store = st.store.lock().unwrap();
        (st.on_change)(&store, &json!({ "type": "SetupChanged" }));
    }
    broadcast(&st, json!({ "type": "setup" }));
    match result {
        Ok(message) => Json(json!({ "ok": true, "message": message })).into_response(),
        Err(message) => (StatusCode::UNPROCESSABLE_ENTITY, Json(json!({ "ok": false, "message": message }))).into_response(),
    }
}

/// The page reports its errors and frame rate here so they show up in the app log.
async fn client_log(body: Bytes) -> StatusCode {
    eprintln!("[office page] {}", String::from_utf8_lossy(&body[..body.len().min(2000)]));
    StatusCode::NO_CONTENT
}

/// What a session's checkout holds, for its card. Git runs off the runtime and never under the store's lock.
async fn changes_json(State(st): State<AppState>, Query(query): Query<HashMap<String, String>>) -> Json<Value> {
    let found = {
        let store = st.store.lock().unwrap();
        store.sessions.iter().find(|s| Some(&s.id) == query.get("session"))
            .map(|s| (s.cwd.clone(), store.sessions.iter().filter(|o| o.id != s.id).map(|o| (o.id.clone(), o.cwd.clone())).collect::<Vec<_>>()))
    };
    let Some((cwd, others)) = found else { return Json(json!({ "ok": false, "error": "That session has ended" })) };
    let read = tokio::task::spawn_blocking(move || {
        let mut c = changes::changes(&cwd);
        if c["ok"] == true {
            let root = c["root"].as_str().unwrap_or("").to_string();
            c["shared"] = others.iter().filter(|(_, cwd)| changes::root_of(cwd).as_deref() == Some(root.as_str())).map(|(id, _)| id.clone()).collect::<Vec<_>>().into();
        }
        c
    });
    Json(read.await.unwrap_or_else(|_| json!({ "ok": false, "error": "Git could not read this checkout" })))
}

async fn changes_diff(State(st): State<AppState>, Query(query): Query<HashMap<String, String>>) -> Json<Value> {
    let (cwd, show) = {
        let store = st.store.lock().unwrap();
        (store.sessions.iter().find(|s| Some(&s.id) == query.get("session")).map(|s| s.cwd.clone()), store.show_code())
    };
    let Some(cwd) = cwd else { return Json(json!({ "ok": false, "error": "That session has ended" })) };
    if !show { return Json(json!({ "ok": false, "error": "Code is hidden in Customize" })); }
    let path = query.get("path").cloned().unwrap_or_default();
    Json(tokio::task::spawn_blocking(move || changes::file_diff(&cwd, &path)).await.unwrap_or_else(|_| json!({ "ok": false, "error": "Git could not read this checkout" })))
}

fn snapshot(st: &Shared) -> Value {
    let (mut v, show_code) = { let mut store = st.store.lock().unwrap(); (store.snapshot(), store.show_code()) };
    v["showCode"] = show_code.into();
    v["approvals"] = st.pending.lock().unwrap().values().map(|p| p.approval.clone()).collect::<Vec<_>>().into();
    v["music"] = st.music.lock().unwrap().clone();
    v["musicSupported"] = cfg!(target_os = "macos").into();
    v["outdatedHooks"] = Value::Array(st.outdated.lock().unwrap().clone());
    v
}

async fn state_json(State(st): State<AppState>) -> Json<Value> {
    Json(snapshot(&st))
}

/// The page offered its key as a subprotocol (checked in guard); it gets "agent-office" back, as browsers require.
async fn ws(State(st): State<AppState>, upgrade: WebSocketUpgrade) -> Response {
    upgrade.protocols([auth::WS_PROTOCOL]).max_message_size(MAX_WS_MESSAGE).max_frame_size(MAX_WS_MESSAGE).on_upgrade(move |socket| client(socket, st))
}

async fn client(mut socket: WebSocket, st: AppState) {
    let mut rx = st.tx.subscribe();
    let mut first = snapshot(&st);
    first["type"] = "snapshot".into();
    if socket.send(Message::Text(first.to_string().into())).await.is_err() {
        return;
    }
    let mut visible = false;
    let mut wants_music = false;
    loop {
        tokio::select! {
            msg = rx.recv() => match msg {
                Ok(text) => if socket.send(Message::Text(text.into())).await.is_err() { break },
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => break,
            },
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Text(text))) => {
                    let Ok(msg) = serde_json::from_str::<Value>(&text) else { continue };
                    match msg["type"].as_str() {
                        Some("presence") => {
                            let now_visible = msg["visible"].as_bool().unwrap_or(false);
                            if now_visible != visible {
                                if now_visible { st.watchers.fetch_add(1, Ordering::SeqCst); } else { st.watchers.fetch_sub(1, Ordering::SeqCst); }
                                visible = now_visible;
                            }
                        }
                        Some("music") => {
                            // "Play my music" at the rooftop, turned on or off
                            let on = msg["on"].as_bool().unwrap_or(false);
                            if on != wants_music {
                                if on { st.music_listeners.fetch_add(1, Ordering::SeqCst); } else { st.music_listeners.fetch_sub(1, Ordering::SeqCst); }
                                wants_music = on;
                            }
                        }
                        Some("focus") => {
                            // "Open in …" / "Open chat": bring that session's chat, window or terminal tab forward.
                            let target = msg["sessionId"].as_str().and_then(|sid| {
                                let store = st.store.lock().unwrap();
                                store.sessions.iter().find(|s| s.id == sid).cloned()
                            });
                            let result = match target {
                                Some(s) => tokio::task::spawn_blocking(move || focus::focus(&s.agent, &s.id, s.chat.as_deref(), s.app.as_deref(), s.term.as_deref(), s.tty.as_deref(), &s.cwd, &s.entrypoint, s.t3_thread.as_deref()))
                                    .await.unwrap_or_else(|_| Err("Couldn't open the app".into())),
                                None => Err("That session has ended".into()),
                            };
                            let reply = match result { Ok(m) => json!({ "type": "focus-result", "ok": true, "message": m }), Err(m) => json!({ "type": "focus-result", "ok": false, "message": m }) };
                            if socket.send(Message::Text(reply.to_string().into())).await.is_err() { break; }
                        }
                        Some("code") => {
                            // "Show code" in Customize
                            let show = msg["show"].as_bool().unwrap_or(true);
                            st.store.lock().unwrap().set_show_code(show);
                            broadcast(&st, json!({ "type": "code", "show": show }));
                        }
                        Some("decide") => {
                            let decision = match msg["decision"].as_str() { Some("allow") => "allow", Some("deny") => "deny", _ => "defer" };
                            let entry = msg["id"].as_str().and_then(|id| st.pending.lock().unwrap().remove(id));
                            if let Some(p) = entry { let _ = p.tx.send(decision); }
                        }
                        _ => {}
                    }
                }
                None | Some(Err(_)) | Some(Ok(Message::Close(_))) => break,
                _ => {}
            },
        }
    }
    if visible {
        st.watchers.fetch_sub(1, Ordering::SeqCst);
    }
    if wants_music {
        st.music_listeners.fetch_sub(1, Ordering::SeqCst);
    }
}

async fn three() -> impl IntoResponse {
    ([(header::CONTENT_TYPE, "text/javascript")], THREE_JS)
}

/// A model or texture from a pack, typed by its extension and inert even if someone opens its URL as a page.
async fn pack_file(Path(rel): Path<String>) -> Response {
    let Some((path, mime)) = packs::file(&packs::dir(), &rel) else { return StatusCode::FORBIDDEN.into_response() };
    match tokio::fs::read(&path).await {
        Ok(data) => ([(header::CONTENT_TYPE, mime), (header::CACHE_CONTROL, "no-cache"), (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (header::CONTENT_SECURITY_POLICY, "default-src 'none'; sandbox"), (header::HeaderName::from_static("cross-origin-resource-policy"), "same-origin")], data).into_response(),
        Err(_) => (StatusCode::NOT_FOUND, "Not found").into_response(),
    }
}

/// The page's policy: it runs only its own scripts, the inline ones it shipped with (by hash) and files from this
/// office, so markup that slips into the page can't run code or read its key. bridge/server.js sends the same one.
fn page_policy(html: &[u8], host: &str) -> String {
    use base64::Engine;
    use sha2::Digest;
    let text = String::from_utf8_lossy(html);
    let mut hashes = String::new();
    let mut rest = text.as_ref();
    while let Some(start) = rest.find("<script>") {
        rest = &rest[start + 8..];
        let Some(end) = rest.find("</script>") else { break };
        let digest = sha2::Sha256::digest(&rest.as_bytes()[..end]);
        hashes += &format!(" 'sha256-{}'", base64::engine::general_purpose::STANDARD.encode(digest));
        rest = &rest[end..];
    }
    [
        "default-src 'self'".to_string(), format!("script-src 'self'{hashes}"),
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com".into(), "font-src 'self' https://fonts.gstatic.com".into(),
        "img-src 'self' data: blob:".into(), format!("connect-src 'self' ws://{host} data: blob:"), "media-src 'self' data: blob:".into(),
        "worker-src 'self' blob:".into(), "object-src 'none'".into(), "base-uri 'none'".into(), "form-action 'none'".into(), "frame-ancestors 'none'".into(),
    ].join("; ")
}

async fn asset(uri: Uri, headers: HeaderMap) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    match Web::get(path) {
        Some(file) => {
            let mime = mime_guess::from_path(path).first_or_octet_stream();
            // say it's UTF-8, or characters like "·" and "…" show up garbled
            let content_type = if mime.type_() == "text" { format!("{mime}; charset=utf-8") } else { mime.to_string() };
            let policy = (mime.subtype() == "html").then(|| {
                // guard() already checked Host names this office, so it is safe to name in the policy.
                page_policy(&file.data, headers.get(header::HOST).and_then(|v| v.to_str().ok()).unwrap_or("localhost"))
            });
            let mut res = ([(header::CONTENT_TYPE, content_type), (header::CACHE_CONTROL, "no-cache".to_string())], file.data.into_owned()).into_response();
            if let Some(policy) = policy.and_then(|p| HeaderValue::from_str(&p).ok()) {
                // The office page may not be framed by other sites (its buttons approve commands).
                let h = res.headers_mut();
                h.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
                h.insert(header::CONTENT_SECURITY_POLICY, policy);
                h.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
            }
            res
        }
        None => (StatusCode::NOT_FOUND, "Not found").into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    const UI: &str = "1111111111111111111111111111111111111111111111111111111111111111";
    const HOOK: &str = "2222222222222222222222222222222222222222222222222222222222222222";

    /// A server on a free port with fixed test keys; never the running office.
    async fn serve() -> u16 {
        serve_with(std::env::temp_dir().join(format!("office-server-data-{}-{}", std::process::id(), auth::random_hex())), Box::new(|_, _| {})).await
    }
    async fn serve_with(dir: PathBuf, on_change: OnChange) -> u16 {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let creds = Credentials { ui: UI.into(), hook: HOOK.into(), dir };
        tokio::spawn(async move { axum::serve(listener, router(port, creds, on_change)).await.unwrap() });
        port
    }

    /// (status, head, body) of one request. Host defaults to this office; `headers` may replace it.
    fn request(port: u16, method: &str, path: &str, headers: &[(&str, &str)], body: &[u8]) -> (u16, String, String) {
        let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        let mut head = format!("{method} {path} HTTP/1.1\r\nConnection: close\r\nContent-Length: {}\r\n", body.len());
        if !headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("host")) { head += &format!("Host: 127.0.0.1:{port}\r\n"); }
        for (k, v) in headers { head += &format!("{k}: {v}\r\n"); }
        s.write_all(head.as_bytes()).unwrap();
        s.write_all(b"\r\n").unwrap();
        s.write_all(body).unwrap();
        let mut out = Vec::new();
        s.read_to_end(&mut out).unwrap();
        let out = String::from_utf8_lossy(&out).into_owned();
        let status = out.split(' ').nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
        let (head, body) = out.split_once("\r\n\r\n").map(|(h, b)| (h.to_string(), b.to_string())).unwrap_or_default();
        (status, head, body)
    }
    fn page(port: u16, method: &str, path: &str, body: &str) -> (u16, String) {
        let (code, _, b) = request(port, method, path, &[("Authorization", &format!("Bearer {UI}")), ("Content-Type", "application/json")], body.as_bytes());
        (code, b)
    }
    fn hook(port: u16, path: &str, body: &str) -> (u16, String) {
        let (code, _, b) = request(port, "POST", path, &[("X-Agent-Office-Token", HOOK), ("Content-Type", "application/json")], body.as_bytes());
        (code, b)
    }

    /// A bare-bones WebSocket client: enough to open, send text and read the server's text frames.
    struct Ws(std::net::TcpStream);
    impl Ws {
        fn open(port: u16, protocols: &str, extra: &[(&str, &str)]) -> Result<Ws, u16> {
            let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
            let mut head = format!("GET /ws HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Protocol: {protocols}\r\n");
            if !extra.iter().any(|(k, _)| k.eq_ignore_ascii_case("host")) { head += &format!("Host: 127.0.0.1:{port}\r\n"); }
            for (k, v) in extra { head += &format!("{k}: {v}\r\n"); }
            s.write_all(format!("{head}\r\n").as_bytes()).unwrap();
            let mut resp = Vec::new();
            let mut byte = [0u8; 1];
            while !resp.ends_with(b"\r\n\r\n") { if s.read(&mut byte).unwrap() == 0 { break; } resp.push(byte[0]); }
            let resp = String::from_utf8_lossy(&resp).to_lowercase();
            let status: u16 = resp.split(' ').nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
            if status != 101 { return Err(status); }
            assert!(resp.contains("sec-websocket-protocol: agent-office\r\n"), "{resp}");
            s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            Ok(Ws(s))
        }
        fn send(&mut self, opcode: u8, payload: &[u8]) {
            let mut f = vec![0x80 | opcode];
            match payload.len() { n if n < 126 => f.push(0x80 | n as u8), n if n < 65536 => { f.push(0x80 | 126); f.extend((n as u16).to_be_bytes()); } n => { f.push(0x80 | 127); f.extend((n as u64).to_be_bytes()); } }
            f.extend([0, 0, 0, 0]); // a zero mask leaves the payload as it is
            f.extend(payload);
            let _ = self.0.write_all(&f);
        }
        fn text(&mut self, t: &str) { self.send(1, t.as_bytes()); }
        /// The next text message of this type, skipping others; None when the server closed the socket.
        fn next(&mut self, kind: &str) -> Option<Value> {
            loop {
                let mut h = [0u8; 2];
                self.0.read_exact(&mut h).ok()?;
                let mut len = (h[1] & 0x7f) as usize;
                if len == 126 { let mut b = [0u8; 2]; self.0.read_exact(&mut b).ok()?; len = u16::from_be_bytes(b) as usize; }
                if len == 127 { let mut b = [0u8; 8]; self.0.read_exact(&mut b).ok()?; len = u64::from_be_bytes(b) as usize; }
                let mut body = vec![0u8; len];
                self.0.read_exact(&mut body).ok()?;
                if h[0] & 0x0f == 8 { return None; }
                if let Ok(v) = serde_json::from_slice::<Value>(&body) { if v["type"] == kind { return Some(v); } }
            }
        }
    }
    fn page_ws(port: u16) -> Ws { Ws::open(port, &format!("agent-office, agent-office.token.{UI}"), &[]).unwrap() }

    fn checkout() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("office-server-{}-{}-{}", std::process::id(), store::now_ms(), auth::random_hex()));
        std::fs::create_dir_all(&dir).unwrap();
        let dir = std::fs::canonicalize(&dir).unwrap();
        let git = |args: &[&str]| assert!(std::process::Command::new("git").args(args).current_dir(&dir)
            .envs([("GIT_AUTHOR_NAME", "t"), ("GIT_AUTHOR_EMAIL", "t@t"), ("GIT_COMMITTER_NAME", "t"), ("GIT_COMMITTER_EMAIL", "t@t")]).output().unwrap().status.success());
        git(&["init", "-q", "-b", "main"]);
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        std::fs::write(dir.join("same.txt"), "AUDIT_FIXTURE_ONLY unchanged\n").unwrap();
        std::fs::write(dir.join(".gitignore"), "secret.env\n").unwrap();
        git(&["add", "."]); git(&["commit", "-q", "-m", "base"]);
        std::fs::write(dir.join("a.txt"), "one\ntwo\n").unwrap();
        std::fs::write(dir.join("secret.env"), "AUDIT_FIXTURE_ONLY ignored\n").unwrap();
        std::fs::write(dir.with_extension("outside"), "AUDIT_FIXTURE_ONLY outside\n").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(dir.with_extension("outside"), dir.join("escape.txt")).unwrap();
        dir
    }
    fn remove(dir: &std::path::Path) {
        let _ = std::fs::remove_file(dir.with_extension("outside"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_sessions_card_can_read_its_checkout_and_only_its_changed_files() {
        let dir = checkout();
        let port = serve().await;
        let cwd = dir.to_string_lossy().into_owned();
        let read = tokio::task::spawn_blocking(move || {
            let ev = json!({ "hook_event_name": "PostToolUse", "session_id": "card-test", "cwd": cwd, "tool_name": "Edit",
                "tool_input": { "file_path": format!("{cwd}/a.txt"), "old_string": "one\n", "new_string": "one\ntwo\n" } });
            assert_eq!(hook(port, "/hook", &ev.to_string()).0, 204);
            let get = |p: &str| serde_json::from_str::<Value>(&page(port, "GET", p, "").1).unwrap();
            let diffs: Vec<Value> = ["same.txt", "secret.env", "escape.txt", "../x", ".git/config", ""].iter()
                .map(|p| get(&format!("/api/changes/diff?session=card-test&path={}", p.replace('/', "%2F")))).collect();
            (get("/api/state"), get("/api/changes?session=card-test"), get("/api/changes/diff?session=card-test&path=a.txt"), get("/api/changes?session=nobody"), diffs)
        });
        let (state, list, diff, gone, refused) = read.await.unwrap();
        remove(&dir);
        assert_eq!(state["showCode"], true);
        assert!(state["recent"].as_array().unwrap().iter().any(|e| e["edit"] == json!({ "del": [], "add": ["two"], "more": 0 })));
        let paths: Vec<&str> = list["files"].as_array().unwrap().iter().filter_map(|f| f["path"].as_str()).collect();
        assert_eq!(paths, ["a.txt", "escape.txt"]);
        assert!(list["shared"].is_array());
        assert!(diff["text"].as_str().unwrap().lines().any(|l| l == "+two"));
        assert_eq!(gone["ok"], false);
        for d in &refused[..2] { assert_eq!(d["ok"], false, "{d}"); }
        for d in &refused { assert!(!d.to_string().contains("AUDIT_FIXTURE_ONLY"), "{d}"); }
        assert_eq!(refused[2]["text"], "Symbolic link");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn reading_and_reporting_need_their_own_keys() {
        let port = serve().await;
        tokio::task::spawn_blocking(move || {
            let ev = r#"{"hook_event_name":"SessionStart","session_id":"keys","cwd":"/tmp"}"#;
            let status = |m: &str, p: &str, h: &[(&str, &str)], b: &str| request(port, m, p, h, b.as_bytes()).0;
            let bearer = |k: &str| format!("Bearer {k}");
            for p in ["/api/state", "/api/changes?session=keys", "/api/changes/diff?session=keys&path=a", "/api/packs", "/api/setup", "/api/auth", "/api/update"] {
                assert_eq!(status("GET", p, &[], ""), 401, "{p}");
                assert_eq!(status("GET", p, &[("Authorization", &bearer(HOOK))], ""), 401, "{p}");
                assert_eq!(status("GET", p, &[("X-Agent-Office-Token", HOOK)], ""), 401, "{p}");
            }
            // Never with the page key here: setup would really change this machine's hooks.
            assert_eq!(status("POST", "/api/setup/codex", &[], ""), 401);
            assert_eq!(status("POST", "/api/setup/codex", &[("X-Agent-Office-Token", HOOK)], ""), 401);
            assert_eq!(status("POST", "/api/update", &[("X-Agent-Office-Token", HOOK)], ""), 401);
            // Nothing downloaded in a test: the page's install button has nothing to install.
            assert_eq!(page(port, "POST", "/api/update", "").0, 409);
            let (code, update) = page(port, "GET", "/api/update", "");
            assert_eq!(code, 200);
            assert!(update.contains("\"version\":null"), "{update}");
            assert_eq!(status("POST", "/api/log", &[], "x"), 401);
            assert_eq!(status("POST", "/api/face/keys/done", &[], "x"), 401);
            assert_eq!(status("POST", "/hook", &[], ev), 401);
            assert_eq!(status("POST", "/hook", &[("Authorization", &bearer(UI))], ev), 401);
            assert_eq!(status("POST", "/permission", &[("X-Agent-Office-Token", UI)], ev), 401);
            assert_eq!(hook(port, "/hook", ev).0, 204);
            assert_eq!(page(port, "GET", "/api/auth", "").0, 204);
            let (code, state) = page(port, "GET", "/api/state", "");
            assert_eq!(code, 200);
            assert!(state.contains("\"keys\""));
            // The page itself is public, keyless, and not frameable.
            let (code, head, body) = request(port, "GET", "/", &[], b"");
            assert_eq!(code, 200);
            assert!(!body.contains(UI) && !body.contains(HOOK));
            let head = head.to_lowercase();
            assert!(head.contains("x-frame-options: deny") && head.contains("x-content-type-options: nosniff"), "{head}");
        }).await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_foreign_host_or_origin_is_refused_even_with_the_key() {
        let port = serve().await;
        tokio::task::spawn_blocking(move || {
            let key = format!("Bearer {UI}");
            for host in [format!("evil.example:{port}"), format!("localhost.evil.example:{port}"), format!("127.0.0.1:{}", port + 1), "localhost".into()] {
                assert_eq!(request(port, "GET", "/api/state", &[("Host", &host), ("Authorization", &key)], b"").0, 403, "{host}");
            }
            assert_eq!(request(port, "GET", "/", &[("Host", &format!("rebind.example:{port}"))], b"").0, 403);
            for origin in ["http://evil.example".to_string(), format!("http://localhost:{}", port + 1), "null".into()] {
                assert_eq!(request(port, "GET", "/api/state", &[("Origin", &origin), ("Authorization", &key)], b"").0, 403, "{origin}");
            }
            let here = format!("localhost:{port}");
            assert_eq!(request(port, "GET", "/api/state", &[("Host", &here), ("Origin", &format!("http://{here}")), ("Authorization", &key)], b"").0, 200);
            assert_eq!(request(port, "GET", "/api/state", &[("Host", &format!("192.168.7.7:{port}")), ("Authorization", &key)], b"").0, 200);
        }).await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn only_a_page_with_the_key_opens_the_socket_and_answers_a_permission_request() {
        let port = serve().await;
        tokio::task::spawn_blocking(move || {
            let here = format!("http://127.0.0.1:{port}");
            assert_eq!(Ws::open(port, "agent-office", &[]).err(), Some(401));
            assert_eq!(Ws::open(port, &format!("agent-office, agent-office.token.{HOOK}"), &[]).err(), Some(401));
            assert_eq!(Ws::open(port, &format!("agent-office, agent-office.token.{UI}"), &[("Origin", "http://evil.example")]).err(), Some(403));
            assert_eq!(Ws::open(port, &format!("agent-office, agent-office.token.{UI}"), &[("Host", &format!("evil.example:{port}"))]).err(), Some(403));
            let mut ws = Ws::open(port, &format!("agent-office, agent-office.token.{UI}"), &[("Origin", &here)]).unwrap();
            assert!(ws.next("snapshot").unwrap()["approvals"].is_array());
            ws.text(r#"{"type":"presence","visible":true}"#);
            std::thread::sleep(Duration::from_millis(100));
            let asked = std::thread::spawn(move || hook(port, "/permission", r#"{"hook_event_name":"PermissionRequest","session_id":"perm","cwd":"/tmp","tool_name":"Bash","tool_input":{"command":"echo AUDIT_FIXTURE_ONLY"}}"#));
            let approval = ws.next("approval").unwrap()["approval"].clone();
            ws.text(&json!({ "type": "decide", "id": approval["id"], "decision": "deny" }).to_string());
            let (code, body) = asked.join().unwrap();
            assert_eq!(code, 200);
            assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["hookSpecificOutput"]["decision"]["behavior"], "deny");
            ws.text(r#"{"type":"presence","visible":false}"#);
            std::thread::sleep(Duration::from_millis(100));
            // Nobody watching: Claude Code asks as usual, at once.
            assert_eq!(hook(port, "/permission", r#"{"hook_event_name":"PermissionRequest","session_id":"perm","cwd":"/tmp","tool_name":"Bash"}"#).0, 204);
        }).await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn malformed_bodies_and_socket_messages_are_refused_without_stopping_the_office() {
        let port = serve().await;
        tokio::task::spawn_blocking(move || {
            for body in ["{", "null", "5", "\"x\"", "[1]", ""] {
                assert_eq!(hook(port, "/hook", body).0, 400, "{body}");
                assert_eq!(hook(port, "/permission", body).0, 400, "{body}");
            }
            assert_eq!(request(port, "GET", "/%ZZ", &[], b"").0, 404);
            assert_eq!(request(port, "GET", "/packs/kit/%ZZ.glb", &[], b"").0, 403);
            let mut ws = page_ws(port);
            ws.next("snapshot").unwrap();
            for m in ["null", "5", "\"x\"", "[]", r#"{"type":5}"#, r#"{"type":"focus","sessionId":{"a":1}}"#, r#"{"type":"decide","id":{"x":1},"decision":"allow"}"#, "not json"] { ws.text(m); }
            ws.send(2, &[1, 2, 3]);
            std::thread::sleep(Duration::from_millis(200));
            assert_eq!(page(port, "GET", "/api/auth", "").0, 204);
            ws.text(&"x".repeat(70 * 1024)); // over the message limit: this socket ends, the office doesn't
            assert!(ws.next("never").is_none());
            assert_eq!(page(port, "GET", "/api/auth", "").0, 204);
        }).await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_one_time_code_trades_for_the_page_key_once() {
        let dir = std::env::temp_dir().join(format!("office-login-{}-{}", std::process::id(), auth::random_hex()));
        let port = serve_with(dir.clone(), Box::new(|_, _| {})).await;
        tokio::task::spawn_blocking(move || {
            // A code the bridge's format would make (an empty file named by the code's SHA-256) works here too.
            let theirs = auth::random_hex();
            std::fs::create_dir_all(dir.join("login-codes")).unwrap();
            std::fs::write(auth::code_file(&dir, &theirs), "").unwrap();
            let code = auth::launch_code(&dir).unwrap();
            let login = |c: &str| request(port, "POST", "/api/login", &[("Content-Type", "application/json")], json!({ "code": c }).to_string().as_bytes());
            assert_eq!(login("0".repeat(64).as_str()).0, 401);
            let (status, _, body) = login(&code);
            assert_eq!(status, 200);
            assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["token"], UI);
            assert_eq!(login(&code).0, 401);
            assert_eq!(request(port, "POST", "/api/login", &[], b"null").0, 401);
            assert_eq!(login(&theirs).0, 200);
            assert_eq!(login(&theirs).0, 401);
            let _ = std::fs::remove_dir_all(&dir);
        }).await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn hooks_without_the_key_get_an_empty_refusal_and_the_office_says_they_need_updating() {
        let seen = Arc::new(Mutex::new(Vec::<Value>::new()));
        let sink = seen.clone();
        let dir = std::env::temp_dir().join(format!("office-outdated-{}-{}", std::process::id(), auth::random_hex()));
        let port = serve_with(dir, Box::new(move |_, e| { if e["type"] == "HooksOutdated" { sink.lock().unwrap().push(e.clone()); } })).await;
        tokio::task::spawn_blocking(move || {
            let mut watcher = page_ws(port);
            watcher.next("snapshot").unwrap();
            watcher.text(r#"{"type":"presence","visible":true}"#);
            std::thread::sleep(Duration::from_millis(100));
            let ev = r#"{"hook_event_name":"PermissionRequest","session_id":"old-hook","tool_name":"Bash","tool_input":{"command":"echo AUDIT_FIXTURE_ONLY"}}"#;
            // An old permission.sh prints whatever the office answers; nothing means Claude Code asks as usual.
            let (status, _, body) = request(port, "POST", "/permission", &[("Content-Type", "application/json")], ev.as_bytes());
            assert_eq!((status, body.as_str()), (401, ""));
            let notice = watcher.next("hooks-outdated").unwrap();
            assert_eq!(notice["hooks"][0]["agent"], "claude-code");
            assert_eq!(notice["hooks"][0]["reason"], "no-key");
            assert!(!notice.to_string().contains("AUDIT_FIXTURE_ONLY") && !notice.to_string().contains("old-hook"));
            request(port, "POST", "/permission", &[("Content-Type", "application/json")], ev.as_bytes());
            request(port, "POST", "/hook?agent=codex", &[("X-Agent-Office-Token", &"f".repeat(64))], b"{}");
            request(port, "POST", "/hook", &[("X-Agent-Office-Agent", "<b>x</b>")], b"{}");
            let (_, state) = page(port, "GET", "/api/state", "");
            let state: Value = serde_json::from_str(&state).unwrap();
            let kinds: Vec<String> = state["outdatedHooks"].as_array().unwrap().iter().map(|h| format!("{}/{}", h["agent"].as_str().unwrap(), h["reason"].as_str().unwrap())).collect();
            assert_eq!(kinds, ["claude-code/no-key", "codex/wrong-key", "unknown/no-key"]);
            assert_eq!(state["outdatedHooks"][0]["count"], 2);
            assert!(state["approvals"].as_array().unwrap().is_empty(), "nothing was held for a refused request");
            assert!(!state["sessions"].to_string().contains("old-hook"));
        }).await.unwrap();
        assert_eq!(seen.lock().unwrap().len(), 3, "the app hears of each kind once");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_page_runs_only_its_own_scripts() {
        use base64::Engine;
        use sha2::Digest;
        let port = serve().await;
        tokio::task::spawn_blocking(move || {
            let (status, head, body) = request(port, "GET", "/", &[], b"");
            assert_eq!(status, 200);
            let csp = head.lines().find_map(|l| l.strip_prefix("content-security-policy: ")).unwrap().to_string();
            let script = csp.split(';').map(str::trim).find(|d| d.starts_with("script-src ")).unwrap();
            assert!(!script.contains("unsafe") && !script.contains('*') && !script.contains("http"), "{script}");
            let mut rest = body.as_str();
            let mut n = 0;
            while let Some(i) = rest.find("<script>") {
                rest = &rest[i + 8..];
                let end = rest.find("</script>").unwrap();
                let hash = base64::engine::general_purpose::STANDARD.encode(sha2::Sha256::digest(&rest.as_bytes()[..end]));
                assert!(script.contains(&format!("'sha256-{hash}'")));
                n += 1;
            }
            assert!(n >= 1);
            for d in ["object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", &format!("connect-src 'self' ws://127.0.0.1:{port}")] {
                assert!(csp.contains(d), "{d}");
            }
        }).await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn packs_serve_models_inert_and_refuse_documents() {
        let base = std::env::temp_dir().join(format!("office-server-packs-{}-{}", std::process::id(), store::now_ms()));
        std::fs::create_dir_all(base.join("kit")).unwrap();
        std::fs::write(base.join("kit/sofa.glb"), "glTF-fixture").unwrap();
        std::fs::write(base.join("kit/evil.html"), "<script>fetch('/api/state')</script>").unwrap();
        std::fs::write(base.join("kit/evil.svg"), "<svg xmlns='http://www.w3.org/2000/svg'><script>1</script></svg>").unwrap();
        // Only this test reads packs through the server, so pointing the env at its folder is safe.
        std::env::set_var("AGENT_OFFICE_PACKS", &base);
        let port = serve().await;
        let (glb, html, svg) = tokio::task::spawn_blocking(move || (request(port, "GET", "/packs/kit/sofa.glb", &[], b""), request(port, "GET", "/packs/kit/evil.html", &[], b"").0, request(port, "GET", "/packs/kit/evil.svg", &[], b"").0)).await.unwrap();
        std::fs::remove_dir_all(&base).unwrap();
        let head = glb.1.to_lowercase();
        assert_eq!(glb.0, 200);
        assert!(head.contains("content-type: model/gltf-binary") && head.contains("x-content-type-options: nosniff") && head.contains("sandbox"), "{head}");
        assert_eq!((html, svg), (403, 403));
    }
}
