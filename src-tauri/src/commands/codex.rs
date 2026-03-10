// Codex bridge server management commands
// Handles starting, stopping, and checking the status of the Codex bridge server in containers

use crate::docker;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
#[cfg(not(debug_assertions))]
use tauri::Manager;
use tracing::{debug, error, info, warn};

use std::sync::LazyLock;

/// Codex bridge server port inside the container
const CODEX_BRIDGE_PORT: u16 = 4098;

/// Maximum number of health check attempts when waiting for server startup
const SERVER_STARTUP_MAX_ATTEMPTS: u32 = 75;

/// Delay between health check attempts in milliseconds
const SERVER_STARTUP_POLL_INTERVAL_MS: u64 = 200;

/// Shared HTTP client with a 2-second timeout for health checks
static HEALTH_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .expect("Failed to build HTTP client")
});

/// Result of starting the Codex bridge server
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexServerStartResult {
    pub host_port: u16,
    pub was_running: bool,
}

/// Status of the Codex bridge server
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexServerStatus {
    pub running: bool,
    pub host_port: Option<u16>,
}

fn resolve_codex_bridge_path(#[allow(unused)] app_handle: &tauri::AppHandle) -> PathBuf {
    #[cfg(debug_assertions)]
    {
        if let Ok(manifest_dir) = std::env::var("CARGO_MANIFEST_DIR") {
            let workspace_root = PathBuf::from(manifest_dir)
                .parent()
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("."));
            let dev_path = workspace_root.join("docker").join("codex-bridge");
            if dev_path.exists() {
                debug!(path = %dev_path.display(), "Using dev codex-bridge path");
                return dev_path;
            }
        }
    }

    #[cfg(not(debug_assertions))]
    {
        if let Ok(bundled) = app_handle
            .path()
            .resolve("codex-bridge", tauri::path::BaseDirectory::Resource)
        {
            if bundled.exists() {
                debug!(path = %bundled.display(), "Using bundled codex-bridge path");
                return bundled;
            }
        }

        if let Ok(res_dir) = app_handle.path().resource_dir() {
            let bundled = res_dir.join("codex-bridge");
            if bundled.exists() {
                debug!(path = %bundled.display(), "Using resource_dir codex-bridge path");
                return bundled;
            }
        }
    }

    PathBuf::from("docker").join("codex-bridge")
}

async fn ensure_codex_bridge_present(
    app_handle: &tauri::AppHandle,
    client: &crate::docker::client::DockerClient,
    container_id: &str,
) -> Result<(), String> {
    let (_, _, bridge_exit_code) = client
        .exec_command_with_status(
            container_id,
            vec![
                "bash",
                "-lc",
                "test -f /opt/codex-bridge/package.json -a -f /opt/codex-bridge/dist/index.js",
            ],
        )
        .await
        .map_err(|e| format!("Failed to inspect Codex bridge in container: {}", e))?;

    let bridge_path = resolve_codex_bridge_path(app_handle);
    let package_json_path = bridge_path.join("package.json");
    let dist_index_path = bridge_path.join("dist").join("index.js");

    let package_json = fs::read(&package_json_path).map_err(|e| {
        format!(
            "Failed to read Codex bridge package.json from {}: {}",
            package_json_path.display(),
            e
        )
    })?;
    let dist_index = fs::read(&dist_index_path).map_err(|e| {
        format!(
            "Failed to read Codex bridge dist from {}: {}",
            dist_index_path.display(),
            e
        )
    })?;

    client
        .exec_in_container(
            container_id,
            vec!["bash", "-lc", "mkdir -p /opt/codex-bridge/dist"],
            None,
        )
        .await
        .map_err(|e| {
            format!(
                "Failed to create Codex bridge directory in container: {}",
                e
            )
        })?;

    client
        .upload_file_to_container(container_id, "/opt/codex-bridge/package.json", package_json)
        .await
        .map_err(|e| format!("Failed to upload Codex bridge package.json: {}", e))?;

    client
        .upload_file_to_container(container_id, "/opt/codex-bridge/dist/index.js", dist_index)
        .await
        .map_err(|e| format!("Failed to upload Codex bridge bundle: {}", e))?;

    let (_, _, node_modules_exit_code) = client
        .exec_command_with_status(
            container_id,
            vec!["bash", "-lc", "test -d /opt/codex-bridge/node_modules"],
        )
        .await
        .map_err(|e| format!("Failed to inspect Codex bridge dependencies: {}", e))?;

    if bridge_exit_code == 0 && node_modules_exit_code == 0 {
        debug!(container_id = %container_id, "Synced Codex bridge bundle into container");
        return Ok(());
    }

    info!(container_id = %container_id, "Bootstrapping Codex bridge dependencies into container");

    let (stdout, stderr, install_exit_code) = client
        .exec_command_with_status(
            container_id,
            vec![
                "bash",
                "-lc",
                "cd /opt/codex-bridge && npm install --omit=dev --no-audit --no-fund",
            ],
        )
        .await
        .map_err(|e| format!("Failed to install Codex bridge dependencies: {}", e))?;

    if install_exit_code != 0 {
        return Err(format!(
            "Failed to install Codex bridge dependencies (exit {}): {}{}{}",
            install_exit_code,
            stdout.trim(),
            if !stdout.trim().is_empty() && !stderr.trim().is_empty() {
                "\n"
            } else {
                ""
            },
            stderr.trim()
        ));
    }

    Ok(())
}

#[tauri::command]
pub async fn start_codex_server(
    app_handle: tauri::AppHandle,
    container_id: String,
) -> Result<CodexServerStartResult, String> {
    info!(container_id = %container_id, "Starting Codex bridge server");

    let client = docker::client::get_docker_client().map_err(|e| e.to_string())?;
    let is_running = client
        .is_container_running(&container_id)
        .await
        .map_err(|e| e.to_string())?;

    if !is_running {
        return Err("Container is not running".to_string());
    }

    let host_port = client
        .get_host_port(&container_id, CODEX_BRIDGE_PORT, "tcp")
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Codex bridge server port (4098) is not mapped".to_string())?;

    let health_url = format!("http://127.0.0.1:{}/global/health", host_port);
    if let Ok(response) = HEALTH_CLIENT.get(&health_url).send().await {
        if response.status().is_success() {
            return Ok(CodexServerStartResult {
                host_port,
                was_running: true,
            });
        }
    }

    ensure_codex_bridge_present(&app_handle, &client, &container_id).await?;

    let command = r#"
        cd /workspace
        rm -f /tmp/codex-bridge.log
        source /etc/profile 2>/dev/null || true
        source ~/.profile 2>/dev/null || true
        source ~/.bashrc 2>/dev/null || true
        source ~/.zshrc 2>/dev/null || true
        [ -d /usr/local/share/npm-global/bin ] && export PATH="/usr/local/share/npm-global/bin:$PATH"
        [ -d ~/.bun/bin ] && export PATH="$HOME/.bun/bin:$PATH"
        [ -d ~/.local/bin ] && export PATH="$HOME/.local/bin:$PATH"
        export PORT=4098
        export HOSTNAME=0.0.0.0
        export CWD=/workspace
        export CODEX_PATH="$(command -v codex 2>/dev/null || echo codex)"
        setsid node /opt/codex-bridge/dist/index.js > /tmp/codex-bridge.log 2>&1 &
        disown
        sleep 0.5
        echo "Started Codex bridge server"
    "#;

    let exec_result = client
        .exec_in_container(&container_id, vec!["bash", "-c", command], None)
        .await
        .map_err(|e| format!("Failed to start Codex bridge server: {}", e))?;

    debug!(container_id = %container_id, result = %exec_result, "Exec result from starting Codex bridge server");

    let mut attempts: u32 = 0;
    loop {
        attempts += 1;
        tokio::time::sleep(tokio::time::Duration::from_millis(
            SERVER_STARTUP_POLL_INTERVAL_MS,
        ))
        .await;

        match HEALTH_CLIENT.get(&health_url).send().await {
            Ok(response) => {
                if response.status().is_success() {
                    info!(container_id = %container_id, host_port = host_port, attempts = attempts, "Codex bridge server started successfully");
                    return Ok(CodexServerStartResult {
                        host_port,
                        was_running: false,
                    });
                }
            }
            Err(error) => {
                debug!(container_id = %container_id, error = %error, attempts = attempts, "Codex bridge health check failed");
            }
        }

        if attempts >= SERVER_STARTUP_MAX_ATTEMPTS {
            if let Ok(log_content) = client
                .exec_in_container(&container_id, vec!["cat", "/tmp/codex-bridge.log"], None)
                .await
            {
                error!(container_id = %container_id, log = %log_content, "Codex bridge log on timeout");
            }

            if let Ok((stdout, stderr, exit_code)) = client
                .exec_command_with_status(
                    &container_id,
                    vec![
                        "bash",
                        "-lc",
                        "test -f /opt/codex-bridge/dist/index.js; echo dist:$?; test -d /opt/codex-bridge/node_modules; echo node_modules:$?; pgrep -f '/opt/codex-bridge/dist/index.js' || true",
                    ],
                )
                .await
            {
                error!(
                    container_id = %container_id,
                    stdout = %stdout,
                    stderr = %stderr,
                    exit_code = exit_code,
                    "Codex bridge process/bootstrap status on timeout"
                );
            }

            warn!(container_id = %container_id, "Codex bridge server did not start within timeout");
            return Err("Codex bridge server did not start within timeout".to_string());
        }
    }
}

#[tauri::command]
pub async fn stop_codex_server(container_id: String) -> Result<(), String> {
    info!(container_id = %container_id, "Stopping Codex bridge server");

    let client = docker::client::get_docker_client().map_err(|e| e.to_string())?;
    let is_running = client
        .is_container_running(&container_id)
        .await
        .map_err(|e| e.to_string())?;

    if !is_running {
        return Ok(());
    }

    client
        .exec_in_container(
            &container_id,
            vec!["bash", "-c", "pkill -f 'codex-bridge' || true"],
            None,
        )
        .await
        .map_err(|e| format!("Failed to stop Codex bridge server: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn get_codex_server_log(container_id: String) -> Result<String, String> {
    let client = docker::client::get_docker_client().map_err(|e| e.to_string())?;
    let is_running = client
        .is_container_running(&container_id)
        .await
        .map_err(|e| e.to_string())?;

    if !is_running {
        return Err("Container is not running".to_string());
    }

    let log_content = client
        .exec_in_container(&container_id, vec!["cat", "/tmp/codex-bridge.log"], None)
        .await
        .map_err(|e| format!("Failed to read log: {}", e))?;

    if log_content.trim().is_empty() {
        return Ok("Codex bridge log is empty".to_string());
    }

    Ok(log_content)
}

#[tauri::command]
pub async fn get_codex_server_status(container_id: String) -> Result<CodexServerStatus, String> {
    let client = docker::client::get_docker_client().map_err(|e| e.to_string())?;
    let is_running = client
        .is_container_running(&container_id)
        .await
        .map_err(|e| e.to_string())?;

    if !is_running {
        return Ok(CodexServerStatus {
            running: false,
            host_port: None,
        });
    }

    let host_port = match client
        .get_host_port(&container_id, CODEX_BRIDGE_PORT, "tcp")
        .await
        .map_err(|e| e.to_string())?
    {
        Some(port) => port,
        None => {
            return Ok(CodexServerStatus {
                running: false,
                host_port: None,
            });
        }
    };

    let health_url = format!("http://127.0.0.1:{}/global/health", host_port);
    let running = match HEALTH_CLIENT.get(&health_url).send().await {
        Ok(response) => response.status().is_success(),
        Err(_) => false,
    };

    Ok(CodexServerStatus {
        running,
        host_port: if running { Some(host_port) } else { None },
    })
}
