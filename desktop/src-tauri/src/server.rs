// The office server built into the app: receives hook events, serves the 3D office, and streams live state.
// Same endpoints as bridge/server.js, so phones and VR headsets can connect to it too.
use crate::store::Store;
use axum::{
    body::Bytes,
    extract::{ws::{Message, WebSocket, WebSocketUpgrade}, State},
    http::{header, HeaderMap, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use rust_embed::RustEmbed;
use serde_json::Value;
use std::sync::{Arc, Mutex};
use tokio::sync::broadcast;

#[derive(RustEmbed)]
#[folder = "../../web/"]
struct Web;

static THREE_JS: &[u8] = include_bytes!("../../../node_modules/three/build/three.min.js");

/// Called after every accepted event, with the store still locked, so the app can update its tray and notify.
pub type OnChange = Box<dyn Fn(&Store, &Value) + Send + Sync>;

struct Shared {
    store: Mutex<Store>,
    tx: broadcast::Sender<String>,
    on_change: OnChange,
}
type AppState = Arc<Shared>;

pub fn router(on_change: OnChange) -> Router {
    let (tx, _) = broadcast::channel(256);
    let state = Arc::new(Shared { store: Mutex::new(Store::default()), tx, on_change });
    Router::new()
        .route("/hook", post(hook))
        .route("/api/state", get(state_json))
        .route("/api/log", post(client_log))
        .route("/ws", get(ws))
        .route("/vendor/three.min.js", get(three))
        .fallback(get(asset))
        .with_state(state)
}

/// Serve on 127.0.0.1 (and ::1, so http://localhost works everywhere). If the port is taken,
/// another office is already running and the app window simply uses that one.
pub async fn run(port: u16, on_change: OnChange) {
    let app = router(on_change);
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

async fn hook(State(st): State<AppState>, headers: HeaderMap, body: Bytes) -> StatusCode {
    let Ok(payload) = serde_json::from_slice::<Value>(&body) else { return StatusCode::BAD_REQUEST };
    let header = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
    let (entrypoint, project_dir) = (header("x-agent-office-entrypoint"), header("x-agent-office-project"));
    let mut store = st.store.lock().unwrap();
    if let Some(event) = store.ingest(&payload, entrypoint, project_dir) {
        (st.on_change)(&store, &event);
        let _ = st.tx.send(serde_json::json!({ "type": "event", "event": event }).to_string());
    }
    StatusCode::NO_CONTENT
}

/// The page reports its errors and frame rate here so they show up in the app log.
async fn client_log(body: Bytes) -> StatusCode {
    eprintln!("[office page] {}", String::from_utf8_lossy(&body[..body.len().min(2000)]));
    StatusCode::NO_CONTENT
}

async fn state_json(State(st): State<AppState>) -> Json<Value> {
    Json(st.store.lock().unwrap().snapshot())
}

async fn ws(State(st): State<AppState>, upgrade: WebSocketUpgrade) -> Response {
    upgrade.on_upgrade(move |socket| client(socket, st))
}

async fn client(mut socket: WebSocket, st: AppState) {
    let mut rx = st.tx.subscribe();
    let snapshot = {
        let mut v = st.store.lock().unwrap().snapshot();
        v["type"] = "snapshot".into();
        v.to_string()
    };
    if socket.send(Message::Text(snapshot.into())).await.is_err() {
        return;
    }
    loop {
        tokio::select! {
            msg = rx.recv() => match msg {
                Ok(text) => if socket.send(Message::Text(text.into())).await.is_err() { break },
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => break,
            },
            incoming = socket.recv() => match incoming {
                None | Some(Err(_)) | Some(Ok(Message::Close(_))) => break,
                _ => {}
            },
        }
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
