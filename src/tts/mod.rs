//! Offline audiobooks with Kokoro through sherpa-onnx. Books are split into short tracks so
//! listening can start within seconds of the first track finishing, generation can resume
//! after a restart, and every sentence keeps its place in the text for read-along.

pub mod text;

use crate::config::Paths;
use crate::db::{now, Db};
use crate::retrieval;
use anyhow::{anyhow, bail, Context, Result};
use futures::StreamExt;
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use sherpa_onnx::{GenerationConfig, OfflineTts, OfflineTtsConfig};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::oneshot;

const MODEL_DIR: &str = "kokoro-multi-lang-v1_0";
const MODEL_URL: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2";
const MODEL_BYTES: u64 = 350_000_000;
const SAMPLE_RATE: usize = 24_000;
const TRACK_CHARS: usize = 1200;
const SPOKEN_KINDS: &str = "('p','h1','h2','h3','h4','h5','h6','li','quote')";

#[derive(Clone, Copy, Serialize)]
pub struct Voice {
    pub id: &'static str,
    pub name: &'static str,
    pub accent: &'static str,
    pub gender: &'static str,
    #[serde(skip)]
    pub sid: i32,
    #[serde(skip)]
    pub lang: &'static str,
}

const fn v(id: &'static str, name: &'static str, accent: &'static str, gender: &'static str, sid: i32, lang: &'static str) -> Voice {
    Voice { id, name, accent, gender, sid, lang }
}

pub const VOICES: &[Voice] = &[
    v("af_heart", "Heart", "American", "Female", 3, "en-us"),
    v("af_bella", "Bella", "American", "Female", 2, "en-us"),
    v("af_nicole", "Nicole", "American", "Female", 6, "en-us"),
    v("af_aoede", "Aoede", "American", "Female", 1, "en-us"),
    v("af_kore", "Kore", "American", "Female", 5, "en-us"),
    v("af_sarah", "Sarah", "American", "Female", 9, "en-us"),
    v("af_nova", "Nova", "American", "Female", 7, "en-us"),
    v("af_sky", "Sky", "American", "Female", 10, "en-us"),
    v("af_alloy", "Alloy", "American", "Female", 0, "en-us"),
    v("af_jessica", "Jessica", "American", "Female", 4, "en-us"),
    v("af_river", "River", "American", "Female", 8, "en-us"),
    v("am_michael", "Michael", "American", "Male", 16, "en-us"),
    v("am_fenrir", "Fenrir", "American", "Male", 14, "en-us"),
    v("am_puck", "Puck", "American", "Male", 18, "en-us"),
    v("am_echo", "Echo", "American", "Male", 12, "en-us"),
    v("am_eric", "Eric", "American", "Male", 13, "en-us"),
    v("am_liam", "Liam", "American", "Male", 15, "en-us"),
    v("am_onyx", "Onyx", "American", "Male", 17, "en-us"),
    v("am_adam", "Adam", "American", "Male", 11, "en-us"),
    v("bf_emma", "Emma", "British", "Female", 21, "en-gb"),
    v("bf_isabella", "Isabella", "British", "Female", 22, "en-gb"),
    v("bf_alice", "Alice", "British", "Female", 20, "en-gb"),
    v("bf_lily", "Lily", "British", "Female", 23, "en-gb"),
    v("bm_george", "George", "British", "Male", 26, "en-gb"),
    v("bm_fable", "Fable", "British", "Male", 25, "en-gb"),
    v("bm_lewis", "Lewis", "British", "Male", 27, "en-gb"),
    v("bm_daniel", "Daniel", "British", "Male", 24, "en-gb"),
];

pub fn voice(id: &str) -> Option<&'static Voice> {
    VOICES.iter().find(|v| v.id == id)
}

pub fn model_path(paths: &Paths) -> PathBuf {
    paths.models.join(MODEL_DIR)
}

pub fn installed(paths: &Paths) -> bool {
    let dir = model_path(paths);
    ["model.onnx", "voices.bin", "tokens.txt", "lexicon-gb-en.txt", "lexicon-us-en.txt"]
        .iter().all(|name| dir.join(name).is_file()) && dir.join("espeak-ng-data").is_dir()
}

pub use crate::server::Events;

/// Downloads and unpacks the voice model. Writes into a temp directory and renames at the
/// end, so an interrupted install never looks installed.
pub async fn install(paths: Paths, events: Events) -> Result<()> {
    let archive = paths.tmp.join("kokoro.tar.bz2");
    let response = reqwest::get(MODEL_URL).await?.error_for_status()?;
    let total = response.content_length().unwrap_or(MODEL_BYTES);
    let mut file = fs::File::create(&archive)?;
    let mut stream = response.bytes_stream();
    let (mut done, mut last) = (0u64, Instant::now());
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("the download was interrupted")?;
        file.write_all(&chunk)?;
        done += chunk.len() as u64;
        if last.elapsed() > Duration::from_millis(400) {
            last = Instant::now();
            let _ = events.send(json!({"type": "tts_install", "stage": "download", "done": done, "total": total}));
        }
    }
    drop(file);
    let _ = events.send(json!({"type": "tts_install", "stage": "unpack", "done": done, "total": total}));
    let unpack = paths.tmp.clone();
    let archive_path = archive.clone();
    tokio::task::spawn_blocking(move || -> Result<()> {
        let staging = unpack.join("kokoro-staging");
        let _ = fs::remove_dir_all(&staging);
        fs::create_dir_all(&staging)?;
        let decoder = bzip2::read::BzDecoder::new(fs::File::open(&archive_path)?);
        tar::Archive::new(decoder).unpack(&staging)?;
        Ok(())
    })
    .await??;
    let _ = fs::remove_file(&archive);
    let target = model_path(&paths);
    let _ = fs::remove_dir_all(&target);
    fs::rename(paths.tmp.join("kokoro-staging").join(MODEL_DIR), &target)?;
    let _ = fs::remove_dir_all(paths.tmp.join("kokoro-staging"));
    let _ = events.send(json!({"type": "tts_install", "stage": "done", "done": total, "total": total}));
    Ok(())
}

struct Engine {
    tts: OfflineTts,
    lang: &'static str,
}

fn load_engine(paths: &Paths, lang: &'static str, threads: i32) -> Result<Engine> {
    let dir = model_path(paths);
    let file = |name: &str| Some(dir.join(name).to_string_lossy().into_owned());
    let mut config = OfflineTtsConfig::default();
    config.model.kokoro.model = file("model.onnx");
    config.model.kokoro.voices = file("voices.bin");
    config.model.kokoro.tokens = file("tokens.txt");
    config.model.kokoro.data_dir = file("espeak-ng-data");
    config.model.kokoro.lexicon = file(if lang == "en-gb" { "lexicon-gb-en.txt" } else { "lexicon-us-en.txt" });
    config.model.kokoro.lang = Some(lang.to_string());
    config.model.num_threads = threads;
    let tts = OfflineTts::create(&config).context("the voice model failed to load")?;
    Ok(Engine { tts, lang })
}

enum Command_ {
    Wake,
    Preview { voice: String, reply: oneshot::Sender<Result<PathBuf>> },
}

#[derive(Clone)]
pub struct Tts {
    tx: mpsc::Sender<Command_>,
    cancel: Arc<AtomicU64>,
    active: Arc<Mutex<Option<String>>>,
    speed: Arc<AtomicU64>,
    pub exporting: Arc<AtomicBool>,
    pub installing: Arc<AtomicBool>,
}

impl Tts {
    pub fn start(db: Db, paths: Paths, events: Events) -> Self {
        let (tx, rx) = mpsc::channel();
        let tts = Tts {
            tx,
            cancel: Arc::new(AtomicU64::new(0)),
            active: Arc::new(Mutex::new(None)),
            speed: Arc::new(AtomicU64::new(0)),
            exporting: Arc::new(AtomicBool::new(false)),
            installing: Arc::new(AtomicBool::new(false)),
        };
        let worker = tts.clone();
        std::thread::Builder::new()
            .name("omareader-tts".into())
            .spawn(move || worker.run(rx, db, paths, events))
            .expect("the TTS thread could not start");
        tts
    }

    pub fn wake(&self) {
        let _ = self.tx.send(Command_::Wake);
    }

    /// Stops the current track if it belongs to `book`. Its partial audio is discarded.
    pub fn interrupt(&self, book: &str) {
        if self.active.lock().unwrap().as_deref() == Some(book) {
            self.cancel.fetch_add(1, Ordering::SeqCst);
        }
    }

    pub async fn preview(&self, voice: String) -> Result<PathBuf> {
        let (reply, rx) = oneshot::channel();
        self.tx.send(Command_::Preview { voice, reply }).map_err(|_| anyhow!("the voice engine has stopped"))?;
        rx.await.map_err(|_| anyhow!("the voice engine has stopped"))?
    }

    /// Characters per second over recent tracks, used for the time estimate.
    pub fn chars_per_second(&self) -> f64 {
        self.speed.load(Ordering::Relaxed) as f64 / 100.0
    }

    fn run(self, rx: mpsc::Receiver<Command_>, db: Db, paths: Paths, events: Events) {
        // Linux applies nice per thread, and ONNX worker threads inherit it, so generating
        // a book in the background doesn't make the laptop feel slow.
        unsafe {
            libc::setpriority(libc::PRIO_PROCESS, 0, 10);
        }
        let mut engine: Option<Engine> = None;
        let mut idle = false;
        loop {
            let message = if idle { rx.recv_timeout(Duration::from_secs(3600)) } else { rx.try_recv().map_err(|e| match e {
                mpsc::TryRecvError::Empty => RecvTimeoutError::Timeout,
                mpsc::TryRecvError::Disconnected => RecvTimeoutError::Disconnected,
            }) };
            match message {
                Ok(Command_::Preview { voice, reply }) => {
                    let _ = reply.send(self.make_preview(&mut engine, &db, &paths, &voice));
                    continue;
                }
                Ok(Command_::Wake) | Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return,
            }
            idle = !self.step(&mut engine, &db, &paths, &events);
        }
    }

    fn threads(&self, db: &Db) -> i32 {
        let cores = std::thread::available_parallelism().map(|n| n.get() as i64).unwrap_or(4);
        db.setting("tts_threads").and_then(|v| v.as_i64()).filter(|n| *n > 0).unwrap_or((cores / 2).clamp(2, 8)) as i32
    }

    fn engine<'e>(&self, slot: &'e mut Option<Engine>, db: &Db, paths: &Paths, lang: &'static str) -> Result<&'e Engine> {
        if slot.as_ref().is_none_or(|e| e.lang != lang) {
            *slot = None;
            *slot = Some(load_engine(paths, lang, self.threads(db))?);
        }
        Ok(slot.as_ref().unwrap())
    }

    fn make_preview(&self, slot: &mut Option<Engine>, db: &Db, paths: &Paths, voice_id: &str) -> Result<PathBuf> {
        let chosen = voice(voice_id).context("unknown voice")?;
        let dir = paths.audio.join("previews");
        fs::create_dir_all(&dir)?;
        let out = dir.join(format!("{}.opus", chosen.id));
        if out.exists() {
            return Ok(out);
        }
        if !installed(paths) {
            bail!("The voice engine isn't installed yet.");
        }
        let engine = self.engine(slot, db, paths, chosen.lang)?;
        let line = format!("Hello, I'm {}. Every book can sound like this.", chosen.name);
        let mut samples = Vec::new();
        synth(engine, chosen.sid, &line, &mut samples)?;
        encode(&samples, &out)?;
        Ok(out)
    }

    /// Generates the next pending track. Returns false when there's nothing to do.
    fn step(&self, slot: &mut Option<Engine>, db: &Db, paths: &Paths, events: &Events) -> bool {
        if !installed(paths) {
            return false;
        }
        let job = match next_track(db) {
            Ok(Some(job)) => job,
            Ok(None) => return false,
            Err(error) => {
                tracing::warn!("audio queue: {error:#}");
                return false;
            }
        };
        let started = Instant::now();
        *self.active.lock().unwrap() = Some(job.book.clone());
        let ticket = self.cancel.load(Ordering::SeqCst);
        let outcome = self.generate(slot, db, paths, &job, ticket);
        *self.active.lock().unwrap() = None;
        match outcome {
            Ok(true) => {
                let elapsed = started.elapsed().as_secs_f64().max(0.01);
                let measured = job.chars as f64 / elapsed;
                let previous = self.chars_per_second();
                let smoothed = if previous > 0.0 { previous * 0.7 + measured * 0.3 } else { measured };
                self.speed.store((smoothed * 100.0) as u64, Ordering::Relaxed);
                emit_progress(db, events, &job.book, Some(job.seq), smoothed);
                finish_if_done(db, events, &job.book);
            }
            Ok(false) => {}
            Err(error) => {
                tracing::warn!(book = job.book, "audio generation failed: {error:#}");
                let message = format!("{error:#}");
                let _ = db.conn().execute(
                    "UPDATE audiobooks SET status='failed', error=?2, updated_at=?3 WHERE book_id=?1",
                    params![job.book, message, now()],
                );
                let _ = events.send(json!({"type": "audio", "book_id": job.book, "status": "failed", "error": message}));
            }
        }
        true
    }

    fn generate(&self, slot: &mut Option<Engine>, db: &Db, paths: &Paths, job: &Job, ticket: u64) -> Result<bool> {
        let chosen = voice(&job.voice).context("unknown voice")?;
        let engine = self.engine(slot, db, paths, chosen.lang)?;
        let blocks = track_blocks(db, job)?;
        let mut samples: Vec<f32> = Vec::with_capacity(SAMPLE_RATE * 90);
        let mut marks: Vec<Value> = Vec::new();
        for block in &blocks {
            let heading = block.kind.starts_with('h');
            let source = block.speech.as_deref().unwrap_or(&block.text);
            let parts = text::sentences(source);
            for sentence in &parts {
                if self.cancel.load(Ordering::SeqCst) != ticket {
                    return Ok(false);
                }
                let spoken = if heading { text::normalize_heading(&sentence.text) } else { text::normalize(&sentence.text) };
                if !spoken.chars().any(char::is_alphanumeric) {
                    continue;
                }
                let start_ms = samples.len() * 1000 / SAMPLE_RATE;
                synth(engine, chosen.sid, &spoken, &mut samples)?;
                let end_ms = samples.len() * 1000 / SAMPLE_RATE;
                marks.push(json!([block.seq, sentence.start, sentence.end, start_ms, end_ms]));
                silence(&mut samples, 140);
            }
            silence(&mut samples, if heading { 650 } else { 260 });
        }
        let dir = paths.audio_dir(&job.book);
        fs::create_dir_all(&dir)?;
        let out = dir.join(format!("{}.opus", job.seq));
        if samples.is_empty() {
            silence(&mut samples, 200);
        }
        encode(&samples, &out)?;
        let duration = samples.len() * 1000 / SAMPLE_RATE;
        let conn = db.conn();
        // A delete or voice change may have replaced the plan while this track was running.
        if self.cancel.load(Ordering::SeqCst) != ticket {
            let _ = fs::remove_file(&out);
            return Ok(false);
        }
        conn.execute(
            "UPDATE audio_tracks SET ready=1, duration_ms=?3, marks=?4, peaks=?5 WHERE book_id=?1 AND seq=?2",
            params![job.book, job.seq, duration as i64, Value::Array(marks).to_string(), peaks(&samples).to_string()],
        )?;
        Ok(true)
    }
}

fn silence(samples: &mut Vec<f32>, ms: usize) {
    samples.resize(samples.len() + SAMPLE_RATE * ms / 1000, 0.0);
}

fn synth(engine: &Engine, sid: i32, line: &str, samples: &mut Vec<f32>) -> Result<()> {
    let config = GenerationConfig { sid, speed: 1.0, ..Default::default() };
    let audio = engine
        .tts
        .generate_with_config::<fn(&[f32], f32) -> bool>(line, &config, None)
        .context("speech synthesis failed")?;
    samples.extend_from_slice(audio.samples());
    Ok(())
}

/// Ogg Opus plays in every engine here, including builds with no AAC or MP3 decoder.
fn encode(samples: &[f32], out: &Path) -> Result<()> {
    let temp = out.with_extension("part");
    let mut child = Command::new("ffmpeg")
        .args(["-y", "-hide_banner", "-loglevel", "error", "-f", "f32le", "-ar", "24000", "-ac", "1", "-i", "pipe:0"])
        .args(["-c:a", "libopus", "-b:a", "40k", "-vbr", "on", "-application", "audio", "-f", "ogg"])
        .arg(&temp)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .context("ffmpeg is required for audiobooks. Install it with `sudo pacman -S ffmpeg`.")?;
    let mut stdin = child.stdin.take().context("no stdin")?;
    let mut bytes = Vec::with_capacity(samples.len() * 4);
    for sample in samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    stdin.write_all(&bytes)?;
    drop(stdin);
    if !child.wait()?.success() {
        let _ = fs::remove_file(&temp);
        bail!("ffmpeg could not encode the audio.");
    }
    fs::rename(temp, out)?;
    Ok(())
}

fn peaks(samples: &[f32]) -> Value {
    let step = SAMPLE_RATE / 4;
    Value::Array(
        samples
            .chunks(step)
            .map(|chunk| {
                let rms = (chunk.iter().map(|s| s * s).sum::<f32>() / chunk.len() as f32).sqrt();
                json!(((rms * 600.0).min(100.0)) as u8)
            })
            .collect(),
    )
}

struct Job {
    book: String,
    voice: String,
    seq: u32,
    first: u32,
    last: u32,
    chars: u32,
}

struct SpeechBlock {
    seq: u32,
    kind: String,
    text: String,
    speech: Option<String>,
}

fn track_blocks(db: &Db, job: &Job) -> Result<Vec<SpeechBlock>> {
    let conn = db.conn();
    let sql = format!("SELECT seq,kind,text,speech FROM blocks WHERE book_id=?1 AND seq>=?2 AND seq<=?3 AND kind IN {SPOKEN_KINDS} ORDER BY seq");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![job.book, job.first, job.last], |r| {
        Ok(SpeechBlock { seq: r.get(0)?, kind: r.get(1)?, text: r.get(2)?, speech: r.get(3)? })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn next_track(db: &Db) -> Result<Option<Job>> {
    let conn = db.conn();
    let current: Option<(String, String, u32)> = conn
        .query_row(
            "SELECT book_id,voice,cursor FROM audiobooks WHERE status='generating' ORDER BY updated_at DESC LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let Some((book, voice, cursor)) = current else { return Ok(None) };
    // Start at the cursor, which is where the reader asked to listen, then wrap around.
    let row: Option<(u32, u32, u32, u32)> = conn
        .query_row(
            "SELECT seq,first_block,last_block,chars FROM audio_tracks WHERE book_id=?1 AND ready=0
             ORDER BY (seq < ?2), seq LIMIT 1",
            params![book, cursor],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    match row {
        Some((seq, first, last, chars)) => Ok(Some(Job { book, voice, seq, first, last, chars })),
        None => {
            conn.execute("UPDATE audiobooks SET status='done', updated_at=?2 WHERE book_id=?1", params![book, now()])?;
            drop(conn);
            next_track(db)
        }
    }
}

fn emit_progress(db: &Db, events: &Events, book: &str, seq: Option<u32>, cps: f64) {
    let conn = db.conn();
    let row: rusqlite::Result<(u32, u32, i64)> = conn.query_row(
        "SELECT COUNT(*), COALESCE(SUM(ready),0), COALESCE(SUM(CASE WHEN ready=0 THEN chars ELSE 0 END),0) FROM audio_tracks WHERE book_id=?1",
        [book],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    );
    if let Ok((total, ready, remaining)) = row {
        let eta = (cps > 0.0).then(|| (remaining as f64 / cps) as u64);
        let _ = events.send(json!({"type": "audio", "book_id": book, "status": "generating", "ready": ready, "total": total, "seq": seq, "eta": eta}));
    }
}

fn finish_if_done(db: &Db, events: &Events, book: &str) {
    let conn = db.conn();
    let pending: u32 = conn
        .query_row("SELECT COUNT(*) FROM audio_tracks WHERE book_id=?1 AND ready=0", [book], |r| r.get(0))
        .unwrap_or(1);
    if pending == 0 {
        let _ = conn.execute("UPDATE audiobooks SET status='done', updated_at=?2 WHERE book_id=?1", params![book, now()]);
        let _ = events.send(json!({"type": "audio", "book_id": book, "status": "done"}));
    }
}

/// Divides the spoken part of a book into tracks. Tracks never cross a chapter boundary,
/// and front matter such as the copyright page is left out.
pub fn plan(db: &Db, book: &str) -> Result<u32> {
    let mut conn = db.conn();
    let chapters = retrieval::chapters(&conn, book)?;
    let sql = format!("SELECT seq,length(text) FROM blocks WHERE book_id=?1 AND seq>=?2 AND seq<?3 AND kind IN {SPOKEN_KINDS} ORDER BY seq");
    let mut tracks: Vec<(u32, u32, u32, u32)> = Vec::new();
    for chapter in chapters.iter().filter(|c| !c.front) {
        let mut stmt = conn.prepare_cached(&sql)?;
        let rows: Vec<(u32, u32)> = stmt
            .query_map(params![book, chapter.start, chapter.end], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<_, _>>()?;
        let mut current: Option<(u32, u32, u32)> = None;
        for (seq, length) in rows {
            let entry = current.get_or_insert((seq, seq, 0));
            entry.1 = seq;
            entry.2 += length;
            if entry.2 as usize >= TRACK_CHARS {
                let (first, last, chars) = current.take().unwrap();
                tracks.push((chapter.idx, first, last, chars));
            }
        }
        if let Some((first, last, chars)) = current {
            tracks.push((chapter.idx, first, last, chars));
        }
    }
    if tracks.is_empty() {
        bail!("This book has no text to narrate.");
    }
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM audio_tracks WHERE book_id=?1", [book])?;
    {
        let mut insert = tx.prepare("INSERT INTO audio_tracks(book_id,seq,chapter,first_block,last_block,chars) VALUES(?1,?2,?3,?4,?5,?6)")?;
        for (seq, (chapter, first, last, chars)) in tracks.iter().enumerate() {
            insert.execute(params![book, seq as u32, chapter, first, last, chars])?;
        }
    }
    tx.commit()?;
    Ok(tracks.len() as u32)
}

pub fn track_for_block(db: &Db, book: &str, block: u32) -> Option<u32> {
    let conn = db.conn();
    conn.query_row(
        "SELECT seq FROM audio_tracks WHERE book_id=?1 AND last_block>=?2 ORDER BY seq LIMIT 1",
        params![book, block],
        |r| r.get(0),
    )
    .optional()
    .ok()
    .flatten()
}

/// Joins the tracks into one chaptered .m4b. AAC is used because that's what audiobook
/// players expect; the Opus tracks remain the in-app format.
pub fn export_m4b(db: &Db, paths: &Paths, book: &str) -> Result<PathBuf> {
    let (title, author, tracks, chapters) = {
        let conn = db.conn();
        let (title, author): (String, String) =
            conn.query_row("SELECT title,author FROM books WHERE id=?1", [book], |r| Ok((r.get(0)?, r.get(1)?)))?;
        let mut stmt = conn.prepare("SELECT seq,chapter,duration_ms,ready FROM audio_tracks WHERE book_id=?1 ORDER BY seq")?;
        let tracks: Vec<(u32, u32, i64, bool)> =
            stmt.query_map([book], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?.collect::<Result<_, _>>()?;
        drop(stmt);
        (title, author, tracks, retrieval::chapters(&conn, book)?)
    };
    if tracks.is_empty() || tracks.iter().any(|t| !t.3) {
        bail!("Finish generating the audiobook before exporting it.");
    }
    let dir = paths.audio_dir(book);
    let list = dir.join("concat.txt");
    let mut concat = String::new();
    for track in &tracks {
        concat.push_str(&format!("file '{}.opus'\n", track.0));
    }
    fs::write(&list, concat)?;
    let escape = |s: &str| s.replace('\\', "\\\\").replace('=', "\\=").replace(';', "\\;").replace('#', "\\#").replace('\n', " ");
    let mut meta = format!(";FFMETADATA1\ntitle={}\nartist={}\nalbum={}\ngenre=Audiobook\n", escape(&title), escape(&author), escape(&title));
    let (mut position, mut index) = (0i64, 0);
    while index < tracks.len() {
        let chapter = tracks[index].1;
        let start = position;
        while index < tracks.len() && tracks[index].1 == chapter {
            position += tracks[index].2;
            index += 1;
        }
        let name = chapters.iter().find(|c| c.idx == chapter).map(|c| c.title.as_str()).unwrap_or("Chapter");
        meta.push_str(&format!("[CHAPTER]\nTIMEBASE=1/1000\nSTART={start}\nEND={position}\ntitle={}\n", escape(name)));
    }
    let meta_path = dir.join("chapters.txt");
    fs::write(&meta_path, meta)?;
    let out = dir.join("audiobook.m4b");
    let temp = dir.join("audiobook.part.m4b");
    let status = Command::new("ffmpeg")
        .args(["-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i"])
        .arg(&list)
        .arg("-i")
        .arg(&meta_path)
        .args(["-map_metadata", "1", "-map", "0:a", "-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart"])
        .arg(&temp)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()?;
    let _ = fs::remove_file(&list);
    let _ = fs::remove_file(&meta_path);
    if !status.success() {
        let _ = fs::remove_file(&temp);
        bail!("ffmpeg could not build the audiobook file.");
    }
    fs::rename(temp, &out)?;
    Ok(out)
}
