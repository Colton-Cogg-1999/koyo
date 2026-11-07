use super::{bad_request, notify, one, parse_query, rows, ApiError, ApiResult, AppState};
use crate::db::now;
use crate::ingest::{self, Registered};
use crate::{notes, retrieval};
use axum::extract::{Path, Request, State};
use axum::http::{header, HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use futures::StreamExt;
use rusqlite::params;
use serde::Deserialize;
use serde_json::{json, Value};
use std::fs;
use tokio::io::AsyncWriteExt;
use tower::ServiceExt;
use tower_http::services::ServeFile;

const BOOK_FIELDS: &str = "b.id, b.title, b.author, b.format, b.file_name, b.file_size, b.language, b.description, b.status,
  b.error, b.has_cover, b.pages, b.words, b.chars, b.favorite, b.added_at, b.opened_at,
  COALESCE(p.progress,0) AS progress, p.updated_at AS read_at, a.status AS audio_status,
  (SELECT COUNT(*) FROM annotations n WHERE n.book_id=b.id AND n.kind!='bookmark') AS annotation_count,
  (SELECT COALESCE(group_concat(collection_id),'') FROM collection_books c WHERE c.book_id=b.id) AS collection_ids";
const BOOK_JOIN: &str = "FROM books b LEFT JOIN positions p ON p.book_id=b.id LEFT JOIN audiobooks a ON a.book_id=b.id";

async fn list_books(State(state): State<AppState>) -> ApiResult {
    let conn = state.db.conn();
    let sql = format!("SELECT {BOOK_FIELDS} {BOOK_JOIN} ORDER BY COALESCE(b.opened_at,b.added_at) DESC");
    Ok(Json(Value::Array(rows(&conn, &sql, [])?)))
}

async fn upload(State(state): State<AppState>, headers: HeaderMap, request: Request) -> ApiResult {
    let name = headers.get("x-file-name").and_then(|v| v.to_str().ok()).map(ingest::percent_decode).unwrap_or_default();
    let name = name.rsplit('/').next().unwrap_or("").to_string();
    if name.is_empty() {
        return Err(bad_request("The file has no name."));
    }
    let temp = state.paths.tmp.join(uuid::Uuid::new_v4().to_string());
    let mut file = tokio::fs::File::create(&temp).await?;
    let mut stream = request.into_body().into_data_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(error) => {
                let _ = fs::remove_file(&temp);
                return Err(bad_request(format!("The upload failed: {error}")));
            }
        };
        file.write_all(&chunk).await?;
    }
    file.flush().await?;
    drop(file);

    let registered = {
        let (db, paths, temp, name) = (state.db.clone(), state.paths.clone(), temp.clone(), name.clone());
        tokio::task::spawn_blocking(move || ingest::register(&db, &paths, &temp, &name)).await.map_err(anyhow::Error::from)?
    };
    let registered = match registered {
        Ok(registered) => registered,
        Err(error) => {
            let _ = fs::remove_file(&temp);
            return Err(ApiError(StatusCode::UNPROCESSABLE_ENTITY, format!("{error:#}")));
        }
    };
    let (id, duplicate) = match registered {
        Registered::Existing(id) => (id, true),
        Registered::New(id) => {
            let worker = state.clone();
            let book = id.clone();
            tokio::task::spawn_blocking(move || {
                let outcome = ingest::process(&worker.db, &worker.paths, &book);
                let status = if outcome.is_ok() { "ready" } else { "failed" };
                notify(&worker, json!({"type": "book", "id": book, "status": status}));
            });
            (id, false)
        }
    };
    Ok(Json(json!({"id": id, "duplicate": duplicate})))
}

async fn book_detail(State(state): State<AppState>, Path(id): Path<String>) -> ApiResult {
    let conn = state.db.conn();
    let sql = format!("SELECT {BOOK_FIELDS} {BOOK_JOIN} WHERE b.id=?1");
    let mut book = one(&conn, &sql, [&id])?;
    book["toc"] = Value::Array(rows(&conn, "SELECT idx,level,title,block,page,front FROM toc WHERE book_id=?1 ORDER BY idx", [&id])?);
    book["sections"] = Value::Array(rows(&conn, "SELECT idx,title,first_block,last_block FROM sections WHERE book_id=?1 ORDER BY idx", [&id])?);
    book["chapters"] = json!(retrieval::chapters(&conn, &id)?);
    book["position"] = rows(&conn, "SELECT block,fraction,page,progress FROM positions WHERE book_id=?1", [&id])?.into_iter().next().unwrap_or(Value::Null);
    Ok(Json(book))
}

#[derive(Deserialize)]
struct BookPatch {
    title: Option<String>,
    author: Option<String>,
    favorite: Option<bool>,
    collections: Option<Vec<i64>>,
}

async fn update_book(State(state): State<AppState>, Path(id): Path<String>, Json(patch): Json<BookPatch>) -> ApiResult {
    let mut conn = state.db.conn();
    let tx = conn.transaction()?;
    if let Some(title) = patch.title.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        tx.execute("UPDATE books SET title=?2 WHERE id=?1", params![id, title])?;
    }
    if let Some(author) = &patch.author {
        tx.execute("UPDATE books SET author=?2 WHERE id=?1", params![id, author.trim()])?;
    }
    if let Some(favorite) = patch.favorite {
        tx.execute("UPDATE books SET favorite=?2 WHERE id=?1", params![id, favorite])?;
    }
    if let Some(collections) = &patch.collections {
        tx.execute("DELETE FROM collection_books WHERE book_id=?1", [&id])?;
        for collection in collections {
            tx.execute("INSERT OR IGNORE INTO collection_books(collection_id,book_id) VALUES(?1,?2)", params![collection, id])?;
        }
    }
    tx.commit()?;
    Ok(Json(json!({"ok": true})))
}

async fn delete_book(State(state): State<AppState>, Path(id): Path<String>) -> ApiResult {
    state.tts.interrupt(&id);
    let removed = state.db.conn().execute("DELETE FROM books WHERE id=?1", [&id])?;
    if removed == 0 {
        return Err(ApiError(StatusCode::NOT_FOUND, "Not found".into()));
    }
    let _ = fs::remove_dir_all(state.paths.book_dir(&id));
    let _ = fs::remove_dir_all(state.paths.audio_dir(&id));
    Ok(Json(json!({"ok": true})))
}

async fn serve_path(path: std::path::PathBuf, mime: &str, request: Request) -> Response {
    let service = ServeFile::new_with_mime(path, &mime.parse().unwrap_or(mime_guess::mime::APPLICATION_OCTET_STREAM));
    match service.oneshot(request).await {
        Ok(response) => response.into_response(),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

pub async fn file_response(path: std::path::PathBuf, mime: &str, request: Request) -> Response {
    serve_path(path, mime, request).await
}

async fn original(State(state): State<AppState>, Path(id): Path<String>, request: Request) -> Result<Response, ApiError> {
    let name: String = state.db.conn().query_row("SELECT file_name FROM books WHERE id=?1", [&id], |r| r.get(0))?;
    let path = ingest::original_path(&state.paths, &id, &name);
    let mime = mime_guess::from_path(&name).first_or_octet_stream();
    // Only PDFs render inline. Anything else is a download, never a page on this origin.
    let is_pdf = mime.essence_str() == "application/pdf";
    let mut response = serve_path(path, mime.essence_str(), request).await;
    if !is_pdf {
        let disposition = "attachment".parse().unwrap();
        response.headers_mut().insert(header::CONTENT_DISPOSITION, disposition);
    }
    Ok(response)
}

async fn cover(State(state): State<AppState>, Path(id): Path<String>, request: Request) -> Response {
    for ext in ["jpg", "png", "webp", "gif", "avif"] {
        let path = state.paths.book_dir(&id).join(format!("cover.{ext}"));
        if path.exists() {
            let mime = mime_guess::from_path(&path).first_or_octet_stream();
            let mut response = serve_path(path, mime.essence_str(), request).await;
            response.headers_mut().insert(header::CACHE_CONTROL, "private, max-age=86400".parse().unwrap());
            return response;
        }
    }
    StatusCode::NOT_FOUND.into_response()
}

async fn asset(State(state): State<AppState>, Path((id, name)): Path<(String, String)>, request: Request) -> Response {
    let valid = !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '.') && !name.contains("..");
    if !valid {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let path = state.paths.book_dir(&id).join("assets").join(&name);
    let mime = mime_guess::from_path(&path).first_or_octet_stream();
    let mut response = serve_path(path, mime.essence_str(), request).await;
    // Book SVGs are untrusted, and this keeps one from running if opened directly.
    response.headers_mut().insert(header::CONTENT_SECURITY_POLICY, "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:".parse().unwrap());
    response
}

async fn section(State(state): State<AppState>, Path((id, n)): Path<(String, u32)>) -> ApiResult {
    let conn = state.db.conn();
    Ok(Json(one(&conn, "SELECT idx,title,html,first_block,last_block FROM sections WHERE book_id=?1 AND idx=?2", params![id, n])?))
}

async fn locate(State(state): State<AppState>, Path((id, seq)): Path<(String, u32)>) -> ApiResult {
    let conn = state.db.conn();
    Ok(Json(one(&conn, "SELECT seq,section,page,x,y,w,h,kind FROM blocks WHERE book_id=?1 AND seq=?2", params![id, seq])?))
}

async fn page_blocks(State(state): State<AppState>, Path((id, page)): Path<(String, u32)>) -> ApiResult {
    let conn = state.db.conn();
    Ok(Json(Value::Array(rows(&conn, "SELECT seq,x,y,w,h,kind FROM blocks WHERE book_id=?1 AND page=?2 ORDER BY seq", params![id, page])?)))
}

#[derive(Deserialize)]
struct PositionBody {
    block: u32,
    #[serde(default)]
    fraction: f64,
    #[serde(default)]
    page: u32,
}

async fn save_position(State(state): State<AppState>, Path(id): Path<String>, Json(body): Json<PositionBody>) -> ApiResult {
    let conn = state.db.conn();
    let (pages, format, chars): (f64, String, f64) =
        conn.query_row("SELECT pages,format,chars FROM books WHERE id=?1", [&id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
    let progress = if format == "pdf" {
        (body.page as f64 + body.fraction - 1.0) / pages.max(1.0)
    } else {
        let start: f64 = conn
            .query_row("SELECT start_char FROM blocks WHERE book_id=?1 AND seq=?2", params![id, body.block], |r| r.get(0))
            .unwrap_or(0.0);
        start / chars.max(1.0)
    }
    .clamp(0.0, 1.0);
    conn.execute(
        "INSERT INTO positions(book_id,block,fraction,page,progress,updated_at) VALUES(?1,?2,?3,?4,?5,?6)
         ON CONFLICT(book_id) DO UPDATE SET block=excluded.block, fraction=excluded.fraction, page=excluded.page,
           progress=excluded.progress, updated_at=excluded.updated_at",
        params![id, body.block, body.fraction, body.page, progress, now()],
    )?;
    conn.execute("UPDATE books SET opened_at=?2 WHERE id=?1", params![id, now()])?;
    Ok(Json(json!({"progress": progress})))
}

async fn search(State(state): State<AppState>, uri: Uri) -> ApiResult {
    let query = parse_query(&uri);
    let text = query.get("q").map(String::as_str).unwrap_or("");
    let results = retrieval::search(&state.db, query.get("book").map(String::as_str), text, 60)?;
    Ok(Json(Value::Array(results)))
}

async fn list_collections(State(state): State<AppState>) -> ApiResult {
    let conn = state.db.conn();
    Ok(Json(Value::Array(rows(
        &conn,
        "SELECT c.id,c.name,(SELECT COUNT(*) FROM collection_books b WHERE b.collection_id=c.id) AS count FROM collections c ORDER BY c.name",
        [],
    )?)))
}

#[derive(Deserialize)]
struct NameBody {
    name: String,
}

async fn create_collection(State(state): State<AppState>, Json(body): Json<NameBody>) -> ApiResult {
    let name = body.name.trim();
    if name.is_empty() {
        return Err(bad_request("A collection needs a name."));
    }
    let conn = state.db.conn();
    conn.execute("INSERT OR IGNORE INTO collections(name,created_at) VALUES(?1,?2)", params![name, now()])?;
    Ok(Json(one(&conn, "SELECT id,name FROM collections WHERE name=?1", [name])?))
}

async fn delete_collection(State(state): State<AppState>, Path(id): Path<i64>) -> ApiResult {
    state.db.conn().execute("DELETE FROM collections WHERE id=?1", [id])?;
    Ok(Json(json!({"ok": true})))
}

async fn rename_collection(State(state): State<AppState>, Path(id): Path<i64>, Json(body): Json<NameBody>) -> ApiResult {
    state.db.conn().execute("UPDATE collections SET name=?2 WHERE id=?1", params![id, body.name.trim()])?;
    Ok(Json(json!({"ok": true})))
}

async fn get_settings(State(state): State<AppState>) -> ApiResult {
    Ok(Json(Value::Object(state.db.all_settings()?)))
}

async fn put_settings(State(state): State<AppState>, Json(body): Json<serde_json::Map<String, Value>>) -> ApiResult {
    for (key, value) in body {
        state.db.set_setting(&key, &value)?;
    }
    Ok(Json(json!({"ok": true})))
}

fn dir_size(path: &std::path::Path) -> u64 {
    let Ok(entries) = fs::read_dir(path) else { return 0 };
    entries
        .flatten()
        .map(|entry| match entry.metadata() {
            Ok(meta) if meta.is_dir() => dir_size(&entry.path()),
            Ok(meta) => meta.len(),
            Err(_) => 0,
        })
        .sum()
}

async fn storage(State(state): State<AppState>) -> ApiResult {
    let paths = &state.paths;
    let (native, calibre) = ingest::supported_formats();
    Ok(Json(json!({
        "data_dir": paths.data,
        "notes_dir": notes::notes_dir(&state.db, paths),
        "books_bytes": dir_size(&paths.books),
        "audio_bytes": dir_size(&paths.audio),
        "models_bytes": dir_size(&paths.models),
        "db_bytes": fs::metadata(&paths.db).map(|m| m.len()).unwrap_or(0),
        "formats": native,
        "calibre_formats": calibre,
        "calibre_installed": crate::ai::find_binary("ebook-convert").is_some(),
    })))
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/books", get(list_books).post(upload))
        .route("/api/books/{id}", get(book_detail).patch(update_book).delete(delete_book))
        .route("/api/books/{id}/file", get(original))
        .route("/api/books/{id}/cover", get(cover))
        .route("/api/books/{id}/assets/{name}", get(asset))
        .route("/api/books/{id}/sections/{n}", get(section))
        .route("/api/books/{id}/blocks/{seq}", get(locate))
        .route("/api/books/{id}/pages/{page}/blocks", get(page_blocks))
        .route("/api/books/{id}/position", put(save_position))
        .route("/api/search", get(search))
        .route("/api/collections", get(list_collections).post(create_collection))
        .route("/api/collections/{id}", delete(delete_collection).patch(rename_collection))
        .route("/api/settings", get(get_settings).put(put_settings))
        .route("/api/storage", get(storage))
        .route("/api/theme", get(theme))
        .route("/api/notes/open-folder", post(open_notes_folder))
        .route("/api/open", post(open_external))
}

async fn theme() -> ApiResult {
    Ok(Json(crate::theme::current()))
}

#[derive(Deserialize)]
struct OpenBody {
    url: String,
}

/// Links in books open in the person's real browser, not the app window.
async fn open_external(Json(body): Json<OpenBody>) -> ApiResult {
    let lower = body.url.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("mailto:")) {
        return Err(bad_request("Only web links can be opened."));
    }
    let _ = std::process::Command::new("xdg-open").arg(body.url).spawn();
    Ok(Json(json!({"ok": true})))
}

async fn open_notes_folder(State(state): State<AppState>) -> ApiResult {
    let dir = notes::notes_dir(&state.db, &state.paths);
    let _ = fs::create_dir_all(&dir);
    let _ = std::process::Command::new("xdg-open").arg(dir).spawn();
    Ok(Json(json!({"ok": true})))
}
