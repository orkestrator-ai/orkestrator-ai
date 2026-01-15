// Terminal-related Tauri commands
// Exposes PTY operations to the frontend via events

use crate::pty::get_terminal_manager;
use tauri::{AppHandle, Emitter, Runtime};
use tracing::{debug, instrument, warn};

fn spawn_output_forwarder<R: Runtime>(
    app: AppHandle<R>,
    session_id: String,
    mut output_rx: tokio::sync::mpsc::Receiver<Vec<u8>>,
) {
    let session_id_clone = session_id.clone();
    let app_clone = app.clone();

    debug!(session_id = %session_id, "Starting output forwarder task");

    // Spawn task to forward output to frontend via events
    tokio::spawn(async move {
        while let Some(data) = output_rx.recv().await {
            // Emit terminal output event
            if let Err(e) = app_clone.emit(&format!("terminal-output-{}", session_id_clone), data) {
                warn!(session_id = %session_id_clone, error = ?e, "Failed to emit terminal output event");
            }
        }
        debug!(session_id = %session_id_clone, "Output forwarder task ended");
    });
}

/// Attach a terminal to a container
#[tauri::command]
#[instrument(skip(app), fields(container_id = %container_id, cols, rows, user))]
pub async fn attach_terminal<R: Runtime>(
    app: AppHandle<R>,
    container_id: String,
    cols: u16,
    rows: u16,
    user: Option<String>,
) -> Result<String, String> {
    debug!("Attaching terminal to container");
    let manager = get_terminal_manager()
        .ok_or_else(|| "Terminal manager not initialized".to_string())?;

    // Create the session
    let session_id = manager
        .create_session(&container_id, cols, rows, user.as_deref())
        .await
        .map_err(|e| e.to_string())?;

    // Start the session and get output receiver
    // Input sender is stored internally in the manager
    let output_rx = manager
        .start_session(&session_id)
        .await
        .map_err(|e| e.to_string())?;

    spawn_output_forwarder(app, session_id.clone(), output_rx);

    Ok(session_id)
}

/// Create a terminal session without starting it (so the frontend can attach listeners first)
#[tauri::command]
#[instrument(fields(container_id = %container_id, cols, rows, user))]
pub async fn create_terminal_session(
    container_id: String,
    cols: u16,
    rows: u16,
    user: Option<String>,
) -> Result<String, String> {
    debug!("Creating terminal session");
    let manager = get_terminal_manager()
        .ok_or_else(|| "Terminal manager not initialized".to_string())?;

    let session_id = manager
        .create_session(&container_id, cols, rows, user.as_deref())
        .await
        .map_err(|e| e.to_string())?;

    debug!(session_id = %session_id, "Terminal session created");
    Ok(session_id)
}

/// Start an existing terminal session and begin forwarding output
#[tauri::command]
#[instrument(skip(app), fields(session_id = %session_id))]
pub async fn start_terminal_session<R: Runtime>(
    app: AppHandle<R>,
    session_id: String,
) -> Result<(), String> {
    debug!("Starting terminal session");
    let manager = get_terminal_manager()
        .ok_or_else(|| "Terminal manager not initialized".to_string())?;

    let output_rx = manager
        .start_session(&session_id)
        .await
        .map_err(|e| e.to_string())?;

    spawn_output_forwarder(app, session_id, output_rx);

    Ok(())
}

/// Write data to a terminal session
#[tauri::command]
#[instrument(fields(session_id = %session_id, data_len = data.len()))]
pub async fn terminal_write(
    session_id: String,
    data: String,
) -> Result<(), String> {
    let manager = get_terminal_manager()
        .ok_or_else(|| "Terminal manager not initialized".to_string())?;

    manager
        .write_to_session(&session_id, data.into_bytes())
        .await
        .map_err(|e| e.to_string())
}

/// Resize a terminal session
#[tauri::command]
#[instrument(fields(session_id = %session_id, cols, rows))]
pub async fn terminal_resize(
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    debug!("Resizing terminal session");
    let manager = get_terminal_manager()
        .ok_or_else(|| "Terminal manager not initialized".to_string())?;

    manager
        .resize_session(&session_id, cols, rows)
        .await
        .map_err(|e| e.to_string())
}

/// Detach a terminal session
#[tauri::command]
#[instrument(fields(session_id = %session_id))]
pub async fn detach_terminal(session_id: String) -> Result<(), String> {
    debug!("Detaching terminal session");
    let manager = get_terminal_manager()
        .ok_or_else(|| "Terminal manager not initialized".to_string())?;

    manager
        .close_session(&session_id)
        .map_err(|e| e.to_string())
}

/// List active terminal sessions
#[tauri::command]
#[instrument]
pub fn list_terminal_sessions() -> Result<Vec<String>, String> {
    let manager = get_terminal_manager()
        .ok_or_else(|| "Terminal manager not initialized".to_string())?;

    Ok(manager.list_sessions())
}

/// Get terminal session info
#[tauri::command]
#[instrument(fields(session_id = %session_id))]
pub fn get_terminal_session(session_id: String) -> Result<Option<(String, u16, u16)>, String> {
    let manager = get_terminal_manager()
        .ok_or_else(|| "Terminal manager not initialized".to_string())?;

    Ok(manager.get_session(&session_id))
}
