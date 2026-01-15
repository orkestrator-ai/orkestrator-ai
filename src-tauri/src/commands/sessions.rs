// Session management Tauri commands
// Commands for creating, updating, and querying terminal sessions

use tracing::{debug, info};

use crate::models::{Session, SessionStatus, SessionType};
use crate::storage::{get_storage, StorageError};

/// Convert storage errors to string for Tauri
fn storage_error_to_string(err: StorageError) -> String {
    err.to_string()
}

/// Create a new session for an environment
#[tauri::command]
pub async fn create_session(
    environment_id: String,
    container_id: String,
    tab_id: String,
    session_type: SessionType,
) -> Result<Session, String> {
    debug!(
        environment_id = %environment_id,
        container_id = %container_id,
        tab_id = %tab_id,
        session_type = %session_type,
        "Creating session"
    );

    let storage = get_storage().map_err(storage_error_to_string)?;

    let session = Session::new(environment_id, container_id, tab_id, session_type);
    let created = storage.add_session(session).map_err(storage_error_to_string)?;

    info!(session_id = %created.id, "Session created");
    Ok(created)
}

/// Get all sessions for an environment
#[tauri::command]
pub async fn get_sessions_by_environment(environment_id: String) -> Result<Vec<Session>, String> {
    debug!(environment_id = %environment_id, "Getting sessions for environment");

    let storage = get_storage().map_err(storage_error_to_string)?;
    let sessions = storage
        .get_sessions_by_environment(&environment_id)
        .map_err(storage_error_to_string)?;

    debug!(
        environment_id = %environment_id,
        session_count = sessions.len(),
        "Found sessions"
    );
    Ok(sessions)
}

/// Get a single session by ID
#[tauri::command]
pub async fn get_session(session_id: String) -> Result<Option<Session>, String> {
    let storage = get_storage().map_err(storage_error_to_string)?;
    storage.get_session(&session_id).map_err(storage_error_to_string)
}

/// Update session status (connected/disconnected)
#[tauri::command]
pub async fn update_session_status(
    session_id: String,
    status: SessionStatus,
) -> Result<Session, String> {
    debug!(session_id = %session_id, status = %status, "Updating session status");

    let storage = get_storage().map_err(storage_error_to_string)?;
    let updated = storage
        .update_session_status(&session_id, status.clone())
        .map_err(storage_error_to_string)?;

    info!(session_id = %session_id, status = %status, "Session status updated");
    Ok(updated)
}

/// Update session's last activity timestamp
#[tauri::command]
pub async fn update_session_activity(session_id: String) -> Result<Session, String> {
    debug!(session_id = %session_id, "Updating session activity");

    let storage = get_storage().map_err(storage_error_to_string)?;
    storage.touch_session(&session_id).map_err(storage_error_to_string)
}

/// Delete a session
#[tauri::command]
pub async fn delete_session(session_id: String) -> Result<(), String> {
    debug!(session_id = %session_id, "Deleting session");

    let storage = get_storage().map_err(storage_error_to_string)?;
    storage.remove_session(&session_id).map_err(storage_error_to_string)?;

    info!(session_id = %session_id, "Session deleted");
    Ok(())
}

/// Rename a session
#[tauri::command]
pub async fn rename_session(session_id: String, name: Option<String>) -> Result<Session, String> {
    debug!(session_id = %session_id, name = ?name, "Renaming session");

    let storage = get_storage().map_err(storage_error_to_string)?;
    let updated = storage
        .rename_session(&session_id, name.clone())
        .map_err(storage_error_to_string)?;

    info!(session_id = %session_id, name = ?name, "Session renamed");
    Ok(updated)
}

/// Update whether a session has launched its command (e.g., Claude)
#[tauri::command]
pub async fn set_session_has_launched_command(
    session_id: String,
    has_launched: bool,
) -> Result<Session, String> {
    debug!(
        session_id = %session_id,
        has_launched = has_launched,
        "Setting session has_launched_command"
    );

    let storage = get_storage().map_err(storage_error_to_string)?;
    let updated = storage
        .set_session_has_launched_command(&session_id, has_launched)
        .map_err(storage_error_to_string)?;

    debug!(
        session_id = %session_id,
        has_launched = has_launched,
        "Session has_launched_command updated"
    );
    Ok(updated)
}

/// Delete all sessions for an environment
#[tauri::command]
pub async fn delete_sessions_by_environment(environment_id: String) -> Result<Vec<String>, String> {
    debug!(environment_id = %environment_id, "Deleting sessions for environment");

    let storage = get_storage().map_err(storage_error_to_string)?;
    let deleted_ids = storage
        .remove_sessions_by_environment(&environment_id)
        .map_err(storage_error_to_string)?;

    info!(
        environment_id = %environment_id,
        deleted_count = deleted_ids.len(),
        "Sessions deleted"
    );
    Ok(deleted_ids)
}

/// Mark all sessions for an environment as disconnected
#[tauri::command]
pub async fn disconnect_environment_sessions(environment_id: String) -> Result<Vec<Session>, String> {
    debug!(environment_id = %environment_id, "Disconnecting environment sessions");

    let storage = get_storage().map_err(storage_error_to_string)?;
    let updated = storage
        .disconnect_environment_sessions(&environment_id)
        .map_err(storage_error_to_string)?;

    info!(
        environment_id = %environment_id,
        disconnected_count = updated.len(),
        "Sessions disconnected"
    );
    Ok(updated)
}

/// Save a session's terminal buffer to a separate file
#[tauri::command]
pub async fn save_session_buffer(session_id: String, buffer: String) -> Result<(), String> {
    debug!(
        session_id = %session_id,
        buffer_size = buffer.len(),
        "Saving session buffer"
    );

    let storage = get_storage().map_err(storage_error_to_string)?;
    storage
        .save_session_buffer(&session_id, &buffer)
        .map_err(storage_error_to_string)?;

    debug!(session_id = %session_id, "Session buffer saved");
    Ok(())
}

/// Load a session's terminal buffer from file
#[tauri::command]
pub async fn load_session_buffer(session_id: String) -> Result<Option<String>, String> {
    debug!(session_id = %session_id, "Loading session buffer");

    let storage = get_storage().map_err(storage_error_to_string)?;
    let buffer = storage
        .load_session_buffer(&session_id)
        .map_err(storage_error_to_string)?;

    debug!(
        session_id = %session_id,
        has_buffer = buffer.is_some(),
        "Session buffer loaded"
    );
    Ok(buffer)
}

/// Sync sessions for an environment with container state
/// If container is not running, marks all sessions as disconnected
#[tauri::command]
pub async fn sync_sessions_with_container(
    environment_id: String,
    container_running: bool,
) -> Result<Vec<Session>, String> {
    debug!(
        environment_id = %environment_id,
        container_running = container_running,
        "Syncing sessions with container state"
    );

    let storage = get_storage().map_err(storage_error_to_string)?;

    if !container_running {
        // Mark all sessions as disconnected
        let updated = storage
            .disconnect_environment_sessions(&environment_id)
            .map_err(storage_error_to_string)?;

        info!(
            environment_id = %environment_id,
            sessions_updated = updated.len(),
            "Sessions marked disconnected (container not running)"
        );
    }

    // Return current sessions for the environment
    storage
        .get_sessions_by_environment(&environment_id)
        .map_err(storage_error_to_string)
}

/// Reorder sessions within an environment
/// Updates the order field of each session based on the provided array of session IDs
#[tauri::command]
pub async fn reorder_sessions(
    environment_id: String,
    session_ids: Vec<String>,
) -> Result<Vec<Session>, String> {
    debug!(
        environment_id = %environment_id,
        session_count = session_ids.len(),
        "Reordering sessions"
    );

    let storage = get_storage().map_err(storage_error_to_string)?;
    let sessions = storage
        .reorder_sessions(&environment_id, &session_ids)
        .map_err(storage_error_to_string)?;

    info!(
        environment_id = %environment_id,
        session_count = sessions.len(),
        "Sessions reordered"
    );
    Ok(sessions)
}

/// Clean up orphaned buffer files (buffers without corresponding sessions)
/// Returns the list of deleted session IDs
#[tauri::command]
pub async fn cleanup_orphaned_buffers() -> Result<Vec<String>, String> {
    debug!("Cleaning up orphaned buffer files");

    let storage = get_storage().map_err(storage_error_to_string)?;
    let deleted = storage
        .cleanup_orphaned_buffers()
        .map_err(storage_error_to_string)?;

    info!(deleted_count = deleted.len(), "Orphaned buffers cleaned up");
    Ok(deleted)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_session_type_display() {
        assert_eq!(SessionType::Plain.to_string(), "plain");
        assert_eq!(SessionType::Claude.to_string(), "claude");
        assert_eq!(SessionType::ClaudeYolo.to_string(), "claude-yolo");
    }

    #[test]
    fn test_session_status_display() {
        assert_eq!(SessionStatus::Connected.to_string(), "connected");
        assert_eq!(SessionStatus::Disconnected.to_string(), "disconnected");
    }
}
