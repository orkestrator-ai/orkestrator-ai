//! Local server management for OpenCode and Claude-bridge
//!
//! Handles starting, stopping, and monitoring local server processes
//! for local (non-Docker) environments.

use super::process::{get_process_manager, is_process_alive, ProcessType};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::process::Command;
use tracing::{debug, info, warn};

static START_LOCKS: OnceLock<StdMutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> = OnceLock::new();

fn get_start_lock(environment_id: &str) -> Arc<tokio::sync::Mutex<()>> {
    let locks = START_LOCKS.get_or_init(|| StdMutex::new(HashMap::new()));
    let mut map = locks.lock().unwrap();
    map.entry(environment_id.to_string())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

/// Result of starting a local server
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalServerStartResult {
    pub port: u16,
    pub pid: u32,
    pub was_running: bool,
}

/// Status of a local server
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalServerStatus {
    pub running: bool,
    pub port: Option<u16>,
    pub pid: Option<u32>,
}

/// Maximum attempts to wait for server startup
const SERVER_STARTUP_MAX_ATTEMPTS: u32 = 75;
/// Interval between health check attempts (200ms)
const SERVER_STARTUP_POLL_INTERVAL_MS: u64 = 200;

/// Check if a server is healthy by making a request to its health endpoint
async fn check_server_health(port: u16) -> bool {
    let client = Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .ok();

    if let Some(client) = client {
        let url = format!("http://127.0.0.1:{}/global/health", port);
        match client.get(&url).send().await {
            Ok(response) => response.status().is_success(),
            Err(_) => false,
        }
    } else {
        false
    }
}

/// Wait for a server to become healthy
async fn wait_for_server_health(port: u16) -> bool {
    for attempt in 1..=SERVER_STARTUP_MAX_ATTEMPTS {
        if check_server_health(port).await {
            debug!(port = port, attempt = attempt, "Server is healthy");
            return true;
        }
        tokio::time::sleep(Duration::from_millis(SERVER_STARTUP_POLL_INTERVAL_MS)).await;
    }
    warn!(port = port, "Server did not become healthy within timeout");
    false
}

/// Start the OpenCode server for a local environment
///
/// # Arguments
/// * `environment_id` - The environment ID
/// * `worktree_path` - Path to the git worktree (working directory)
/// * `port` - Port to run the server on
///
/// # Returns
/// Result with server start information
pub async fn start_local_opencode_server(
    environment_id: &str,
    worktree_path: &str,
    port: u16,
) -> Result<LocalServerStartResult, String> {
    info!(
        environment_id = %environment_id,
        worktree_path = %worktree_path,
        port = port,
        "Starting local OpenCode server"
    );

    let manager = get_process_manager();

    // Check if already running
    if manager.is_running(environment_id, ProcessType::OpenCode).await {
        if let Some(pid) = manager.get_pid(environment_id, ProcessType::OpenCode).await {
            debug!(environment_id = %environment_id, pid = pid, "OpenCode server already running");
            return Ok(LocalServerStartResult {
                port,
                pid,
                was_running: true,
            });
        }
    }

    // Prepare environment variables
    let mut env_vars = HashMap::new();
    env_vars.insert("TERM".to_string(), "xterm-256color".to_string());

    // Spawn the opencode serve process
    // The opencode CLI should be in the PATH
    let pid = manager
        .spawn(
            environment_id,
            ProcessType::OpenCode,
            "opencode",
            &["serve", "--port", &port.to_string(), "--hostname", "0.0.0.0"],
            worktree_path,
            env_vars,
        )
        .await
        .map_err(|e| format!("Failed to spawn OpenCode server: {}", e))?;

    // Wait for server to become healthy
    if !wait_for_server_health(port).await {
        // Try to kill the process if it didn't start properly
        let _ = manager.kill(environment_id, ProcessType::OpenCode).await;
        return Err("OpenCode server failed to start within timeout".to_string());
    }

    info!(
        environment_id = %environment_id,
        port = port,
        pid = pid,
        "OpenCode server started successfully"
    );

    Ok(LocalServerStartResult {
        port,
        pid,
        was_running: false,
    })
}

/// Stop the OpenCode server for a local environment
pub async fn stop_local_opencode_server(environment_id: &str) -> Result<(), String> {
    info!(environment_id = %environment_id, "Stopping local OpenCode server");

    let manager = get_process_manager();
    manager
        .kill(environment_id, ProcessType::OpenCode)
        .await
        .map_err(|e| format!("Failed to stop OpenCode server: {}", e))?;

    Ok(())
}

/// Get the status of the OpenCode server for a local environment
pub async fn get_local_opencode_status(
    environment_id: &str,
    port: Option<u16>,
    pid: Option<u32>,
) -> LocalServerStatus {
    let manager = get_process_manager();

    // Check if we're tracking this process
    let is_running = if let Some(p) = pid {
        // Check if stored PID is still alive
        if is_process_alive(p) {
            // Verify it's responding to health checks
            if let Some(port) = port {
                check_server_health(port).await
            } else {
                true
            }
        } else {
            false
        }
    } else {
        manager.is_running(environment_id, ProcessType::OpenCode).await
    };

    LocalServerStatus {
        running: is_running,
        port,
        pid,
    }
}

/// Start the Claude-bridge server for a local environment
///
/// # Arguments
/// * `environment_id` - The environment ID
/// * `worktree_path` - Path to the git worktree (working directory)
/// * `port` - Port to run the server on
/// * `bridge_path` - Path to the claude-bridge dist directory
/// * `bundled_bun_path` - Optional path to bundled bun binary (for packaged apps)
///
/// # Returns
/// Result with server start information
pub async fn start_local_claude_bridge(
    environment_id: &str,
    worktree_path: &str,
    port: u16,
    bridge_path: &str,
    bundled_bun_path: Option<&str>,
) -> Result<LocalServerStartResult, String> {
    let start_lock = get_start_lock(environment_id);
    let _guard = start_lock.lock().await;

    info!(
        environment_id = %environment_id,
        worktree_path = %worktree_path,
        port = port,
        bridge_path = %bridge_path,
        "Starting local Claude-bridge server"
    );

    let manager = get_process_manager();

    // Check if already running
    if manager
        .is_running(environment_id, ProcessType::ClaudeBridge)
        .await
    {
        if let Some(pid) = manager
            .get_pid(environment_id, ProcessType::ClaudeBridge)
            .await
        {
            debug!(
                environment_id = %environment_id,
                pid = pid,
                "Claude-bridge server already running"
            );
            return Ok(LocalServerStartResult {
                port,
                pid,
                was_running: true,
            });
        }
    }
    debug!(
        environment_id = %environment_id,
        worktree_path = %worktree_path,
        port = port,
        bridge_path = %bridge_path,
        "Claude-bridge not running; will attempt start"
    );

    // Prepare environment variables
    let mut env_vars = HashMap::new();
    env_vars.insert("PORT".to_string(), port.to_string());
    // Bind to localhost to avoid PNA/CORS restrictions in WebView
    env_vars.insert("HOSTNAME".to_string(), "127.0.0.1".to_string());
    env_vars.insert("TERM".to_string(), "xterm-256color".to_string());

    // Build a comprehensive PATH for packaged apps
    // Start with the current PATH or common locations
    let mut path = std::env::var("PATH").unwrap_or_else(|_| String::new());

    // Add common binary locations that might be missing in packaged apps
    let common_paths = [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
    ];
    for common in common_paths {
        if !path.contains(common) {
            path = if path.is_empty() {
                common.to_string()
            } else {
                format!("{}:{}", path, common)
            };
        }
    }

    // Add bun's directory if found
    if let Some(bun_path) = find_bun_binary() {
        if let Some(parent) = PathBuf::from(&bun_path).parent() {
            let parent_str = parent.to_string_lossy();
            if !path.contains(parent_str.as_ref()) {
                path = format!("{}:{}", parent_str, path);
            }
        }
    }

    // Add node's directory if found
    let node_binary = resolve_node_binary();
    if let Some(ref node_path) = node_binary {
        if let Some(parent) = PathBuf::from(node_path).parent() {
            let parent_str = parent.to_string_lossy();
            if !path.contains(parent_str.as_ref()) {
                path = format!("{}:{}", parent_str, path);
            }
        }
        env_vars.insert("NODE_BINARY".to_string(), node_path.clone());
        env_vars.insert("NODE".to_string(), node_path.clone());
    } else {
        // Hint the SDK where node lives if it supports NODE_BINARY/NODE
        env_vars.insert("NODE_BINARY".to_string(), "node".to_string());
        env_vars.insert("NODE".to_string(), "node".to_string());
    }

    // Add bundled bun directory to PATH if available
    if let Some(bun_path) = bundled_bun_path {
        if let Some(parent) = PathBuf::from(bun_path).parent() {
            let parent_str = parent.to_string_lossy();
            if !path.contains(parent_str.as_ref()) {
                path = format!("{}:{}", parent_str, path);
            }
        }
    }

    env_vars.insert("PATH".to_string(), path.clone());
    debug!(path = %path, "Set PATH for claude-bridge process");

    // The bridge is a Node.js application
    // We need to run: node/bun <bridge_path>/dist/index.js
    let entry_point = format!("{}/dist/index.js", bridge_path);
    ensure_claude_bridge_ready(bridge_path, &entry_point).await?;
    if !Path::new(&entry_point).exists() {
        return Err(format!(
            "Claude-bridge entrypoint missing after readiness check: {}",
            entry_point
        ));
    }

    let (runtime_cmd, runtime_args) = resolve_js_runtime(&entry_point, bundled_bun_path);
    let runtime_args_ref: Vec<&str> = runtime_args.iter().map(String::as_str).collect();

    // The bridge must run from its own directory (where node_modules is located)
    // But we set CWD env var so the Claude SDK operates on the worktree
    env_vars.insert("CWD".to_string(), worktree_path.to_string());

    let pid = manager
        .spawn(
            environment_id,
            ProcessType::ClaudeBridge,
            runtime_cmd,
            &runtime_args_ref,
            bridge_path, // Run from bridge directory so node_modules is accessible
            env_vars,
        )
        .await
        .map_err(|e| format!("Failed to spawn Claude-bridge server: {}", e))?;
    debug!(environment_id = %environment_id, pid = pid, cwd = %bridge_path, "Spawned claude-bridge process");

    // Wait for server to become healthy
    if !wait_for_server_health(port).await {
        // Try to kill the process if it didn't start properly
        let _ = manager.kill(environment_id, ProcessType::ClaudeBridge).await;
        return Err("Claude-bridge server failed to start within timeout".to_string());
    }

    info!(
        environment_id = %environment_id,
        port = port,
        pid = pid,
        "Claude-bridge server started successfully"
    );

    Ok(LocalServerStartResult {
        port,
        pid,
        was_running: false,
    })
}

/// Stop the Claude-bridge server for a local environment
pub async fn stop_local_claude_bridge(environment_id: &str) -> Result<(), String> {
    info!(environment_id = %environment_id, "Stopping local Claude-bridge server");

    let manager = get_process_manager();
    manager
        .kill(environment_id, ProcessType::ClaudeBridge)
        .await
        .map_err(|e| format!("Failed to stop Claude-bridge server: {}", e))?;

    Ok(())
}

/// Get the status of the Claude-bridge server for a local environment
pub async fn get_local_claude_status(
    environment_id: &str,
    port: Option<u16>,
    pid: Option<u32>,
) -> LocalServerStatus {
    let manager = get_process_manager();

    // Check if we're tracking this process
    let is_running = if let Some(p) = pid {
        // Check if stored PID is still alive
        if is_process_alive(p) {
            // Verify it's responding to health checks
            if let Some(port) = port {
                check_server_health(port).await
            } else {
                true
            }
        } else {
            false
        }
    } else {
        manager
            .is_running(environment_id, ProcessType::ClaudeBridge)
            .await
    };

    LocalServerStatus {
        running: is_running,
        port,
        pid,
    }
}

/// Stop all local servers for an environment
pub async fn stop_all_local_servers(environment_id: &str) -> Result<(), String> {
    info!(environment_id = %environment_id, "Stopping all local servers");

    let manager = get_process_manager();
    manager
        .kill_all(environment_id)
        .await
        .map_err(|e| format!("Failed to stop local servers: {}", e))?;

    Ok(())
}

async fn ensure_claude_bridge_ready(bridge_path: &str, entry_point: &str) -> Result<(), String> {
    let entry_path = Path::new(entry_point);
    if entry_path.exists() {
        return Ok(());
    }

    let bridge_dir = Path::new(bridge_path);
    if !bridge_dir.exists() {
        return Err(format!(
            "Claude-bridge directory not found at {}",
            bridge_path
        ));
    }

    let has_package_json = bridge_dir.join("package.json").exists();
    if !has_package_json {
        return Err(format!(
            "Claude-bridge entrypoint missing at {} (no package.json found to build)",
            entry_point
        ));
    }

    info!(
        bridge_path = %bridge_path,
        entry_point = %entry_point,
        "Claude-bridge dist missing; attempting build"
    );

    let install_output = Command::new("bun")
        .args(["install"])
        .current_dir(bridge_path)
        .output()
        .await
        .map_err(|e| format!("Failed to run bun install for claude-bridge: {}", e))?;

    if !install_output.status.success() {
        let stderr = String::from_utf8_lossy(&install_output.stderr);
        let stdout = String::from_utf8_lossy(&install_output.stdout);
        return Err(format!(
            "Claude-bridge bun install failed: {}\n{}",
            stderr, stdout
        ));
    }

    let build_output = Command::new("bun")
        .args(["run", "build"])
        .current_dir(bridge_path)
        .output()
        .await
        .map_err(|e| format!("Failed to run bun build for claude-bridge: {}", e))?;

    if !build_output.status.success() {
        let stderr = String::from_utf8_lossy(&build_output.stderr);
        let stdout = String::from_utf8_lossy(&build_output.stdout);
        return Err(format!(
            "Claude-bridge bun build failed: {}\n{}",
            stderr, stdout
        ));
    }

    if !entry_path.exists() {
        return Err(format!(
            "Claude-bridge build completed but entrypoint is still missing at {}",
            entry_point
        ));
    }

    Ok(())
}

fn resolve_js_runtime(entry_point: &str, bundled_bun_path: Option<&str>) -> (&'static str, Vec<String>) {
    // First, try the bundled bun binary (highest priority for packaged apps)
    if let Some(bun_path) = bundled_bun_path {
        let path = PathBuf::from(bun_path);
        if path.exists() {
            // Ensure the bundled binary has executable permissions
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Ok(metadata) = std::fs::metadata(&path) {
                    let mut perms = metadata.permissions();
                    let mode = perms.mode();
                    // Check if executable bit is set for owner
                    if mode & 0o100 == 0 {
                        debug!(bun_path = %bun_path, "Setting executable permission on bundled bun");
                        perms.set_mode(mode | 0o755);
                        let _ = std::fs::set_permissions(&path, perms);
                    }
                }
            }
            debug!(bun_path = %bun_path, "Using bundled bun runtime");
            let bun_static: &'static str = Box::leak(bun_path.to_string().into_boxed_str());
            return (bun_static, vec![entry_point.to_string()]);
        }
    }

    // Try to find bun in system locations
    if let Some(bun_path) = find_bun_binary() {
        debug!(bun_path = %bun_path, "Using system bun runtime");
        // Leak the string to get a static lifetime - this is fine as we only call this once per server start
        let bun_static: &'static str = Box::leak(bun_path.into_boxed_str());
        return (bun_static, vec![entry_point.to_string()]);
    }

    // Fall back to node
    if let Some(node_path) = resolve_node_binary() {
        debug!(node_path = %node_path, "Using node runtime");
        let node_static: &'static str = Box::leak(node_path.into_boxed_str());
        return (node_static, vec![entry_point.to_string()]);
    }

    // Last resort - try bare commands (works in dev, may fail in packaged app)
    warn!("Could not find bun or node in known locations, falling back to bare command");
    ("node", vec![entry_point.to_string()])
}

/// Get the user's home directory using multiple methods
fn get_home_dir() -> Option<PathBuf> {
    // Try dirs crate first (most reliable)
    if let Some(home) = dirs::home_dir() {
        return Some(home);
    }
    // Fallback to HOME env var
    std::env::var("HOME").ok().map(PathBuf::from)
}

/// Find bun binary by checking common installation locations
fn find_bun_binary() -> Option<String> {
    // Check environment variable first
    if let Ok(path) = std::env::var("BUN_INSTALL") {
        let bun_path = PathBuf::from(&path).join("bin").join("bun");
        if bun_path.exists() {
            return Some(bun_path.to_string_lossy().to_string());
        }
    }

    // Get home directory for user-specific paths
    let home = get_home_dir();

    // Common bun installation locations on macOS
    let candidates: Vec<PathBuf> = vec![
        // Homebrew on Apple Silicon
        PathBuf::from("/opt/homebrew/bin/bun"),
        // Homebrew on Intel
        PathBuf::from("/usr/local/bin/bun"),
        // Bun's default install location
        home.as_ref().map(|h| PathBuf::from(h).join(".bun/bin/bun")).unwrap_or_default(),
    ];

    for candidate in candidates {
        if candidate.exists() && candidate.to_string_lossy() != "" {
            debug!(path = %candidate.display(), "Found bun binary");
            return Some(candidate.to_string_lossy().to_string());
        }
    }

    // Try which as last resort (works if PATH is set correctly)
    if let Ok(output) = std::process::Command::new("which").arg("bun").output() {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() && PathBuf::from(&path).exists() {
                return Some(path);
            }
        }
    }

    None
}

fn resolve_node_binary() -> Option<String> {
    // Check environment variable first
    if let Ok(path) = std::env::var("NODE_BINARY") {
        if !path.is_empty() && PathBuf::from(&path).exists() {
            return Some(path);
        }
    }

    // Get home directory for user-specific paths
    let home = std::env::var("HOME").ok();

    // Common node installation locations on macOS
    let mut candidates: Vec<PathBuf> = vec![
        // Homebrew on Apple Silicon
        PathBuf::from("/opt/homebrew/bin/node"),
        // Homebrew on Intel
        PathBuf::from("/usr/local/bin/node"),
        // System node
        PathBuf::from("/usr/bin/node"),
    ];

    // Add NVM paths if home is available
    if let Some(ref h) = home {
        let nvm_dir = PathBuf::from(h).join(".nvm/versions/node");
        if nvm_dir.exists() {
            // Try to find the default or latest node version
            if let Ok(entries) = std::fs::read_dir(&nvm_dir) {
                let mut versions: Vec<_> = entries
                    .filter_map(|e| e.ok())
                    .filter(|e| e.path().is_dir())
                    .collect();
                // Sort by name descending to get latest version first
                versions.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
                for version in versions {
                    let node_path = version.path().join("bin/node");
                    if node_path.exists() {
                        candidates.insert(0, node_path);
                        break;
                    }
                }
            }
        }

        // Also check fnm (Fast Node Manager)
        let fnm_dir = PathBuf::from(h).join(".fnm/node-versions");
        if fnm_dir.exists() {
            if let Ok(entries) = std::fs::read_dir(&fnm_dir) {
                let mut versions: Vec<_> = entries
                    .filter_map(|e| e.ok())
                    .filter(|e| e.path().is_dir())
                    .collect();
                versions.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
                for version in versions {
                    let node_path = version.path().join("installation/bin/node");
                    if node_path.exists() {
                        candidates.insert(0, node_path);
                        break;
                    }
                }
            }
        }
    }

    for candidate in candidates {
        if candidate.exists() {
            debug!(path = %candidate.display(), "Found node binary");
            return Some(candidate.to_string_lossy().to_string());
        }
    }

    // Try which as last resort
    if let Ok(output) = std::process::Command::new("which").arg("node").output() {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() && PathBuf::from(&path).exists() {
                return Some(path);
            }
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_check_server_health_no_server() {
        // This should return false since no server is running
        let result = check_server_health(59999).await;
        assert!(!result);
    }
}
