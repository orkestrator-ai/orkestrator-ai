// OpenCode server management commands
// Handles starting, stopping, and checking the status of the OpenCode server in containers

use crate::docker;
use serde::{Deserialize, Serialize};
use tracing::{debug, error, info, warn};

/// OpenCode server port inside the container
const OPENCODE_SERVER_PORT: u16 = 4096;

/// Maximum number of health check attempts when waiting for server startup
const SERVER_STARTUP_MAX_ATTEMPTS: u32 = 75;

/// Delay between health check attempts in milliseconds
const SERVER_STARTUP_POLL_INTERVAL_MS: u64 = 200;

/// Result of starting the OpenCode server
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeServerStartResult {
    /// The host port mapped to the server
    pub host_port: u16,
    /// Whether the server was already running
    pub was_running: bool,
}

/// Status of the OpenCode server
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeServerStatus {
    /// Whether the server is running
    pub running: bool,
    /// The host port if running
    pub host_port: Option<u16>,
}

/// Start the OpenCode server in a container
/// Runs `opencode serve` in the container's workspace directory
#[tauri::command]
pub async fn start_opencode_server(container_id: String) -> Result<OpenCodeServerStartResult, String> {
    info!(container_id = %container_id, "Starting OpenCode server");

    let client = docker::client::get_docker_client().map_err(|e| e.to_string())?;

    // Check if container is running
    let is_running = client
        .is_container_running(&container_id)
        .await
        .map_err(|e| e.to_string())?;

    if !is_running {
        return Err("Container is not running".to_string());
    }

    // Get the host port for the OpenCode server
    let host_port = client
        .get_host_port(&container_id, OPENCODE_SERVER_PORT, "tcp")
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "OpenCode server port (4096) is not mapped".to_string())?;

    // Check if server is already running by trying to ping it
    let health_url = format!("http://127.0.0.1:{}/global/health", host_port);
    let base_url = format!("http://127.0.0.1:{}", host_port);
    debug!(container_id = %container_id, base_url = %base_url, health_url = %health_url, "OpenCode server URLs");
    if let Ok(response) = reqwest::get(&health_url).await {
        if response.status().is_success() {
            debug!(container_id = %container_id, host_port = host_port, "OpenCode server already running");
            return Ok(OpenCodeServerStartResult {
                host_port,
                was_running: true,
            });
        }
    }

    // Start the server in the background using docker exec
    // Use setsid to create a new session so the process survives exec termination
    // Use full path to opencode binary since setsid doesn't inherit PATH
    // --port 4096: listen on the mapped container port
    // --hostname 0.0.0.0: bind to all interfaces so it's accessible from host
    let command = r#"
        cd /workspace
        rm -f /tmp/opencode-serve.log
        setsid /home/node/.opencode/bin/opencode serve --port 4096 --hostname 0.0.0.0 > /tmp/opencode-serve.log 2>&1 &
        disown
        sleep 0.5
        echo "Started opencode serve"
    "#;

    // Execute the command in the container
    let exec_result = client
        .exec_in_container(&container_id, vec!["bash", "-c", command], None)
        .await
        .map_err(|e| format!("Failed to start OpenCode server: {}", e))?;

    debug!(container_id = %container_id, result = %exec_result, "Exec result from starting OpenCode server");

    // Wait for the server to start (poll health endpoint)
    // OpenCode server may need time to initialize, especially on first run
    let mut attempts: u32 = 0;

    loop {
        attempts += 1;
        tokio::time::sleep(tokio::time::Duration::from_millis(SERVER_STARTUP_POLL_INTERVAL_MS)).await;

        // Check health endpoint
        match reqwest::get(&health_url).await {
            Ok(response) => {
                if response.status().is_success() {
                    info!(container_id = %container_id, host_port = host_port, attempts = attempts, "OpenCode server started successfully");
                    return Ok(OpenCodeServerStartResult {
                        host_port,
                        was_running: false,
                    });
                }
                debug!(container_id = %container_id, status = %response.status(), attempts = attempts, "Health check returned non-success status");
            }
            Err(e) => {
                debug!(container_id = %container_id, error = %e, attempts = attempts, "Health check failed");
            }
        }

        if attempts >= SERVER_STARTUP_MAX_ATTEMPTS {
            // Read server log for debugging before returning error
            let log_result = client
                .exec_in_container(&container_id, vec!["cat", "/tmp/opencode-serve.log"], None)
                .await;

            if let Ok(log_content) = log_result {
                error!(container_id = %container_id, log = %log_content, "OpenCode server log on timeout");
            }

            // Also check if process is running
            let ps_result = client
                .exec_in_container(&container_id, vec!["bash", "-c", "pgrep -f 'opencode serve' || echo 'No process found'"], None)
                .await;

            if let Ok(ps_output) = ps_result {
                error!(container_id = %container_id, ps = %ps_output, "Process check on timeout");
            }

            warn!(container_id = %container_id, "OpenCode server did not start within timeout");
            return Err("OpenCode server did not start within timeout".to_string());
        }
    }
}

/// Stop the OpenCode server in a container
#[tauri::command]
pub async fn stop_opencode_server(container_id: String) -> Result<(), String> {
    info!(container_id = %container_id, "Stopping OpenCode server");

    let client = docker::client::get_docker_client().map_err(|e| e.to_string())?;

    // Check if container is running
    let is_running = client
        .is_container_running(&container_id)
        .await
        .map_err(|e| e.to_string())?;

    if !is_running {
        return Ok(()); // Nothing to stop if container isn't running
    }

    // Kill the opencode serve process
    let command = "pkill -f 'opencode serve' || true";

    client
        .exec_in_container(&container_id, vec!["bash", "-c", command], None)
        .await
        .map_err(|e| format!("Failed to stop OpenCode server: {}", e))?;

    info!(container_id = %container_id, "OpenCode server stopped");
    Ok(())
}

/// Get the OpenCode server log from a container (for debugging)
#[tauri::command]
pub async fn get_opencode_server_log(container_id: String) -> Result<String, String> {
    debug!(container_id = %container_id, "Getting OpenCode server log");

    let client = docker::client::get_docker_client().map_err(|e| e.to_string())?;

    // Check if container is running
    let is_running = client
        .is_container_running(&container_id)
        .await
        .map_err(|e| e.to_string())?;

    if !is_running {
        return Err("Container is not running".to_string());
    }

    // Read the log file
    let log_content = client
        .exec_in_container(&container_id, vec!["cat", "/tmp/opencode-serve.log"], None)
        .await
        .map_err(|e| format!("Failed to read log: {}", e))?;

    Ok(log_content)
}

/// Get the status of the OpenCode server in a container
#[tauri::command]
pub async fn get_opencode_server_status(container_id: String) -> Result<OpenCodeServerStatus, String> {
    debug!(container_id = %container_id, "Checking OpenCode server status");

    let client = docker::client::get_docker_client().map_err(|e| e.to_string())?;

    // Check if container is running
    let is_running = client
        .is_container_running(&container_id)
        .await
        .map_err(|e| e.to_string())?;

    if !is_running {
        return Ok(OpenCodeServerStatus {
            running: false,
            host_port: None,
        });
    }

    // Get the host port
    let host_port = match client
        .get_host_port(&container_id, OPENCODE_SERVER_PORT, "tcp")
        .await
        .map_err(|e| e.to_string())?
    {
        Some(port) => port,
        None => {
            return Ok(OpenCodeServerStatus {
                running: false,
                host_port: None,
            });
        }
    };

    // Check if server is responding
    let health_url = format!("http://127.0.0.1:{}/global/health", host_port);
    let running = match reqwest::get(&health_url).await {
        Ok(response) => response.status().is_success(),
        Err(_) => false,
    };

    Ok(OpenCodeServerStatus {
        running,
        host_port: if running { Some(host_port) } else { None },
    })
}
