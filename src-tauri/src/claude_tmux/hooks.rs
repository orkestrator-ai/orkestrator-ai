//! Claude Code hook integration for tmux mode.
//!
//! Claude Code calls user-defined "hook" shell commands at well-known points
//! (PreToolUse, PostToolUse, UserPromptSubmit, Stop, Notification). We use
//! these hooks to surface tool decisions to our native UI:
//!
//!  1. The hook is a tiny shell script that writes the incoming payload to a
//!     "pending" file in the session's runtime directory.
//!  2. For *blocking* hooks (currently PreToolUse), the script then polls for
//!     a "response" file written by Rust when the user decides, and prints
//!     that response back to Claude Code.
//!  3. For *informational* hooks (PostToolUse, Stop, Notification,
//!     UserPromptSubmit), the script writes the pending file and exits
//!     immediately with `{}` — Rust picks the event up from the pending
//!     directory on its next poll.
//!
//! The same hook script and `settings.local.json` are valid for both local
//! worktrees and containers; only the embedded directory paths differ.

use super::backend::Backend;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Default for how long the PreToolUse hook will wait for the UI to respond
/// before falling back to Claude Code's normal permission prompt.
pub const HOOK_TIMEOUT_SECS: u32 = 600; // 10 min

#[derive(Debug, Clone, Copy)]
pub enum HookEventKind {
    PreToolUse,
    PostToolUse,
    UserPromptSubmit,
    Stop,
    Notification,
    SessionStart,
}

impl HookEventKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            HookEventKind::PreToolUse => "PreToolUse",
            HookEventKind::PostToolUse => "PostToolUse",
            HookEventKind::UserPromptSubmit => "UserPromptSubmit",
            HookEventKind::Stop => "Stop",
            HookEventKind::Notification => "Notification",
            HookEventKind::SessionStart => "SessionStart",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        Some(match s {
            "PreToolUse" => HookEventKind::PreToolUse,
            "PostToolUse" => HookEventKind::PostToolUse,
            "UserPromptSubmit" => HookEventKind::UserPromptSubmit,
            "Stop" => HookEventKind::Stop,
            "Notification" => HookEventKind::Notification,
            "SessionStart" => HookEventKind::SessionStart,
            _ => return None,
        })
    }

    pub fn is_blocking(&self) -> bool {
        matches!(self, HookEventKind::PreToolUse)
    }
}

/// A pending hook event read off disk.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingHookEvent {
    /// Unique ID (filename stem). Used to match the response file back.
    pub id: String,
    /// "PreToolUse", "PostToolUse", etc.
    pub kind: String,
    /// Raw payload Claude Code wrote to the hook's stdin.
    pub payload: Value,
}

/// Layout of files inside the per-session hook runtime directory.
pub struct HookPaths {
    pub root: String,
    pub pending_dir: String,
    pub response_dir: String,
    pub script: String,
    pub claude_settings: String,
}

impl HookPaths {
    /// Build a layout under `<runtime_root>` (which differs between local and
    /// container — e.g. `/tmp/orkestrator-claude-tmux/<env-id>` for both, but
    /// the *meaning* of `/tmp` is different).
    pub fn new(runtime_root: &str, worktree_or_workspace: &str) -> Self {
        let root = runtime_root.to_string();
        HookPaths {
            pending_dir: format!("{}/pending", root),
            response_dir: format!("{}/response", root),
            script: format!("{}/hook.sh", root),
            // Drop hooks into the worktree/workspace so Claude Code picks them up.
            claude_settings: format!("{}/.claude/settings.local.json", worktree_or_workspace),
            root,
        }
    }
}

/// Shell script Claude Code will invoke for every configured hook event.
///
/// We pass the event kind as the first argument and let the script branch
/// on whether it should block waiting for the user. The runtime dir is
/// templated in at script-generation time so the script itself is fully
/// self-contained and doesn't need extra env vars at hook-invocation time
/// (which is convenient because hook environments are minimal).
pub fn hook_script(paths: &HookPaths, timeout_secs: u32) -> String {
    format!(
        r#"#!/usr/bin/env bash
# orkestrator-ai claude-tmux hook
# Usage: hook.sh <EventKind>
# Stdin: JSON payload from Claude Code
# Stdout: JSON response (for blocking hooks)
set -u
EVENT_KIND="${{1:-Unknown}}"
PENDING_DIR={pending_dir_q}
RESPONSE_DIR={response_dir_q}
TIMEOUT_SECS={timeout}

mkdir -p "$PENDING_DIR" "$RESPONSE_DIR" 2>/dev/null || true

# Generate a unique ID (no nanoseconds on BSD/macOS; combine date+pid+RANDOM).
ID="$(date +%s)-$$-${{RANDOM}}-${{RANDOM}}"
PENDING_FILE="$PENDING_DIR/${{EVENT_KIND}}-${{ID}}.json"
RESPONSE_FILE="$RESPONSE_DIR/${{EVENT_KIND}}-${{ID}}.json"

PAYLOAD="$(cat)"
printf '%s' "$PAYLOAD" > "$PENDING_FILE"

case "$EVENT_KIND" in
  PreToolUse)
    # Block until Rust writes a decision or we time out.
    i=0
    while [ $i -lt $((TIMEOUT_SECS * 4)) ]; do
      if [ -f "$RESPONSE_FILE" ]; then
        cat "$RESPONSE_FILE"
        rm -f "$RESPONSE_FILE" "$PENDING_FILE"
        exit 0
      fi
      sleep 0.25
      i=$((i + 1))
    done
    # Timeout: defer to Claude Code's own permission flow.
    rm -f "$PENDING_FILE"
    echo '{{}}'
    ;;
  *)
    # Informational hook: emit then exit.
    # Pending file is left for Rust to pick up; Rust deletes after consuming.
    echo '{{}}'
    ;;
esac
"#,
        pending_dir_q = shell_dq(&paths.pending_dir),
        response_dir_q = shell_dq(&paths.response_dir),
        timeout = timeout_secs,
    )
}

/// `.claude/settings.local.json` content that wires every supported event to
/// our hook script. The matcher `"*"` matches every tool (so PreToolUse
/// intercepts every approval). See Claude Code docs for the schema.
pub fn claude_settings_json(hook_script_path: &str) -> String {
    let cmd = format!("bash {} ", shell_dq(hook_script_path)); // event kind appended below

    let mk = |kind: &str| {
        json!({
            "matcher": "*",
            "hooks": [{ "type": "command", "command": format!("{}{}", cmd, kind) }]
        })
    };
    let mk_no_matcher = |kind: &str| {
        json!({
            "hooks": [{ "type": "command", "command": format!("{}{}", cmd, kind) }]
        })
    };

    let value = json!({
        "hooks": {
            "PreToolUse":       [mk("PreToolUse")],
            "PostToolUse":      [mk("PostToolUse")],
            "UserPromptSubmit": [mk_no_matcher("UserPromptSubmit")],
            "Stop":             [mk_no_matcher("Stop")],
            "Notification":     [mk_no_matcher("Notification")],
            "SessionStart":     [mk_no_matcher("SessionStart")]
        }
    });

    serde_json::to_string_pretty(&value).expect("static JSON serializes")
}

/// Write hook.sh and .claude/settings.local.json into the backend.
pub async fn install_hooks(backend: &Backend, paths: &HookPaths) -> Result<(), String> {
    backend.ensure_dir(&paths.root).await?;
    backend.ensure_dir(&paths.pending_dir).await?;
    backend.ensure_dir(&paths.response_dir).await?;

    let script = hook_script(paths, HOOK_TIMEOUT_SECS);
    backend.write_file(&paths.script, &script).await?;
    backend.exec(&["chmod", "+x", &paths.script]).await?;

    let settings = claude_settings_json(&paths.script);
    backend.write_file(&paths.claude_settings, &settings).await?;

    Ok(())
}

/// Scan the pending dir and return all unread events, deleting them after
/// reading. Returns events sorted by filename so the order matches when
/// they were written.
pub async fn drain_pending(
    backend: &Backend,
    paths: &HookPaths,
) -> Result<Vec<PendingHookEvent>, String> {
    let mut names = backend.list_dir(&paths.pending_dir).await?;
    names.sort();

    let mut events = Vec::new();
    for name in names {
        if !name.ends_with(".json") {
            continue;
        }
        let full = format!("{}/{}", paths.pending_dir, name);
        let Some(content) = backend.read_file(&full).await? else {
            continue;
        };
        let payload: Value = match serde_json::from_str(&content) {
            Ok(v) => v,
            Err(_) => Value::String(content.clone()),
        };
        let (kind, id) = parse_event_filename(&name);

        // For blocking hooks (PreToolUse), leave the pending file in place —
        // it stays until the user decides and we write a response file.
        // For informational hooks, consume now.
        let is_blocking = HookEventKind::from_str(&kind)
            .map(|k| k.is_blocking())
            .unwrap_or(false);
        if !is_blocking {
            backend.remove_file(&full).await.ok();
        }

        events.push(PendingHookEvent {
            id,
            kind,
            payload,
        });
    }

    Ok(events)
}

/// Write a response file for a previously emitted blocking hook event.
/// `response` is the JSON Claude Code will receive on stdout from the hook.
pub async fn reply_to_hook(
    backend: &Backend,
    paths: &HookPaths,
    kind: &str,
    id: &str,
    response: &Value,
) -> Result<(), String> {
    let filename = format!("{}-{}.json", kind, id);
    let response_path = format!("{}/{}", paths.response_dir, filename);
    let pending_path = format!("{}/{}", paths.pending_dir, filename);
    backend
        .write_file(&response_path, &serde_json::to_string(response).unwrap_or_else(|_| "{}".into()))
        .await?;
    // Best-effort: hook.sh removes both on its own when it consumes the
    // response, but if it timed out we should clean the pending file too.
    let _ = pending_path; // intentionally not removed here
    Ok(())
}

/// Convenience: build a PreToolUse JSON response. `decision` is one of
/// "approve" | "block". For "block", `reason` is shown to Claude.
pub fn pre_tool_use_response(decision: &str, reason: Option<&str>) -> Value {
    let mut out = json!({ "decision": decision });
    if let Some(r) = reason {
        out["reason"] = Value::String(r.to_string());
    }
    out
}

fn parse_event_filename(name: &str) -> (String, String) {
    // "PreToolUse-1731519430-1234-9876-5432.json" → ("PreToolUse", "1731519430-1234-9876-5432")
    let stem = name.strip_suffix(".json").unwrap_or(name);
    if let Some(dash) = stem.find('-') {
        let (kind, rest) = stem.split_at(dash);
        let id = rest.trim_start_matches('-');
        return (kind.to_string(), id.to_string());
    }
    (stem.to_string(), String::new())
}

/// Double-quote escape for embedding paths inside the generated bash script.
fn shell_dq(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' | '\\' | '$' | '`' => {
                out.push('\\');
                out.push(ch);
            }
            _ => out.push(ch),
        }
    }
    out.push('"');
    out
}
