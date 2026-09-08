use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpEvent {
    pub kind: String,
    pub session_id: Option<String>,
    pub method: Option<String>,
    pub id: Option<u64>,
    pub payload: Value,
}

struct Pending {
    tx: oneshot::Sender<Result<Value, String>>,
}

struct AcpInner {
    stdin: Mutex<ChildStdin>,
    pending: Mutex<HashMap<u64, Pending>>,
    next_id: AtomicU64,
    shutting_down: AtomicBool,
    app: AppHandle,
}

pub struct AcpClient {
    inner: Arc<AcpInner>,
    child: Arc<Mutex<Child>>,
    init: Mutex<Option<Value>>,
}

impl AcpClient {
    pub async fn spawn(app: AppHandle, grok: PathBuf) -> Result<Self, String> {
        let mut cmd = Command::new(&grok);
        cmd.arg("agent")
            .arg("--no-leader")
            .arg("stdio")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .env("GROK_DISABLE_AUTOUPDATER", "1");

        if let Ok(path) = std::env::var("PATH") {
            let prefix = grok
                .parent()
                .map(|p| p.display().to_string())
                .unwrap_or_default();
            if !prefix.is_empty() && !path.split(':').any(|p| p == prefix) {
                cmd.env("PATH", format!("{prefix}:{path}"));
            }
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("failed to start grok agent: {e}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "grok agent stdin not piped".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "grok agent stdout not piped".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "grok agent stderr not piped".to_string())?;

        let inner = Arc::new(AcpInner {
            stdin: Mutex::new(stdin),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            shutting_down: AtomicBool::new(false),
            app: app.clone(),
        });

        let reader_inner = inner.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            loop {
                match lines.next_line().await {
                    Ok(Some(line)) => {
                        if line.trim().is_empty() {
                            continue;
                        }
                        handle_line(&reader_inner, &line).await;
                    }
                    Ok(None) => break,
                    Err(_) => break,
                }
            }
            if reader_inner.shutting_down.load(Ordering::SeqCst) {
                return;
            }
            let _ = reader_inner.app.emit(
                "acp-event",
                AcpEvent {
                    kind: "exit".into(),
                    session_id: None,
                    method: None,
                    id: None,
                    payload: json!({ "reason": "stdout closed" }),
                },
            );
        });

        let log_app = app.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = log_app.emit(
                    "acp-event",
                    AcpEvent {
                        kind: "log".into(),
                        session_id: None,
                        method: None,
                        id: None,
                        payload: json!({ "stream": "stderr", "line": line }),
                    },
                );
            }
        });

        Ok(Self {
            inner,
            child: Arc::new(Mutex::new(child)),
            init: Mutex::new(None),
        })
    }

    pub async fn is_alive(&self) -> bool {
        if self.inner.shutting_down.load(Ordering::SeqCst) {
            return false;
        }
        let mut child = self.child.lock().await;
        match child.try_wait() {
            Ok(None) => true,
            _ => false,
        }
    }

    pub async fn cached_init(&self) -> Option<Value> {
        self.init.lock().await.clone()
    }

    pub async fn set_init(&self, value: Value) {
        *self.init.lock().await = Some(value);
    }

    pub async fn initialize(&self) -> Result<Value, String> {
        self.request(
            "initialize",
            json!({
                "protocolVersion": 1,
                "clientCapabilities": {},
                "clientInfo": {
                    "name": "grokzilla",
                    "title": "Grokzilla",
                    "version": "0.1.0"
                }
            }),
        )
        .await
    }

    pub async fn authenticate(&self, method_id: &str) -> Result<Value, String> {
        self.request("authenticate", json!({ "methodId": method_id }))
            .await
    }

    pub async fn session_new(&self, cwd: &str) -> Result<Value, String> {
        self.request(
            "session/new",
            json!({
                "cwd": cwd,
                "mcpServers": []
            }),
        )
        .await
    }

    pub async fn session_load(&self, session_id: &str, cwd: &str) -> Result<Value, String> {
        self.request(
            "session/load",
            json!({
                "sessionId": session_id,
                "cwd": cwd,
                "mcpServers": []
            }),
        )
        .await
    }

    #[allow(dead_code)]
    pub async fn session_list(&self) -> Result<Value, String> {
        self.request("session/list", json!({})).await
    }

    #[allow(dead_code)]
    pub async fn prompt(&self, session_id: &str, text: &str) -> Result<Value, String> {
        self.prompt_blocks(
            session_id,
            json!([{ "type": "text", "text": text }]),
        )
        .await
    }

    pub async fn billing(&self) -> Result<Value, String> {
        self.request("x.ai/billing", json!({})).await
    }

    pub async fn prompt_blocks(&self, session_id: &str, prompt: Value) -> Result<Value, String> {
        self.request(
            "session/prompt",
            json!({
                "sessionId": session_id,
                "prompt": prompt
            }),
        )
        .await
    }

    pub async fn cancel(&self, session_id: &str) -> Result<(), String> {
        self.notify("session/cancel", json!({ "sessionId": session_id }))
            .await
    }

    pub async fn set_mode(&self, session_id: &str, mode_id: &str) -> Result<Value, String> {
        self.request(
            "session/set_mode",
            json!({
                "sessionId": session_id,
                "modeId": mode_id
            }),
        )
        .await
    }

    pub async fn set_model(&self, session_id: &str, model_id: &str) -> Result<Value, String> {
        self.request(
            "session/set_model",
            json!({
                "sessionId": session_id,
                "modelId": model_id
            }),
        )
        .await
    }

    pub async fn set_config_option(
        &self,
        session_id: &str,
        config_id: &str,
        value: &str,
    ) -> Result<Value, String> {
        self.request(
            "session/set_config_option",
            json!({
                "sessionId": session_id,
                "configId": config_id,
                "value": value
            }),
        )
        .await
    }

    pub async fn respond_permission(
        &self,
        id: u64,
        option_id: Option<String>,
        cancelled: bool,
    ) -> Result<(), String> {
        let result = if cancelled {
            json!({ "outcome": { "outcome": "cancelled" } })
        } else {
            json!({
                "outcome": {
                    "outcome": "selected",
                    "optionId": option_id.unwrap_or_else(|| "allow-once".into())
                }
            })
        };
        self.write(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": result
        }))
        .await
    }

    pub async fn shutdown(&self) {
        self.inner.shutting_down.store(true, Ordering::SeqCst);
        let mut child = self.child.lock().await;
        let _ = child.kill().await;
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.inner.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.inner.pending.lock().await;
            pending.insert(id, Pending { tx });
        }
        self.write(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        }))
        .await?;
        rx.await
            .map_err(|_| format!("agent dropped response for {method}"))?
    }

    async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        self.write(&json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params
        }))
        .await
    }

    async fn write(&self, value: &Value) -> Result<(), String> {
        let mut line = serde_json::to_vec(value).map_err(|e| e.to_string())?;
        line.push(b'\n');
        let mut stdin = self.inner.stdin.lock().await;
        stdin
            .write_all(&line)
            .await
            .map_err(|e| format!("failed to write to grok agent: {e}"))?;
        stdin
            .flush()
            .await
            .map_err(|e| format!("failed to flush grok agent: {e}"))?;
        Ok(())
    }
}

async fn handle_line(inner: &Arc<AcpInner>, line: &str) {
    let value: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(err) => {
            let _ = inner.app.emit(
                "acp-event",
                AcpEvent {
                    kind: "error".into(),
                    session_id: None,
                    method: None,
                    id: None,
                    payload: json!({ "message": format!("invalid json from agent: {err}"), "line": line }),
                },
            );
            return;
        }
    };

    let id = value.get("id").and_then(|v| {
        v.as_u64()
            .or_else(|| v.as_i64().map(|n| n as u64))
            .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
    });

    if value.get("result").is_some() || value.get("error").is_some() {
        if let Some(id) = id {
            let mut pending = inner.pending.lock().await;
            if let Some(pending) = pending.remove(&id) {
                let result = if let Some(error) = value.get("error") {
                    let message = error
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("agent error")
                        .to_string();
                    Err(message)
                } else {
                    Ok(value.get("result").cloned().unwrap_or(Value::Null))
                };
                let _ = pending.tx.send(result);
                return;
            }
        }
    }

    if let Some(method) = value.get("method").and_then(Value::as_str) {
        let params = value.get("params").cloned().unwrap_or(Value::Null);
        let session_id = params
            .get("sessionId")
            .and_then(Value::as_str)
            .map(|s| s.to_string());

        if let Some(id) = id {
            if method == "session/request_permission" {
                let _ = inner.app.emit(
                    "acp-event",
                    AcpEvent {
                        kind: "permission".into(),
                        session_id,
                        method: Some(method.to_string()),
                        id: Some(id),
                        payload: params,
                    },
                );
                return;
            }

            // Unknown incoming request: cancel rather than hang the agent.
            let mut line = serde_json::to_vec(&json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32601, "message": format!("Method not implemented: {method}") }
            }))
            .unwrap_or_default();
            line.push(b'\n');
            let mut stdin = inner.stdin.lock().await;
            let _ = stdin.write_all(&line).await;
            let _ = stdin.flush().await;
            return;
        }

        let kind = if method == "session/update" {
            "update"
        } else {
            "notification"
        };
        let payload = if method == "session/update" {
            params.get("update").cloned().unwrap_or(params.clone())
        } else {
            params
        };
        let _ = inner.app.emit(
            "acp-event",
            AcpEvent {
                kind: kind.into(),
                session_id,
                method: Some(method.to_string()),
                id: None,
                payload,
            },
        );
    }
}
