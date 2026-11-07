use super::{find_binary, AiEvent, ModelOption, ProviderStatus, Turn};
use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::mpsc;

struct Client {
    _child: Child,
    stdin: ChildStdin,
    stdout: Lines<BufReader<ChildStdout>>,
    next_id: u64,
}

impl Client {
    async fn start(cwd: &Path) -> Result<Self> {
        let binary = find_binary("codex").context("Codex isn't installed.")?;
        let mut child = Command::new(binary)
            .arg("app-server")
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .context("could not start Codex")?;
        let stdin = child.stdin.take().context("no stdin")?;
        let stdout = BufReader::new(child.stdout.take().context("no stdout")?).lines();
        let mut client = Client { _child: child, stdin, stdout, next_id: 0 };
        client
            .request(
                "initialize",
                json!({
                    "clientInfo": {"name": "omareader", "title": "OmaReader", "version": env!("CARGO_PKG_VERSION")},
                    "capabilities": {"experimentalApi": true},
                }),
            )
            .await?;
        client.write(&json!({"method": "initialized"})).await?;
        Ok(client)
    }

    async fn write(&mut self, message: &Value) -> Result<()> {
        let mut line = message.to_string();
        line.push('\n');
        self.stdin.write_all(line.as_bytes()).await?;
        Ok(())
    }

    /// Sends a request and skips notifications until its response arrives.
    async fn request(&mut self, method: &str, params: Value) -> Result<Value> {
        self.next_id += 1;
        let id = self.next_id;
        self.write(&json!({"id": id, "method": method, "params": params})).await?;
        loop {
            let line = self.stdout.next_line().await?.context("Codex closed unexpectedly")?;
            let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
            if message.get("method").is_none() && message["id"].as_u64() == Some(id) {
                if let Some(error) = message.get("error") {
                    bail!("{}", error["message"].as_str().unwrap_or("Codex reported an error."));
                }
                return Ok(message["result"].clone());
            }
        }
    }
}

/// Turns off everything except talking. With this set the model has no shell, patch,
/// web, browser or sub-agent tools, and the sandbox stays read-only with no network.
fn locked_config() -> Value {
    let off: HashMap<&str, bool> = [
        "apps", "browser_use", "code_mode_host", "computer_use", "goals", "image_generation", "in_app_browser",
        "multi_agent", "multi_agent_v2", "plugins", "remote_plugin", "shell_snapshot", "shell_tool", "unified_exec",
    ]
    .into_iter()
    .map(|name| (name, false))
    .collect();
    json!({
        "features": off,
        "web_search": "disabled",
        "shell_environment_policy": {"inherit": "none"},
    })
}

pub async fn run(cwd: &Path, turn: Turn, tx: &mpsc::Sender<AiEvent>) -> Result<()> {
    let mut client = Client::start(cwd).await?;
    let mut params = json!({
        "cwd": cwd,
        "ephemeral": true,
        "sandbox": "read-only",
        "approvalPolicy": "never",
        "baseInstructions": turn.system,
        "config": locked_config(),
        "serviceName": "omareader",
    });
    if let Some(model) = turn.model.as_deref().filter(|m| !m.is_empty()) {
        params["model"] = json!(model);
    }
    let thread = client.request("thread/start", params).await?;
    let thread_id = thread["thread"]["id"].as_str().context("Codex returned no thread")?.to_string();
    client
        .request(
            "turn/start",
            json!({"threadId": thread_id, "effort": "low", "input": [{"type": "text", "text": turn.prompt}]}),
        )
        .await?;

    let mut saw_text = false;
    while let Some(line) = client.stdout.next_line().await? {
        let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
        match message["method"].as_str() {
            Some("item/agentMessage/delta") => {
                if let Some(delta) = message["params"]["delta"].as_str() {
                    saw_text = true;
                    if tx.send(AiEvent::Delta(delta.to_string())).await.is_err() {
                        return Ok(());
                    }
                }
            }
            Some("item/started") => {
                // A last line of defence: tools are disabled, so any tool item means
                // something unexpected, possibly text in the book steering the model.
                let kind = message["params"]["item"]["type"].as_str().unwrap_or("");
                if !matches!(kind, "userMessage" | "agentMessage" | "reasoning" | "plan" | "contextCompaction" | "hookPrompt") {
                    bail!("Stopped: Codex tried to use a tool ({kind}), which OmaReader doesn't allow.");
                }
            }
            Some("turn/completed") => {
                let turn = &message["params"]["turn"];
                if turn["status"] == "failed" {
                    let detail = turn["error"]["message"].as_str().unwrap_or("Codex could not finish the answer.");
                    bail!("{}", friendly(detail));
                }
                if !saw_text {
                    bail!("Codex returned an empty answer.");
                }
                return Ok(());
            }
            Some("error") => {
                if message["params"]["willRetry"].as_bool() != Some(true) {
                    let detail = message["params"]["error"]["message"].as_str().unwrap_or("Codex reported an error.");
                    bail!("{}", friendly(detail));
                }
            }
            _ => {
                // Server-initiated requests carry an id; refuse anything that asks for approval.
                if let (Some(id), Some(_)) = (message.get("id"), message.get("method")) {
                    client.write(&json!({"id": id, "result": {"decision": "decline"}})).await?;
                }
            }
        }
    }
    Err(anyhow!("Codex closed before finishing the answer."))
}

fn friendly(message: &str) -> String {
    let lower = message.to_lowercase();
    if lower.contains("login") || lower.contains("not authenticated") || lower.contains("unauthorized") {
        return "Codex isn't signed in. Run `codex login` in a terminal, then try again.".into();
    }
    message.to_string()
}

async fn probe(cwd: &Path) -> Result<(bool, Option<String>, Vec<ModelOption>)> {
    let mut client = Client::start(cwd).await?;
    let account = client.request("account/read", json!({})).await?;
    let signed_in = account["account"].is_object();
    let plan = account["account"]["planType"].as_str().map(str::to_string);
    let list = client.request("model/list", json!({})).await?;
    let mut models = vec![ModelOption { id: String::new(), label: "Default".into() }];
    if let Some(data) = list["data"].as_array() {
        for item in data {
            let id = item["id"].as_str().or(item["model"].as_str()).unwrap_or("").to_string();
            let label = item["displayName"].as_str().unwrap_or(&id).to_string();
            if !id.is_empty() {
                models.push(ModelOption { id, label });
            }
        }
    }
    Ok((signed_in, plan, models))
}

pub async fn status(cwd: &Path) -> ProviderStatus {
    let mut out = ProviderStatus {
        id: "codex",
        name: "Codex",
        installed: false,
        signed_in: false,
        plan: None,
        models: vec![ModelOption { id: String::new(), label: "Default".into() }],
        default_model: None,
        help: "Install the Codex CLI, then run `codex login`.".into(),
    };
    if find_binary("codex").is_none() {
        return out;
    }
    out.installed = true;
    match tokio::time::timeout(Duration::from_secs(12), probe(cwd)).await {
        Ok(Ok((signed_in, plan, models))) => {
            out.signed_in = signed_in;
            out.plan = plan;
            out.models = models;
            out.help = if signed_in { String::new() } else { "Run `codex login` in a terminal.".into() };
        }
        _ => out.help = "Codex didn't respond. Try running `codex` in a terminal.".into(),
    }
    out
}
