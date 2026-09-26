// The office server built into the app: receives hook events, serves the 3D office, streams live state,
// and answers permission requests you allow or deny from the office.
// Same endpoints as bridge/server.js, so phones and VR headsets can connect to it too.
use crate::adapters;
use crate::store::{self, Store};
use axum::{
    body::Bytes,
    extract::{ws::{Message, WebSocket, WebSocketUpgrade}, Query, Request, State},
    http::{header, HeaderMap, StatusCode, Uri},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use rust_embed::RustEmbed;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{broadcast, oneshot};

#[derive(RustEmbed)]
#[folder = "../../web/"]
struct Web;

static THREE_JS: &[u8] = include_bytes!("../../../node_modules/three/build/three.min.js");

/// How long a watched office holds a permission request before Claude Code shows its own dialog.
const APPROVAL_HOLD: Duration = Duration::from_secs(45);

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
    /// Only this machine's office pages may connect; otherwise any website could reach localhost and approve commands.
    origins: Vec<String>,
}
type AppState = Arc<Shared>;

fn broadcast(st: &Shared, msg: Value) {
    let _ = st.tx.send(msg.to_string());
}

pub fn router(port: u16, on_change: OnChange) -> Router {
    let (tx, _) = broadcast::channel(256);
    let state = Arc::new(Shared {
        store: Mutex::new(Store::default()),
        tx,
        on_change,
        pending: Mutex::new(HashMap::new()),
        watchers: AtomicUsize::new(0),
        seq: AtomicU64::new(0),
        origins: ["localhost", "127.0.0.1", "[::1]"].iter().map(|h| format!("http://{h}:{port}")).collect(),
    });
    Router::new()
        .route("/hook", post(hook))
        .route("/permission", post(permission))
        .route("/api/state", get(state_json))
        .route("/api/log", post(client_log))
        .route("/ws", get(ws))
        .route("/vendor/three.min.js", get(three))
        .fallback(get(asset))
        .layer(middleware::from_fn_with_state(state.clone(), check_origin))
        .with_state(state)
}

/// Serve on 127.0.0.1 (and ::1, so http://localhost works everywhere). If the port is taken,
/// another office is already running and the app window simply uses that one.
pub async fn run(port: u16, on_change: OnChange) {
    let app = router(port, on_change);
    match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
        Ok(listener) => {
            if let Ok(v6) = tokio::net::TcpListener::bind(("::1", port)).await {
                let app6 = app.clone();
                tokio::spawn(async move {
                    let _ = axum::serve(v6, app6).await;
                });
            }
            println!("Agent Office is running at http://localhost:{port}");
            if let Err(err) = axum::serve(listener, app).await {
                eprintln!("Agent Office server stopped: {err}");
            }
        }
        Err(err) => eprintln!("Port {port} is busy ({err}); using the office that is already running there."),
    }
}

/// Hooks (curl) send no Origin header; browsers always do. Reject pages from anywhere but this office.
async fn check_origin(State(st): State<AppState>, req: Request, next: Next) -> Response {
    if let Some(origin) = req.headers().get(header::ORIGIN).and_then(|v| v.to_str().ok()) {
        if !st.origins.iter().any(|o| o == origin) {
            return StatusCode::FORBIDDEN.into_response();
        }
    }
    next.run(req).await
}

/// Other agents (Codex, Cursor, Gemini CLI…) send their own payloads through adapters/hook.sh with the tool's
/// name in X-Agent-Office-Agent (or ?agent=); translate them to the Claude shape first.
fn ingest(st: &Shared, headers: &HeaderMap, query: &HashMap<String, String>, body: &Bytes) -> Result<Option<Value>, StatusCode> {
    let raw = serde_json::from_slice::<Value>(body).map_err(|_| StatusCode::BAD_REQUEST)?;
    let header = |name: &str| headers.get(name).and_then(|v| v.to_str().ok()).filter(|v| !v.is_empty());
    let agent = header("x-agent-office-agent").or(query.get("agent").map(String::as_str)).unwrap_or("claude-code").to_lowercase();
    let Some(payload) = adapters::normalize(&agent, &raw, header("x-agent-office-event")) else { return Ok(None) };
    let mut store = st.store.lock().unwrap();
    let event = store.ingest_from(&payload, header("x-agent-office-entrypoint"), header("x-agent-office-project"), &agent);
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

/// The page reports its errors and frame rate here so they show up in the app log.
async fn client_log(body: Bytes) -> StatusCode {
    eprintln!("[office page] {}", String::from_utf8_lossy(&body[..body.len().min(2000)]));
    StatusCode::NO_CONTENT
}

fn snapshot(st: &Shared) -> Value {
    let mut v = st.store.lock().unwrap().snapshot();
    v["approvals"] = st.pending.lock().unwrap().values().map(|p| p.approval.clone()).collect::<Vec<_>>().into();
    v
}

async fn state_json(State(st): State<AppState>) -> Json<Value> {
    Json(snapshot(&st))
}

async fn ws(State(st): State<AppState>, upgrade: WebSocketUpgrade) -> Response {
    upgrade.on_upgrade(move |socket| client(socket, st))
}

async fn client(mut socket: WebSocket, st: AppState) {
    let mut rx = st.tx.subscribe();
    let mut first = snapshot(&st);
    first["type"] = "snapshot".into();
    if socket.send(Message::Text(first.to_string().into())).await.is_err() {
        return;
    }
    let mut visible = false;
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
}

async fn three() -> impl IntoResponse {
    ([(header::CONTENT_TYPE, "text/javascript")], THREE_JS)
}

async fn asset(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    match Web::get(path) {
        Some(file) => {
            let mime = mime_guess::from_path(path).first_or_octet_stream();
            // say it's UTF-8, or characters like "·" and "…" show up garbled
            let content_type = if mime.type_() == "text" { format!("{mime}; charset=utf-8") } else { mime.to_string() };
            ([(header::CONTENT_TYPE, content_type), (header::CACHE_CONTROL, "no-cache".to_string())], file.data.into_owned()).into_response()
        }
        None => (StatusCode::NOT_FOUND, "Not found").into_response(),
    }
}
