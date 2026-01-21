// Editor integration commands
// Opens VS Code or Cursor attached to a running container or for a local path

use crate::models::PreferredEditor;
use std::path::Path;
use std::process::Command;

/// Open an editor (VS Code or Cursor) attached to a running container
/// Uses the Dev Containers extension's attached container mode
#[tauri::command]
pub async fn open_in_editor(container_id: String, editor: PreferredEditor) -> Result<(), String> {
    // The container ID is already a hex string (e.g., "abc123def456...")
    // The Dev Containers extension expects it hex-encoded as bytes
    // So we encode the UTF-8 bytes of the container ID string
    let hex_id = hex::encode(container_id.as_bytes());

    // Build the VS Code remote URI for attached container
    // Format: vscode-remote://attached-container+{hex_encoded_container_id}/workspace
    // The /workspace path matches the WORKDIR in our Dockerfile
    let uri = format!("vscode-remote://attached-container+{}/workspace", hex_id);

    // Determine the command to run based on editor preference
    let cmd = editor.cli_command();

    // Spawn the editor process
    Command::new(cmd)
        .arg("--folder-uri")
        .arg(&uri)
        .spawn()
        .map_err(|e| {
            format!(
                "Failed to open {}: {}. Make sure the {} CLI is installed and in your PATH.",
                editor.display_name(),
                e,
                editor.display_name()
            )
        })?;

    Ok(())
}

/// Open an editor (VS Code or Cursor) for a local directory path
/// Used for local/worktree environments
#[tauri::command]
pub async fn open_local_in_editor(path: String, editor: PreferredEditor) -> Result<(), String> {
    // Validate that the path exists and is a directory
    let path_ref = Path::new(&path);
    if !path_ref.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    if !path_ref.is_dir() {
        return Err(format!("Path is not a directory: {}", path));
    }

    // Determine the command to run based on editor preference
    let cmd = editor.cli_command();

    // Spawn the editor process with the local path
    Command::new(cmd)
        .arg(&path)
        .spawn()
        .map_err(|e| {
            format!(
                "Failed to open {}: {}. Make sure the {} CLI is installed and in your PATH.",
                editor.display_name(),
                e,
                editor.display_name()
            )
        })?;

    Ok(())
}
