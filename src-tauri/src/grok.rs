use serde::Serialize;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command as StdCommand, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::process::Command;

pub fn grok_home() -> PathBuf {
    if let Ok(home) = std::env::var("GROK_HOME") {
        if !home.is_empty() {
            return PathBuf::from(home);
        }
    }
    home_dir().join(".grok")
}

pub fn home_dir() -> PathBuf {
    std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/"))
}

pub fn find_grok() -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("GROK_BIN") {
        let path = PathBuf::from(explicit);
        if path.is_file() {
            return Some(path);
        }
    }

    let home_bin = grok_home().join("bin").join("grok");
    if home_bin.is_file() {
        return Some(home_bin);
    }

    if let Ok(path) = std::env::var("PATH") {
        for dir in path.split(':') {
            let candidate = Path::new(dir).join("grok");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    None
}

pub fn auth_path() -> PathBuf {
    grok_home().join("auth.json")
}

pub fn is_logged_in() -> bool {
    let path = auth_path();
    path.is_file() && std::fs::metadata(&path).map(|m| m.len() > 2).unwrap_or(false)
}

pub fn grok_version(bin: &Path) -> Option<String> {
    let output = std::process::Command::new(bin)
        .arg("--version")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    Some(text.lines().next().unwrap_or(text.trim()).trim().to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrokStatus {
    pub grok_path: Option<String>,
    pub version: Option<String>,
    pub logged_in: bool,
    pub grok_home: String,
    pub auth_path: String,
}

pub fn status() -> GrokStatus {
    let grok_path = find_grok();
    let version = grok_path.as_ref().and_then(|p| grok_version(p));
    GrokStatus {
        grok_path: grok_path.map(|p| p.display().to_string()),
        version,
        logged_in: is_logged_in(),
        grok_home: grok_home().display().to_string(),
        auth_path: auth_path().display().to_string(),
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedDrop {
    pub path: String,
    pub rel: String,
}

pub fn fetch_billing_http() -> Result<Value, String> {
    let (token, user_id) = cli_token()?;
    let mut cmd = StdCommand::new("curl");
    cmd.args([
        "-sS",
        "--max-time",
        "15",
        "-H",
        &format!("Authorization: Bearer {token}"),
        "-H",
        "X-XAI-Token-Auth: xai-grok-cli",
        "-H",
        "Accept: application/json",
    ]);
    if let Some(uid) = user_id {
        cmd.args(["-H", &format!("x-userid: {uid}")]);
    }
    cmd.arg("https://cli-chat-proxy.grok.com/v1/billing?format=credits");
    let output = cmd
        .output()
        .map_err(|e| format!("failed to fetch billing: {e}"))?;
    if !output.status.success() {
        return Err("billing request failed".into());
    }
    serde_json::from_slice(&output.stdout).map_err(|e| format!("invalid billing json: {e}"))
}

fn cli_token() -> Result<(String, Option<String>), String> {
    let text = fs::read_to_string(auth_path()).map_err(|_| "not logged in".to_string())?;
    let value: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let obj = value.as_object().ok_or_else(|| "not logged in".to_string())?;
    for entry in obj.values() {
        let key = entry.get("key").and_then(Value::as_str).unwrap_or("");
        if key.is_empty() {
            continue;
        }
        let user_id = entry
            .get("user_id")
            .and_then(Value::as_str)
            .map(|s| s.to_string());
        return Ok((key.to_string(), user_id));
    }
    Err("not logged in".into())
}

pub fn save_drop(name: &str, data_base64: &str) -> Result<SavedDrop, String> {
    let bytes = b64_decode(data_base64)?;
    let dir = grok_home().join("tmp").join("drops");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let safe = sanitize_name(name);
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = dir.join(format!("{stamp}-{safe}"));
    fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(SavedDrop {
        path: path.display().to_string(),
        rel: name.trim().is_empty().then_some(safe).unwrap_or_else(|| name.to_string()),
    })
}

fn sanitize_name(name: &str) -> String {
    let base = Path::new(name)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "drop.bin".into());
    let cleaned: String = base
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '.' || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() { "drop.bin".into() } else { cleaned }
}

pub fn image_mime(path: &str, kind: &str, given: Option<&str>) -> Option<String> {
    if let Some(mime) = given {
        if mime.starts_with("image/") {
            return Some(mime.to_string());
        }
    }
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "heic" | "heif" => "image/heic",
        _ if kind == "image" => "image/png",
        _ => return None,
    };
    Some(mime.into())
}

pub fn read_image_block(path: &str, mime: &str) -> Result<Value, String> {
    let bytes = fs::read(path).map_err(|e| format!("failed to read image: {e}"))?;
    Ok(json!({
        "type": "image",
        "mimeType": mime,
        "data": b64_encode(&bytes),
    }))
}

const B64: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn b64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(((data.len() + 2) / 3) * 4);
    let mut i = 0;
    while i < data.len() {
        let b0 = data[i];
        let b1 = if i + 1 < data.len() { data[i + 1] } else { 0 };
        let b2 = if i + 2 < data.len() { data[i + 2] } else { 0 };
        out.push(B64[(b0 >> 2) as usize] as char);
        out.push(B64[(((b0 & 3) << 4) | (b1 >> 4)) as usize] as char);
        if i + 1 < data.len() {
            out.push(B64[(((b1 & 15) << 2) | (b2 >> 6)) as usize] as char);
        } else {
            out.push('=');
        }
        if i + 2 < data.len() {
            out.push(B64[(b2 & 63) as usize] as char);
        } else {
            out.push('=');
        }
        i += 3;
    }
    out
}

fn b64_decode(input: &str) -> Result<Vec<u8>, String> {
    let clean: Vec<u8> = input
        .bytes()
        .filter(|b| !b.is_ascii_whitespace())
        .collect();
    if clean.len() % 4 != 0 {
        return Err("invalid image data".into());
    }
    let mut out = Vec::with_capacity(clean.len() / 4 * 3);
    let val = |c: u8| -> Result<u8, String> {
        Ok(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => 0,
            _ => return Err("invalid image data".into()),
        })
    };
    let mut i = 0;
    while i < clean.len() {
        let a = val(clean[i])?;
        let b = val(clean[i + 1])?;
        let c = val(clean[i + 2])?;
        let d = val(clean[i + 3])?;
        out.push((a << 2) | (b >> 4));
        if clean[i + 2] != b'=' {
            out.push((b << 4) | (c >> 2));
        }
        if clean[i + 3] != b'=' {
            out.push((c << 6) | d);
        }
        i += 4;
    }
    Ok(out)
}

pub async fn start_login(bin: &Path) -> Result<(), String> {
    Command::new(bin)
        .arg("login")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to launch grok login: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{b64_decode, b64_encode, image_mime};

    #[test]
    fn roundtrips_base64() {
        let src = b"hello image";
        assert_eq!(b64_decode(&b64_encode(src)).unwrap(), src);
    }

    #[test]
    fn detects_image_mime() {
        assert_eq!(
            image_mime("/tmp/pic.PNG", "file", None).as_deref(),
            Some("image/png")
        );
        assert_eq!(
            image_mime("/tmp/a.bin", "image", Some("image/webp")).as_deref(),
            Some("image/webp")
        );
        assert_eq!(image_mime("/tmp/note.txt", "file", None), None);
    }
}
