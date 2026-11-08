use anyhow::{bail, Context, Result};
use omareader::config::{self, Paths};
use omareader::db::Db;
use omareader::server::{self, Inner};
#[cfg(feature = "narration")]
use omareader::tts::Tts;
use omareader::{ai, ingest};
use std::net::SocketAddr;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;

const DEFAULT_PORT: u16 = 47_821;
const BROWSERS: &[&str] = &["chromium", "chromium-browser", "google-chrome-stable", "google-chrome", "brave", "brave-browser", "microsoft-edge-stable"];

fn usage() -> &'static str {
    "Kōyō, a quiet reader\n\n  omareader                open the reader\n  omareader serve [port]   run the server and print its address\n  omareader import FILE…   add files to the library\n  omareader backup DIR     snapshot into a new directory (close the app first)\n  omareader restore BACKUP NEW_LIBRARY   restore without overwriting anything\n"
}

async fn start_server(listener: TcpListener, paths: Paths, db: Db) -> Result<(String, tokio::task::JoinHandle<()>)> {
    let port = listener.local_addr()?.port();
    let token = config::session_token(&paths)?;
    let events = server::new_events();
    #[cfg(feature = "narration")]
    let tts = Tts::start(db.clone(), paths.clone(), events.clone());
    let state = Arc::new(Inner {
        db,
        paths,
        token: token.clone(),
        port,
        events,
        #[cfg(feature = "narration")]
        tts,
        provider_cache: Mutex::new(None),
    });
    let app = server::router(state);
    let task = tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, app).await {
            tracing::error!("server stopped: {error}");
        }
    });
    Ok((format!("http://127.0.0.1:{port}/auth?t={token}"), task))
}

/// The window is one local page, so browser services it will never use are switched off.
/// Measured on a library page: about 30 MB less PSS and three fewer processes.
const LEAN_FLAGS: &[&str] = &[
    "--disable-extensions",
    "--disable-component-update",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-default-apps",
    "--disable-breakpad",
    "--no-pings",
    "--renderer-process-limit=1",
    "--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication,CertificateTransparencyComponentUpdater",
];

/// A dedicated profile keeps the app window independent of the person's browser, so
/// closing it ends Kōyō and nothing mixes with their tabs or history.
fn open_window(url: &str, paths: &Paths) -> Result<Option<std::process::Child>> {
    let Some(browser) = BROWSERS.iter().find_map(|name| ai::find_binary(name)) else {
        Command::new("xdg-open").arg(url).stdout(Stdio::null()).stderr(Stdio::null()).spawn().context("no browser found")?;
        return Ok(None);
    };
    let child = Command::new(browser)
        .arg(format!("--app={url}"))
        .arg(format!("--user-data-dir={}", paths.data.join("window").display()))
        .args(["--class=Koyo", "--no-first-run", "--no-default-browser-check", "--window-size=1500,950"])
        .arg("--ozone-platform-hint=auto")
        .args(LEAN_FLAGS)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .context("could not open the reader window")?;
    Ok(Some(child))
}

async fn already_running(port: u16, paths: &Paths) -> bool {
    let Ok(token) = config::session_token(paths) else { return false };
    let url = format!("http://127.0.0.1:{port}/api/books");
    match reqwest::Client::new().get(url).header("Cookie", format!("oma_session={token}")).timeout(std::time::Duration::from_secs(2)).send().await {
        Ok(response) => response.status().is_success(),
        Err(_) => false,
    }
}

async fn run_desktop(paths: Paths, db: Db) -> Result<()> {
    let bound = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], DEFAULT_PORT))).await;
    let listener = match bound {
        Ok(listener) => listener,
        Err(_) if already_running(DEFAULT_PORT, &paths).await => {
            let token = config::session_token(&paths)?;
            open_window(&format!("http://127.0.0.1:{DEFAULT_PORT}/auth?t={token}"), &paths)?;
            return Ok(());
        }
        Err(_) => TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).await?,
    };
    let (url, task) = start_server(listener, paths.clone(), db).await?;
    match open_window(&url, &paths)? {
        Some(mut child) => {
            let waited = tokio::task::spawn_blocking(move || child.wait()).await?;
            waited.context("the reader window failed")?;
        }
        None => {
            task.await?;
        }
    }
    Ok(())
}

async fn run_server(paths: Paths, db: Db, port: u16) -> Result<()> {
    let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], port))).await.with_context(|| format!("could not listen on 127.0.0.1:{port}"))?;
    let (url, task) = start_server(listener, paths, db).await?;
    println!("{url}");
    task.await?;
    Ok(())
}

fn run_import(paths: &Paths, db: &Db, files: &[String]) -> Result<()> {
    if files.is_empty() {
        bail!("{}", usage());
    }
    let mut failures = 0;
    for file in files {
        match ingest::import_path(db, paths, Path::new(file)) {
            Ok(id) => println!("imported {file} as {id}"),
            Err(error) => {
                failures += 1;
                eprintln!("{file}: {error:#}");
            }
        }
    }
    if failures > 0 {
        bail!("{failures} file(s) could not be imported");
    }
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "omareader=info".into()))
        .with_writer(std::io::stderr)
        .init();
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().is_some_and(|s| s == "restore") {
        if args.len() != 3 { bail!("{}", usage()); }
        omareader::backup::restore(Path::new(&args[1]), Path::new(&args[2]))?;
        println!("Restored to {}. Set OMAREADER_DATA_DIR to this directory to open it. Voice models can be downloaded again.", args[2]);
        return Ok(());
    }
    let paths = Paths::resolve()?;
    let _library_lock = omareader::backup::lock(&paths, args.first().is_some_and(|s| s == "backup"))?;
    let db = Db::open(&paths.db)?;
    match args.first().map(String::as_str) {
        None => run_desktop(paths, db).await,
        Some("serve") => {
            let port = args.get(1).map(|p| p.parse()).transpose().context("the port must be a number")?.unwrap_or(DEFAULT_PORT);
            run_server(paths, db, port).await
        }
        Some("backup") => {
            if args.len() != 2 { bail!("{}", usage()); }
            omareader::backup::create(&paths, &db, Path::new(&args[1]))?;
            println!("Backed up books, notes, conversations, positions and audio to {}. Voice models and browser/session data are excluded.", args[1]);
            Ok(())
        }
        Some("import") => run_import(&paths, &db, &args[1..]),
        Some(_) => {
            print!("{}", usage());
            Ok(())
        }
    }
}
