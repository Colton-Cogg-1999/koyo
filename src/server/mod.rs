pub mod audio;
pub mod chat;
pub mod library;
pub mod notes;

use crate::ai::ProviderStatus;
use crate::config::Paths;
use crate::db::Db;
use crate::tts::{Events, Tts};
use axum::body::Body;
use axum::extract::{Query, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode, Uri};
use axum::middleware::{self, Next};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::get;
use axum::{Json, Router};
use futures::Stream;
use rusqlite::types::ValueRef;
use rusqlite::{Connection, Params};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tokio::sync::broadcast;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;

pub struct Inner {
    pub db: Db,
    pub paths: Paths,
    pub token: String,
    pub port: u16,
    pub events: Events,
    pub tts: Tts,
    pub provider_cache: Mutex<Option<(Instant, Vec<ProviderStatus>)>>,
}

pub type AppState = Arc<Inner>;

pub struct ApiError(pub StatusCode, pub String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error": self.1}))).into_response()
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(error: anyhow::Error) -> Self {
        ApiError(StatusCode::INTERNAL_SERVER_ERROR, format!("{error:#}"))
    }
}

impl From<rusqlite::Error> for ApiError {
    fn from(error: rusqlite::Error) -> Self {
        if matches!(error, rusqlite::Error::QueryReturnedNoRows) {
            return ApiError(StatusCode::NOT_FOUND, "Not found".into());
        }
        ApiError(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
    }
}

impl From<std::io::Error> for ApiError {
    fn from(error: std::io::Error) -> Self {
        ApiError(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
    }
}

pub type ApiResult<T = Json<Value>> = Result<T, ApiError>;

pub fn bad_request(message: impl Into<String>) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, message.into())
}

/// Runs a query and returns rows as JSON objects keyed by column name.
pub fn rows<P: Params>(conn: &Connection, sql: &str, params: P) -> rusqlite::Result<Vec<Value>> {
    let mut stmt = conn.prepare(sql)?;
    let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let mut result = stmt.query(params)?;
    let mut out = Vec::new();
    while let Some(row) = result.next()? {
        let mut object = Map::with_capacity(names.len());
        for (i, name) in names.iter().enumerate() {
            let value = match row.get_ref(i)? {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(n) => json!(n),
                ValueRef::Real(f) => json!(f),
                ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
                ValueRef::Blob(_) => Value::Null,
            };
            object.insert(name.clone(), value);
        }
        out.push(Value::Object(object));
    }
    Ok(out)
}

pub fn one<P: Params>(conn: &Connection, sql: &str, params: P) -> rusqlite::Result<Value> {
    rows(conn, sql, params)?.into_iter().next().ok_or(rusqlite::Error::QueryReturnedNoRows)
}

#[derive(rust_embed::RustEmbed)]
#[folder = "web/dist"]
struct Assets;

const CSP: &str = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; \
img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; \
object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

fn cookie_matches(headers: &HeaderMap, token: &str) -> bool {
    headers
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|cookies| cookies.split(';').any(|c| c.trim().strip_prefix("oma_session=").is_some_and(|v| v == token)))
}

/// The server is loopback-only, but a browser can still be pointed at it. The Host check
/// stops DNS rebinding, the Origin check stops cross-site writes, and the session cookie
/// keeps out other local users and pages.
async fn guard(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let host = request.headers().get(header::HOST).and_then(|h| h.to_str().ok()).unwrap_or("");
    let allowed = [format!("127.0.0.1:{}", state.port), format!("localhost:{}", state.port)];
    if !allowed.iter().any(|a| a == host) {
        return (StatusCode::FORBIDDEN, "Unrecognized host").into_response();
    }
    let writing = !matches!(*request.method(), Method::GET | Method::HEAD);
    if writing {
        let origin = request.headers().get(header::ORIGIN).and_then(|o| o.to_str().ok());
        let same = origin.is_some_and(|o| allowed.iter().any(|a| o == format!("http://{a}")));
        if !same {
            return (StatusCode::FORBIDDEN, "Cross-origin write refused").into_response();
        }
    }
    let path = request.uri().path();
    if path.starts_with("/api/") && path != "/api/health" && !cookie_matches(request.headers(), &state.token) {
        return ApiError(StatusCode::UNAUTHORIZED, "Open OmaReader from the omareader command.".into()).into_response();
    }
    // File-serving routes must never interpret a decoded identifier as a path.
    if let Some(rest) = path.strip_prefix("/api/books/") {
        let id = rest.split('/').next().unwrap_or("");
        if id.len() != 24 || !id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
            return ApiError(StatusCode::BAD_REQUEST, "Invalid book identifier.".into()).into_response();
        }
    }
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    // Keep the stricter sandbox on untrusted book assets.
    headers.entry(header::CONTENT_SECURITY_POLICY).or_insert(HeaderValue::from_static(CSP));
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    headers.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    response
}

#[derive(Deserialize)]
struct AuthQuery {
    t: String,
}

async fn auth(State(state): State<AppState>, Query(query): Query<AuthQuery>) -> Response {
    if query.t != state.token {
        return (StatusCode::FORBIDDEN, "Invalid session link").into_response();
    }
    let cookie = format!("oma_session={}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000", state.token);
    ([(header::SET_COOKIE, cookie)], Redirect::to("/")).into_response()
}

async fn health() -> Json<Value> {
    Json(json!({"app": "omareader"}))
}

async fn events(State(state): State<AppState>) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let stream = BroadcastStream::new(state.events.subscribe()).filter_map(|message| {
        message.ok().map(|value: Value| Ok(Event::default().data(value.to_string())))
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

async fn statics(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    let (file, name) = match Assets::get(path) {
        Some(file) => (file, path),
        None if path.starts_with("assets/") => return StatusCode::NOT_FOUND.into_response(),
        None => match Assets::get("index.html") {
            Some(file) => (file, "index.html"),
            None => return (StatusCode::NOT_FOUND, "The web UI hasn't been built. Run `npm run build` in web/.").into_response(),
        },
    };
    let mime = mime_guess::from_path(name).first_or_octet_stream();
    let cache = if name.starts_with("assets/") { "public, max-age=31536000, immutable" } else { "no-cache" };
    ([(header::CONTENT_TYPE, mime.as_ref().to_string()), (header::CACHE_CONTROL, cache.to_string())], Body::from(file.data.into_owned())).into_response()
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/auth", get(auth))
        .route("/api/health", get(health))
        .route("/api/events", get(events))
        .merge(library::routes())
        .merge(notes::routes())
        .merge(chat::routes())
        .merge(audio::routes())
        .fallback(statics)
        .layer(middleware::from_fn_with_state(state.clone(), guard))
        .with_state(state)
}

pub fn notify(state: &AppState, value: Value) {
    let _ = state.events.send(value);
}

pub fn new_events() -> Events {
    broadcast::channel(256).0
}

pub fn parse_query(uri: &Uri) -> HashMap<String, String> {
    uri.query()
        .map(|q| {
            q.split('&')
                .filter_map(|pair| pair.split_once('='))
                .map(|(k, v)| (k.to_string(), crate::ingest::percent_decode(&v.replace('+', " "))))
                .collect()
        })
        .unwrap_or_default()
}
