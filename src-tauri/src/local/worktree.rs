//! Git worktree operations for local environments
//!
//! Handles creating, deleting, and managing git worktrees in the
//! ~/orkestrator-ai/workspaces/ directory.

use rand::Rng;
use std::path::{Path, PathBuf};
use thiserror::Error;
use tokio::process::Command;
use tracing::{debug, error, info, warn};

/// Error type for worktree operations
#[derive(Error, Debug)]
pub enum WorktreeError {
    #[error("Source repository not found: {0}")]
    SourceNotFound(String),

    #[error("Failed to create worktree directory: {0}")]
    DirectoryCreationFailed(String),

    #[error("Failed to create worktree: {0}")]
    WorktreeCreationFailed(String),

    #[error("Failed to delete worktree: {0}")]
    WorktreeDeletionFailed(String),

    #[error("Failed to detect default branch: {0}")]
    BranchDetectionFailed(String),

    #[error("Failed to copy env files: {0}")]
    EnvCopyFailed(String),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Home directory not found")]
    HomeDirNotFound,
}

pub struct WorktreeCreateResult {
    pub path: String,
    pub branch: String,
}

/// Base directory for local worktrees
const WORKTREE_BASE_DIR: &str = "orkestrator-ai/workspaces";

/// Get the base path for worktrees: ~/orkestrator-ai/workspaces/
fn get_worktree_base_path() -> Result<PathBuf, WorktreeError> {
    let home = dirs::home_dir().ok_or(WorktreeError::HomeDirNotFound)?;
    Ok(home.join(WORKTREE_BASE_DIR))
}

/// Generate a unique 6-character alphanumeric suffix
fn generate_unique_suffix() -> String {
    const CHARSET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let mut rng = rand::thread_rng();
    (0..6)
        .map(|_| {
            let idx = rng.gen_range(0..CHARSET.len());
            CHARSET[idx] as char
        })
        .collect()
}

/// Maximum attempts to generate a unique worktree path
const MAX_WORKTREE_PATH_ATTEMPTS: u32 = 100;

/// Generate a unique worktree path with a random suffix
///
/// Always includes a unique suffix to ensure all worktree paths are distinct,
/// even the first one created for a project.
pub fn generate_worktree_path(project_name: &str) -> Result<PathBuf, WorktreeError> {
    let base_path = get_worktree_base_path()?;

    // Always generate a unique suffix for the worktree path
    let mut attempts = 0;
    loop {
        attempts += 1;
        if attempts > MAX_WORKTREE_PATH_ATTEMPTS {
            return Err(WorktreeError::DirectoryCreationFailed(format!(
                "Failed to generate unique worktree path after {} attempts for project: {}",
                MAX_WORKTREE_PATH_ATTEMPTS, project_name
            )));
        }

        let suffix = generate_unique_suffix();
        let name_with_suffix = format!("{}-{}", project_name, suffix);
        let worktree_path = base_path.join(name_with_suffix);

        if !worktree_path.exists() {
            return Ok(worktree_path);
        }
    }
}

/// Detect the default branch (main or master) of a git repository
pub async fn get_default_branch(repo_path: &str) -> Result<String, WorktreeError> {
    debug!(repo_path = %repo_path, "Detecting default branch");

    // First, try to get the remote HEAD
    let output = Command::new("git")
        .args(["symbolic-ref", "refs/remotes/origin/HEAD", "--short"])
        .current_dir(repo_path)
        .output()
        .await
        .map_err(|e| WorktreeError::BranchDetectionFailed(e.to_string()))?;

    if output.status.success() {
        let branch = String::from_utf8_lossy(&output.stdout)
            .trim()
            .to_string()
            .replace("origin/", "");
        if !branch.is_empty() {
            debug!(branch = %branch, "Detected default branch from remote HEAD");
            return Ok(branch);
        }
    }

    // Fallback: check if main exists
    let output = Command::new("git")
        .args(["rev-parse", "--verify", "refs/heads/main"])
        .current_dir(repo_path)
        .output()
        .await
        .map_err(|e| WorktreeError::BranchDetectionFailed(e.to_string()))?;

    if output.status.success() {
        debug!("Detected 'main' as default branch");
        return Ok("main".to_string());
    }

    // Fallback: check if master exists
    let output = Command::new("git")
        .args(["rev-parse", "--verify", "refs/heads/master"])
        .current_dir(repo_path)
        .output()
        .await
        .map_err(|e| WorktreeError::BranchDetectionFailed(e.to_string()))?;

    if output.status.success() {
        debug!("Detected 'master' as default branch");
        return Ok("master".to_string());
    }

    // Final fallback
    warn!(repo_path = %repo_path, "Could not detect default branch, falling back to 'main'");
    Ok("main".to_string())
}

/// Add a pattern to the .git/info/exclude file
///
/// For worktrees, this resolves the actual git directory from the .git file.
/// The pattern is only added if it doesn't already exist in the exclude file.
pub async fn add_to_git_exclude(worktree_path: &str, pattern: &str) -> Result<(), WorktreeError> {
    let worktree = Path::new(worktree_path);
    let git_path = worktree.join(".git");

    // For worktrees, .git is a file containing "gitdir: <path>"
    // We need to resolve the actual git directory
    let git_dir = if git_path.is_file() {
        let content = tokio::fs::read_to_string(&git_path)
            .await
            .map_err(WorktreeError::Io)?;
        let gitdir_line = content
            .lines()
            .find(|line| line.starts_with("gitdir:"))
            .ok_or_else(|| {
                WorktreeError::Io(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "No gitdir line found in .git file",
                ))
            })?;
        let gitdir = gitdir_line.strip_prefix("gitdir:").unwrap().trim();
        PathBuf::from(gitdir)
    } else if git_path.is_dir() {
        git_path
    } else {
        return Err(WorktreeError::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!(".git not found at {}", git_path.display()),
        )));
    };

    // Create info directory if it doesn't exist
    let info_dir = git_dir.join("info");
    if !info_dir.exists() {
        tokio::fs::create_dir_all(&info_dir)
            .await
            .map_err(WorktreeError::Io)?;
    }

    let exclude_file = info_dir.join("exclude");

    // Read existing content if file exists
    let existing_content = match tokio::fs::read_to_string(&exclude_file).await {
        Ok(content) => content,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(WorktreeError::Io(e)),
    };

    // Check if pattern already exists
    if existing_content.lines().any(|line| line.trim() == pattern) {
        debug!(pattern = %pattern, "Pattern already in git exclude");
        return Ok(());
    }

    // Append the pattern
    let mut new_content = existing_content;
    if !new_content.is_empty() && !new_content.ends_with('\n') {
        new_content.push('\n');
    }
    new_content.push_str(pattern);
    new_content.push('\n');

    tokio::fs::write(&exclude_file, new_content)
        .await
        .map_err(WorktreeError::Io)?;

    debug!(pattern = %pattern, exclude_file = %exclude_file.display(), "Added pattern to git exclude");

    Ok(())
}

/// Create a git worktree for a local environment
///
/// # Arguments
/// * `source_repo_path` - Path to the source git repository
/// * `branch_name` - Name of the new branch to create in the worktree
/// * `project_name` - Name of the project (used for worktree directory name)
///
/// # Returns
/// The path to the created worktree
pub async fn create_worktree(
    source_repo_path: &str,
    branch_name: &str,
    project_name: &str,
) -> Result<WorktreeCreateResult, WorktreeError> {
    info!(
        source = %source_repo_path,
        branch = %branch_name,
        project = %project_name,
        "Creating git worktree for local environment"
    );

    // Verify source repo exists
    if !Path::new(source_repo_path).exists() {
        return Err(WorktreeError::SourceNotFound(source_repo_path.to_string()));
    }

    // Create base directory if it doesn't exist
    let base_path = get_worktree_base_path()?;
    if !base_path.exists() {
        debug!(path = %base_path.display(), "Creating worktree base directory");
        std::fs::create_dir_all(&base_path).map_err(|e| {
            WorktreeError::DirectoryCreationFailed(format!("{}: {}", base_path.display(), e))
        })?;
    }

    // Generate unique worktree path
    let worktree_path = generate_worktree_path(project_name)?;
    let worktree_path_str = worktree_path.to_string_lossy().to_string();

    // Get the default branch to base the worktree on
    let default_branch = get_default_branch(source_repo_path).await?;

    // Fetch from origin to ensure we have the latest commits
    debug!(source = %source_repo_path, "Fetching from origin to get latest commits");
    let fetch_output = Command::new("git")
        .args(["fetch", "origin", &default_branch])
        .current_dir(source_repo_path)
        .output()
        .await;

    if let Err(e) = &fetch_output {
        warn!(error = %e, "Failed to fetch from origin, will branch from local");
    } else if let Ok(output) = &fetch_output {
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            warn!(error = %stderr, "Git fetch failed, will branch from local");
        }
    }

    // Use origin/<default_branch> as the start point to get latest remote commits
    let start_point = format!("origin/{}", default_branch);

    debug!(
        source = %source_repo_path,
        branch = %branch_name,
        default_branch = %default_branch,
        start_point = %start_point,
        worktree_path = %worktree_path_str,
        "Preparing git worktree command"
    );

    // Resolve a usable branch name (avoid branches already checked out in another worktree)
    let mut target_branch = branch_name.to_string();
    let mut attempt = 0;

    loop {
        attempt += 1;
        let branch_exists = branch_exists(source_repo_path, &target_branch).await?;
        let branch_in_use = branch_checked_out(source_repo_path, &target_branch).await?;

        if branch_exists && branch_in_use {
            debug!(
                branch = %target_branch,
                "Branch is already checked out in another worktree; generating a new name"
            );
            target_branch =
                generate_unique_branch_name(source_repo_path, branch_name, attempt).await?;
            continue;
        }

        if branch_exists {
            debug!(branch = %target_branch, "Branch exists; reusing existing branch for worktree");
        }

        // Create the worktree
        // If branch exists, reuse it: git worktree add <path> <branch>
        // Otherwise create a new branch: git worktree add -b <branch> <path> <start-point>
        let output = if branch_exists {
            Command::new("git")
                .args(["worktree", "add", &worktree_path_str, &target_branch])
                .current_dir(source_repo_path)
                .output()
                .await
                .map_err(|e| WorktreeError::WorktreeCreationFailed(e.to_string()))?
        } else {
            Command::new("git")
                .args([
                    "worktree",
                    "add",
                    "-b",
                    &target_branch,
                    &worktree_path_str,
                    &start_point,
                ])
                .current_dir(source_repo_path)
                .output()
                .await
                .map_err(|e| WorktreeError::WorktreeCreationFailed(e.to_string()))?
        };

        if output.status.success() {
            break;
        }

        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        error!(
            branch = %target_branch,
            worktree_path = %worktree_path_str,
            start_point = %start_point,
            status = ?output.status.code(),
            stdout = %stdout,
            stderr = %stderr,
            "Failed to create git worktree"
        );

        if is_branch_in_use_error(&stderr) || is_branch_exists_error(&stderr) {
            target_branch =
                generate_unique_branch_name(source_repo_path, branch_name, attempt).await?;
            continue;
        }

        return Err(WorktreeError::WorktreeCreationFailed(stderr.to_string()));
    }

    info!(
        worktree_path = %worktree_path_str,
        branch = %branch_name,
        "Successfully created git worktree"
    );

    // Add .orkestrator to git exclude file so it's ignored locally
    if let Err(e) = add_to_git_exclude(&worktree_path_str, ".orkestrator").await {
        warn!(error = %e, "Failed to add .orkestrator to git exclude (non-fatal)");
    }

    Ok(WorktreeCreateResult {
        path: worktree_path_str,
        branch: target_branch,
    })
}

async fn branch_exists(repo_path: &str, branch_name: &str) -> Result<bool, WorktreeError> {
    let output = Command::new("git")
        .args([
            "rev-parse",
            "--verify",
            &format!("refs/heads/{}", branch_name),
        ])
        .current_dir(repo_path)
        .output()
        .await
        .map_err(|e| WorktreeError::WorktreeCreationFailed(e.to_string()))?;

    Ok(output.status.success())
}

async fn branch_checked_out(repo_path: &str, branch_name: &str) -> Result<bool, WorktreeError> {
    let output = Command::new("git")
        .args(["worktree", "list", "--porcelain"])
        .current_dir(repo_path)
        .output()
        .await
        .map_err(|e| WorktreeError::WorktreeCreationFailed(e.to_string()))?;

    if !output.status.success() {
        return Ok(false);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let target = format!("branch refs/heads/{}", branch_name);
    Ok(stdout.lines().any(|line| line.trim() == target))
}

async fn generate_unique_branch_name(
    repo_path: &str,
    base_name: &str,
    attempt: usize,
) -> Result<String, WorktreeError> {
    for idx in attempt..=50 {
        let candidate = format!("{}-{}", base_name, idx);
        let exists = branch_exists(repo_path, &candidate).await?;
        let in_use = branch_checked_out(repo_path, &candidate).await?;
        if !exists && !in_use {
            return Ok(candidate);
        }
    }

    Err(WorktreeError::WorktreeCreationFailed(
        "Failed to generate unique branch name for worktree".to_string(),
    ))
}

fn is_branch_in_use_error(stderr: &str) -> bool {
    stderr.contains("is already used by worktree")
}

fn is_branch_exists_error(stderr: &str) -> bool {
    stderr.contains("already exists")
}

/// Delete a git worktree
///
/// # Arguments
/// * `source_repo_path` - Path to the source git repository
/// * `worktree_path` - Path to the worktree to delete
pub async fn delete_worktree(
    source_repo_path: &str,
    worktree_path: &str,
) -> Result<(), WorktreeError> {
    info!(
        source = %source_repo_path,
        worktree = %worktree_path,
        "Deleting git worktree"
    );

    // First, remove the worktree from git's tracking
    let output = Command::new("git")
        .args(["worktree", "remove", "--force", worktree_path])
        .current_dir(source_repo_path)
        .output()
        .await
        .map_err(|e| WorktreeError::WorktreeDeletionFailed(e.to_string()))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        warn!(error = %stderr, "Git worktree remove failed, attempting manual cleanup");

        // If git worktree remove fails, try to clean up manually
        if Path::new(worktree_path).exists() {
            std::fs::remove_dir_all(worktree_path).map_err(|e| {
                WorktreeError::WorktreeDeletionFailed(format!(
                    "Failed to remove directory {}: {}",
                    worktree_path, e
                ))
            })?;
        }

        // Also try to prune the worktree reference
        let _ = Command::new("git")
            .args(["worktree", "prune"])
            .current_dir(source_repo_path)
            .output()
            .await;
    }

    info!(worktree_path = %worktree_path, "Successfully deleted git worktree");

    Ok(())
}

/// Copy .env and .env.local files from source to destination
///
/// # Arguments
/// * `source_path` - Path to the source directory (original project)
/// * `dest_path` - Path to the destination directory (worktree)
pub fn copy_env_files(source_path: &str, dest_path: &str) -> Result<(), WorktreeError> {
    debug!(
        source = %source_path,
        dest = %dest_path,
        "Copying env files to worktree"
    );

    let source = Path::new(source_path);
    let dest = Path::new(dest_path);

    let env_files = [".env", ".env.local"];
    let mut copied_count = 0;

    for file_name in env_files {
        let source_file = source.join(file_name);
        let dest_file = dest.join(file_name);

        if source_file.exists() {
            std::fs::copy(&source_file, &dest_file).map_err(|e| {
                WorktreeError::EnvCopyFailed(format!(
                    "Failed to copy {} to {}: {}",
                    source_file.display(),
                    dest_file.display(),
                    e
                ))
            })?;
            debug!(file = %file_name, "Copied env file");
            copied_count += 1;
        }
    }

    info!(count = copied_count, "Copied env files to worktree");

    Ok(())
}

/// Get setupLocal commands from orkestrator-ai.json without executing them
///
/// Reads the orkestrator-ai.json file from the worktree directory and returns
/// the commands specified in the `setupLocal` field. Does not execute the commands.
///
/// # Arguments
/// * `worktree_path` - Path to the worktree directory
///
/// # Returns
/// A vector of commands to run, or an empty vector if no config file or no commands
pub async fn get_setup_local_commands(worktree_path: &str) -> Vec<String> {
    let config_path = Path::new(worktree_path).join("orkestrator-ai.json");

    // Read and parse the config file
    let config_content = match tokio::fs::read_to_string(&config_path).await {
        Ok(content) => content,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            debug!(worktree_path = %worktree_path, "No orkestrator-ai.json found");
            return vec![];
        }
        Err(e) => {
            warn!(error = %e, "Failed to read orkestrator-ai.json");
            return vec![];
        }
    };

    let config: serde_json::Value = match serde_json::from_str(&config_content) {
        Ok(v) => v,
        Err(e) => {
            warn!(error = %e, "Failed to parse orkestrator-ai.json");
            return vec![];
        }
    };

    // Extract setupLocal field - can be string or array of strings
    match config.get("setupLocal") {
        Some(serde_json::Value::String(s)) => {
            if s.is_empty() {
                vec![]
            } else {
                vec![s.clone()]
            }
        }
        Some(serde_json::Value::Array(arr)) => arr
            .iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .filter(|s| !s.is_empty())
            .collect(),
        _ => {
            debug!(worktree_path = %worktree_path, "No setupLocal field found in orkestrator-ai.json");
            vec![]
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_generate_unique_suffix() {
        let suffix = generate_unique_suffix();
        assert_eq!(suffix.len(), 6);
        assert!(suffix.chars().all(|c| c.is_ascii_alphanumeric()));
    }

    #[test]
    fn test_get_worktree_base_path() {
        let path = get_worktree_base_path();
        assert!(path.is_ok());
        let path = path.unwrap();
        assert!(path.to_string_lossy().contains("orkestrator-ai/workspaces"));
    }

    #[tokio::test]
    async fn test_run_setup_local_no_config_file() {
        let temp_dir = TempDir::new().unwrap();
        let result = run_setup_local(temp_dir.path().to_str().unwrap()).await;

        assert!(result.success);
        assert_eq!(result.commands_run, 0);
        assert!(result.error.is_none());
    }

    #[tokio::test]
    async fn test_run_setup_local_empty_setup_local() {
        let temp_dir = TempDir::new().unwrap();
        let config_path = temp_dir.path().join("orkestrator-ai.json");
        tokio::fs::write(&config_path, r#"{"setupLocal": []}"#)
            .await
            .unwrap();

        let result = run_setup_local(temp_dir.path().to_str().unwrap()).await;

        assert!(result.success);
        assert_eq!(result.commands_run, 0);
        assert!(result.error.is_none());
    }

    #[tokio::test]
    async fn test_run_setup_local_no_setup_local_field() {
        let temp_dir = TempDir::new().unwrap();
        let config_path = temp_dir.path().join("orkestrator-ai.json");
        tokio::fs::write(&config_path, r#"{"run": ["echo hello"]}"#)
            .await
            .unwrap();

        let result = run_setup_local(temp_dir.path().to_str().unwrap()).await;

        assert!(result.success);
        assert_eq!(result.commands_run, 0);
        assert!(result.error.is_none());
    }

    #[tokio::test]
    async fn test_run_setup_local_single_command_string() {
        let temp_dir = TempDir::new().unwrap();
        let config_path = temp_dir.path().join("orkestrator-ai.json");
        tokio::fs::write(&config_path, r#"{"setupLocal": "echo hello"}"#)
            .await
            .unwrap();

        let result = run_setup_local(temp_dir.path().to_str().unwrap()).await;

        assert!(result.success);
        assert_eq!(result.commands_run, 1);
        assert!(result.error.is_none());
    }

    #[tokio::test]
    async fn test_run_setup_local_multiple_commands() {
        let temp_dir = TempDir::new().unwrap();
        let config_path = temp_dir.path().join("orkestrator-ai.json");
        tokio::fs::write(
            &config_path,
            r#"{"setupLocal": ["echo one", "echo two", "echo three"]}"#,
        )
        .await
        .unwrap();

        let result = run_setup_local(temp_dir.path().to_str().unwrap()).await;

        assert!(result.success);
        assert_eq!(result.commands_run, 3);
        assert!(result.error.is_none());
    }

    #[tokio::test]
    async fn test_run_setup_local_failing_command() {
        let temp_dir = TempDir::new().unwrap();
        let config_path = temp_dir.path().join("orkestrator-ai.json");
        tokio::fs::write(
            &config_path,
            r#"{"setupLocal": ["echo success", "exit 1", "echo never_runs"]}"#,
        )
        .await
        .unwrap();

        let result = run_setup_local(temp_dir.path().to_str().unwrap()).await;

        assert!(!result.success);
        assert_eq!(result.commands_run, 1); // Only first command ran successfully
        assert!(result.error.is_some());
        assert!(result.error.unwrap().contains("exit 1"));
    }

    #[tokio::test]
    async fn test_run_setup_local_invalid_json() {
        let temp_dir = TempDir::new().unwrap();
        let config_path = temp_dir.path().join("orkestrator-ai.json");
        tokio::fs::write(&config_path, "not valid json")
            .await
            .unwrap();

        let result = run_setup_local(temp_dir.path().to_str().unwrap()).await;

        assert!(!result.success);
        assert_eq!(result.commands_run, 0);
        assert!(result.error.is_some());
        assert!(result.error.unwrap().contains("Failed to parse"));
    }

    #[tokio::test]
    async fn test_add_to_git_exclude_regular_repo() {
        let temp_dir = TempDir::new().unwrap();
        let git_dir = temp_dir.path().join(".git");
        tokio::fs::create_dir_all(&git_dir).await.unwrap();

        let result = add_to_git_exclude(temp_dir.path().to_str().unwrap(), ".orkestrator").await;
        assert!(result.is_ok());

        // Verify the pattern was added
        let exclude_content = tokio::fs::read_to_string(git_dir.join("info/exclude"))
            .await
            .unwrap();
        assert!(exclude_content.contains(".orkestrator"));
    }

    #[tokio::test]
    async fn test_add_to_git_exclude_pattern_already_exists() {
        let temp_dir = TempDir::new().unwrap();
        let git_dir = temp_dir.path().join(".git");
        let info_dir = git_dir.join("info");
        tokio::fs::create_dir_all(&info_dir).await.unwrap();

        // Pre-populate with the pattern
        tokio::fs::write(info_dir.join("exclude"), ".orkestrator\n")
            .await
            .unwrap();

        let result = add_to_git_exclude(temp_dir.path().to_str().unwrap(), ".orkestrator").await;
        assert!(result.is_ok());

        // Verify pattern wasn't duplicated
        let exclude_content = tokio::fs::read_to_string(info_dir.join("exclude"))
            .await
            .unwrap();
        assert_eq!(exclude_content.matches(".orkestrator").count(), 1);
    }

    #[tokio::test]
    async fn test_add_to_git_exclude_worktree() {
        let temp_dir = TempDir::new().unwrap();

        // Create a fake worktree structure where .git is a file pointing to a gitdir
        let actual_git_dir = temp_dir.path().join("actual_git_dir");
        tokio::fs::create_dir_all(&actual_git_dir).await.unwrap();

        let worktree_dir = temp_dir.path().join("worktree");
        tokio::fs::create_dir_all(&worktree_dir).await.unwrap();

        // Create .git file (not directory) with gitdir reference
        let git_file_content = format!("gitdir: {}", actual_git_dir.display());
        tokio::fs::write(worktree_dir.join(".git"), &git_file_content)
            .await
            .unwrap();

        let result = add_to_git_exclude(worktree_dir.to_str().unwrap(), ".orkestrator").await;
        assert!(result.is_ok());

        // Verify the pattern was added to the actual git directory
        let exclude_content = tokio::fs::read_to_string(actual_git_dir.join("info/exclude"))
            .await
            .unwrap();
        assert!(exclude_content.contains(".orkestrator"));
    }

    #[tokio::test]
    async fn test_add_to_git_exclude_no_git_dir() {
        let temp_dir = TempDir::new().unwrap();

        let result = add_to_git_exclude(temp_dir.path().to_str().unwrap(), ".orkestrator").await;
        assert!(result.is_err());
    }
}
