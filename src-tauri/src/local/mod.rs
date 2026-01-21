//! Local environment management module
//!
//! This module handles local (non-Docker) environments that use git worktrees
//! and run agent servers as native child processes on the host machine.

pub mod ports;
pub mod process;
pub mod pty;
pub mod servers;
pub mod worktree;

// Re-export commonly used items
pub use ports::allocate_ports;
pub use pty::{get_local_terminal_manager, init_local_terminal_manager};
pub use servers::{
    get_local_claude_status, get_local_opencode_status, start_local_claude_bridge,
    start_local_opencode_server, stop_all_local_servers, stop_local_claude_bridge,
    stop_local_opencode_server, LocalServerStartResult, LocalServerStatus,
};
pub use worktree::{copy_env_files, create_worktree, delete_worktree, get_setup_local_commands};
