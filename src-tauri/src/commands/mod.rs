// Tauri commands module
// Commands are exposed to the frontend via the invoke API

mod claude;
mod claude_cli;
mod claude_state;
mod claude_tmux;
mod codex;
mod config;
pub mod credentials;
mod docker;
mod editor;
mod environments;
mod files;
mod github;
mod kanban;
mod local_servers;
mod local_terminal;
mod network;
mod opencode;
mod projects;
mod sessions;
mod terminal;

pub use claude::*;
pub use claude_cli::*;
pub use claude_state::*;
pub use claude_tmux::*;
pub use codex::*;
pub use config::*;
pub use credentials::{get_credential_status, has_claude_credentials};
pub use docker::*;
pub use editor::*;
pub use environments::*;
pub use files::*;
pub use github::*;
pub use kanban::*;
pub use local_servers::*;
pub use local_terminal::*;
pub use network::*;
pub use opencode::*;
pub use projects::*;
pub use sessions::*;
pub use terminal::*;

/// Load the runtime setting that enables Codex raw event logging. Shared by
/// both the container and local server start commands.
fn load_codex_bridge_raw_event_logging() -> Result<bool, String> {
    let storage = crate::storage::get_storage().map_err(|e| e.to_string())?;
    let config = storage.load_config().map_err(|e| e.to_string())?;
    Ok(config.global.experimental_codex_raw_event_logging)
}

/// Simple greeting command for testing
#[tauri::command]
pub fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}
