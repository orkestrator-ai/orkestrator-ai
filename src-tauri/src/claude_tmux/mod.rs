//! Claude Tmux mode
//!
//! Drives the `claude` CLI under a tmux session and surfaces a native-style
//! chat UI by reading the JSONL transcript and intercepting tool decisions
//! through Claude Code hooks (no Agent SDK required).
//!
//! Local and container environments share one code path; the [`Backend`]
//! enum dispatches shell commands either directly on the host or via
//! `docker exec` into the environment's container.

pub mod backend;
pub mod hooks;
pub mod manager;
pub mod session;
pub mod transcript;

pub use manager::{get_manager, init_manager};
