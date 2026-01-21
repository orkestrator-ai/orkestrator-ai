// GitHub integration Tauri commands

use crate::docker::client::get_docker_client;
use crate::models::PrState;

/// PR detection result containing both URL and state
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrDetectionResult {
    pub url: String,
    pub state: PrState,
    pub has_merge_conflicts: bool,
}

/// Detect PR URL and state for the current branch by running gh pr view in the container
#[tauri::command]
pub async fn detect_pr(container_id: String) -> Result<Option<PrDetectionResult>, String> {
    let client = get_docker_client().map_err(|e| e.to_string())?;

    // Check if container is running
    let is_running = client
        .is_container_running(&container_id)
        .await
        .map_err(|e| e.to_string())?;

    if !is_running {
        return Err("Container is not running".to_string());
    }

    // Run: gh pr view --json url,state,mergeable -q '{url: .url, state: .state, mergeable: .mergeable}'
    // This returns JSON with URL, state, and mergeable status
    // mergeable can be: "MERGEABLE", "CONFLICTING", "UNKNOWN"
    let output = client
        .exec_command(
            &container_id,
            vec![
                "gh",
                "pr",
                "view",
                "--json",
                "url,state,mergeable",
                "-q",
                "{url: .url, state: .state, mergeable: .mergeable}",
            ],
        )
        .await
        .map_err(|e| e.to_string())?;

    let trimmed = output.trim();

    // If output is empty, no PR exists
    if trimmed.is_empty() {
        return Ok(None);
    }

    // Try to parse the JSON output first
    // This is the expected success path when a PR exists
    #[derive(serde::Deserialize)]
    struct GhPrView {
        url: String,
        state: String,
        mergeable: Option<String>,
    }

    let pr_view: GhPrView = match serde_json::from_str(trimmed) {
        Ok(parsed) => parsed,
        Err(_) => {
            // JSON parsing failed - this likely means no PR exists
            // or gh CLI returned an error message instead of JSON
            // Fall back to checking for common error indicators
            let trimmed_lower = trimmed.to_lowercase();
            if trimmed_lower.contains("no pull request")
                || trimmed_lower.contains("could not resolve")
                || trimmed_lower.contains("not found")
                || trimmed_lower.contains("error")
                || trimmed_lower.contains("failed")
            {
                return Ok(None);
            }
            // Unexpected non-JSON output that doesn't match known errors
            // Log and return None rather than erroring
            tracing::debug!(output = %trimmed, "Unexpected non-JSON output from gh pr view");
            return Ok(None);
        }
    };

    // Validate URL format
    if !pr_view.url.starts_with("https://")
        || !pr_view.url.contains("github.com/")
        || !pr_view.url.contains("/pull/")
    {
        return Ok(None);
    }

    // Convert state string to PrState enum
    let state = match pr_view.state.to_uppercase().as_str() {
        "OPEN" => PrState::Open,
        "MERGED" => PrState::Merged,
        "CLOSED" => PrState::Closed,
        _ => return Ok(None), // Unknown state
    };

    // Check for merge conflicts
    // mergeable can be: "MERGEABLE", "CONFLICTING", "UNKNOWN"
    let has_merge_conflicts = pr_view
        .mergeable
        .map(|m| m.to_uppercase() == "CONFLICTING")
        .unwrap_or(false);

    Ok(Some(PrDetectionResult {
        url: pr_view.url,
        state,
        has_merge_conflicts,
    }))
}

/// Detect PR URL and state for the current branch by running gh pr view locally
/// Used for local (worktree-based) environments where there's no container
#[tauri::command]
pub async fn detect_pr_local(environment_id: String) -> Result<Option<PrDetectionResult>, String> {
    use crate::storage::get_storage;
    use tokio::process::Command;
    use tracing::debug;

    // Get the environment to find the worktree path
    let storage = get_storage().map_err(|e| e.to_string())?;
    let environment = storage
        .get_environment(&environment_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Environment not found: {}", environment_id))?;

    // Get the worktree path - this only works for local environments
    let worktree_path = environment
        .worktree_path
        .ok_or_else(|| "Environment is not a local environment (no worktree path)".to_string())?;

    debug!(environment_id = %environment_id, worktree_path = %worktree_path, "Detecting PR for local environment");

    // Run: gh pr view --json url,state,mergeable -q '{url: .url, state: .state, mergeable: .mergeable}'
    let output = Command::new("gh")
        .args([
            "pr",
            "view",
            "--json",
            "url,state,mergeable",
            "-q",
            "{url: .url, state: .state, mergeable: .mergeable}",
        ])
        .current_dir(&worktree_path)
        .output()
        .await
        .map_err(|e| format!("Failed to execute gh command: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let trimmed = stdout.trim();

    debug!(stdout = %trimmed, stderr = %stderr, "gh pr view output");

    // If output is empty or command failed, no PR exists
    if trimmed.is_empty() || !output.status.success() {
        return Ok(None);
    }

    // Try to parse the JSON output
    #[derive(serde::Deserialize)]
    struct GhPrView {
        url: String,
        state: String,
        mergeable: Option<String>,
    }

    let pr_view: GhPrView = match serde_json::from_str(trimmed) {
        Ok(parsed) => parsed,
        Err(_) => {
            let trimmed_lower = trimmed.to_lowercase();
            if trimmed_lower.contains("no pull request")
                || trimmed_lower.contains("could not resolve")
                || trimmed_lower.contains("not found")
                || trimmed_lower.contains("error")
                || trimmed_lower.contains("failed")
            {
                return Ok(None);
            }
            debug!(output = %trimmed, "Unexpected non-JSON output from gh pr view (local)");
            return Ok(None);
        }
    };

    // Validate URL format
    if !pr_view.url.starts_with("https://")
        || !pr_view.url.contains("github.com/")
        || !pr_view.url.contains("/pull/")
    {
        return Ok(None);
    }

    // Convert state string to PrState enum
    let state = match pr_view.state.to_uppercase().as_str() {
        "OPEN" => PrState::Open,
        "MERGED" => PrState::Merged,
        "CLOSED" => PrState::Closed,
        _ => return Ok(None),
    };

    // Check for merge conflicts
    let has_merge_conflicts = pr_view
        .mergeable
        .map(|m| m.to_uppercase() == "CONFLICTING")
        .unwrap_or(false);

    Ok(Some(PrDetectionResult {
        url: pr_view.url,
        state,
        has_merge_conflicts,
    }))
}

/// Detect if there's an open PR for the current branch by running gh pr view in the container
#[tauri::command]
pub async fn detect_pr_url(container_id: String) -> Result<Option<String>, String> {
    let client = get_docker_client().map_err(|e| e.to_string())?;

    // Check if container is running
    let is_running = client
        .is_container_running(&container_id)
        .await
        .map_err(|e| e.to_string())?;

    if !is_running {
        return Err("Container is not running".to_string());
    }

    // Run: gh pr view --json url -q '.url'
    // This returns just the URL string if a PR exists, or an error if no PR
    let output = client
        .exec_command(
            &container_id,
            vec!["gh", "pr", "view", "--json", "url", "-q", ".url"],
        )
        .await
        .map_err(|e| e.to_string())?;

    let trimmed = output.trim();
    let trimmed_lower = trimmed.to_lowercase();

    // If output is empty or contains error indicators, return None
    // Using case-insensitive matching for robustness across gh CLI versions
    if trimmed.is_empty()
        || trimmed_lower.contains("no pull request")
        || trimmed_lower.contains("could not resolve")
        || trimmed_lower.contains("not found")
        || trimmed_lower.contains("error")
        || trimmed_lower.contains("failed")
    {
        return Ok(None);
    }

    // Validate it looks like a GitHub PR URL
    // Must start with https:// and contain github.com/...pull/
    if trimmed.starts_with("https://") && trimmed.contains("github.com/") && trimmed.contains("/pull/") {
        return Ok(Some(trimmed.to_string()));
    }

    // If we got unexpected output (not a valid URL), return None
    Ok(None)
}

/// Open a URL in the default browser
/// This uses Tauri's opener plugin
#[tauri::command]
pub async fn open_in_browser(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    app.opener()
        .open_url(&url, None::<&str>)
        .map_err(|e| format!("Failed to open browser: {}", e))
}

/// Get the PR URL for an environment (reads from storage)
#[tauri::command]
pub async fn get_environment_pr_url(environment_id: String) -> Result<Option<String>, String> {
    use crate::storage::get_storage;

    let storage = get_storage().map_err(|e| e.to_string())?;
    let environment = storage
        .get_environment(&environment_id)
        .map_err(|e| e.to_string())?;

    Ok(environment.and_then(|e| e.pr_url))
}

/// Clear the PR URL, state, and merge conflicts for an environment (for resetting)
#[tauri::command]
pub async fn clear_environment_pr(environment_id: String) -> Result<(), String> {
    use crate::storage::get_storage;
    use serde_json::json;

    let storage = get_storage().map_err(|e| e.to_string())?;

    // Set pr_url, pr_state, and has_merge_conflicts to null
    storage
        .update_environment(
            &environment_id,
            json!({ "prUrl": null, "prState": null, "hasMergeConflicts": null }),
        )
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Merge method for PR merging
#[derive(serde::Deserialize, Default, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum MergeMethod {
    #[default]
    Squash,
    Merge,
    Rebase,
}

impl MergeMethod {
    fn as_flag(&self) -> &'static str {
        match self {
            MergeMethod::Squash => "--squash",
            MergeMethod::Merge => "--merge",
            MergeMethod::Rebase => "--rebase",
        }
    }
}

/// Merge the current branch's PR using gh pr merge
#[tauri::command]
pub async fn merge_pr(
    container_id: String,
    method: Option<MergeMethod>,
    delete_branch: Option<bool>,
) -> Result<(), String> {
    use tracing::info;

    let client = get_docker_client().map_err(|e| e.to_string())?;

    // Check if container is running
    let is_running = client
        .is_container_running(&container_id)
        .await
        .map_err(|e| e.to_string())?;

    if !is_running {
        return Err("Container is not running".to_string());
    }

    let merge_method = method.unwrap_or_default();
    let should_delete_branch = delete_branch.unwrap_or(true);

    // Build the command
    let mut cmd = vec!["gh", "pr", "merge", merge_method.as_flag()];

    if should_delete_branch {
        cmd.push("--delete-branch");
    }

    info!(
        container_id = %container_id,
        method = ?merge_method.as_flag(),
        delete_branch = should_delete_branch,
        "Merging PR"
    );

    // Run: gh pr merge --squash --delete-branch (or other options)
    let output = client
        .exec_command(&container_id, cmd)
        .await
        .map_err(|e| e.to_string())?;

    let trimmed = output.trim();
    let trimmed_lower = trimmed.to_lowercase();

    // Check for error indicators
    if trimmed_lower.contains("error")
        || trimmed_lower.contains("failed")
        || trimmed_lower.contains("could not")
        || trimmed_lower.contains("not mergeable")
        || trimmed_lower.contains("merge conflict")
        || trimmed_lower.contains("denied")
        || trimmed_lower.contains("unauthorized")
        || trimmed_lower.contains("permission")
    {
        return Err(format!("Failed to merge PR: {}", trimmed));
    }

    tracing::debug!(container_id = %container_id, output = %trimmed, "gh pr merge output");
    info!(container_id = %container_id, "PR merged successfully");

    Ok(())
}

/// Merge the current branch's PR locally using gh pr merge
/// Used for local (worktree-based) environments where there's no container
#[tauri::command]
pub async fn merge_pr_local(
    environment_id: String,
    method: Option<MergeMethod>,
    _delete_branch: Option<bool>,
) -> Result<(), String> {
    use crate::storage::get_storage;
    use tokio::process::Command;
    use tracing::{debug, info};

    // Get the environment to find the worktree path
    let storage = get_storage().map_err(|e| e.to_string())?;
    let environment = storage
        .get_environment(&environment_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Environment not found: {}", environment_id))?;

    // Get the worktree path - this only works for local environments
    let worktree_path = environment
        .worktree_path
        .ok_or_else(|| "Environment is not a local environment (no worktree path)".to_string())?;

    let merge_method = method.unwrap_or_default();

    // Note: We intentionally do NOT use --delete-branch for worktree-based environments.
    // Worktrees cannot switch to another branch (like main) after merge because that branch
    // is already checked out in the main repository. The user should delete the environment
    // when done, which properly removes the worktree.

    info!(
        environment_id = %environment_id,
        worktree_path = %worktree_path,
        method = ?merge_method.as_flag(),
        "Merging PR (local)"
    );

    // Build the command arguments - no --delete-branch for worktrees
    let args = vec!["pr", "merge", merge_method.as_flag()];

    // Run: gh pr merge --squash (or --merge/--rebase)
    let output = Command::new("gh")
        .args(&args)
        .current_dir(&worktree_path)
        .output()
        .await
        .map_err(|e| format!("Failed to execute gh command: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let trimmed = stdout.trim();
    let stderr_trimmed = stderr.trim();

    debug!(stdout = %trimmed, stderr = %stderr_trimmed, status = ?output.status, "gh pr merge output (local)");

    // Primary check: rely on exit status
    // gh pr merge returns non-zero on actual failures
    if !output.status.success() {
        let error_msg = if !stderr_trimmed.is_empty() {
            stderr_trimmed
        } else if !trimmed.is_empty() {
            trimmed
        } else {
            "Unknown error"
        };
        return Err(format!("Failed to merge PR: {}", error_msg));
    }

    info!(environment_id = %environment_id, "PR merged successfully (local)");

    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn test_url_format() {
        // Simple test to ensure URLs are valid
        let url = "https://github.com/user/repo/pull/123";
        assert!(url.starts_with("https://"));
    }
}
