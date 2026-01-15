// Claude Code activity state polling
// Monitors /tmp/.claude-state in containers and emits events to frontend

use bollard::container::LogOutput;
use bollard::exec::{CreateExecOptions, StartExecResults};
use bollard::Docker;
use futures::StreamExt;
use std::collections::HashMap;
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter, Runtime};
use tokio::sync::Mutex;
use tokio::time::{interval, Duration};
use tracing::{debug, trace, warn};

/// Polling interval for checking Claude state in containers
const POLL_INTERVAL_MS: u64 = 1000;

/// Event payload for claude state changes
#[derive(Clone, serde::Serialize)]
pub struct ClaudeStateEvent {
    pub container_id: String,
    pub state: String,
}

/// Tracks active polling tasks
struct ClaudeStateManager {
    /// Map of container_id -> abort handle
    active_polls: Mutex<HashMap<String, tokio::task::AbortHandle>>,
}

impl ClaudeStateManager {
    fn new() -> Self {
        Self {
            active_polls: Mutex::new(HashMap::new()),
        }
    }

    async fn start_polling<R: Runtime>(
        &self,
        app: AppHandle<R>,
        container_id: String,
    ) -> Result<(), String> {
        let mut polls = self.active_polls.lock().await;

        // If already polling this container, skip
        if polls.contains_key(&container_id) {
            debug!(container_id = %container_id, "Already polling claude state");
            return Ok(());
        }

        let container_id_clone = container_id.clone();
        let container_id_for_task = container_id.clone();

        // Spawn the polling task
        let handle = tokio::spawn(async move {
            let mut poll_interval = interval(Duration::from_millis(POLL_INTERVAL_MS));
            let mut last_state = String::new();

            // Connect to Docker
            let docker = match Docker::connect_with_local_defaults() {
                Ok(d) => d,
                Err(e) => {
                    warn!(error = ?e, "Failed to connect to Docker for state polling");
                    return;
                }
            };

            debug!(container_id = %container_id_for_task, "Starting claude state polling");

            loop {
                poll_interval.tick().await;

                // Read /tmp/.claude-state from container
                let exec_result = docker
                    .create_exec(
                        &container_id_for_task,
                        CreateExecOptions {
                            cmd: Some(vec!["cat", "/tmp/.claude-state"]),
                            attach_stdout: Some(true),
                            attach_stderr: Some(true),
                            ..Default::default()
                        },
                    )
                    .await;

                let exec = match exec_result {
                    Ok(e) => e,
                    Err(e) => {
                        // Container might not be ready yet, or state file doesn't exist
                        trace!(container_id = %container_id_for_task, error = ?e, "Failed to create exec for state polling");
                        continue;
                    }
                };

                let start_result = docker.start_exec(&exec.id, None).await;

                if let Ok(StartExecResults::Attached { mut output, .. }) = start_result {
                    let mut state_output = String::new();
                    while let Some(Ok(chunk)) = output.next().await {
                        match chunk {
                            LogOutput::StdOut { message } | LogOutput::StdErr { message } => {
                                state_output.push_str(&String::from_utf8_lossy(&message));
                            }
                            _ => {}
                        }
                    }
                    let state = state_output.trim().to_string();

                    // Emit if state changed (or first read) and is valid
                    // Valid states: working, waiting, idle
                    let is_valid = state == "working" || state == "waiting" || state == "idle";
                    if is_valid && state != last_state {
                        debug!(
                            container_id = %container_id_for_task,
                            previous_state = %last_state,
                            new_state = %state,
                            "Claude state changed"
                        );
                        last_state = state.clone();

                        let event_name = format!("claude-state-{}", container_id_for_task);
                        let result = app.emit(
                            &event_name,
                            ClaudeStateEvent {
                                container_id: container_id_for_task.clone(),
                                state: state.clone(),
                            },
                        );
                        if let Err(e) = result {
                            warn!(error = ?e, event_name = %event_name, "Failed to emit claude state event");
                        }
                    } else if !state.is_empty() && !is_valid {
                        trace!(
                            container_id = %container_id_for_task,
                            state = %state,
                            "Invalid claude state read (expected 'working', 'waiting', or 'idle')"
                        );
                    }
                }
            }
        });

        // Store the abort handle so we can cancel later
        polls.insert(container_id_clone, handle.abort_handle());
        Ok(())
    }

    async fn stop_polling(&self, container_id: &str) {
        let mut polls = self.active_polls.lock().await;
        if let Some(handle) = polls.remove(container_id) {
            debug!(container_id = %container_id, "Stopping claude state polling");
            handle.abort();
        }
    }
}

// Global manager instance
static CLAUDE_STATE_MANAGER: OnceLock<ClaudeStateManager> = OnceLock::new();

fn get_manager() -> &'static ClaudeStateManager {
    CLAUDE_STATE_MANAGER.get_or_init(ClaudeStateManager::new)
}

/// Start polling claude state for a container
#[tauri::command]
pub async fn start_claude_state_polling<R: Runtime>(
    app: AppHandle<R>,
    container_id: String,
) -> Result<(), String> {
    debug!(container_id = %container_id, "Starting claude state polling");
    get_manager().start_polling(app, container_id).await
}

/// Stop polling claude state for a container
#[tauri::command]
pub async fn stop_claude_state_polling(container_id: String) -> Result<(), String> {
    get_manager().stop_polling(&container_id).await;
    Ok(())
}
