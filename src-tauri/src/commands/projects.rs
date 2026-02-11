// Project management Tauri commands

use crate::models::Project;
use crate::storage::{get_storage, StorageError};

/// Convert storage errors to string for Tauri
fn storage_error_to_string(err: StorageError) -> String {
    err.to_string()
}

/// Get all projects
#[tauri::command]
pub async fn get_projects() -> Result<Vec<Project>, String> {
    let storage = get_storage().map_err(storage_error_to_string)?;
    storage.load_projects().map_err(storage_error_to_string)
}

/// Add a new project
#[tauri::command]
pub async fn add_project(git_url: String, local_path: Option<String>) -> Result<Project, String> {
    // Validate git URL
    if !is_valid_git_url(&git_url) {
        return Err("Invalid Git URL format".to_string());
    }

    // Convert SSH URLs to HTTPS for token-based authentication
    let normalized_url = convert_ssh_to_https(&git_url);

    let storage = get_storage().map_err(storage_error_to_string)?;
    let project = Project::new(normalized_url, local_path);
    storage
        .add_project(project)
        .map_err(storage_error_to_string)
}

/// Remove a project by ID
#[tauri::command]
pub async fn remove_project(project_id: String) -> Result<(), String> {
    let storage = get_storage().map_err(storage_error_to_string)?;
    storage
        .remove_project(&project_id)
        .map_err(storage_error_to_string)
}

/// Get a project by ID
#[tauri::command]
pub async fn get_project(project_id: String) -> Result<Option<Project>, String> {
    let storage = get_storage().map_err(storage_error_to_string)?;
    storage
        .get_project(&project_id)
        .map_err(storage_error_to_string)
}

/// Update a project
#[tauri::command]
pub async fn update_project(
    project_id: String,
    updates: serde_json::Value,
) -> Result<Project, String> {
    let storage = get_storage().map_err(storage_error_to_string)?;
    storage
        .update_project(&project_id, updates)
        .map_err(storage_error_to_string)
}

/// Reorder projects based on the provided array of project IDs
/// The order of IDs determines the new display order
#[tauri::command]
pub async fn reorder_projects(project_ids: Vec<String>) -> Result<Vec<Project>, String> {
    let storage = get_storage().map_err(storage_error_to_string)?;
    storage
        .reorder_projects(&project_ids)
        .map_err(storage_error_to_string)
}

/// Validate a Git URL format
#[tauri::command]
pub fn validate_git_url(url: String) -> bool {
    is_valid_git_url(&url)
}

/// Get the git remote URL from a local directory
/// Automatically converts SSH URLs to HTTPS for token-based authentication
#[tauri::command]
pub async fn get_git_remote_url(path: String) -> Result<Option<String>, String> {
    use std::process::Command;

    let output = Command::new("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(&path)
        .output()
        .map_err(|e| format!("Failed to execute git command: {}", e))?;

    if output.status.success() {
        let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if url.is_empty() {
            Ok(None)
        } else {
            // Convert SSH URLs to HTTPS for token-based authentication
            Ok(Some(convert_ssh_to_https(&url)))
        }
    } else {
        // No remote found or not a git repo - not an error, just return None
        Ok(None)
    }
}

/// Check if a string is a valid Git URL
fn is_valid_git_url(url: &str) -> bool {
    let url = url.trim();

    // SSH format: git@github.com:user/repo.git
    if url.starts_with("git@") {
        return url.contains(':') && (url.contains('/') || url.ends_with(".git"));
    }

    // HTTPS format: https://github.com/user/repo.git
    if url.starts_with("https://") || url.starts_with("http://") {
        return url.contains("github.com")
            || url.contains("gitlab.com")
            || url.contains("bitbucket.org")
            || url.ends_with(".git");
    }

    false
}

/// Convert SSH git URL to HTTPS format for token-based authentication
/// Supports: git@host:user/repo.git -> https://host/user/repo.git
fn convert_ssh_to_https(url: &str) -> String {
    let url = url.trim();

    // Already HTTPS - return as-is
    if url.starts_with("https://") || url.starts_with("http://") {
        return url.to_string();
    }

    // SSH format: git@github.com:user/repo.git
    if url.starts_with("git@") {
        // Extract host and path: git@github.com:user/repo.git -> (github.com, user/repo.git)
        if let Some(at_pos) = url.find('@') {
            let after_at = &url[at_pos + 1..];
            if let Some(colon_pos) = after_at.find(':') {
                let host = &after_at[..colon_pos];
                let path = &after_at[colon_pos + 1..];
                return format!("https://{}/{}", host, path);
            }
        }
    }

    // ssh://git@github.com/user/repo.git format
    if url.starts_with("ssh://") {
        let without_scheme = url.strip_prefix("ssh://").unwrap_or(url);
        // Remove git@ prefix if present
        let without_user = without_scheme
            .strip_prefix("git@")
            .unwrap_or(without_scheme);
        return format!("https://{}", without_user);
    }

    // git:// protocol (rare but valid)
    if url.starts_with("git://") {
        let without_scheme = url.strip_prefix("git://").unwrap_or(url);
        return format!("https://{}", without_scheme);
    }

    // Unknown format - return as-is
    url.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_valid_git_urls() {
        assert!(is_valid_git_url("git@github.com:user/repo.git"));
        assert!(is_valid_git_url("https://github.com/user/repo.git"));
        assert!(is_valid_git_url("https://github.com/user/repo"));
        assert!(is_valid_git_url("git@gitlab.com:user/repo.git"));
    }

    #[test]
    fn test_invalid_git_urls() {
        assert!(!is_valid_git_url(""));
        assert!(!is_valid_git_url("not-a-url"));
        assert!(!is_valid_git_url("ftp://github.com/repo"));
    }

    #[test]
    fn test_ssh_to_https_conversion() {
        // Standard SSH format
        assert_eq!(
            convert_ssh_to_https("git@github.com:user/repo.git"),
            "https://github.com/user/repo.git"
        );
        assert_eq!(
            convert_ssh_to_https("git@gitlab.com:org/project.git"),
            "https://gitlab.com/org/project.git"
        );
        assert_eq!(
            convert_ssh_to_https("git@bitbucket.org:team/repo.git"),
            "https://bitbucket.org/team/repo.git"
        );

        // Nested paths
        assert_eq!(
            convert_ssh_to_https("git@github.com:org/team/repo.git"),
            "https://github.com/org/team/repo.git"
        );

        // Without .git suffix
        assert_eq!(
            convert_ssh_to_https("git@github.com:user/repo"),
            "https://github.com/user/repo"
        );
    }

    #[test]
    fn test_ssh_scheme_conversion() {
        assert_eq!(
            convert_ssh_to_https("ssh://git@github.com/user/repo.git"),
            "https://github.com/user/repo.git"
        );
        assert_eq!(
            convert_ssh_to_https("ssh://github.com/user/repo.git"),
            "https://github.com/user/repo.git"
        );
    }

    #[test]
    fn test_git_scheme_conversion() {
        assert_eq!(
            convert_ssh_to_https("git://github.com/user/repo.git"),
            "https://github.com/user/repo.git"
        );
    }

    #[test]
    fn test_https_passthrough() {
        // HTTPS URLs should pass through unchanged
        assert_eq!(
            convert_ssh_to_https("https://github.com/user/repo.git"),
            "https://github.com/user/repo.git"
        );
        assert_eq!(
            convert_ssh_to_https("http://github.com/user/repo.git"),
            "http://github.com/user/repo.git"
        );
    }

    #[test]
    fn test_whitespace_handling() {
        assert_eq!(
            convert_ssh_to_https("  git@github.com:user/repo.git  "),
            "https://github.com/user/repo.git"
        );
    }
}
