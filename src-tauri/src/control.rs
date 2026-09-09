use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixListener;
use tokio::sync::{oneshot, Mutex};

const TOKEN_LEN: usize = 16;
const REPLY_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlRequest {
    pub request_id: u64,
    pub method: String,
    pub params: Value,
}

pub struct ControlHub {
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    next_id: AtomicU64,
}

impl ControlHub {
    pub fn new() -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
        }
    }
}

#[derive(Deserialize)]
struct WireIn {
    token: Option<String>,
    id: Option<u64>,
    method: Option<String>,
    params: Option<Value>,
}

pub fn data_dir() -> PathBuf {
    crate::grok::home_dir().join("Library/Application Support/ai.grokzilla.app")
}

pub fn socket_path() -> PathBuf {
    data_dir().join("control.sock")
}

pub fn token_path() -> PathBuf {
    data_dir().join("control.token")
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0xf) as usize] as char);
    }
    out
}

fn random_token() -> Result<String, String> {
    let mut buf = [0u8; TOKEN_LEN];
    fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut buf))
        .map_err(|e| format!("failed to read /dev/urandom: {e}"))?;
    Ok(hex_encode(&buf))
}

pub fn ensure_token() -> Result<String, String> {
    let dir = data_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = token_path();
    if let Ok(existing) = fs::read_to_string(&path) {
        let trimmed = existing.trim();
        if trimmed.len() >= 16 {
            return Ok(trimmed.to_string());
        }
    }
    let token = random_token()?;
    fs::write(&path, format!("{token}\n")).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(token)
}

pub fn start(app: AppHandle, hub: Arc<ControlHub>) {
    tauri::async_runtime::spawn(async move {
        if let Err(err) = serve(app, hub).await {
            eprintln!("grokzilla control socket: {err}");
        }
    });
}

async fn serve(app: AppHandle, hub: Arc<ControlHub>) -> Result<(), String> {
    let token = ensure_token()?;
    let sock = socket_path();
    if let Some(parent) = sock.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let _ = fs::remove_file(&sock);
    let listener = UnixListener::bind(&sock).map_err(|e| format!("bind {}: {e}", sock.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&sock, fs::Permissions::from_mode(0o600));
    }
    loop {
        let (stream, _) = match listener.accept().await {
            Ok(pair) => pair,
            Err(_) => continue,
        };
        let app = app.clone();
        let hub = hub.clone();
        let token = token.clone();
        tauri::async_runtime::spawn(async move {
            handle_client(stream, app, hub, token).await;
        });
    }
}

async fn handle_client(
    stream: tokio::net::UnixStream,
    app: AppHandle,
    hub: Arc<ControlHub>,
    token: String,
) {
    let (reader, mut writer) = stream.into_split();
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let reply = match dispatch_line(line, &app, &hub, &token).await {
            Ok(value) => value,
            Err(err) => json!({ "ok": false, "error": err }),
        };
        let mut payload = reply.to_string();
        payload.push('\n');
        if writer.write_all(payload.as_bytes()).await.is_err() {
            break;
        }
    }
}

async fn dispatch_line(
    line: &str,
    app: &AppHandle,
    hub: &Arc<ControlHub>,
    expected_token: &str,
) -> Result<Value, String> {
    let wire: WireIn = serde_json::from_str(line).map_err(|e| format!("invalid json: {e}"))?;
    let id = wire.id.unwrap_or(0);
    if wire.token.as_deref() != Some(expected_token) {
        return Ok(json!({ "ok": false, "id": id, "error": "unauthorized" }));
    }
    let method = wire.method.unwrap_or_default();
    if method.is_empty() {
        return Ok(json!({ "ok": false, "id": id, "error": "missing method" }));
    }
    let params = wire.params.unwrap_or(Value::Null);
    let result = call_frontend(app, hub, method, params).await?;
    Ok(json!({ "ok": true, "id": id, "result": result }))
}

async fn call_frontend(
    app: &AppHandle,
    hub: &Arc<ControlHub>,
    method: String,
    params: Value,
) -> Result<Value, String> {
    let request_id = hub.next_id.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = oneshot::channel();
    hub.pending.lock().await.insert(request_id, tx);
    let event = ControlRequest {
        request_id,
        method,
        params,
    };
    app.emit_to("main", "control-command", event)
        .map_err(|e| e.to_string())?;
    match tokio::time::timeout(REPLY_TIMEOUT, rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("control reply dropped".into()),
        Err(_) => {
            hub.pending.lock().await.remove(&request_id);
            Err("control reply timed out (is Grokzilla's window ready?)".into())
        }
    }
}

#[tauri::command]
pub async fn control_reply(
    hub: tauri::State<'_, Arc<ControlHub>>,
    request_id: u64,
    ok: bool,
    result: Option<Value>,
    error: Option<String>,
) -> Result<(), String> {
    let tx = hub.pending.lock().await.remove(&request_id);
    let Some(tx) = tx else {
        return Ok(());
    };
    let body = if ok {
        Ok(result.unwrap_or(Value::Null))
    } else {
        Err(error.unwrap_or_else(|| "failed".into()))
    };
    let _ = tx.send(body);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{hex_encode, WireIn};

    #[test]
    fn hex_encodes_bytes() {
        assert_eq!(hex_encode(&[0x0f, 0xa0]), "0fa0");
    }

    #[test]
    fn parses_wire_request() {
        let wire: WireIn = serde_json::from_str(
            r#"{"token":"abc","id":3,"method":"status","params":{"cwd":"/tmp"}}"#,
        )
        .unwrap();
        assert_eq!(wire.token.as_deref(), Some("abc"));
        assert_eq!(wire.id, Some(3));
        assert_eq!(wire.method.as_deref(), Some("status"));
    }
}
