//! One tmux-driven Claude session per environment.
//!
//! Each session owns:
//!   - a tmux session name (`orkestrator-<env-id>`)
//!   - a runtime directory holding hook scripts + pending/response files
//!   - a background poll loop that drains hook events and tails the JSONL
//!     transcript, emitting Tauri events to the frontend.
//!
//! The poll loop runs until [`TmuxSession::stop`] is called or the tmux
//! session dies.

use super::backend::Backend;
use super::hooks::{self, HookPaths, PendingHookEvent};
use super::transcript::{self, TranscriptTail, POLL_INTERVAL_MS};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::{Mutex, Notify};
use tokio::task::JoinHandle;
use tracing::{debug, info, warn};
use uuid::Uuid;

/// All Tauri events emitted on behalf of a tmux session go through this
/// single channel name. The payload's `kind` field disambiguates.
pub const TAURI_EVENT: &str = "claude-tmux:event";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum TmuxEvent {
    /// Session has fully started — tmux up, claude launched, hooks installed.
    Started {
        environment_id: String,
        session_id: String,
    },
    /// A new JSONL line was appended to the transcript.
    TranscriptLine {
        environment_id: String,
        session_id: String,
        line: Value,
    },
    /// A hook event landed (PreToolUse blocks until `reply_to_hook` is called;
    /// others are informational).
    Hook {
        environment_id: String,
        session_id: String,
        event_id: String,
        event_kind: String,
        payload: Value,
    },
    /// The tmux session was killed or claude exited.
    Stopped { environment_id: String },
    /// Recoverable error during polling — surfaced for diagnostics but the
    /// loop keeps running.
    Warning {
        environment_id: String,
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TmuxSessionStatus {
    pub environment_id: String,
    pub session_id: Option<String>,
    pub tmux_session: String,
    pub running: bool,
    pub transcript_path: Option<String>,
}

pub struct TmuxSession {
    pub environment_id: String,
    pub backend: Backend,
    pub session_id: String,
    pub tmux_session: String,
    pub hook_paths: HookPaths,
    pub claude_home: String,
    pub transcript_path: Arc<Mutex<Option<String>>>,
    pub poll_handle: Arc<Mutex<Option<JoinHandle<()>>>>,
    pub stop_notify: Arc<Notify>,
}

impl TmuxSession {
    /// Build paths and IDs but do not yet start anything.
    pub fn build(environment_id: String, backend: Backend) -> Self {
        let session_id = Uuid::new_v4().to_string();
        let tmux_session = format!("orkestrator-{}", short_id(&environment_id));

        // Per-env runtime dir. We deliberately keep it under /tmp so it's
        // identical in local/container and survives across the lifetime of
        // the env without polluting the worktree.
        let runtime_root = format!("/tmp/orkestrator-claude-tmux/{}", environment_id);

        let workspace = match &backend {
            Backend::Local { cwd } => cwd.clone(),
            Backend::Container { .. } => "/workspace".to_string(),
        };
        let claude_home = match &backend {
            Backend::Local { .. } => {
                // Host user's claude home.
                let home = std::env::var("HOME").unwrap_or_else(|_| "/".to_string());
                format!("{}/.claude", home)
            }
            Backend::Container { .. } => "/home/node/.claude".to_string(),
        };

        let hook_paths = HookPaths::new(&runtime_root, &workspace);

        TmuxSession {
            environment_id,
            backend,
            session_id,
            tmux_session,
            hook_paths,
            claude_home,
            transcript_path: Arc::new(Mutex::new(None)),
            poll_handle: Arc::new(Mutex::new(None)),
            stop_notify: Arc::new(Notify::new()),
        }
    }

    pub fn status(&self, running: bool) -> TmuxSessionStatus {
        TmuxSessionStatus {
            environment_id: self.environment_id.clone(),
            session_id: Some(self.session_id.clone()),
            tmux_session: self.tmux_session.clone(),
            running,
            transcript_path: None,
        }
    }

    /// Start tmux + claude and spawn the poll loop. Idempotent: returns Ok
    /// without restarting if tmux already has a session by this name.
    pub async fn start(
        self: Arc<Self>,
        app: AppHandle,
        initial_prompt: Option<String>,
        model: Option<String>,
    ) -> Result<(), String> {
        // 1. Install hooks (script + .claude/settings.local.json)
        hooks::install_hooks(&self.backend, &self.hook_paths).await?;

        // 2. Ensure tmux is available.
        let probe = self.backend.exec(&["which", "tmux"]).await?;
        if !probe.success() || probe.stdout.trim().is_empty() {
            return Err(
                "tmux is not installed in this environment. For containers, rebuild the base image; for local, install tmux on the host."
                    .to_string(),
            );
        }

        // 3. Start tmux session (if not already alive) and launch claude.
        let alive = self.tmux_alive().await?;
        if !alive {
            // Build the claude command. We let claude pick its own session ID
            // and we discover it from the JSONL filename.
            let mut claude_cmd = String::from("claude");
            if let Some(m) = model {
                claude_cmd.push_str(&format!(" --model {}", shell_arg(&m)));
            }
            // Force a known session id for deterministic transcript discovery.
            claude_cmd.push_str(&format!(" --session-id {}", self.session_id));

            // We start tmux in detached mode and launch claude as the first command.
            // The shell wrapper keeps the pane alive if claude exits unexpectedly.
            let wrapped = format!(
                "{}; echo '[claude exited]'; exec bash",
                claude_cmd,
            );

            let out = self
                .backend
                .exec(&[
                    "tmux",
                    "new-session",
                    "-d",
                    "-s",
                    &self.tmux_session,
                    "-x",
                    "200",
                    "-y",
                    "50",
                    "sh",
                    "-c",
                    &wrapped,
                ])
                .await?;
            if !out.success() {
                return Err(format!("tmux new-session failed: {}", out.stderr));
            }
            info!(env = %self.environment_id, session = %self.tmux_session, "Started tmux claude session");
        }

        // 4. Send the initial prompt (if any) after a brief delay so claude's
        //    TUI is ready to receive keystrokes.
        if let Some(prompt) = initial_prompt {
            tokio::time::sleep(std::time::Duration::from_millis(800)).await;
            let _ = self.send_text(&prompt).await;
            let _ = self.send_enter().await;
        }

        // 5. Kick off the poll loop.
        self.clone().spawn_poll_loop(app.clone());

        // 6. Emit started event.
        let _ = app.emit(
            TAURI_EVENT,
            TmuxEvent::Started {
                environment_id: self.environment_id.clone(),
                session_id: self.session_id.clone(),
            },
        );

        Ok(())
    }

    fn spawn_poll_loop(self: Arc<Self>, app: AppHandle) {
        let session = self.clone();
        let handle = tokio::spawn(async move {
            let mut tail: Option<TranscriptTail> = None;
            loop {
                tokio::select! {
                    _ = session.stop_notify.notified() => {
                        debug!(env = %session.environment_id, "tmux poll loop stop signal");
                        break;
                    }
                    _ = tokio::time::sleep(std::time::Duration::from_millis(POLL_INTERVAL_MS)) => {}
                }

                // a) drain pending hook events
                match hooks::drain_pending(&session.backend, &session.hook_paths).await {
                    Ok(events) => {
                        for evt in events {
                            session.emit_hook(&app, evt);
                        }
                    }
                    Err(e) => {
                        warn!(env = %session.environment_id, error = %e, "drain_pending failed");
                    }
                }

                // b) discover transcript file if we don't know it yet
                if tail.is_none() {
                    match transcript::find_transcript_path(
                        &session.backend,
                        &session.claude_home,
                        &session.session_id,
                    )
                    .await
                    {
                        Ok(Some(p)) => {
                            let _ = session.transcript_path.lock().await.replace(p.clone());
                            tail = Some(TranscriptTail::new(p));
                        }
                        Ok(None) => {}
                        Err(e) => {
                            warn!(env = %session.environment_id, error = %e, "find_transcript_path failed");
                        }
                    }
                }

                // c) tail the transcript
                if let Some(t) = tail.as_mut() {
                    match t.read_new(&session.backend).await {
                        Ok(lines) => {
                            for line in lines {
                                let _ = app.emit(
                                    TAURI_EVENT,
                                    TmuxEvent::TranscriptLine {
                                        environment_id: session.environment_id.clone(),
                                        session_id: session.session_id.clone(),
                                        line,
                                    },
                                );
                            }
                        }
                        Err(e) => {
                            warn!(env = %session.environment_id, error = %e, "transcript read failed");
                        }
                    }
                }

                // d) detect tmux dying
                if !session.tmux_alive().await.unwrap_or(false) {
                    let _ = app.emit(
                        TAURI_EVENT,
                        TmuxEvent::Stopped {
                            environment_id: session.environment_id.clone(),
                        },
                    );
                    break;
                }
            }
        });
        let h = self.poll_handle.clone();
        tokio::spawn(async move {
            let mut slot = h.lock().await;
            *slot = Some(handle);
        });
    }

    fn emit_hook(&self, app: &AppHandle, evt: PendingHookEvent) {
        let _ = app.emit(
            TAURI_EVENT,
            TmuxEvent::Hook {
                environment_id: self.environment_id.clone(),
                session_id: self.session_id.clone(),
                event_id: evt.id,
                event_kind: evt.kind,
                payload: evt.payload,
            },
        );
    }

    pub async fn tmux_alive(&self) -> Result<bool, String> {
        let out = self
            .backend
            .exec(&["tmux", "has-session", "-t", &self.tmux_session])
            .await?;
        Ok(out.success())
    }

    /// Send literal text into the tmux pane (no trailing Enter).
    pub async fn send_text(&self, text: &str) -> Result<(), String> {
        // `tmux send-keys -l` sends literal text (no key-name interpretation).
        let out = self
            .backend
            .exec(&["tmux", "send-keys", "-t", &self.tmux_session, "-l", text])
            .await?;
        if !out.success() {
            return Err(out.stderr);
        }
        Ok(())
    }

    pub async fn send_enter(&self) -> Result<(), String> {
        self.send_keys(&["Enter"]).await
    }

    /// Send one or more tmux key names (e.g. "Enter", "Escape", "C-c").
    pub async fn send_keys(&self, keys: &[&str]) -> Result<(), String> {
        let mut args: Vec<&str> = vec!["tmux", "send-keys", "-t", &self.tmux_session];
        args.extend_from_slice(keys);
        let out = self.backend.exec(&args).await?;
        if !out.success() {
            return Err(out.stderr);
        }
        Ok(())
    }

    /// Capture the visible pane (the TUI) as text. Useful as a fallback view
    /// when our JSONL parsing can't represent something.
    pub async fn capture_pane(&self) -> Result<String, String> {
        let out = self
            .backend
            .exec(&["tmux", "capture-pane", "-t", &self.tmux_session, "-p", "-e"])
            .await?;
        if !out.success() {
            return Err(out.stderr);
        }
        Ok(out.stdout)
    }

    pub async fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        let out = self
            .backend
            .exec(&[
                "tmux",
                "resize-window",
                "-t",
                &self.tmux_session,
                "-x",
                &cols.to_string(),
                "-y",
                &rows.to_string(),
            ])
            .await?;
        if !out.success() {
            return Err(out.stderr);
        }
        Ok(())
    }

    pub async fn reply_to_hook(
        &self,
        event_kind: &str,
        event_id: &str,
        response: Value,
    ) -> Result<(), String> {
        hooks::reply_to_hook(&self.backend, &self.hook_paths, event_kind, event_id, &response)
            .await
    }

    /// Approve / deny a PreToolUse blocking hook.
    pub async fn answer_pre_tool_use(
        &self,
        event_id: &str,
        decision: &str,
        reason: Option<String>,
    ) -> Result<(), String> {
        let resp = hooks::pre_tool_use_response(decision, reason.as_deref());
        self.reply_to_hook("PreToolUse", event_id, resp).await
    }

    pub async fn stop(&self) -> Result<(), String> {
        // Stop the poll loop first.
        self.stop_notify.notify_waiters();

        // Kill tmux. Best-effort.
        let _ = self
            .backend
            .exec(&["tmux", "kill-session", "-t", &self.tmux_session])
            .await;

        Ok(())
    }
}

fn short_id(env_id: &str) -> String {
    env_id.chars().take(12).collect::<String>().replace('-', "")
}

fn shell_arg(s: &str) -> String {
    // Single-quote escape. Mirrors backend.rs's helper.
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for ch in s.chars() {
        if ch == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
}

/// A trivial reference type so we can satisfy `Value::String` constructions
/// without pulling in `Cow`. (No-op helper retained for future use.)
#[allow(dead_code)]
fn _v(v: Value) -> Value {
    v
}

// Avoid unused warning when this module is built without the json macro path.
#[allow(dead_code)]
fn _json_keepalive() -> Value {
    json!(null)
}
