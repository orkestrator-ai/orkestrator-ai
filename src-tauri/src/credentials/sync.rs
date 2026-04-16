// Background task that keeps Claude credentials in sync between the macOS
// Keychain and any running Orkestrator containers. Without this, a container
// created with a snapshot of credentials will start failing once the host's
// copy is refreshed (refresh tokens are single-use and get rotated).

use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tracing::{debug, info, warn};

use crate::credentials::{self, CredentialsError};
use crate::docker::{
    container::{CONTAINER_LABEL_APP, CONTAINER_LABEL_APP_VALUE},
    get_docker_client,
};

const SYNC_INTERVAL: Duration = Duration::from_secs(60);
const CREDENTIALS_PATH_IN_CONTAINER: &str = "/home/node/.claude/.credentials.json";
const NODE_UID: u64 = 1000;
const NODE_GID: u64 = 1000;
const CREDENTIALS_EVENT: &str = "claude-credentials-error";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CredentialsErrorPayload {
    pub message: String,
    pub kind: &'static str,
}

fn emit_error(app: &AppHandle, kind: &'static str, message: impl Into<String>) {
    let payload = CredentialsErrorPayload {
        message: message.into(),
        kind,
    };
    if let Err(e) = app.emit(CREDENTIALS_EVENT, &payload) {
        warn!(error = ?e, "Failed to emit credentials error event");
    }
}

/// Push a credentials JSON blob into a single container.
async fn push_to_container(container_id: &str, creds_json: &[u8]) -> Result<(), String> {
    let client = get_docker_client().map_err(|e| e.to_string())?;
    client
        .upload_file_to_container_with_metadata(
            container_id,
            CREDENTIALS_PATH_IN_CONTAINER,
            creds_json.to_vec(),
            0o600,
            NODE_UID,
            NODE_GID,
        )
        .await
        .map_err(|e| e.to_string())
}

/// List running orkestrator-managed container IDs.
async fn list_running_managed_containers() -> Result<Vec<String>, String> {
    let client = get_docker_client().map_err(|e| e.to_string())?;
    let label = format!("{}={}", CONTAINER_LABEL_APP, CONTAINER_LABEL_APP_VALUE);
    let containers = client
        .list_containers(false, Some(&label))
        .await
        .map_err(|e| e.to_string())?;
    Ok(containers.into_iter().filter_map(|c| c.id).collect())
}

/// One tick of the sync loop. Returns true if credentials were pushed.
async fn sync_once(
    app: &AppHandle,
    last_synced_token: &mut Option<String>,
) -> Result<bool, CredentialsError> {
    let running = match list_running_managed_containers().await {
        Ok(ids) => ids,
        Err(e) => {
            debug!(error = %e, "Skipping credential sync tick: could not list containers");
            return Ok(false);
        }
    };

    if running.is_empty() {
        return Ok(false);
    }

    let creds = credentials::get_or_refresh_claude_credentials().await?;
    let token = creds.claude_ai_oauth.access_token.clone();

    if last_synced_token.as_deref() == Some(token.as_str()) {
        return Ok(false);
    }

    let json = serde_json::to_vec(&creds).map_err(|e| {
        CredentialsError::ParseError(format!("Failed to serialize credentials: {}", e))
    })?;

    let mut failures: Vec<String> = Vec::new();
    for container_id in &running {
        if let Err(e) = push_to_container(container_id, &json).await {
            failures.push(format!("{}: {}", &container_id[..12.min(container_id.len())], e));
        }
    }

    if !failures.is_empty() {
        emit_error(
            app,
            "push_failed",
            format!(
                "Failed to push refreshed Claude credentials to {} container(s): {}",
                failures.len(),
                failures.join("; ")
            ),
        );
    }

    *last_synced_token = Some(token);
    info!(
        containers = running.len() - failures.len(),
        "Synced refreshed Claude credentials to running containers"
    );
    Ok(true)
}

/// Run the credential-sync loop forever. Intended to be spawned as a background
/// task from the Tauri `setup` hook.
pub async fn run_sync_loop(app: AppHandle) {
    let mut interval = tokio::time::interval(SYNC_INTERVAL);
    // Skip the immediate first tick; wait a full interval before the first run
    // so startup doesn't race with container creation.
    interval.tick().await;

    let mut last_synced_token: Option<String> = None;
    let mut consecutive_errors = 0u32;

    loop {
        interval.tick().await;

        match sync_once(&app, &mut last_synced_token).await {
            Ok(_) => {
                consecutive_errors = 0;
            }
            Err(e) => {
                consecutive_errors = consecutive_errors.saturating_add(1);
                // Only surface to the UI after a couple of failures in a row,
                // to avoid flapping on transient network hiccups.
                if consecutive_errors == 2 {
                    emit_error(
                        &app,
                        "refresh_failed",
                        format!(
                            "Claude credential refresh is failing: {}. Containers may hit 401 errors until the host's `claude` CLI re-authenticates.",
                            e
                        ),
                    );
                }
                warn!(error = ?e, consecutive_errors, "Credential sync tick failed");
            }
        }
    }
}
