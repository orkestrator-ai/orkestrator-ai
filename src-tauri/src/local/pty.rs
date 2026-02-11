//! Local PTY (pseudo-terminal) management for local environments
//!
//! Handles terminal sessions that spawn local shell processes in worktree directories,
//! as opposed to Docker exec sessions for containerized environments.

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtyPair, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use thiserror::Error;
use tokio::sync::mpsc;
use tracing::{debug, info, warn};

#[derive(Error, Debug)]
pub enum LocalPtyError {
    #[error("PTY error: {0}")]
    Pty(String),
    #[error("Session not found: {0}")]
    SessionNotFound(String),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}

/// Wrapper to hold either a full PtyPair (before start) or just the master (after start)
enum PtyHandle {
    /// Full pair before the session is started
    Pair(PtyPair),
    /// Just the master after start (for resize operations)
    Master(Box<dyn MasterPty + Send>),
}

/// A local terminal session running a shell in a worktree directory
pub struct LocalTerminalSession {
    pub session_id: String,
    #[allow(dead_code)]
    pub environment_id: String,
    pub worktree_path: String,
    pub cols: u16,
    pub rows: u16,
    pub is_active: bool,
    pty_handle: Option<PtyHandle>,
}

impl LocalTerminalSession {
    pub fn new(environment_id: &str, worktree_path: &str, cols: u16, rows: u16) -> Self {
        Self {
            session_id: uuid::Uuid::new_v4().to_string(),
            environment_id: environment_id.to_string(),
            worktree_path: worktree_path.to_string(),
            cols,
            rows,
            is_active: false,
            pty_handle: None,
        }
    }
}

/// Manager for local terminal sessions
pub struct LocalTerminalManager {
    sessions: Arc<Mutex<HashMap<String, LocalTerminalSession>>>,
    input_senders: Arc<Mutex<HashMap<String, mpsc::Sender<Vec<u8>>>>>,
}

impl LocalTerminalManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            input_senders: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Create a new local terminal session
    pub async fn create_session(
        &self,
        environment_id: &str,
        worktree_path: &str,
        cols: u16,
        rows: u16,
    ) -> Result<String, LocalPtyError> {
        debug!(
            environment_id = %environment_id,
            worktree_path = %worktree_path,
            cols = cols,
            rows = rows,
            "Creating local terminal session"
        );

        // Create the PTY system
        let pty_system = native_pty_system();

        // Create a PTY pair with the specified size
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| LocalPtyError::Pty(e.to_string()))?;

        // Create and store session
        let mut session = LocalTerminalSession::new(environment_id, worktree_path, cols, rows);
        session.pty_handle = Some(PtyHandle::Pair(pair));
        session.is_active = true;

        let session_id = session.session_id.clone();

        {
            let mut sessions = self.sessions.lock().unwrap();
            sessions.insert(session_id.clone(), session);
        }

        debug!(session_id = %session_id, "Local terminal session created");
        Ok(session_id)
    }

    /// Start a local terminal session and return output receiver
    pub async fn start_session(
        &self,
        session_id: &str,
    ) -> Result<mpsc::Receiver<Vec<u8>>, LocalPtyError> {
        debug!(session_id = %session_id, "Starting local terminal session");

        let (worktree_path, pair) = {
            let mut sessions = self.sessions.lock().unwrap();
            let session = sessions
                .get_mut(session_id)
                .ok_or_else(|| LocalPtyError::SessionNotFound(session_id.to_string()))?;

            let pty_handle = session
                .pty_handle
                .take()
                .ok_or_else(|| LocalPtyError::Pty("PTY handle already taken".to_string()))?;

            let pair = match pty_handle {
                PtyHandle::Pair(p) => p,
                PtyHandle::Master(_) => {
                    return Err(LocalPtyError::Pty("Session already started".to_string()));
                }
            };

            (session.worktree_path.clone(), pair)
        };

        // Get the user's default shell
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());

        // Build the command to run in the PTY
        let mut cmd = CommandBuilder::new(&shell);
        cmd.cwd(&worktree_path);

        // Set up environment variables
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");

        // Spawn the shell in the PTY
        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| LocalPtyError::Pty(e.to_string()))?;

        // Drop the slave - we don't need it after spawning
        drop(pair.slave);

        // Create channels for input/output
        let (input_tx, mut input_rx) = mpsc::channel::<Vec<u8>>(1024);
        let (output_tx, output_rx) = mpsc::channel::<Vec<u8>>(1024);

        // Store the input sender
        {
            let mut senders = self.input_senders.lock().unwrap();
            senders.insert(session_id.to_string(), input_tx);
        }

        // Get writer and reader from the master
        let mut writer = pair
            .master
            .take_writer()
            .map_err(|e| LocalPtyError::Pty(e.to_string()))?;
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| LocalPtyError::Pty(e.to_string()))?;

        // Store just the master for resize operations (no need for a dummy slave)
        {
            let mut sessions = self.sessions.lock().unwrap();
            if let Some(session) = sessions.get_mut(session_id) {
                session.pty_handle = Some(PtyHandle::Master(pair.master));
            }
        }

        let session_id_clone = session_id.to_string();

        // Spawn task to read output
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => {
                        debug!(session_id = %session_id_clone, "PTY reader got EOF");
                        break;
                    }
                    Ok(n) => {
                        let data = buf[..n].to_vec();
                        if output_tx.blocking_send(data).is_err() {
                            debug!(session_id = %session_id_clone, "Output channel closed");
                            break;
                        }
                    }
                    Err(e) => {
                        warn!(session_id = %session_id_clone, error = %e, "Error reading from PTY");
                        break;
                    }
                }
            }
            debug!(session_id = %session_id_clone, "PTY reader thread ended");
        });

        let session_id_clone2 = session_id.to_string();

        // Spawn task to write input
        tokio::spawn(async move {
            loop {
                match input_rx.recv().await {
                    Some(data) => {
                        if let Err(e) = writer.write_all(&data) {
                            warn!(session_id = %session_id_clone2, error = %e, "Error writing to PTY");
                            break;
                        }
                        if let Err(e) = writer.flush() {
                            warn!(session_id = %session_id_clone2, error = %e, "Error flushing PTY");
                        }
                    }
                    None => {
                        debug!(session_id = %session_id_clone2, "Input channel closed");
                        break;
                    }
                }
            }
            debug!(session_id = %session_id_clone2, "PTY writer task ended");
        });

        // Wait for the child process in a separate thread
        let session_id_clone3 = session_id.to_string();
        let sessions = self.sessions.clone();
        std::thread::spawn(move || {
            let _ = child.wait();
            debug!(session_id = %session_id_clone3, "PTY child process exited");
            // Mark session as inactive
            if let Ok(mut sessions) = sessions.lock() {
                if let Some(session) = sessions.get_mut(&session_id_clone3) {
                    session.is_active = false;
                }
            }
        });

        info!(session_id = %session_id, "Local terminal session started");
        Ok(output_rx)
    }

    /// Write data to a local terminal session
    pub async fn write_to_session(
        &self,
        session_id: &str,
        data: Vec<u8>,
    ) -> Result<(), LocalPtyError> {
        let sender = {
            let senders = self.input_senders.lock().unwrap();
            senders
                .get(session_id)
                .ok_or_else(|| LocalPtyError::SessionNotFound(session_id.to_string()))?
                .clone()
        };

        sender
            .send(data)
            .await
            .map_err(|_| LocalPtyError::Pty("Failed to send data to terminal".to_string()))?;
        Ok(())
    }

    /// Resize a local terminal session
    pub fn resize_session(
        &self,
        session_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), LocalPtyError> {
        debug!(session_id = %session_id, cols = cols, rows = rows, "Resizing local terminal session");

        let mut sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get_mut(session_id)
            .ok_or_else(|| LocalPtyError::SessionNotFound(session_id.to_string()))?;

        session.cols = cols;
        session.rows = rows;

        if let Some(ref pty_handle) = session.pty_handle {
            let master: &dyn MasterPty = match pty_handle {
                PtyHandle::Pair(pair) => pair.master.as_ref(),
                PtyHandle::Master(m) => m.as_ref(),
            };
            master
                .resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| LocalPtyError::Pty(e.to_string()))?;
        }

        Ok(())
    }

    /// Close a local terminal session
    pub fn close_session(&self, session_id: &str) -> Result<(), LocalPtyError> {
        debug!(session_id = %session_id, "Closing local terminal session");

        // Remove input sender (this will cause the input task to end)
        {
            let mut senders = self.input_senders.lock().unwrap();
            senders.remove(session_id);
        }

        // Remove session
        let mut sessions = self.sessions.lock().unwrap();
        if sessions.remove(session_id).is_none() {
            return Err(LocalPtyError::SessionNotFound(session_id.to_string()));
        }

        info!(session_id = %session_id, "Local terminal session closed");
        Ok(())
    }

    /// Get session info
    #[allow(dead_code)]
    pub fn get_session(&self, session_id: &str) -> Option<(String, String, u16, u16)> {
        let sessions = self.sessions.lock().unwrap();
        sessions.get(session_id).map(|s| {
            (
                s.environment_id.clone(),
                s.worktree_path.clone(),
                s.cols,
                s.rows,
            )
        })
    }

    /// List all active sessions
    #[allow(dead_code)]
    pub fn list_sessions(&self) -> Vec<String> {
        let sessions = self.sessions.lock().unwrap();
        sessions.keys().cloned().collect()
    }
}

impl Default for LocalTerminalManager {
    fn default() -> Self {
        Self::new()
    }
}

// Global local terminal manager instance
static LOCAL_TERMINAL_MANAGER: std::sync::OnceLock<LocalTerminalManager> =
    std::sync::OnceLock::new();

/// Initialize the global local terminal manager
pub fn init_local_terminal_manager() {
    let _ = LOCAL_TERMINAL_MANAGER.set(LocalTerminalManager::new());
}

/// Get the global local terminal manager
pub fn get_local_terminal_manager() -> Option<&'static LocalTerminalManager> {
    LOCAL_TERMINAL_MANAGER.get()
}
