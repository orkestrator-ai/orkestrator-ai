//! Tauri commands for local server management
//!
//! These commands manage OpenCode and Claude-bridge servers
//! for local (non-Docker) environments.

use crate::local::{
    get_local_claude_status, get_local_opencode_status, start_local_claude_bridge,
    start_local_opencode_server, stop_local_claude_bridge, stop_local_opencode_server,
    LocalServerStartResult, LocalServerStatus,
};
use crate::local::ports::{allocate_ports, is_port_available};
use crate::local::process::{get_process_manager, is_process_alive, ProcessType};
use crate::storage::get_storage;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::PathBuf;
use tauri::Manager;
use tracing::{debug, info, warn};

/// Result type for local server start commands
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalServerResult {
    pub port: u16,
    pub pid: u32,
    pub was_running: bool,
}

impl From<LocalServerStartResult> for LocalServerResult {
    fn from(result: LocalServerStartResult) -> Self {
        Self {
            port: result.port,
            pid: result.pid,
            was_running: result.was_running,
        }
    }
}

/// Status type for local server commands
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalServerStatusResult {
    pub running: bool,
    pub port: Option<u16>,
    pub pid: Option<u32>,
}

impl From<LocalServerStatus> for LocalServerStatusResult {
    fn from(status: LocalServerStatus) -> Self {
        Self {
            running: status.running,
            port: status.port,
            pid: status.pid,
        }
    }
}

/// Start the OpenCode server for a local environment
#[tauri::command]
pub async fn start_local_opencode_server_cmd(
    environment_id: String,
) -> Result<LocalServerResult, String> {
    debug!(environment_id = %environment_id, "Starting local OpenCode server");

    let storage = get_storage().map_err(|e| e.to_string())?;
    let environment = storage
        .get_environment(&environment_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Environment not found: {}", environment_id))?;

    // Verify this is a local environment
    if environment.is_containerized() {
        return Err("Cannot start local server for containerized environment".to_string());
    }

    // Get the worktree path
    let worktree_path = environment
        .worktree_path
        .as_ref()
        .ok_or("Local environment missing worktree path")?;

    // Get the allocated port
    let port = environment
        .local_opencode_port
        .ok_or("Local environment missing OpenCode port")?;

    // Start the server
    let result = start_local_opencode_server(&environment_id, worktree_path, port).await?;

    // Update the PID in storage if it changed
    if !result.was_running {
        storage
            .update_environment(
                &environment_id,
                json!({
                    "opencodePid": result.pid
                }),
            )
            .map_err(|e| format!("Failed to update environment: {}", e))?;
    }

    info!(
        environment_id = %environment_id,
        port = result.port,
        pid = result.pid,
        "Local OpenCode server started"
    );

    Ok(result.into())
}

/// Stop the OpenCode server for a local environment
#[tauri::command]
pub async fn stop_local_opencode_server_cmd(
    environment_id: String,
) -> Result<(), String> {
    debug!(environment_id = %environment_id, "Stopping local OpenCode server");

    stop_local_opencode_server(&environment_id).await?;

    // Clear the PID in storage
    let storage = get_storage().map_err(|e| e.to_string())?;
    storage
        .update_environment(
            &environment_id,
            json!({
                "opencodePid": null
            }),
        )
        .map_err(|e| format!("Failed to update environment: {}", e))?;

    info!(environment_id = %environment_id, "Local OpenCode server stopped");

    Ok(())
}

/// Get the status of the OpenCode server for a local environment
#[tauri::command]
pub async fn get_local_opencode_server_status(
    environment_id: String,
) -> Result<LocalServerStatusResult, String> {
    debug!(environment_id = %environment_id, "Getting local OpenCode server status");

    let storage = get_storage().map_err(|e| e.to_string())?;
    let environment = storage
        .get_environment(&environment_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Environment not found: {}", environment_id))?;

    let status = get_local_opencode_status(
        &environment_id,
        environment.local_opencode_port,
        environment.opencode_pid,
    )
    .await;

    Ok(status.into())
}

/// Start the Claude-bridge server for a local environment
#[tauri::command]
pub async fn start_local_claude_server_cmd(
    app_handle: tauri::AppHandle,
    environment_id: String,
) -> Result<LocalServerResult, String> {
    debug!(environment_id = %environment_id, "Starting local Claude-bridge server");

    let storage = get_storage().map_err(|e| e.to_string())?;
    let environment = storage
        .get_environment(&environment_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Environment not found: {}", environment_id))?;
    debug!(
        environment_id = %environment_id,
        environment_type = ?environment.environment_type,
        worktree_path = ?environment.worktree_path,
        port = ?environment.local_claude_port,
        pid = ?environment.claude_bridge_pid,
        "Local Claude-bridge environment snapshot"
    );

    // Verify this is a local environment
    if environment.is_containerized() {
        return Err("Cannot start local server for containerized environment".to_string());
    }

    // Get the worktree path
    let worktree_path = environment
        .worktree_path
        .as_ref()
        .ok_or("Local environment missing worktree path")?;

    let manager = get_process_manager();

    if let Some(pid) = environment.claude_bridge_pid {
        if is_process_alive(pid) {
            manager
                .recover_from_pid(&environment_id, ProcessType::ClaudeBridge, pid)
                .await;
        }
    }

    // Get the allocated port
    let mut port = environment
        .local_claude_port
        .ok_or("Local environment missing Claude-bridge port")?;

    if !is_port_available(port) {
        warn!(
            environment_id = %environment_id,
            port = port,
            "Claude-bridge port already in use; attempting to recover"
        );

        if let Some(pid) = environment.claude_bridge_pid {
            if is_process_alive(pid) {
                if let Err(err) = manager.kill(&environment_id, ProcessType::ClaudeBridge).await {
                    warn!(
                        environment_id = %environment_id,
                        port = port,
                        error = %err,
                        "Failed to kill existing Claude-bridge process"
                    );
                }
            }
        }

        if !is_port_available(port) {
            let all_envs = storage.get_all_environments().map_err(|e| e.to_string())?;
            let allocation = allocate_ports(&all_envs)?;
            let new_port = allocation.claude_port;
            warn!(
                environment_id = %environment_id,
                old_port = port,
                new_port = new_port,
                "Reassigning Claude-bridge port"
            );
            port = new_port;
            storage
                .update_environment(
                    &environment_id,
                    json!({
                        "localClaudePort": new_port,
                        "claudeBridgePid": null
                    }),
                )
                .map_err(|e| format!("Failed to update environment: {}", e))?;
        }
    }

    // Get the path to the claude-bridge
    // In development, it's in the docker/claude-bridge directory
    // In production, it's bundled as a resource
    let bridge_path = resolve_claude_bridge_path(&app_handle);
    debug!(environment_id = %environment_id, bridge_path = %bridge_path, "Resolved claude-bridge path");

    // Get the path to the bundled bun binary (for packaged apps)
    let bundled_bun_path = resolve_bundled_bun_path(&app_handle);
    if let Some(ref bun_path) = bundled_bun_path {
        debug!(environment_id = %environment_id, bun_path = %bun_path, "Resolved bundled bun path");
    }

    // Start the server
    let result = start_local_claude_bridge(&environment_id, worktree_path, port, &bridge_path, bundled_bun_path.as_deref()).await?;

    // Update the PID in storage if it changed
    if !result.was_running {
        storage
            .update_environment(
                &environment_id,
                json!({
                    "claudeBridgePid": result.pid
                }),
            )
            .map_err(|e| format!("Failed to update environment: {}", e))?;
    }

    info!(
        environment_id = %environment_id,
        port = result.port,
        pid = result.pid,
        "Local Claude-bridge server started"
    );

    Ok(result.into())
}

fn dev_claude_bridge_path() -> Option<String> {
    // In dev, CARGO_MANIFEST_DIR points to src-tauri; claude-bridge lives at ../docker/claude-bridge
    // Use env!() macro to capture the value at compile time (not runtime)
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let manifest_path = PathBuf::from(manifest_dir);
    let workspace_root = manifest_path.parent()?;
    let bridge_path = workspace_root.join("docker").join("claude-bridge");
    Some(bridge_path.to_string_lossy().to_string())
}

/// Resolve the claude-bridge path for both development and production
fn resolve_claude_bridge_path(app_handle: &tauri::AppHandle) -> String {
    // In debug mode, prefer the development path first because it has node_modules
    // The bundled resource path in target/debug only has dist and package.json
    #[cfg(debug_assertions)]
    {
        if let Some(dev_path) = dev_claude_bridge_path() {
            let dev_pathbuf = PathBuf::from(&dev_path);
            // Check that both the directory and node_modules exist
            if dev_pathbuf.exists() && dev_pathbuf.join("node_modules").exists() {
                debug!(path = %dev_path, "Using dev claude-bridge path (debug mode)");
                return dev_path;
            }
        }
    }

    // Try bundled resource path (production)
    // Use resolve_resource which is the Tauri v2 way to access bundled resources
    if let Ok(bundled) = app_handle.path().resolve("claude-bridge", tauri::path::BaseDirectory::Resource) {
        debug!(path = %bundled.display(), "Checking bundled claude-bridge path");
        if bundled.exists() {
            debug!(path = %bundled.display(), "Found bundled claude-bridge");
            return bundled.to_string_lossy().to_string();
        }
    }

    // Also try resource_dir() directly as a fallback
    if let Ok(res_dir) = app_handle.path().resource_dir() {
        let bundled = res_dir.join("claude-bridge");
        debug!(resource_dir = %res_dir.display(), path = %bundled.display(), "Checking resource_dir claude-bridge path");
        if bundled.exists() {
            debug!(path = %bundled.display(), "Found claude-bridge via resource_dir");
            return bundled.to_string_lossy().to_string();
        }
    }

    // Fallback to development path (also handles release builds where bundled path doesn't exist)
    if let Some(dev_path) = dev_claude_bridge_path() {
        let dev_pathbuf = PathBuf::from(&dev_path);
        if dev_pathbuf.exists() {
            debug!(path = %dev_path, "Found dev claude-bridge path");
            return dev_path;
        }
    }

    // Last resort - relative path (will likely fail but provides a clear error)
    warn!("Could not resolve claude-bridge path, using fallback");
    "docker/claude-bridge".to_string()
}

/// Resolve the bundled bun binary path for packaged apps
fn resolve_bundled_bun_path(#[allow(unused)] app_handle: &tauri::AppHandle) -> Option<String> {
    // In debug mode, skip bundled bun - it may have code signing issues on macOS
    // that cause it to hang. Use system bun/node instead.
    #[cfg(debug_assertions)]
    {
        debug!("Debug mode: skipping bundled bun, will use system runtime");
        return None;
    }

    // Try bundled resource path (production)
    #[cfg(not(debug_assertions))]
    {
        if let Ok(bundled) = app_handle.path().resolve("bin/bun", tauri::path::BaseDirectory::Resource) {
            debug!(path = %bundled.display(), "Checking bundled bun path");
            if bundled.exists() {
                debug!(path = %bundled.display(), "Found bundled bun");
                return Some(bundled.to_string_lossy().to_string());
            }
        }

        // Also try resource_dir() directly as a fallback
        if let Ok(res_dir) = app_handle.path().resource_dir() {
            let bundled = res_dir.join("bin").join("bun");
            debug!(resource_dir = %res_dir.display(), path = %bundled.display(), "Checking resource_dir bun path");
            if bundled.exists() {
                debug!(path = %bundled.display(), "Found bun via resource_dir");
                return Some(bundled.to_string_lossy().to_string());
            }
        }

        // No bundled bun found - that's okay, we'll fall back to system bun/node
        debug!("No bundled bun found, will use system runtime");
        None
    }
}

/// Stop the Claude-bridge server for a local environment
#[tauri::command]
pub async fn stop_local_claude_server_cmd(
    environment_id: String,
) -> Result<(), String> {
    debug!(environment_id = %environment_id, "Stopping local Claude-bridge server");

    stop_local_claude_bridge(&environment_id).await?;

    // Clear the PID in storage
    let storage = get_storage().map_err(|e| e.to_string())?;
    storage
        .update_environment(
            &environment_id,
            json!({
                "claudeBridgePid": null
            }),
        )
        .map_err(|e| format!("Failed to update environment: {}", e))?;

    info!(environment_id = %environment_id, "Local Claude-bridge server stopped");

    Ok(())
}

/// Get the status of the Claude-bridge server for a local environment
#[tauri::command]
pub async fn get_local_claude_server_status(
    environment_id: String,
) -> Result<LocalServerStatusResult, String> {
    debug!(environment_id = %environment_id, "Getting local Claude-bridge server status");

    let storage = get_storage().map_err(|e| e.to_string())?;
    let environment = storage
        .get_environment(&environment_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Environment not found: {}", environment_id))?;

    let status = get_local_claude_status(
        &environment_id,
        environment.local_claude_port,
        environment.claude_bridge_pid,
    )
    .await;

    Ok(status.into())
}
