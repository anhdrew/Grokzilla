mod acp;
mod fssearch;
mod grok;
mod sessions;
mod skills;

use acp::AcpClient;
use grok::GrokStatus;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sessions::{ProjectInfo, ThreadInfo, ThreadStats};
use std::sync::Arc;
use tauri::State;
use tokio::sync::Mutex;

struct AppState {
    client: Mutex<Option<Arc<AcpClient>>>,
}

fn require_client(client: &Option<Arc<AcpClient>>) -> Result<Arc<AcpClient>, String> {
    client
        .clone()
        .ok_or_else(|| "Grok agent is not running".to_string())
}

#[tauri::command]
fn grok_status() -> GrokStatus {
    grok::status()
}

#[tauri::command]
async fn start_agent(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<Value, String> {
    let grok = grok::find_grok().ok_or_else(|| {
        "Grok Build CLI was not found. Install it, then reopen Grokzilla.".to_string()
    })?;

    {
        let mut slot = state.client.lock().await;
        if let Some(existing) = slot.as_ref() {
            if existing.is_alive().await {
                if let Some(init) = existing.cached_init().await {
                    return Ok(init);
                }
            }
        }
        if let Some(existing) = slot.take() {
            existing.shutdown().await;
        }
        let client = AcpClient::spawn(app, grok).await?;
        let init = client.initialize().await?;
        client.set_init(init.clone()).await;
        *slot = Some(Arc::new(client));
        Ok(init)
    }
}

#[tauri::command]
async fn authenticate(state: State<'_, AppState>, method_id: String) -> Result<Value, String> {
    let slot = state.client.lock().await;
    let client = require_client(&slot)?;
    drop(slot);
    client.authenticate(&method_id).await
}

#[tauri::command]
async fn start_login() -> Result<GrokStatus, String> {
    let grok = grok::find_grok().ok_or_else(|| "Grok Build CLI was not found".to_string())?;
    grok::start_login(&grok).await?;
    Ok(grok::status())
}

#[tauri::command]
fn list_threads() -> Result<Vec<ThreadInfo>, String> {
    sessions::list_threads()
}

#[tauri::command]
fn list_projects() -> Result<Vec<ProjectInfo>, String> {
    let threads = sessions::list_threads()?;
    Ok(sessions::projects_from(&threads))
}

#[tauri::command]
fn hydrate_session(session_id: String, cwd: String) -> Result<Vec<Value>, String> {
    sessions::hydrate_updates(&session_id, &cwd)
}

#[tauri::command]
fn thread_stats(session_id: String, cwd: String) -> Result<ThreadStats, String> {
    sessions::thread_stats(&session_id, &cwd)
}

#[tauri::command]
fn delete_thread(session_id: String, cwd: String) -> Result<(), String> {
    sessions::delete_thread(&session_id, &cwd)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionStart {
    session_id: String,
    raw: Value,
}

fn session_id_from(value: &Value) -> Result<String, String> {
    value
        .get("sessionId")
        .and_then(Value::as_str)
        .map(|s| s.to_string())
        .ok_or_else(|| "agent did not return a sessionId".to_string())
}

#[tauri::command]
async fn new_session(state: State<'_, AppState>, cwd: String) -> Result<SessionStart, String> {
    let slot = state.client.lock().await;
    let client = require_client(&slot)?;
    drop(slot);
    let raw = client.session_new(&cwd).await?;
    Ok(SessionStart {
        session_id: session_id_from(&raw)?,
        raw,
    })
}

#[tauri::command]
async fn load_session(
    state: State<'_, AppState>,
    session_id: String,
    cwd: String,
) -> Result<SessionStart, String> {
    let slot = state.client.lock().await;
    let client = require_client(&slot)?;
    drop(slot);
    let raw = client.session_load(&session_id, &cwd).await?;
    Ok(SessionStart {
        session_id,
        raw,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttachmentIn {
    path: String,
    rel: String,
    kind: String,
    mime_type: Option<String>,
}

#[tauri::command]
async fn send_prompt(
    state: State<'_, AppState>,
    session_id: String,
    text: String,
    attachments: Option<Vec<AttachmentIn>>,
) -> Result<Value, String> {
    let slot = state.client.lock().await;
    let client = require_client(&slot)?;
    drop(slot);
    let mut blocks = vec![json!({ "type": "text", "text": text })];
    for item in attachments.unwrap_or_default() {
        if let Some(mime) = grok::image_mime(&item.path, &item.kind, item.mime_type.as_deref()) {
            blocks.push(grok::read_image_block(&item.path, &mime)?);
            continue;
        }
        let uri = format!("file://{}", item.path);
        blocks.push(json!({
            "type": "resource_link",
            "uri": uri,
            "name": item.rel,
            "mimeType": if item.kind == "folder" { "inode/directory" } else { "text/plain" }
        }));
    }
    client.prompt_blocks(&session_id, Value::Array(blocks)).await
}

#[tauri::command]
fn search_paths(cwd: String, query: String) -> Result<Vec<fssearch::PathHit>, String> {
    let hidden = query.starts_with('!');
    fssearch::search(&cwd, &query, hidden)
}

#[tauri::command]
fn list_dir(cwd: String, rel: String) -> Result<Vec<fssearch::PathHit>, String> {
    fssearch::list_dir(&cwd, &rel)
}

#[tauri::command]
fn list_skills(cwd: String) -> Vec<skills::SkillInfo> {
    skills::list_skills(&cwd)
}

#[tauri::command]
async fn get_billing(state: State<'_, AppState>) -> Result<Value, String> {
    let slot = state.client.lock().await;
    if let Ok(client) = require_client(&slot) {
        drop(slot);
        if let Ok(value) = client.billing().await {
            return Ok(value);
        }
    } else {
        drop(slot);
    }
    grok::fetch_billing_http()
}

#[tauri::command]
fn save_drop(name: String, data_base64: String) -> Result<grok::SavedDrop, String> {
    grok::save_drop(&name, &data_base64)
}

#[tauri::command]
async fn cancel_prompt(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let slot = state.client.lock().await;
    let client = require_client(&slot)?;
    drop(slot);
    client.cancel(&session_id).await
}

#[tauri::command]
async fn set_mode(
    state: State<'_, AppState>,
    session_id: String,
    mode_id: String,
) -> Result<Value, String> {
    let slot = state.client.lock().await;
    let client = require_client(&slot)?;
    drop(slot);
    client.set_mode(&session_id, &mode_id).await
}

#[tauri::command]
async fn set_model(
    state: State<'_, AppState>,
    session_id: String,
    model_id: String,
) -> Result<Value, String> {
    let slot = state.client.lock().await;
    let client = require_client(&slot)?;
    drop(slot);
    client.set_model(&session_id, &model_id).await
}

#[tauri::command]
async fn set_config_option(
    state: State<'_, AppState>,
    session_id: String,
    config_id: String,
    value: String,
) -> Result<Value, String> {
    let slot = state.client.lock().await;
    let client = require_client(&slot)?;
    drop(slot);
    client
        .set_config_option(&session_id, &config_id, &value)
        .await
}

#[tauri::command]
async fn respond_permission(
    state: State<'_, AppState>,
    id: u64,
    option_id: Option<String>,
    cancelled: bool,
) -> Result<(), String> {
    let slot = state.client.lock().await;
    let client = require_client(&slot)?;
    drop(slot);
    client.respond_permission(id, option_id, cancelled).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            client: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            grok_status,
            start_agent,
            authenticate,
            start_login,
            list_threads,
            list_projects,
            hydrate_session,
            thread_stats,
            delete_thread,
            new_session,
            load_session,
            send_prompt,
            cancel_prompt,
            set_mode,
            set_model,
            set_config_option,
            respond_permission,
            search_paths,
            list_dir,
            list_skills,
            get_billing,
            save_drop
        ])
        .run(tauri::generate_context!())
        .expect("error while running Grokzilla");
}
