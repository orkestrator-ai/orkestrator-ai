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
use serde_json::Value;
use std::collections::HashSet;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::{Mutex, Notify};
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
    /// A previously emitted blocking hook timed out before the user
    /// responded. The frontend should dismiss the pending approval.
    HookTimedOut {
        environment_id: String,
        session_id: String,
        event_kind: String,
        event_id: String,
    },
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
        // NOTE: Container paths assume Orkestrator's base image, which runs
        // tools as the `node` user with workspace at `/workspace` and Claude
        // state under `/home/node/.claude`. Custom images that diverge from
        // this layout will not work with tmux mode without changes to
        // `Backend::Container::exec` and the constants below.
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

        // 2b. Ensure claude CLI is available *and* supports --session-id —
        // we rely on that flag to discover the transcript filename.
        let claude_probe = self.backend.exec(&["which", "claude"]).await?;
        if !claude_probe.success() || claude_probe.stdout.trim().is_empty() {
            return Err("claude CLI not found in this environment.".to_string());
        }
        let help = self.backend.exec(&["claude", "--help"]).await?;
        let help_text = format!("{}\n{}", help.stdout, help.stderr);
        if !help_text.contains("--session-id") {
            return Err(
                "Installed claude CLI does not support --session-id. Upgrade to a newer Claude Code version, or switch to terminal/native mode."
                    .to_string(),
            );
        }

        // 3. Start tmux session (if not already alive) and launch claude.
        let alive = self.tmux_alive().await?;
        if !alive {
            // Build the claude command. We force a known session id so we
            // can deterministically discover the transcript JSONL file.
            let mut claude_cmd = String::from("claude");
            if let Some(m) = model {
                claude_cmd.push_str(&format!(" --model {}", shell_arg(&m)));
            }
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
        tokio::spawn(async move {
            let mut tail: Option<TranscriptTail> = None;
            let mut emitted_blocking_ids: HashSet<String> = HashSet::new();
            loop {
                tokio::select! {
                    _ = session.stop_notify.notified() => {
                        debug!(env = %session.environment_id, "tmux poll loop stop signal");
                        break;
                    }
                    _ = tokio::time::sleep(std::time::Duration::from_millis(POLL_INTERVAL_MS)) => {}
                }

                // a) drain pending hook events (dedup blocking by id)
                match hooks::drain_pending(
                    &session.backend,
                    &session.hook_paths,
                    &mut emitted_blocking_ids,
                )
                .await
                {
                    Ok(events) => {
                        for evt in events {
                            session.emit_hook(&app, evt);
                        }
                    }
                    Err(e) => {
                        warn!(env = %session.environment_id, error = %e, "drain_pending failed");
                    }
                }

                // a2) drain blocking-hook timeouts so the UI can dismiss
                //     stale approval cards.
                match hooks::drain_timeouts(&session.backend, &session.hook_paths).await {
                    Ok(timeouts) => {
                        for (kind, id) in timeouts {
                            emitted_blocking_ids.remove(&id);
                            let _ = app.emit(
                                TAURI_EVENT,
                                TmuxEvent::HookTimedOut {
                                    environment_id: session.environment_id.clone(),
                                    session_id: session.session_id.clone(),
                                    event_kind: kind,
                                    event_id: id,
                                },
                            );
                        }
                    }
                    Err(e) => {
                        warn!(env = %session.environment_id, error = %e, "drain_timeouts failed");
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
    ///
    /// Newlines are sent as Alt-Enter, not as raw LF, because the Claude TUI
    /// interprets a bare Enter as "submit". Most modern TUIs (including
    /// Claude Code) accept Alt-Enter as "insert a newline without submitting"
    /// so a multi-line message lands as one prompt rather than being
    /// submitted line-by-line.
    pub async fn send_text(&self, text: &str) -> Result<(), String> {
        if text.is_empty() {
            return Ok(());
        }
        let parts: Vec<&str> = text.split('\n').collect();
        for (idx, part) in parts.iter().enumerate() {
            if !part.is_empty() {
                let out = self
                    .backend
                    .exec(&["tmux", "send-keys", "-t", &self.tmux_session, "-l", part])
                    .await?;
                if !out.success() {
                    return Err(out.stderr);
                }
            }
            // Insert a newline between segments — but not after the final one.
            if idx + 1 < parts.len() {
                self.send_keys(&["M-Enter"]).await?;
            }
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

        // Restore the user's .claude/settings.local.json and remove the
        // per-session runtime directory.
        if let Err(e) = hooks::uninstall_hooks(&self.backend, &self.hook_paths).await {
            warn!(env = %self.environment_id, error = %e, "uninstall_hooks failed");
        }

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claude_tmux::hooks::{self, HOOK_TIMEOUT_SECS};
    use std::collections::HashSet;
    use tempfile::TempDir;
    use tokio::fs;

    #[test]
    fn short_id_truncates_and_strips_dashes() {
        // 36-char UUID → 12 chars taken then dashes removed.
        let id = short_id("a33f9026-8cfe-4077-aefd-4db2c2637dcc");
        assert_eq!(id.len(), 11); // "a33f90268cfe" minus the embedded dash = 11
        assert!(!id.contains('-'));
        assert!("a33f9026-8cfe".starts_with(&id[..4]));
    }

    #[test]
    fn shell_arg_quotes_simple_value() {
        assert_eq!(shell_arg("sonnet"), "'sonnet'");
    }

    #[test]
    fn shell_arg_escapes_single_quotes() {
        assert_eq!(shell_arg("it's"), "'it'\\''s'");
    }

    #[test]
    fn tmux_session_status_returns_running_flag() {
        let tmp = TempDir::new().unwrap();
        let session = TmuxSession::build(
            "env-1".to_string(),
            Backend::Local {
                cwd: tmp.path().to_string_lossy().into_owned(),
            },
        );
        let alive = session.status(true);
        assert_eq!(alive.environment_id, "env-1");
        assert!(alive.running);
        assert!(alive.session_id.is_some());
        assert!(alive.tmux_session.starts_with("orkestrator-"));

        let dead = session.status(false);
        assert!(!dead.running);
    }

    #[tokio::test]
    async fn install_then_uninstall_restores_original_settings() {
        let tmp = TempDir::new().unwrap();
        let backend = Backend::Local {
            cwd: tmp.path().to_string_lossy().into_owned(),
        };
        let session = TmuxSession::build("env-restore".to_string(), backend.clone());

        // Pre-existing user settings.
        let original = "{\"theme\":\"dark\"}";
        let settings_path = session.hook_paths.claude_settings.clone();
        let parent = std::path::Path::new(&settings_path).parent().unwrap();
        fs::create_dir_all(parent).await.unwrap();
        fs::write(&settings_path, original).await.unwrap();

        hooks::install_hooks(&backend, &session.hook_paths).await.unwrap();

        let after_install = fs::read_to_string(&settings_path).await.unwrap();
        assert!(after_install.contains("\"hooks\""));
        assert!(after_install.contains("\"theme\""));

        hooks::uninstall_hooks(&backend, &session.hook_paths).await.unwrap();
        let restored = fs::read_to_string(&settings_path).await.unwrap();
        assert_eq!(restored, original);
        // Runtime dir is gone.
        assert!(!std::path::Path::new(&session.hook_paths.root).exists());
    }

    #[tokio::test]
    async fn uninstall_removes_settings_when_none_existed() {
        let tmp = TempDir::new().unwrap();
        let backend = Backend::Local {
            cwd: tmp.path().to_string_lossy().into_owned(),
        };
        let session = TmuxSession::build("env-fresh".to_string(), backend.clone());

        hooks::install_hooks(&backend, &session.hook_paths).await.unwrap();
        assert!(std::path::Path::new(&session.hook_paths.claude_settings).exists());

        hooks::uninstall_hooks(&backend, &session.hook_paths).await.unwrap();
        assert!(!std::path::Path::new(&session.hook_paths.claude_settings).exists());
    }

    #[tokio::test]
    async fn drain_pending_dedupes_blocking_events_across_calls() {
        let tmp = TempDir::new().unwrap();
        let backend = Backend::Local {
            cwd: tmp.path().to_string_lossy().into_owned(),
        };
        let session = TmuxSession::build("env-dedup".to_string(), backend.clone());
        hooks::install_hooks(&backend, &session.hook_paths).await.unwrap();

        // Simulate hook.sh writing a PreToolUse pending file.
        let pending = format!(
            "{}/PreToolUse-1234-5678.json",
            session.hook_paths.pending_dir
        );
        fs::write(&pending, "{\"tool_name\":\"Bash\"}").await.unwrap();

        let mut emitted: HashSet<String> = HashSet::new();
        let first = hooks::drain_pending(&backend, &session.hook_paths, &mut emitted)
            .await
            .unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].kind, "PreToolUse");
        assert_eq!(emitted.len(), 1);

        // Second poll without the user answering should NOT re-emit.
        let second = hooks::drain_pending(&backend, &session.hook_paths, &mut emitted)
            .await
            .unwrap();
        assert!(second.is_empty(), "blocking event re-emitted");

        // Pending file disappears (e.g. hook.sh consumed a response or timed
        // out): the id should be pruned from `emitted`.
        fs::remove_file(&pending).await.unwrap();
        let third = hooks::drain_pending(&backend, &session.hook_paths, &mut emitted)
            .await
            .unwrap();
        assert!(third.is_empty());
        assert!(emitted.is_empty());
    }

    #[tokio::test]
    async fn drain_pending_consumes_informational_events_each_time() {
        let tmp = TempDir::new().unwrap();
        let backend = Backend::Local {
            cwd: tmp.path().to_string_lossy().into_owned(),
        };
        let session = TmuxSession::build("env-info".to_string(), backend.clone());
        hooks::install_hooks(&backend, &session.hook_paths).await.unwrap();

        let pending = format!(
            "{}/Notification-aa-bb.json",
            session.hook_paths.pending_dir
        );
        fs::write(&pending, "{\"message\":\"hi\"}").await.unwrap();

        let mut emitted: HashSet<String> = HashSet::new();
        let first = hooks::drain_pending(&backend, &session.hook_paths, &mut emitted)
            .await
            .unwrap();
        assert_eq!(first.len(), 1);
        // Informational pending file should be deleted by drain_pending itself.
        assert!(!std::path::Path::new(&pending).exists());
    }

    #[tokio::test]
    async fn drain_timeouts_returns_and_removes_timeout_sentinels() {
        let tmp = TempDir::new().unwrap();
        let backend = Backend::Local {
            cwd: tmp.path().to_string_lossy().into_owned(),
        };
        let session = TmuxSession::build("env-timeout".to_string(), backend.clone());
        hooks::install_hooks(&backend, &session.hook_paths).await.unwrap();

        let timeout_file = format!(
            "{}/PreToolUse-id-1.json",
            session.hook_paths.timeout_dir
        );
        fs::write(&timeout_file, "{\"timed_out\":true}").await.unwrap();

        let outs = hooks::drain_timeouts(&backend, &session.hook_paths)
            .await
            .unwrap();
        assert_eq!(outs.len(), 1);
        assert_eq!(outs[0].0, "PreToolUse");
        assert_eq!(outs[0].1, "id-1");
        assert!(!std::path::Path::new(&timeout_file).exists());
    }

    #[test]
    fn hook_timeout_constant_is_reasonable() {
        // Anything 1-60 minutes is fine; just guard against zero or absurd.
        assert!(HOOK_TIMEOUT_SECS >= 60);
        assert!(HOOK_TIMEOUT_SECS <= 3600);
    }
}

