// Tauri commands module
// Commands are exposed to the frontend via the invoke API

mod claude_cli;
mod claude_state;
mod config;
pub mod credentials;
mod docker;
mod editor;
mod environments;
mod files;
mod github;
mod network;
mod opencode;
mod projects;
mod sessions;
mod terminal;

pub use claude_cli::*;
pub use claude_state::*;
pub use config::*;
pub use credentials::{get_credential_status, has_claude_credentials};
pub use docker::*;
pub use editor::*;
pub use environments::*;
pub use files::*;
pub use github::*;
pub use network::*;
pub use opencode::*;
pub use projects::*;
pub use sessions::*;
pub use terminal::*;

/// Simple greeting command for testing
#[tauri::command]
pub fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}
