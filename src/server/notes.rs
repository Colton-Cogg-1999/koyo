use super::{bad_request, one, rows, ApiError, ApiResult, AppState};
use crate::db::now;
use crate::notes;
use axum::extract::{Path, State};
use axum::http::{header, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch};
use axum::{Json, Router};
use rusqlite::params;
use serde::Deserialize;
use serde_json::{json, Value};

const CHAPTER: &str = "(SELECT t.title FROM toc t WHERE t.book_id=a.book_id AND t.block<=a.block ORDER BY t.block DESC, t.idx DESC LIMIT 1) AS chapter";

fn mirror(state: &AppState, book: Option<&str>) {
    let outcome = match book {
        Some(id) => notes::mirror_book(&state.db, &state.paths, id),
        None => notes::mirror_loose_notes(&state.db, &state.paths),
    };
    if let Err(error) = outcome {
        tracing::warn!("could not update the Markdown notes: {error:#}");
    }
}

async fn all_annotations(State(state): State<AppState>, uri: Uri) -> ApiResult {
    let query = super::parse_query(&uri);
    let conn = state.db.conn();
    let sql = format!(
        "SELECT a.*, b.title AS book_title, b.author AS book_author, {CHAPTER} FROM annotations a JOIN books b ON b.id=a.book_id
         WHERE (?1 IS NULL OR a.book_id=?1) AND (?2 IS NULL OR a.kind=?2) ORDER BY a.created_at DESC"
    );
    Ok(Json(Value::Array(rows(&conn, &sql, params![query.get("book"), query.get("kind")])?)))
}

#[derive(Deserialize)]
struct NewAnnotation {
    book_id: String,
    kind: String,
    #[serde(default = "default_color")]
    color: String,
    anchor: Value,
    #[serde(default)]
    block: u32,
    #[serde(default)]
    page: u32,
    #[serde(default)]
    quote: String,
    #[serde(default)]
    note: String,
}

fn default_color() -> String {
    "yellow".into()
}

const COLORS: &[&str] = &["yellow", "blue", "green", "pink"];

async fn create_annotation(State(state): State<AppState>, Json(body): Json<NewAnnotation>) -> ApiResult {
    if !matches!(body.kind.as_str(), "highlight" | "bookmark") {
        return Err(bad_request("Unknown annotation kind."));
    }
    if !COLORS.contains(&body.color.as_str()) {
        return Err(bad_request("Unknown highlight color."));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let time = now();
    let created = {
        let conn = state.db.conn();
        conn.execute(
            "INSERT INTO annotations(id,book_id,kind,color,anchor,block,page,quote,note,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?10)",
            params![id, body.book_id, body.kind, body.color, body.anchor.to_string(), body.block, body.page, body.quote, body.note, time],
        )?;
        one(&conn, &format!("SELECT a.*, {CHAPTER} FROM annotations a WHERE a.id=?1"), [&id])?
    };
    mirror(&state, Some(&body.book_id));
    Ok(Json(created))
}

#[derive(Deserialize)]
struct AnnotationPatch {
    color: Option<String>,
    note: Option<String>,
}

async fn update_annotation(State(state): State<AppState>, Path(id): Path<String>, Json(body): Json<AnnotationPatch>) -> ApiResult {
    if body.color.as_deref().is_some_and(|c| !COLORS.contains(&c)) {
        return Err(bad_request("Unknown highlight color."));
    }
    let (updated, book): (Value, String) = {
        let conn = state.db.conn();
        conn.execute(
            "UPDATE annotations SET color=COALESCE(?2,color), note=COALESCE(?3,note), updated_at=?4 WHERE id=?1",
            params![id, body.color, body.note, now()],
        )?;
        let updated = one(&conn, &format!("SELECT a.*, {CHAPTER} FROM annotations a WHERE a.id=?1"), [&id])?;
        let book = updated["book_id"].as_str().unwrap_or("").to_string();
        (updated, book)
    };
    mirror(&state, Some(&book));
    Ok(Json(updated))
}

async fn delete_annotation(State(state): State<AppState>, Path(id): Path<String>) -> ApiResult {
    let book: String = {
        let conn = state.db.conn();
        let book = conn.query_row("SELECT book_id FROM annotations WHERE id=?1", [&id], |r| r.get(0))?;
        conn.execute("DELETE FROM annotations WHERE id=?1", [&id])?;
        book
    };
    mirror(&state, Some(&book));
    Ok(Json(json!({"ok": true})))
}

async fn list_notes(State(state): State<AppState>, uri: Uri) -> ApiResult {
    let query = super::parse_query(&uri);
    let conn = state.db.conn();
    Ok(Json(Value::Array(rows(
        &conn,
        "SELECT n.*, b.title AS book_title FROM notes n LEFT JOIN books b ON b.id=n.book_id
         WHERE (?1 IS NULL OR n.book_id=?1) ORDER BY n.updated_at DESC",
        params![query.get("book")],
    )?)))
}

#[derive(Deserialize)]
struct NewNote {
    book_id: Option<String>,
    #[serde(default)]
    title: String,
    #[serde(default)]
    body: String,
}

async fn create_note(State(state): State<AppState>, Json(body): Json<NewNote>) -> ApiResult {
    let id = uuid::Uuid::new_v4().to_string();
    let time = now();
    let created = {
        let conn = state.db.conn();
        conn.execute(
            "INSERT INTO notes(id,book_id,title,body,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?5)",
            params![id, body.book_id, body.title, body.body, time],
        )?;
        one(&conn, "SELECT n.*, b.title AS book_title FROM notes n LEFT JOIN books b ON b.id=n.book_id WHERE n.id=?1", [&id])?
    };
    mirror(&state, body.book_id.as_deref());
    Ok(Json(created))
}

#[derive(Deserialize)]
struct NotePatch {
    title: Option<String>,
    body: Option<String>,
}

async fn update_note(State(state): State<AppState>, Path(id): Path<String>, Json(body): Json<NotePatch>) -> ApiResult {
    let (updated, book) = {
        let conn = state.db.conn();
        conn.execute(
            "UPDATE notes SET title=COALESCE(?2,title), body=COALESCE(?3,body), updated_at=?4 WHERE id=?1",
            params![id, body.title, body.body, now()],
        )?;
        let updated = one(&conn, "SELECT n.*, b.title AS book_title FROM notes n LEFT JOIN books b ON b.id=n.book_id WHERE n.id=?1", [&id])?;
        let book = updated["book_id"].as_str().map(str::to_string);
        (updated, book)
    };
    mirror(&state, book.as_deref());
    Ok(Json(updated))
}

async fn delete_note(State(state): State<AppState>, Path(id): Path<String>) -> ApiResult {
    let book: Option<String> = {
        let conn = state.db.conn();
        let book = conn.query_row("SELECT book_id FROM notes WHERE id=?1", [&id], |r| r.get(0))?;
        conn.execute("DELETE FROM notes WHERE id=?1", [&id])?;
        book
    };
    mirror(&state, book.as_deref());
    Ok(Json(json!({"ok": true})))
}

async fn export_book(State(state): State<AppState>, Path(id): Path<String>) -> Result<Response, ApiError> {
    let (title, markdown) = notes::book_markdown(&state.db, &id).map_err(|_| ApiError(StatusCode::NOT_FOUND, "Not found".into()))?;
    let safe: String = title.chars().filter(|c| c.is_alphanumeric() || *c == ' ').collect();
    let disposition = format!("attachment; filename=\"{} notes.md\"", safe.trim());
    Ok(([(header::CONTENT_TYPE, "text/markdown; charset=utf-8".to_string()), (header::CONTENT_DISPOSITION, disposition)], markdown).into_response())
}

async fn export_all(State(state): State<AppState>) -> Result<Response, ApiError> {
    let ids: Vec<String> = {
        let conn = state.db.conn();
        let mut stmt = conn.prepare("SELECT id FROM books WHERE id IN (SELECT book_id FROM annotations) OR id IN (SELECT book_id FROM notes) ORDER BY title")?;
        let rows = stmt.query_map([], |r| r.get(0))?;
        rows.collect::<Result<_, _>>()?
    };
    let mut markdown = String::new();
    for id in ids { markdown.push_str(&notes::book_markdown(&state.db, &id)?.1); markdown.push_str("\n---\n\n"); }
    Ok(([(header::CONTENT_TYPE, "text/markdown; charset=utf-8"), (header::CONTENT_DISPOSITION, "attachment; filename=\"Koyo notes.md\"")], markdown).into_response())
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/annotations/export.md", get(export_all))
        .route("/api/annotations", get(all_annotations).post(create_annotation))
        .route("/api/annotations/{id}", patch(update_annotation).delete(delete_annotation))
        .route("/api/notes", get(list_notes).post(create_note))
        .route("/api/notes/{id}", patch(update_note).delete(delete_note))
        .route("/api/books/{id}/notes.md", get(export_book))
}
