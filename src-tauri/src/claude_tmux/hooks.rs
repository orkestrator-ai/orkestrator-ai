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
use std::collections::HashSet;

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
    /// Sentinel files dropped by hook.sh when a blocking hook times out.
    /// Rust uses them to dismiss the corresponding pending approval in the UI.
    pub timeout_dir: String,
    pub script: String,
    pub claude_settings: String,
    /// Backup of any pre-existing `.claude/settings.local.json`. Restored on
    /// session stop so we don't permanently mutate user state.
    pub claude_settings_backup: String,
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
            timeout_dir: format!("{}/timeout", root),
            script: format!("{}/hook.sh", root),
            // Drop hooks into the worktree/workspace so Claude Code picks them up.
            claude_settings: format!("{}/.claude/settings.local.json", worktree_or_workspace),
            claude_settings_backup: format!("{}/settings.local.json.orkestrator-backup", root),
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
TIMEOUT_DIR={timeout_dir_q}
TIMEOUT_SECS={timeout}

mkdir -p "$PENDING_DIR" "$RESPONSE_DIR" "$TIMEOUT_DIR" 2>/dev/null || true

# Generate a unique ID (no nanoseconds on BSD/macOS; combine date+pid+RANDOM).
ID="$(date +%s)-$$-${{RANDOM}}-${{RANDOM}}"
PENDING_FILE="$PENDING_DIR/${{EVENT_KIND}}-${{ID}}.json"
RESPONSE_FILE="$RESPONSE_DIR/${{EVENT_KIND}}-${{ID}}.json"
TIMEOUT_FILE="$TIMEOUT_DIR/${{EVENT_KIND}}-${{ID}}.json"

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
    # Timeout: drop a sentinel so Rust can dismiss the UI prompt, then
    # defer to Claude Code's own permission flow with an empty response.
    printf '{{"timed_out":true}}' > "$TIMEOUT_FILE"
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
        timeout_dir_q = shell_dq(&paths.timeout_dir),
        timeout = timeout_secs,
    )
}

/// Build the hooks object that our settings.local.json contributes. Returned
/// as a JSON Value so the caller can merge it into any pre-existing settings.
///
/// NOTE: We deliberately do *not* register a `PreToolUse` hook. The session
/// is launched with `--dangerously-skip-permissions`, so the UI should not
/// gate tool calls. A blocking `PreToolUse` hook would defeat that flag by
/// surfacing an approval card for every tool. If a future "approval policy"
/// feature wants to re-enable gating, add `PreToolUse` back here.
pub fn hooks_block(hook_script_path: &str) -> Value {
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

    json!({
        "PostToolUse":      [mk("PostToolUse")],
        "UserPromptSubmit": [mk_no_matcher("UserPromptSubmit")],
        "Stop":             [mk_no_matcher("Stop")],
        "Notification":     [mk_no_matcher("Notification")],
        "SessionStart":     [mk_no_matcher("SessionStart")]
    })
}

/// Merge our hooks block into `existing` (parsed `.claude/settings.local.json`
/// content, or `null` if absent). Preserves any unrelated keys. Returns the
/// pretty-printed JSON text to write.
pub fn merge_settings_json(existing: Option<&str>, hook_script_path: &str) -> String {
    let mut root: Value = existing
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_else(|| json!({}));

    if !root.is_object() {
        root = json!({});
    }
    let obj = root.as_object_mut().expect("root is object");
    obj.insert("hooks".to_string(), hooks_block(hook_script_path));

    serde_json::to_string_pretty(&root).expect("settings JSON serializes")
}

/// Write hook.sh and merge our hooks block into `.claude/settings.local.json`,
/// backing up any pre-existing user settings so they can be restored on stop.
pub async fn install_hooks(backend: &Backend, paths: &HookPaths) -> Result<(), String> {
    backend.ensure_dir(&paths.root).await?;
    backend.ensure_dir(&paths.pending_dir).await?;
    backend.ensure_dir(&paths.response_dir).await?;
    backend.ensure_dir(&paths.timeout_dir).await?;

    let script = hook_script(paths, HOOK_TIMEOUT_SECS);
    backend.write_file(&paths.script, &script).await?;
    backend.exec(&["chmod", "+x", &paths.script]).await?;

    // Snapshot whatever's there now (if anything) so `uninstall_hooks` can
    // put it back. We always overwrite the backup at install time — restart
    // mid-session would otherwise lose the original.
    let existing = backend.read_file(&paths.claude_settings).await?;
    if let Some(prev) = existing.as_deref() {
        backend.write_file(&paths.claude_settings_backup, prev).await?;
    } else {
        // Mark "no original" with an idempotent sentinel.
        backend
            .write_file(&paths.claude_settings_backup, "__orkestrator_no_original__")
            .await?;
    }

    let merged = merge_settings_json(existing.as_deref(), &paths.script);
    backend.write_file(&paths.claude_settings, &merged).await?;

    Ok(())
}

/// Restore the user's original `.claude/settings.local.json` and remove the
/// runtime directory. Best-effort: errors are returned but the caller can
/// safely ignore them (cleanup is not critical to correctness).
pub async fn uninstall_hooks(backend: &Backend, paths: &HookPaths) -> Result<(), String> {
    let backup = backend.read_file(&paths.claude_settings_backup).await?;
    match backup.as_deref() {
        Some("__orkestrator_no_original__") => {
            backend.remove_file(&paths.claude_settings).await?;
        }
        Some(content) => {
            backend.write_file(&paths.claude_settings, content).await?;
        }
        None => {
            // No backup recorded — leave settings as-is.
        }
    }
    backend.remove_file(&paths.claude_settings_backup).await.ok();
    // Drop the per-session runtime dir entirely.
    backend.exec(&["rm", "-rf", &paths.root]).await.ok();
    Ok(())
}

/// Scan the timeout dir and return the IDs of blocking hooks that gave up
/// waiting for a response. Files are consumed on read.
pub async fn drain_timeouts(
    backend: &Backend,
    paths: &HookPaths,
) -> Result<Vec<(String, String)>, String> {
    let names = backend.list_dir(&paths.timeout_dir).await?;
    let mut out = Vec::new();
    for name in names {
        if !name.ends_with(".json") {
            continue;
        }
        let (kind, id) = parse_event_filename(&name);
        let full = format!("{}/{}", paths.timeout_dir, name);
        backend.remove_file(&full).await.ok();
        out.push((kind, id));
    }
    Ok(out)
}

/// Scan the pending dir and return all unread events, deleting them after
/// reading. Returns events sorted by filename so the order matches when
/// they were written.
///
/// `already_emitted` is a set of blocking-event IDs that have previously been
/// surfaced to the UI. Blocking pending files stay on disk until `hook.sh`
/// consumes the response, so without this set we would re-emit them on every
/// poll. The set is also pruned of IDs whose pending files have disappeared
/// (timed out or answered).
pub async fn drain_pending(
    backend: &Backend,
    paths: &HookPaths,
    already_emitted: &mut HashSet<String>,
) -> Result<Vec<PendingHookEvent>, String> {
    let mut names = backend.list_dir(&paths.pending_dir).await?;
    names.sort();

    // Prune entries from `already_emitted` whose pending files are gone so
    // that if Claude later re-uses an ID (unlikely but possible) we don't
    // miss it.
    let still_present: HashSet<String> = names
        .iter()
        .filter(|n| n.ends_with(".json"))
        .map(|n| parse_event_filename(n).1)
        .collect();
    already_emitted.retain(|id| still_present.contains(id));

    let mut events = Vec::new();
    for name in names {
        if !name.ends_with(".json") {
            continue;
        }
        let full = format!("{}/{}", paths.pending_dir, name);
        let (kind, id) = parse_event_filename(&name);

        let is_blocking = HookEventKind::from_str(&kind)
            .map(|k| k.is_blocking())
            .unwrap_or(false);

        // For blocking hooks, skip if we've already told the UI about this
        // event — the pending file lingers until hook.sh consumes the
        // response.
        if is_blocking && already_emitted.contains(&id) {
            continue;
        }

        let Some(content) = backend.read_file(&full).await? else {
            continue;
        };
        let payload: Value = match serde_json::from_str(&content) {
            Ok(v) => v,
            Err(_) => Value::String(content.clone()),
        };

        if is_blocking {
            already_emitted.insert(id.clone());
        } else {
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
    backend
        .write_file(&response_path, &serde_json::to_string(response).unwrap_or_else(|_| "{}".into()))
        .await?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_event_filename_splits_kind_and_id() {
        let (kind, id) = parse_event_filename("PreToolUse-1731519430-1234-9876-5432.json");
        assert_eq!(kind, "PreToolUse");
        assert_eq!(id, "1731519430-1234-9876-5432");
    }

    #[test]
    fn parse_event_filename_tolerates_missing_extension() {
        let (kind, id) = parse_event_filename("Notification-abc-123");
        assert_eq!(kind, "Notification");
        assert_eq!(id, "abc-123");
    }

    #[test]
    fn parse_event_filename_returns_empty_id_when_no_dash() {
        let (kind, id) = parse_event_filename("PreToolUse.json");
        assert_eq!(kind, "PreToolUse");
        assert_eq!(id, "");
    }

    #[test]
    fn pre_tool_use_response_approve_has_no_reason() {
        let v = pre_tool_use_response("approve", None);
        assert_eq!(v["decision"], "approve");
        assert!(v.get("reason").is_none());
    }

    #[test]
    fn pre_tool_use_response_block_includes_reason() {
        let v = pre_tool_use_response("block", Some("nope"));
        assert_eq!(v["decision"], "block");
        assert_eq!(v["reason"], "nope");
    }

    #[test]
    fn hooks_block_has_supported_informational_event_kinds() {
        let v = hooks_block("/tmp/x/hook.sh");
        let obj = v.as_object().unwrap();
        for kind in [
            "PostToolUse",
            "UserPromptSubmit",
            "Stop",
            "Notification",
            "SessionStart",
        ] {
            assert!(obj.contains_key(kind), "missing kind: {kind}");
        }
        // PreToolUse is intentionally omitted so --dangerously-skip-permissions
        // is honored end-to-end.
        assert!(!obj.contains_key("PreToolUse"));
        let post = &v["PostToolUse"][0];
        assert_eq!(post["matcher"], "*");
        assert!(post["hooks"][0]["command"].as_str().unwrap().contains("PostToolUse"));
    }

    #[test]
    fn merge_settings_json_preserves_unrelated_keys() {
        let prev = r#"{"theme":"dark","permissions":{"x":1}}"#;
        let merged = merge_settings_json(Some(prev), "/tmp/hook.sh");
        let v: Value = serde_json::from_str(&merged).unwrap();
        assert_eq!(v["theme"], "dark");
        assert_eq!(v["permissions"]["x"], 1);
        assert!(v["hooks"]["PostToolUse"].is_array());
    }

    #[test]
    fn merge_settings_json_creates_object_from_nothing() {
        let merged = merge_settings_json(None, "/tmp/hook.sh");
        let v: Value = serde_json::from_str(&merged).unwrap();
        assert!(v["hooks"]["PostToolUse"].is_array());
    }

    #[test]
    fn merge_settings_json_overwrites_existing_hooks() {
        let prev = r#"{"hooks":{"PostToolUse":[{"matcher":"foo","hooks":[]}]}}"#;
        let merged = merge_settings_json(Some(prev), "/tmp/hook.sh");
        let v: Value = serde_json::from_str(&merged).unwrap();
        // Our matcher is "*", not "foo".
        assert_eq!(v["hooks"]["PostToolUse"][0]["matcher"], "*");
    }

    #[test]
    fn merge_settings_json_replaces_non_object_root() {
        let merged = merge_settings_json(Some("[\"oops\"]"), "/tmp/hook.sh");
        let v: Value = serde_json::from_str(&merged).unwrap();
        assert!(v.is_object());
        assert!(v["hooks"].is_object());
    }

    #[test]
    fn hook_event_kind_blocking_only_pre_tool_use() {
        assert!(HookEventKind::PreToolUse.is_blocking());
        for k in [
            HookEventKind::PostToolUse,
            HookEventKind::UserPromptSubmit,
            HookEventKind::Stop,
            HookEventKind::Notification,
            HookEventKind::SessionStart,
        ] {
            assert!(!k.is_blocking());
        }
    }

    #[test]
    fn shell_dq_escapes_dangerous_chars() {
        let escaped = shell_dq("/tmp/$x \"y\" `z` \\w");
        assert_eq!(escaped, "\"/tmp/\\$x \\\"y\\\" \\`z\\` \\\\w\"");
    }

    #[test]
    fn hook_paths_layout_under_runtime_root() {
        let p = HookPaths::new("/tmp/run", "/work");
        assert_eq!(p.root, "/tmp/run");
        assert_eq!(p.pending_dir, "/tmp/run/pending");
        assert_eq!(p.response_dir, "/tmp/run/response");
        assert_eq!(p.timeout_dir, "/tmp/run/timeout");
        assert_eq!(p.script, "/tmp/run/hook.sh");
        assert_eq!(p.claude_settings, "/work/.claude/settings.local.json");
        assert!(p.claude_settings_backup.starts_with("/tmp/run/"));
    }

    #[test]
    fn hook_script_contains_timeout_dir_and_event_kind_branch() {
        let paths = HookPaths::new("/tmp/run", "/work");
        let script = hook_script(&paths, 60);
        assert!(script.contains("TIMEOUT_DIR=\"/tmp/run/timeout\""));
        assert!(script.contains("TIMEOUT_SECS=60"));
        assert!(script.contains("PreToolUse)"));
        assert!(script.contains("timed_out"));
    }
}
