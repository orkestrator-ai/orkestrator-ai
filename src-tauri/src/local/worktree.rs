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

/// Generate a unique worktree path, adding suffix if the base name already exists
pub fn generate_worktree_path(project_name: &str) -> Result<PathBuf, WorktreeError> {
    let base_path = get_worktree_base_path()?;

    // Try the project name first
    let mut worktree_path = base_path.join(project_name);

    // If it exists, add a unique suffix
    if worktree_path.exists() {
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
            worktree_path = base_path.join(name_with_suffix);

            if !worktree_path.exists() {
                break;
            }
        }
    }

    Ok(worktree_path)
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
            target_branch = generate_unique_branch_name(source_repo_path, branch_name, attempt).await?;
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
            target_branch = generate_unique_branch_name(source_repo_path, branch_name, attempt).await?;
            continue;
        }

        return Err(WorktreeError::WorktreeCreationFailed(stderr.to_string()));
    }

    info!(
        worktree_path = %worktree_path_str,
        branch = %branch_name,
        "Successfully created git worktree"
    );

    Ok(WorktreeCreateResult {
        path: worktree_path_str,
        branch: target_branch,
    })
}

async fn branch_exists(repo_path: &str, branch_name: &str) -> Result<bool, WorktreeError> {
    let output = Command::new("git")
        .args(["rev-parse", "--verify", &format!("refs/heads/{}", branch_name)])
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
