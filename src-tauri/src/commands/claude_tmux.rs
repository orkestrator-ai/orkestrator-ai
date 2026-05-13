//! Tauri commands for Claude tmux mode.

use crate::claude_tmux::{
    backend::Backend,
    get_manager,
    session::{TmuxSession, TmuxSessionStatus},
};
use crate::models::EnvironmentType;
use crate::storage::get_storage;
use serde_json::Value;
use std::sync::Arc;
use tauri::AppHandle;
use tracing::info;

fn resolve_backend(environment_id: &str) -> Result<Backend, String> {
    let storage = get_storage().map_err(|e| e.to_string())?;
    let env = storage
        .get_environment(environment_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("environment {} not found", environment_id))?;

    match env.environment_type {
        EnvironmentType::Local => {
            let cwd = env
                .worktree_path
                .clone()
                .ok_or_else(|| "local environment has no worktree path".to_string())?;
            Ok(Backend::Local { cwd })
        }
        EnvironmentType::Containerized => {
            let container_id = env
                .container_id
                .clone()
                .ok_or_else(|| "container environment has no container id".to_string())?;
            Ok(Backend::Container { container_id })
        }
    }
}

async fn get_or_create(environment_id: &str) -> Result<Arc<TmuxSession>, String> {
    let mgr = get_manager();
    if let Some(s) = mgr.get(environment_id).await {
        return Ok(s);
    }
    let backend = resolve_backend(environment_id)?;
    let session = Arc::new(TmuxSession::build(environment_id.to_string(), backend));
    mgr.insert(environment_id.to_string(), session.clone()).await;
    Ok(session)
}

#[tauri::command]
pub async fn claude_tmux_start(
    app: AppHandle,
    environment_id: String,
    initial_prompt: Option<String>,
    model: Option<String>,
) -> Result<TmuxSessionStatus, String> {
    info!(env = %environment_id, "claude_tmux_start");
    let session = get_or_create(&environment_id).await?;
    session.clone().start(app, initial_prompt, model).await?;
    let alive = session.tmux_alive().await.unwrap_or(false);
    Ok(session.status(alive))
}

#[tauri::command]
pub async fn claude_tmux_stop(environment_id: String) -> Result<(), String> {
    info!(env = %environment_id, "claude_tmux_stop");
    let mgr = get_manager();
    if let Some(session) = mgr.remove(&environment_id).await {
        session.stop().await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn claude_tmux_status(
    environment_id: String,
) -> Result<Option<TmuxSessionStatus>, String> {
    Ok(get_manager().status(&environment_id).await)
}

#[tauri::command]
pub async fn claude_tmux_send_text(environment_id: String, text: String) -> Result<(), String> {
    let session = get_manager()
        .get(&environment_id)
        .await
        .ok_or_else(|| "tmux session not running".to_string())?;
    session.send_text(&text).await
}

#[tauri::command]
pub async fn claude_tmux_send_keys(
    environment_id: String,
    keys: Vec<String>,
) -> Result<(), String> {
    let session = get_manager()
        .get(&environment_id)
        .await
        .ok_or_else(|| "tmux session not running".to_string())?;
    let refs: Vec<&str> = keys.iter().map(|s| s.as_str()).collect();
    session.send_keys(&refs).await
}

#[tauri::command]
pub async fn claude_tmux_submit(environment_id: String, text: String) -> Result<(), String> {
    let session = get_manager()
        .get(&environment_id)
        .await
        .ok_or_else(|| "tmux session not running".to_string())?;
    if !text.is_empty() {
        session.send_text(&text).await?;
    }
    session.send_enter().await
}

#[tauri::command]
pub async fn claude_tmux_capture_pane(environment_id: String) -> Result<String, String> {
    let session = get_manager()
        .get(&environment_id)
        .await
        .ok_or_else(|| "tmux session not running".to_string())?;
    session.capture_pane().await
}

#[tauri::command]
pub async fn claude_tmux_resize(
    environment_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let session = get_manager()
        .get(&environment_id)
        .await
        .ok_or_else(|| "tmux session not running".to_string())?;
    session.resize(cols, rows).await
}

#[tauri::command]
pub async fn claude_tmux_answer_pre_tool_use(
    environment_id: String,
    event_id: String,
    decision: String,
    reason: Option<String>,
) -> Result<(), String> {
    let session = get_manager()
        .get(&environment_id)
        .await
        .ok_or_else(|| "tmux session not running".to_string())?;
    session
        .answer_pre_tool_use(&event_id, &decision, reason)
        .await
}

#[tauri::command]
pub async fn claude_tmux_reply_hook(
    environment_id: String,
    event_kind: String,
    event_id: String,
    response: Value,
) -> Result<(), String> {
    let session = get_manager()
        .get(&environment_id)
        .await
        .ok_or_else(|| "tmux session not running".to_string())?;
    session.reply_to_hook(&event_kind, &event_id, response).await
}
