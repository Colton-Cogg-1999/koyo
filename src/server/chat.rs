use super::{bad_request, one, parse_query, rows, ApiResult, AppState};
use crate::ai::{self, AiEvent, Turn};
use crate::db::now;
use crate::retrieval::{self, AskRequest};
use axum::extract::{Path, State};
use axum::http::Uri;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get};
use axum::{Json, Router};
use rusqlite::params;
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

const HISTORY_TURNS: usize = 8;
const STATUS_TTL: Duration = Duration::from_secs(300);

async fn provider_list(state: &AppState, refresh: bool) -> Vec<ai::ProviderStatus> {
    let cached = state.provider_cache.lock().unwrap().clone();
    let list = match cached {
        Some((at, list)) if !refresh && at.elapsed() < STATUS_TTL => list,
        _ => {
            let list = ai::statuses(&state.paths.ai_cwd).await;
            *state.provider_cache.lock().unwrap() = Some((Instant::now(), list.clone()));
            list
        }
    };
    list
}

async fn providers(State(state): State<AppState>, uri: Uri) -> ApiResult {
    let list = provider_list(&state, parse_query(&uri).contains_key("refresh")).await;
    let selected = state.db.setting_str("ai_provider").or_else(|| list.iter().find(|p| p.signed_in).map(|p| p.id.to_string()));
    Ok(Json(json!({"providers": list, "selected": selected, "model": state.db.setting_str("ai_model").unwrap_or_default()})))
}

async fn list_chats(State(state): State<AppState>, Path(book): Path<String>) -> ApiResult {
    let conn = state.db.conn();
    Ok(Json(Value::Array(rows(&conn, "SELECT id,title,created_at,updated_at FROM chats WHERE book_id=?1 ORDER BY updated_at DESC", [book])?)))
}

async fn create_chat(State(state): State<AppState>, Path(book): Path<String>) -> ApiResult {
    let id = uuid::Uuid::new_v4().to_string();
    let time = now();
    let conn = state.db.conn();
    conn.execute("INSERT INTO chats(id,book_id,created_at,updated_at) VALUES(?1,?2,?3,?3)", params![id, book, time])?;
    Ok(Json(one(&conn, "SELECT id,title,created_at,updated_at FROM chats WHERE id=?1", [id])?))
}

async fn messages(State(state): State<AppState>, Path(chat): Path<String>) -> ApiResult {
    let conn = state.db.conn();
    let list = rows(&conn, "SELECT id,role,content,citations,provider,created_at FROM messages WHERE chat_id=?1 ORDER BY id", [chat])?;
    let parsed = list
        .into_iter()
        .map(|mut message| {
            let citations = message["citations"].as_str().and_then(|c| serde_json::from_str(c).ok()).unwrap_or(json!([]));
            message["citations"] = citations;
            message
        })
        .collect();
    Ok(Json(Value::Array(parsed)))
}

async fn delete_chat(State(state): State<AppState>, Path(chat): Path<String>) -> ApiResult {
    state.db.conn().execute("DELETE FROM chats WHERE id=?1", [chat])?;
    Ok(Json(json!({"ok": true})))
}

#[derive(Deserialize)]
struct Ask {
    #[serde(flatten)]
    request: AskRequest,
    /// The text to show in the transcript when a quick action sends a longer instruction.
    #[serde(default)]
    label: Option<String>,
}

fn sse(value: Value) -> Result<Event, std::convert::Infallible> {
    Ok(Event::default().data(value.to_string()))
}

async fn ask(State(state): State<AppState>, Path(chat): Path<String>, Json(body): Json<Ask>) -> Result<Response, super::ApiError> {
    let question = body.request.question.trim().to_string();
    if question.is_empty() {
        return Err(bad_request("Ask a question first."));
    }
    let (book, history): (String, Vec<(String, String)>) = {
        let conn = state.db.conn();
        let book = conn.query_row("SELECT book_id FROM chats WHERE id=?1", [&chat], |r| r.get(0))?;
        let mut stmt = conn.prepare("SELECT role,content FROM messages WHERE chat_id=?1 ORDER BY id DESC LIMIT ?2")?;
        let mut turns: Vec<(String, String)> =
            stmt.query_map(params![chat, HISTORY_TURNS as i64], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?;
        turns.reverse();
        (book, turns)
    };
    let provider = match state.db.setting_str("ai_provider") {
        Some(provider) if matches!(provider.as_str(), "claude" | "codex") => provider,
        Some(_) => return Err(bad_request("Unknown AI provider. Choose Claude Code or Codex in settings.")),
        None => provider_list(&state, false).await.iter().find(|p| p.signed_in)
            .map(|p| p.id.to_string()).ok_or_else(|| bad_request("Sign in to Claude Code or Codex before asking a question."))?,
    };
    let model = state.db.setting_str("ai_model");
    let prompt = retrieval::build(&state.db, &book, &body.request, &history).map_err(|e| bad_request(&e.to_string()))?;
    let citations = prompt.citations.clone();
    let shown = body.label.clone().unwrap_or_else(|| question.clone());
    {
        let conn = state.db.conn();
        let time = now();
        conn.execute("INSERT INTO messages(chat_id,role,content,created_at) VALUES(?1,'user',?2,?3)", params![chat, shown, time])?;
        let title: String = shown.chars().take(70).collect();
        conn.execute("UPDATE chats SET title=CASE WHEN title='' THEN ?2 ELSE title END, updated_at=?3 WHERE id=?1", params![chat, title, time])?;
    }

    let (tx, mut rx) = mpsc::channel::<AiEvent>(64);
    let cwd = state.paths.ai_cwd.clone();
    let turn = Turn { system: prompt.system, prompt: prompt.prompt, model };
    let run_provider = provider.clone();
    tokio::spawn(async move { ai::run(&run_provider, &cwd, turn, tx).await });

    let stream = async_stream::stream! {
        yield sse(json!({"type": "citations", "citations": citations}));
        let mut answer = String::new();
        let mut failed: Option<String> = None;
        while let Some(event) = rx.recv().await {
            match event {
                AiEvent::Delta(text) => {
                    answer.push_str(&text);
                    yield sse(json!({"type": "delta", "text": text}));
                }
                AiEvent::Failed(message) => {
                    failed = Some(message.clone());
                    yield sse(json!({"type": "error", "message": message}));
                }
            }
        }
        if !answer.is_empty() {
            let saved = {
                let conn = state.db.conn();
                let cited = serde_json::to_string(&citations).unwrap_or_else(|_| "[]".into());
                let _ = conn.execute(
                    "INSERT INTO messages(chat_id,role,content,citations,provider,created_at) VALUES(?1,'assistant',?2,?3,?4,?5)",
                    params![chat, answer, cited, provider, now()],
                );
                conn.last_insert_rowid()
            };
            if failed.is_none() {
                yield sse(json!({"type": "done", "id": saved}));
            }
        }
    };
    Ok(Sse::new(stream).keep_alive(KeepAlive::default()).into_response())
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/ai/providers", get(providers))
        .route("/api/books/{id}/chats", get(list_chats).post(create_chat))
        .route("/api/chats/{id}", delete(delete_chat))
        .route("/api/chats/{id}/messages", get(messages).post(ask))
}
