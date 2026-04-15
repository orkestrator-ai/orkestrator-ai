// GitHub integration Tauri commands

use crate::docker::client::get_docker_client;
use crate::models::PrState;
use crate::storage::Storage;

/// PR detection result containing both URL and state
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrDetectionResult {
    pub url: String,
    pub state: PrState,
    pub has_merge_conflicts: bool,
}

#[derive(serde::Deserialize)]
struct GhPrListEntry {
    url: String,
    state: String,
    mergeable: Option<String>,
    #[serde(rename = "updatedAt")]
    updated_at: Option<String>,
}

struct DetectionCandidate {
    rank: u8,
    updated_at: Option<String>,
    result: PrDetectionResult,
}

fn parse_pr_state(state: &str) -> Option<PrState> {
    match state.to_uppercase().as_str() {
        "OPEN" => Some(PrState::Open),
        "MERGED" => Some(PrState::Merged),
        "CLOSED" => Some(PrState::Closed),
        _ => None,
    }
}

fn pr_state_rank(state: &PrState) -> u8 {
    match state {
        PrState::Open => 2,
        PrState::Merged => 1,
        PrState::Closed => 0,
    }
}

fn is_valid_pr_url(url: &str) -> bool {
    url.starts_with("https://") && url.contains("github.com/") && url.contains("/pull/")
}

fn is_expected_absence_output(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() || trimmed == "[]" {
        return true;
    }

    let lowered = trimmed.to_lowercase();
    lowered.contains("no pull request")
        || lowered.contains("no pull requests match your search")
        || lowered.contains("could not resolve")
        || lowered.contains("not found")
}

fn build_detection_candidate(entry: GhPrListEntry) -> Option<DetectionCandidate> {
    let state = parse_pr_state(&entry.state)?;
    if !is_valid_pr_url(&entry.url) {
        return None;
    }

    let has_merge_conflicts = entry
        .mergeable
        .map(|mergeable| mergeable.eq_ignore_ascii_case("CONFLICTING"))
        .unwrap_or(false);

    Some(DetectionCandidate {
        rank: pr_state_rank(&state),
        updated_at: entry.updated_at,
        result: PrDetectionResult {
            url: entry.url,
            state,
            has_merge_conflicts,
        },
    })
}

fn parse_pr_detection_output(trimmed: &str) -> Option<PrDetectionResult> {
    let entries: Vec<GhPrListEntry> = serde_json::from_str(trimmed).ok()?;

    entries
        .into_iter()
        .filter_map(build_detection_candidate)
        .max_by(|left, right| {
            left.rank
                .cmp(&right.rank)
                .then_with(|| left.updated_at.cmp(&right.updated_at))
        })
        .map(|candidate| candidate.result)
}

fn parse_pr_list_output(trimmed: &str, branch: &str) -> Result<Option<PrDetectionResult>, String> {
    if is_expected_absence_output(trimmed) {
        return Ok(None);
    }

    if let Some(result) = parse_pr_detection_output(trimmed) {
        return Ok(Some(result));
    }

    tracing::debug!(output = %trimmed, branch = %branch, "Unexpected output from gh pr list");
    Err("Failed to parse gh pr list output".to_string())
}

fn parse_local_pr_list_output(
    stdout: &str,
    stderr: &str,
    success: bool,
    branch: &str,
) -> Result<Option<PrDetectionResult>, String> {
    let trimmed = stdout.trim();
    let stderr_trimmed = stderr.trim();

    if !success {
        if (!trimmed.is_empty() && is_expected_absence_output(trimmed))
            || (!stderr_trimmed.is_empty() && is_expected_absence_output(stderr_trimmed))
        {
            return Ok(None);
        }

        tracing::debug!(
            stdout = %trimmed,
            stderr = %stderr_trimmed,
            branch = %branch,
            "gh pr list failed for local environment"
        );

        let error_msg = if !stderr_trimmed.is_empty() {
            stderr_trimmed.to_string()
        } else if !trimmed.is_empty() {
            trimmed.to_string()
        } else {
            "gh pr list failed".to_string()
        };

        return Err(format!("Failed to detect PR: {}", error_msg));
    }

    parse_pr_list_output(trimmed, branch)
}

fn get_environment_pr_url_from_storage(
    storage: &Storage,
    environment_id: &str,
) -> Result<Option<String>, String> {
    let environment = storage
        .get_environment(environment_id)
        .map_err(|e| e.to_string())?;

    Ok(environment.and_then(|e| e.pr_url))
}

fn clear_environment_pr_in_storage(storage: &Storage, environment_id: &str) -> Result<(), String> {
    use serde_json::json;

    storage
        .update_environment(
            environment_id,
            json!({ "prUrl": null, "prState": null, "hasMergeConflicts": null }),
        )
        .map_err(|e| e.to_string())?;

    Ok(())
}

fn build_merge_command(method: MergeMethod, should_delete_branch: bool) -> Vec<&'static str> {
    let mut cmd = vec!["gh", "pr", "merge", method.as_flag()];

    if should_delete_branch {
        cmd.push("--delete-branch");
    }

    cmd
}

fn build_local_merge_args(method: MergeMethod) -> Vec<&'static str> {
    vec!["pr", "merge", method.as_flag()]
}

fn parse_merge_command_result(stdout: &str, stderr: &str, success: bool) -> Result<(), String> {
    if success {
        return Ok(());
    }

    let stdout_trimmed = stdout.trim();
    let stderr_trimmed = stderr.trim();
    let error_msg = if !stderr_trimmed.is_empty() {
        stderr_trimmed.to_string()
    } else if !stdout_trimmed.is_empty() {
        stdout_trimmed.to_string()
    } else {
        "Unknown error".to_string()
    };

    Err(format!("Failed to merge PR: {}", error_msg))
}

/// Detect PR URL and state for the environment's branch by querying GitHub for that head branch
/// Uses the stored branch explicitly so detection is independent of the current checkout
#[tauri::command]
pub async fn detect_pr(
    container_id: String,
    branch: String,
) -> Result<Option<PrDetectionResult>, String> {
    if branch.trim().is_empty() {
        return Err("Branch name cannot be empty".to_string());
    }

    let client = get_docker_client().map_err(|e| e.to_string())?;

    // Check if container is running
    let is_running = client
        .is_container_running(&container_id)
        .await
        .map_err(|e| e.to_string())?;

    if !is_running {
        return Err("Container is not running".to_string());
    }

    // Run: gh pr list --head <branch> --state all --json ...
    // Query by head branch explicitly so detection keeps following the environment's
    // stored branch even after background renames or checkout changes.
    // Use exec_command_stdout to only capture stdout, as gh CLI may output
    // progress messages to stderr which would corrupt JSON parsing.
    let output = client
        .exec_command_stdout(
            &container_id,
            vec![
                "gh",
                "pr",
                "list",
                "--head",
                &branch,
                "--state",
                "all",
                "--limit",
                "30",
                "--json",
                "url,state,mergeable,updatedAt",
            ],
        )
        .await
        .map_err(|e| e.to_string())?;

    parse_pr_list_output(output.trim(), &branch)
}

/// Detect PR URL and state for the environment's branch by querying GitHub for that head branch
/// Uses the stored branch explicitly so detection is independent of the current checkout
/// Used for local (worktree-based) environments where there's no container
#[tauri::command]
pub async fn detect_pr_local(
    environment_id: String,
    branch: String,
) -> Result<Option<PrDetectionResult>, String> {
    use crate::storage::get_storage;
    use tokio::process::Command;
    use tracing::debug;

    if branch.trim().is_empty() {
        return Err("Branch name cannot be empty".to_string());
    }

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

    debug!(environment_id = %environment_id, worktree_path = %worktree_path, branch = %branch, "Detecting PR for local environment");

    // Run: gh pr list --head <branch> --state all --json ...
    // Query by head branch explicitly so detection keeps following the environment's
    // stored branch even after background renames or checkout changes.
    let output = Command::new("gh")
        .args([
            "pr",
            "list",
            "--head",
            &branch,
            "--state",
            "all",
            "--limit",
            "30",
            "--json",
            "url,state,mergeable,updatedAt",
        ])
        .current_dir(&worktree_path)
        .output()
        .await
        .map_err(|e| format!("Failed to execute gh command: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    debug!(stdout = %stdout.trim(), stderr = %stderr.trim(), "gh pr list output");

    parse_local_pr_list_output(&stdout, &stderr, output.status.success(), &branch)
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

/// Reveal a file or directory in the system file manager (Finder / Explorer)
#[tauri::command]
pub async fn reveal_in_file_manager(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    app.opener()
        .reveal_item_in_dir(std::path::Path::new(&path))
        .map_err(|e| format!("Failed to reveal path: {}", e))
}

/// Get the PR URL for an environment (reads from storage)
#[tauri::command]
pub async fn get_environment_pr_url(environment_id: String) -> Result<Option<String>, String> {
    use crate::storage::get_storage;

    let storage = get_storage().map_err(|e| e.to_string())?;
    get_environment_pr_url_from_storage(storage, &environment_id)
}

/// Clear the PR URL, state, and merge conflicts for an environment (for resetting)
#[tauri::command]
pub async fn clear_environment_pr(environment_id: String) -> Result<(), String> {
    use crate::storage::get_storage;

    let storage = get_storage().map_err(|e| e.to_string())?;
    clear_environment_pr_in_storage(storage, &environment_id)
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

    let cmd = build_merge_command(merge_method, should_delete_branch);

    info!(
        container_id = %container_id,
        method = ?merge_method.as_flag(),
        delete_branch = should_delete_branch,
        "Merging PR"
    );

    // Run: gh pr merge --squash --delete-branch (or other options)
    // Use exec_command_with_status to check the exit code for success/failure.
    // String-based error detection is unreliable because after a successful merge with
    // --delete-branch, git may auto-pull and output file paths that contain words like
    // "permission" or "error" (e.g. "permissions-check/page.tsx").
    let (stdout, stderr, exit_code) = client
        .exec_command_with_status(&container_id, cmd)
        .await
        .map_err(|e| e.to_string())?;

    tracing::debug!(
        container_id = %container_id,
        stdout = %stdout.trim(),
        stderr = %stderr.trim(),
        exit_code = exit_code,
        "gh pr merge output"
    );

    parse_merge_command_result(&stdout, &stderr, exit_code == 0)?;

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
    let args = build_local_merge_args(merge_method);

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
    // gh pr merge returns non-zero on actual failures.
    parse_merge_command_result(trimmed, stderr_trimmed, output.status.success())?;

    info!(environment_id = %environment_id, "PR merged successfully (local)");

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        build_local_merge_args, build_merge_command, clear_environment_pr_in_storage, detect_pr,
        detect_pr_local, get_environment_pr_url_from_storage, is_expected_absence_output,
        parse_local_pr_list_output, parse_merge_command_result, parse_pr_detection_output,
        parse_pr_list_output, MergeMethod,
    };
    use crate::models::{Environment, PrState};
    use crate::storage::Storage;
    use tempfile::tempdir;

    fn create_test_storage() -> Storage {
        let temp_dir = tempdir().expect("tempdir should be created");
        Storage::new_for_tests(temp_dir.keep())
    }

    #[test]
    fn parse_pr_detection_output_prefers_open_pr_for_branch() {
        let parsed = parse_pr_detection_output(
            r#"[
                {"url":"https://github.com/org/repo/pull/11","state":"MERGED","mergeable":"MERGEABLE","updatedAt":"2026-04-15T09:00:00Z"},
                {"url":"https://github.com/org/repo/pull/12","state":"OPEN","mergeable":"CONFLICTING","updatedAt":"2026-04-15T10:00:00Z"}
            ]"#,
        )
        .expect("expected PR detection result");

        assert_eq!(parsed.url, "https://github.com/org/repo/pull/12");
        assert_eq!(parsed.state, PrState::Open);
        assert!(parsed.has_merge_conflicts);
    }

    #[test]
    fn parse_pr_detection_output_ignores_invalid_entries() {
        let parsed = parse_pr_detection_output(
            r#"[
                {"url":"https://example.com/not-a-pr","state":"OPEN","mergeable":"MERGEABLE","updatedAt":"2026-04-15T09:00:00Z"},
                {"url":"https://github.com/org/repo/pull/13","state":"CLOSED","mergeable":"UNKNOWN","updatedAt":"2026-04-15T11:00:00Z"}
            ]"#,
        )
        .expect("expected fallback PR detection result");

        assert_eq!(parsed.url, "https://github.com/org/repo/pull/13");
        assert_eq!(parsed.state, PrState::Closed);
        assert!(!parsed.has_merge_conflicts);
    }

    #[test]
    fn expected_absence_output_treats_empty_array_as_no_pr() {
        assert!(is_expected_absence_output("[]"));
    }

    #[test]
    fn parse_pr_detection_output_prefers_most_recent_same_state() {
        let parsed = parse_pr_detection_output(
            r#"[
                {"url":"https://github.com/org/repo/pull/21","state":"OPEN","mergeable":"MERGEABLE","updatedAt":"2026-04-15T09:00:00Z"},
                {"url":"https://github.com/org/repo/pull/22","state":"OPEN","mergeable":"MERGEABLE","updatedAt":"2026-04-15T10:00:00Z"}
            ]"#,
        )
        .expect("expected PR detection result");

        assert_eq!(parsed.url, "https://github.com/org/repo/pull/22");
        assert_eq!(parsed.state, PrState::Open);
    }

    #[test]
    fn parse_pr_list_output_returns_error_on_unexpected_output() {
        let error = parse_pr_list_output("warning: something odd happened", "feature/test")
            .expect_err("unexpected output should fail");

        assert!(error.contains("Failed to parse"));
    }

    #[test]
    fn parse_local_pr_list_output_treats_known_absence_as_no_pr() {
        let parsed = parse_local_pr_list_output(
            "",
            "no pull requests match your search",
            false,
            "feature/test",
        )
        .expect("known absence should not error");

        assert!(parsed.is_none());
    }

    #[test]
    fn parse_local_pr_list_output_returns_error_for_real_failures() {
        let error = parse_local_pr_list_output(
            "",
            "authentication failed for github.com",
            false,
            "feature/test",
        )
        .expect_err("unexpected failures should surface");

        assert!(error.contains("authentication failed"));
    }

    #[test]
    fn get_environment_pr_url_from_storage_returns_stored_url() {
        let storage = create_test_storage();
        let mut environment = Environment::new("project-1".to_string());
        environment.pr_url = Some("https://github.com/org/repo/pull/42".to_string());
        storage
            .add_environment(environment.clone())
            .expect("environment should save");

        let pr_url = get_environment_pr_url_from_storage(&storage, &environment.id)
            .expect("PR URL should load");

        assert_eq!(
            pr_url,
            Some("https://github.com/org/repo/pull/42".to_string())
        );
    }

    #[test]
    fn clear_environment_pr_in_storage_clears_all_metadata() {
        let storage = create_test_storage();
        let mut environment = Environment::new("project-1".to_string());
        environment.pr_url = Some("https://github.com/org/repo/pull/42".to_string());
        environment.pr_state = Some(PrState::Open);
        environment.has_merge_conflicts = Some(true);
        storage
            .add_environment(environment.clone())
            .expect("environment should save");

        clear_environment_pr_in_storage(&storage, &environment.id)
            .expect("PR metadata should clear");

        let updated = storage
            .get_environment(&environment.id)
            .expect("environment should load")
            .expect("environment should exist");

        assert!(updated.pr_url.is_none());
        assert!(updated.pr_state.is_none());
        assert!(updated.has_merge_conflicts.is_none());
    }

    #[test]
    fn build_merge_command_includes_delete_branch_when_requested() {
        let command = build_merge_command(MergeMethod::Squash, true);
        assert_eq!(
            command,
            vec!["gh", "pr", "merge", "--squash", "--delete-branch"]
        );
    }

    #[test]
    fn build_local_merge_args_never_include_delete_branch() {
        let args = build_local_merge_args(MergeMethod::Rebase);
        assert_eq!(args, vec!["pr", "merge", "--rebase"]);
    }

    #[test]
    fn parse_merge_command_result_prefers_stderr_on_failure() {
        let error = parse_merge_command_result("stdout message", "stderr message", false)
            .expect_err("failure should use stderr");

        assert_eq!(error, "Failed to merge PR: stderr message");
    }

    #[tokio::test]
    async fn detect_pr_rejects_empty_branch() {
        let error = detect_pr("container-1".to_string(), "   ".to_string())
            .await
            .expect_err("empty branch should be rejected");

        assert_eq!(error, "Branch name cannot be empty");
    }

    #[tokio::test]
    async fn detect_pr_local_rejects_empty_branch() {
        let error = detect_pr_local("env-1".to_string(), "".to_string())
            .await
            .expect_err("empty branch should be rejected");

        assert_eq!(error, "Branch name cannot be empty");
    }
}
