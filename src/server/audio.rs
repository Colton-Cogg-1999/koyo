use super::library::file_response;
use super::{bad_request, notify, one, rows, ApiError, ApiResult, AppState};
use crate::db::now;
use crate::tts::{self, VOICES};
use axum::extract::{Path, Request, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use rusqlite::params;
use serde::Deserialize;
use serde_json::{json, Value};
use std::fs;
use std::sync::atomic::Ordering;

async fn status(State(state): State<AppState>) -> ApiResult {
    Ok(Json(json!({
        "installed": tts::installed(&state.paths),
        "voices": VOICES,
        "default_voice": state.db.setting_str("tts_voice").unwrap_or_else(|| "af_heart".to_string()),
        "threads": state.db.setting("tts_threads"),
        "cores": std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4),
        "ffmpeg": crate::ai::find_binary("ffmpeg").is_some(),
    })))
}

async fn install(State(state): State<AppState>) -> ApiResult {
    if tts::installed(&state.paths) {
        return Ok(Json(json!({"ok": true})));
    }
    if state.tts.installing.swap(true, Ordering::SeqCst) {
        return Err(ApiError(StatusCode::CONFLICT, "Voice installation is already running.".into()));
    }
    let worker = state.clone();
    tokio::spawn(async move {
        if let Err(error) = tts::install(worker.paths.clone(), worker.events.clone()).await {
            tracing::warn!("voice install failed: {error:#}");
            notify(&worker, json!({"type": "tts_install", "stage": "failed", "error": format!("{error:#}")}));
        } else {
            worker.tts.wake();
        }
        worker.tts.installing.store(false, Ordering::SeqCst);
    });
    Ok(Json(json!({"ok": true})))
}

async fn preview(State(state): State<AppState>, Path(voice): Path<String>, request: Request) -> Result<Response, ApiError> {
    let path = state.tts.preview(voice).await.map_err(|e| bad_request(format!("{e:#}")))?;
    Ok(file_response(path, "audio/ogg", request).await)
}

async fn summary(state: &AppState, book: &str) -> Result<Value, ApiError> {
    let conn = state.db.conn();
    let audiobook = rows(&conn, "SELECT voice,status,cursor,error,listen_seq,listen_ms FROM audiobooks WHERE book_id=?1", [book])?.into_iter().next();
    let Some(mut audiobook) = audiobook else { return Ok(json!({"status": "none"})) };
    audiobook["tracks"] = Value::Array(rows(
        &conn,
        "SELECT seq,chapter,first_block,last_block,chars,ready,duration_ms FROM audio_tracks WHERE book_id=?1 ORDER BY seq",
        [book],
    )?);
    let exported = state.paths.audio_dir(book).join("audiobook.m4b");
    audiobook["has_export"] = json!(exported.exists());
    audiobook["chars_per_second"] = json!(state.tts.chars_per_second());
    Ok(audiobook)
}

async fn get_audio(State(state): State<AppState>, Path(book): Path<String>) -> ApiResult {
    Ok(Json(summary(&state, &book).await?))
}

async fn all_audio(State(state): State<AppState>) -> ApiResult {
    let conn = state.db.conn();
    Ok(Json(Value::Array(rows(
        &conn,
        "SELECT a.book_id,a.voice,a.status,a.error,a.updated_at,b.title,b.author,b.has_cover,
           (SELECT COUNT(*) FROM audio_tracks t WHERE t.book_id=a.book_id) AS total,
           (SELECT COALESCE(SUM(ready),0) FROM audio_tracks t WHERE t.book_id=a.book_id) AS ready,
           (SELECT COALESCE(SUM(duration_ms),0) FROM audio_tracks t WHERE t.book_id=a.book_id) AS duration_ms
         FROM audiobooks a JOIN books b ON b.id=a.book_id ORDER BY a.updated_at DESC",
        [],
    )?)))
}

#[derive(Deserialize)]
struct Start {
    voice: String,
    /// Generate outward from this block, so what the reader wants next comes first.
    block: Option<u32>,
}

async fn start(State(state): State<AppState>, Path(book): Path<String>, Json(body): Json<Start>) -> ApiResult {
    if tts::voice(&body.voice).is_none() {
        return Err(bad_request("Unknown voice."));
    }
    if !tts::installed(&state.paths) {
        return Err(bad_request("Install the voice engine first."));
    }
    let existing = {
        let conn = state.db.conn();
        rows(&conn, "SELECT voice FROM audiobooks WHERE book_id=?1", [&book])?.into_iter().next()
    };
    let same_voice = existing.as_ref().is_some_and(|row| row["voice"] == body.voice.as_str());
    if !same_voice {
        state.tts.interrupt(&book);
        let _ = fs::remove_dir_all(state.paths.audio_dir(&book));
        let (db, id) = (state.db.clone(), book.clone());
        tokio::task::spawn_blocking(move || tts::plan(&db, &id))
            .await
            .map_err(anyhow::Error::from)?
            .map_err(|e| bad_request(format!("{e:#}")))?;
    }
    let cursor = body.block.and_then(|b| tts::track_for_block(&state.db, &book, b)).unwrap_or(0);
    {
        let conn = state.db.conn();
        conn.execute(
            "INSERT INTO audiobooks(book_id,voice,status,cursor,created_at,updated_at) VALUES(?1,?2,'generating',?3,?4,?4)
             ON CONFLICT(book_id) DO UPDATE SET voice=excluded.voice, cursor=excluded.cursor,
               status=CASE WHEN (SELECT COUNT(*) FROM audio_tracks t WHERE t.book_id=?1 AND t.ready=0)>0 THEN 'generating' ELSE 'done' END,
               error=NULL, updated_at=excluded.updated_at",
            params![book, body.voice, cursor, now()],
        )?;
    }
    state.db.set_setting("tts_voice", &json!(body.voice))?;
    state.tts.wake();
    Ok(Json(summary(&state, &book).await?))
}

async fn pause(State(state): State<AppState>, Path(book): Path<String>) -> ApiResult {
    state.db.conn().execute(
        "UPDATE audiobooks SET status='paused', updated_at=?2 WHERE book_id=?1 AND status='generating'",
        params![book, now()],
    )?;
    state.tts.interrupt(&book);
    notify(&state, json!({"type": "audio", "book_id": book, "status": "paused"}));
    Ok(Json(summary(&state, &book).await?))
}

async fn delete_audio(State(state): State<AppState>, Path(book): Path<String>) -> ApiResult {
    {
        let conn = state.db.conn();
        conn.execute("DELETE FROM audiobooks WHERE book_id=?1", [&book])?;
        conn.execute("DELETE FROM audio_tracks WHERE book_id=?1", [&book])?;
    }
    state.tts.interrupt(&book);
    let _ = fs::remove_dir_all(state.paths.audio_dir(&book));
    notify(&state, json!({"type": "audio", "book_id": book, "status": "none"}));
    Ok(Json(json!({"ok": true})))
}

async fn track(State(state): State<AppState>, Path((book, seq)): Path<(String, u32)>, request: Request) -> Result<Response, ApiError> {
    Ok(file_response(state.paths.audio_dir(&book).join(format!("{seq}.opus")), "audio/ogg", request).await)
}

async fn track_detail(State(state): State<AppState>, Path((book, seq)): Path<(String, u32)>) -> ApiResult {
    let conn = state.db.conn();
    let mut detail = one(&conn, "SELECT seq,chapter,ready,duration_ms,marks,peaks FROM audio_tracks WHERE book_id=?1 AND seq=?2", params![book, seq])?;
    for key in ["marks", "peaks"] {
        detail[key] = detail[key].as_str().and_then(|t| serde_json::from_str(t).ok()).unwrap_or(json!([]));
    }
    Ok(Json(detail))
}

async fn locate(State(state): State<AppState>, Path((book, block)): Path<(String, u32)>) -> ApiResult {
    Ok(Json(json!({"seq": tts::track_for_block(&state.db, &book, block)})))
}

#[derive(Deserialize)]
struct Listen {
    seq: u32,
    ms: i64,
}

async fn save_listen(State(state): State<AppState>, Path(book): Path<String>, Json(body): Json<Listen>) -> ApiResult {
    state.db.conn().execute("UPDATE audiobooks SET listen_seq=?2, listen_ms=?3 WHERE book_id=?1", params![book, body.seq, body.ms])?;
    Ok(Json(json!({"ok": true})))
}

async fn export(State(state): State<AppState>, Path(book): Path<String>) -> ApiResult {
    if state.tts.exporting.swap(true, Ordering::SeqCst) {
        return Err(ApiError(StatusCode::CONFLICT, "An export is already running.".into()));
    }
    let worker = state.clone();
    let id = book.clone();
    tokio::task::spawn_blocking(move || {
        let outcome = tts::export_m4b(&worker.db, &worker.paths, &id);
        worker.tts.exporting.store(false, Ordering::SeqCst);
        match outcome {
            Ok(_) => notify(&worker, json!({"type": "audio_export", "book_id": id, "status": "done"})),
            Err(error) => notify(&worker, json!({"type": "audio_export", "book_id": id, "status": "failed", "error": format!("{error:#}")})),
        }
    });
    Ok(Json(json!({"ok": true})))
}

async fn download(State(state): State<AppState>, Path(book): Path<String>, request: Request) -> Result<Response, ApiError> {
    let title: String = state.db.conn().query_row("SELECT title FROM books WHERE id=?1", [&book], |r| r.get(0))?;
    let path = state.paths.audio_dir(&book).join("audiobook.m4b");
    let mut response = file_response(path, "audio/mp4", request).await.into_response();
    let safe: String = title.chars().filter(|c| c.is_alphanumeric() || *c == ' ').collect();
    if let Ok(value) = HeaderValue::from_str(&format!("attachment; filename=\"{}.m4b\"", safe.trim())) {
        response.headers_mut().insert(header::CONTENT_DISPOSITION, value);
    }
    Ok(response)
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/tts", get(status))
        .route("/api/tts/install", post(install))
        .route("/api/tts/preview/{voice}", get(preview))
        .route("/api/audiobooks", get(all_audio))
        .route("/api/books/{id}/audio", get(get_audio).post(start).delete(delete_audio))
        .route("/api/books/{id}/audio/pause", post(pause))
        .route("/api/books/{id}/audio/position", put(save_listen))
        .route("/api/books/{id}/audio/export", post(export))
        .route("/api/books/{id}/audio/download", get(download))
        .route("/api/books/{id}/audio/at/{block}", get(locate))
        .route("/api/books/{id}/audio/tracks/{seq}", get(track))
        .route("/api/books/{id}/audio/tracks/{seq}/detail", get(track_detail))
}
