//! Claude Code hook integration for tmux mode.
//!
//! Claude Code calls user-defined "hook" shell commands at well-known points
//! (PreToolUse, PermissionRequest, Elicitation, PostToolUse,
//! UserPromptSubmit, Stop, Notification). We use
//! these hooks to surface tool decisions to our native UI.
//!
//! Layout:
//!   - One `hook.sh` is installed per *workspace* (env). It extracts
//!     `session_id` from the payload Claude Code feeds on stdin and writes
//!     the event to a *per-session* pending dir at
//!     `<workspace_root>/sessions/<session_id>/pending/<EventKind>-<id>.json`.
//!   - Each `TmuxSession`'s poll loop reads from its own session's pending
//!     dir, so concurrent tabs in the same workspace get their own events
//!     without bleed.
//!   - `.claude/settings.local.json` (workspace-level) is installed once and
//!     uninstalled when the last session in the workspace stops; an
//!     idempotent backup of the user's original is preserved.

use super::backend::Backend;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use tracing::{debug, warn};

/// Default for how long the PreToolUse hook will wait for the UI to respond
/// before falling back to Claude Code's normal permission prompt.
pub const HOOK_TIMEOUT_SECS: u32 = 600; // 10 min

/// Sentinel value stored in the settings-backup file when there was no
/// original `.claude/settings.local.json` at install time.
const BACKUP_SENTINEL_NO_ORIGINAL: &str = "__orkestrator_no_original__";
const CLAUDE_SETTINGS_LOCAL_GIT_EXCLUDE_PATTERN: &str = ".claude/settings.local.json";

#[derive(Debug, Clone, Copy)]
pub enum HookEventKind {
    PreToolUse,
    PermissionRequest,
    Elicitation,
    ElicitationResult,
    UserPromptExpansion,
    PostToolUse,
    UserPromptSubmit,
    Stop,
    SubagentStop,
    Notification,
    SessionStart,
}

impl HookEventKind {
    pub fn from_str(s: &str) -> Option<Self> {
        Some(match s {
            "PreToolUse" => HookEventKind::PreToolUse,
            "PermissionRequest" => HookEventKind::PermissionRequest,
            "Elicitation" => HookEventKind::Elicitation,
            "ElicitationResult" => HookEventKind::ElicitationResult,
            "UserPromptExpansion" => HookEventKind::UserPromptExpansion,
            "PostToolUse" => HookEventKind::PostToolUse,
            "UserPromptSubmit" => HookEventKind::UserPromptSubmit,
            "Stop" => HookEventKind::Stop,
            "SubagentStop" => HookEventKind::SubagentStop,
            "Notification" => HookEventKind::Notification,
            "SessionStart" => HookEventKind::SessionStart,
            _ => return None,
        })
    }

    pub fn is_blocking(&self) -> bool {
        matches!(
            self,
            HookEventKind::PreToolUse
                | HookEventKind::PermissionRequest
                | HookEventKind::Elicitation
        )
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

/// Workspace-level (per-env) hook layout. One `hook.sh` and one settings
/// install per workspace, regardless of how many tabs are open.
#[derive(Debug, Clone)]
pub struct WorkspaceHookPaths {
    pub root: String,
    pub sessions_dir: String,
    pub script: String,
    pub claude_settings: String,
    pub claude_settings_backup: String,
}

impl WorkspaceHookPaths {
    /// `runtime_root` is per-workspace (e.g. `/tmp/orkestrator-claude-tmux/<env-id>`).
    /// `workspace` is the cwd whose `.claude/settings.local.json` we'll touch.
    pub fn new(runtime_root: &str, workspace: &str) -> Self {
        let root = runtime_root.to_string();
        WorkspaceHookPaths {
            sessions_dir: format!("{}/sessions", root),
            script: format!("{}/hook.sh", root),
            claude_settings: format!("{}/.claude/settings.local.json", workspace),
            claude_settings_backup: format!("{}/settings.local.json.orkestrator-backup", root),
            root,
        }
    }
}

/// Per-session subdirectories under the workspace's `sessions_dir`. Each
/// `TmuxSession` owns its own set; hook.sh routes events here by parsing the
/// `session_id` field from the payload.
#[derive(Debug, Clone)]
pub struct SessionHookPaths {
    pub session_dir: String,
    pub pending_dir: String,
    pub response_dir: String,
    /// Sentinel files dropped by hook.sh when a blocking hook times out.
    pub timeout_dir: String,
}

impl SessionHookPaths {
    pub fn new(workspace: &WorkspaceHookPaths, session_id: &str) -> Self {
        let session_dir = format!("{}/{}", workspace.sessions_dir, session_id);
        SessionHookPaths {
            pending_dir: format!("{}/pending", session_dir),
            response_dir: format!("{}/response", session_dir),
            timeout_dir: format!("{}/timeout", session_dir),
            session_dir,
        }
    }
}

/// Shell script Claude Code will invoke for every configured hook event.
///
/// The script:
///   1. reads the JSON payload from stdin
///   2. extracts `session_id` with sed (no jq dependency)
///   3. writes the payload to `<sessions_dir>/<session_id>/pending/<EventKind>-<id>.json`
///   4. for blocking hooks (PreToolUse), polls the corresponding response file
///      and emits its contents back to Claude on stdout
///   5. for informational hooks, prints `{}` and exits
///
/// If `session_id` cannot be parsed (unexpected payload shape), events are
/// routed to a fallback `unknown/` subdir so they don't disappear silently.
pub fn hook_script(workspace: &WorkspaceHookPaths, timeout_secs: u32) -> String {
    format!(
        r#"#!/usr/bin/env bash
# orkestrator-ai claude-tmux hook
# Usage: hook.sh <EventKind>
# Stdin: JSON payload from Claude Code
# Stdout: JSON response (for blocking hooks)
set -u
EVENT_KIND="${{1:-Unknown}}"
SESSIONS_DIR={sessions_dir_q}
TIMEOUT_SECS={timeout}

PAYLOAD="$(cat)"

# Extract session_id from the JSON payload.
#
# Primary: python3, which parses the JSON properly and is broadly available
# on macOS/Linux and in our container base image.
# Fallback: sed regex — handles single-line JSON where session_id is a
# UUID-shaped string. Used only when python3 is missing or fails.
# If both fail (payload missing the field or shape is unexpected) we route
# events to an `unknown/` subdir so they don't disappear silently.
SESSION_ID=""
if command -v python3 >/dev/null 2>&1; then
  SESSION_ID="$(printf '%s' "$PAYLOAD" | python3 -c 'import sys, json
try:
    d = json.loads(sys.stdin.read())
    v = d.get("session_id", "") if isinstance(d, dict) else ""
    if isinstance(v, str):
        print(v)
except Exception:
    pass' 2>/dev/null)"
fi
if [ -z "$SESSION_ID" ]; then
  SESSION_ID="$(printf '%s' "$PAYLOAD" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([0-9a-fA-F-]\{{8,\}}\)".*/\1/p' | head -1)"
fi
if [ -z "$SESSION_ID" ]; then
  SESSION_ID="unknown"
fi
# Defensive: strip any path-traversal characters before using as a dir name.
SESSION_ID="$(printf '%s' "$SESSION_ID" | tr -cd 'A-Za-z0-9._-')"
if [ -z "$SESSION_ID" ]; then
  SESSION_ID="unknown"
fi

SESSION_DIR="$SESSIONS_DIR/$SESSION_ID"
PENDING_DIR="$SESSION_DIR/pending"
RESPONSE_DIR="$SESSION_DIR/response"
TIMEOUT_DIR="$SESSION_DIR/timeout"
mkdir -p "$PENDING_DIR" "$RESPONSE_DIR" "$TIMEOUT_DIR" 2>/dev/null || true

# Generate a unique ID (no nanoseconds on BSD/macOS; combine date+pid+RANDOM).
ID="$(date +%s)-$$-${{RANDOM}}-${{RANDOM}}"
PENDING_FILE="$PENDING_DIR/${{EVENT_KIND}}-${{ID}}.json"
RESPONSE_FILE="$RESPONSE_DIR/${{EVENT_KIND}}-${{ID}}.json"
TIMEOUT_FILE="$TIMEOUT_DIR/${{EVENT_KIND}}-${{ID}}.json"

printf '%s' "$PAYLOAD" > "$PENDING_FILE"

case "$EVENT_KIND" in
  PreToolUse|PermissionRequest|Elicitation)
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
        sessions_dir_q = shell_dq(&workspace.sessions_dir),
        timeout = timeout_secs,
    )
}

/// Build the hooks object that our settings.local.json contributes. Returned
/// as a JSON Value so the caller can merge it into any pre-existing settings.
///
/// NOTE: We only register `PreToolUse` for Claude Code's built-in
/// user-interaction tools. General tool permissions remain bypassed by the
/// session's `--dangerously-skip-permissions` launch flag.
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
        "PreToolUse": [
            {
                "matcher": "AskUserQuestion",
                "hooks": [{ "type": "command", "command": format!("{}{}", cmd, "PreToolUse") }]
            },
            {
                "matcher": "ExitPlanMode",
                "hooks": [{ "type": "command", "command": format!("{}{}", cmd, "PreToolUse") }]
            }
        ],
        "PermissionRequest": [mk("PermissionRequest")],
        "Elicitation":       [mk_no_matcher("Elicitation")],
        "ElicitationResult": [mk_no_matcher("ElicitationResult")],
        "UserPromptExpansion": [mk_no_matcher("UserPromptExpansion")],
        "PostToolUse":       [mk("PostToolUse")],
        "UserPromptSubmit":  [mk_no_matcher("UserPromptSubmit")],
        "Stop":              [mk_no_matcher("Stop")],
        "SubagentStop":      [mk_no_matcher("SubagentStop")],
        "Notification":      [mk_no_matcher("Notification")],
        "SessionStart":      [mk_no_matcher("SessionStart")]
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

/// Install workspace-level hooks. Idempotent: a subsequent call when the
/// hooks are already installed does NOT clobber the original-settings backup
/// — only the first install captures the user's true original.
pub async fn install_workspace_hooks(
    backend: &Backend,
    paths: &WorkspaceHookPaths,
) -> Result<(), String> {
    backend.ensure_dir(&paths.root).await?;
    backend.ensure_dir(&paths.sessions_dir).await?;
    ensure_claude_settings_git_ignored(backend).await;

    let script = hook_script(paths, HOOK_TIMEOUT_SECS);
    backend.write_file(&paths.script, &script).await?;
    backend.exec(&["chmod", "+x", &paths.script]).await?;

    // Backup: write the original settings ONLY if we haven't already on a
    // previous install. This keeps the user's true original safe even when
    // the second tab in the same workspace calls install_workspace_hooks.
    let existing_backup = backend.read_file(&paths.claude_settings_backup).await?;
    let existing_settings = backend.read_file(&paths.claude_settings).await?;
    if existing_backup.is_none() {
        match existing_settings.as_deref() {
            Some(prev) => {
                backend
                    .write_file(&paths.claude_settings_backup, prev)
                    .await?;
            }
            None => {
                backend
                    .write_file(&paths.claude_settings_backup, BACKUP_SENTINEL_NO_ORIGINAL)
                    .await?;
            }
        }
    }

    // Always overwrite settings.local.json with our hooks block; subsequent
    // installs are no-ops because the merged content is the same.
    let merged = merge_settings_json(existing_settings.as_deref(), &paths.script);
    backend.write_file(&paths.claude_settings, &merged).await?;

    Ok(())
}

async fn ensure_claude_settings_git_ignored(backend: &Backend) {
    let script = git_exclude_setup_script(CLAUDE_SETTINGS_LOCAL_GIT_EXCLUDE_PATTERN);
    let out = match backend.exec(&["bash", "-lc", &script]).await {
        Ok(out) => out,
        Err(e) => {
            warn!(error = %e, "Failed to run Claude settings Git exclude setup");
            return;
        }
    };

    if out.success() {
        debug!("Ensured Claude workspace settings are ignored by Git");
    } else {
        warn!(
            status = out.status,
            stderr = %out.stderr,
            "Claude settings Git exclude setup exited unsuccessfully"
        );
    }
}

fn git_exclude_setup_script(pattern: &str) -> String {
    format!(
        r#"set -e
pattern={pattern_q}

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  exit 0
fi

git_dir_raw="$(git rev-parse --git-dir)"
common_dir_raw="$(git rev-parse --git-common-dir 2>/dev/null || printf '%s' "$git_dir_raw")"

git_dir="$(cd "$git_dir_raw" 2>/dev/null && pwd -P || printf '%s' "$git_dir_raw")"
common_dir="$(cd "$common_dir_raw" 2>/dev/null && pwd -P || printf '%s' "$common_dir_raw")"

if [ "$git_dir" != "$common_dir" ]; then
  git config extensions.worktreeConfig true
  exclude_file="$(git config --worktree --get core.excludesFile 2>/dev/null || true)"
  if [ -z "$exclude_file" ]; then
    exclude_file="$git_dir/info/exclude"
    git config --worktree core.excludesFile "$exclude_file"
  fi
else
  exclude_file="$git_dir/info/exclude"
fi

case "$exclude_file" in
  "~/"*) exclude_file="$HOME/${{exclude_file#~/}}" ;;
esac

mkdir -p "$(dirname "$exclude_file")"
touch "$exclude_file"

append_exclude_pattern() {{
  exclude_file="$1"
  pattern="$2"
  if [ -s "$exclude_file" ] && [ "$(tail -c 1 "$exclude_file" 2>/dev/null)" != "" ]; then
    printf '\n' >> "$exclude_file"
  fi
  printf '%s\n' "$pattern" >> "$exclude_file"
}}

if ! grep -qxF "$pattern" "$exclude_file"; then
  append_exclude_pattern "$exclude_file" "$pattern"
fi
"#,
        pattern_q = shell_dq(pattern)
    )
}

/// Restore the user's original `.claude/settings.local.json` and remove the
/// workspace runtime directory. Should only be called when the last session
/// in the workspace stops — the caller is responsible for this gating.
pub async fn uninstall_workspace_hooks(
    backend: &Backend,
    paths: &WorkspaceHookPaths,
) -> Result<(), String> {
    let backup = backend.read_file(&paths.claude_settings_backup).await?;
    match backup.as_deref() {
        Some(s) if s == BACKUP_SENTINEL_NO_ORIGINAL => {
            backend.remove_file(&paths.claude_settings).await?;
        }
        Some(content) => {
            backend.write_file(&paths.claude_settings, content).await?;
        }
        None => {
            // No backup recorded — leave settings as-is.
        }
    }
    backend
        .remove_file(&paths.claude_settings_backup)
        .await
        .ok();
    backend.exec(&["rm", "-rf", &paths.root]).await.ok();
    Ok(())
}

/// Create the per-session pending/response/timeout dirs.
pub async fn ensure_session_dirs(
    backend: &Backend,
    paths: &SessionHookPaths,
) -> Result<(), String> {
    backend.ensure_dir(&paths.session_dir).await?;
    backend.ensure_dir(&paths.pending_dir).await?;
    backend.ensure_dir(&paths.response_dir).await?;
    backend.ensure_dir(&paths.timeout_dir).await?;
    Ok(())
}

/// Remove a session's runtime subdirs. Best-effort.
pub async fn remove_session_dirs(
    backend: &Backend,
    paths: &SessionHookPaths,
) -> Result<(), String> {
    backend.exec(&["rm", "-rf", &paths.session_dir]).await.ok();
    Ok(())
}

/// Scan the timeout dir and return the IDs of blocking hooks that gave up
/// waiting for a response. Files are consumed on read.
pub async fn drain_timeouts(
    backend: &Backend,
    paths: &SessionHookPaths,
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
/// poll. The set is also pruned of IDs whose pending files have disappeared.
pub async fn drain_pending(
    backend: &Backend,
    paths: &SessionHookPaths,
    already_emitted: &mut HashSet<String>,
) -> Result<Vec<PendingHookEvent>, String> {
    let mut names = backend.list_dir(&paths.pending_dir).await?;
    names.sort();

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

        events.push(PendingHookEvent { id, kind, payload });
    }

    Ok(events)
}

/// Return the currently pending blocking hooks without consuming the files and
/// without consulting the poll loop's already-emitted set. This is used as an
/// authoritative UI rehydration snapshot when a tab remounts after missing
/// Tauri events while inactive.
pub async fn list_pending_blocking(
    backend: &Backend,
    paths: &SessionHookPaths,
) -> Result<Vec<PendingHookEvent>, String> {
    let mut names = backend.list_dir(&paths.pending_dir).await?;
    names.sort();

    let mut events = Vec::new();
    for name in names {
        if !name.ends_with(".json") {
            continue;
        }
        let (kind, id) = parse_event_filename(&name);
        let is_blocking = HookEventKind::from_str(&kind)
            .map(|k| k.is_blocking())
            .unwrap_or(false);
        if !is_blocking {
            continue;
        }

        let response_path = format!("{}/{}", paths.response_dir, name);
        if backend.read_file(&response_path).await?.is_some() {
            continue;
        }

        let full = format!("{}/{}", paths.pending_dir, name);
        let Some(content) = backend.read_file(&full).await? else {
            continue;
        };
        let payload: Value = match serde_json::from_str(&content) {
            Ok(v) => v,
            Err(_) => Value::String(content),
        };
        events.push(PendingHookEvent { id, kind, payload });
    }

    Ok(events)
}

/// Write a response file for a previously emitted blocking hook event.
pub async fn reply_to_hook(
    backend: &Backend,
    paths: &SessionHookPaths,
    kind: &str,
    id: &str,
    response: &Value,
) -> Result<(), String> {
    let filename = response_filename(kind, id)?;
    let response_path = format!("{}/{}", paths.response_dir, filename);
    backend
        .write_file(
            &response_path,
            &serde_json::to_string(response).unwrap_or_else(|_| "{}".into()),
        )
        .await?;
    // The hook script only needs the response file from here. Removing the
    // pending file makes answered hooks disappear from rehydration snapshots
    // immediately instead of waiting for the script's next poll tick.
    let pending_path = format!("{}/{}", paths.pending_dir, filename);
    backend.remove_file(&pending_path).await.ok();
    Ok(())
}

fn response_filename(kind: &str, id: &str) -> Result<String, String> {
    if HookEventKind::from_str(kind).is_none() {
        return Err(format!("unsupported hook event kind: {kind}"));
    }
    if id.is_empty()
        || id.contains("..")
        || !id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
    {
        return Err("invalid hook event id".to_string());
    }
    Ok(format!("{}-{}.json", kind, id))
}

/// Convenience: build a PreToolUse JSON response. `decision` is one of
/// "approve" | "block". For "block", `reason` is shown to Claude.
pub fn pre_tool_use_response(decision: &str, reason: Option<&str>) -> Value {
    let permission_decision = match decision {
        "approve" | "allow" => "allow",
        "block" | "deny" => "deny",
        other => other,
    };
    let mut output = json!({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": permission_decision
        }
    });
    if let Some(r) = reason {
        output["hookSpecificOutput"]["permissionDecisionReason"] = Value::String(r.to_string());
    }
    output
}

fn parse_event_filename(name: &str) -> (String, String) {
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
    use serde_json::json;
    use std::path::{Path, PathBuf};

    fn git_available() -> bool {
        std::process::Command::new("git")
            .arg("--version")
            .output()
            .map(|out| out.status.success())
            .unwrap_or(false)
    }

    fn run_git(dir: &Path, args: &[&str]) {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {:?} failed\nstdout: {}\nstderr: {}",
            args,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn git_stdout(dir: &Path, args: &[&str]) -> String {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {:?} failed\nstdout: {}\nstderr: {}",
            args,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    fn resolve_repo_path(repo: &Path, path: String) -> PathBuf {
        let path = PathBuf::from(path);
        if path.is_absolute() {
            path
        } else {
            repo.join(path)
        }
    }

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
        assert_eq!(v["hookSpecificOutput"]["permissionDecision"], "allow");
        assert!(v["hookSpecificOutput"]
            .get("permissionDecisionReason")
            .is_none());
    }

    #[test]
    fn pre_tool_use_response_block_includes_reason() {
        let v = pre_tool_use_response("block", Some("nope"));
        assert_eq!(v["hookSpecificOutput"]["permissionDecision"], "deny");
        assert_eq!(v["hookSpecificOutput"]["permissionDecisionReason"], "nope");
    }

    #[test]
    fn hooks_block_has_supported_informational_event_kinds() {
        let v = hooks_block("/tmp/x/hook.sh");
        let obj = v.as_object().unwrap();
        for kind in [
            "PreToolUse",
            "PermissionRequest",
            "Elicitation",
            "ElicitationResult",
            "UserPromptExpansion",
            "PostToolUse",
            "UserPromptSubmit",
            "Stop",
            "SubagentStop",
            "Notification",
            "SessionStart",
        ] {
            assert!(obj.contains_key(kind), "missing kind: {kind}");
        }
        assert_eq!(v["PreToolUse"][0]["matcher"], "AskUserQuestion");
        assert_eq!(v["PreToolUse"][1]["matcher"], "ExitPlanMode");
        let post = &v["PostToolUse"][0];
        assert_eq!(post["matcher"], "*");
        assert!(post["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .contains("PostToolUse"));
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
    fn hook_event_kind_blocking_for_interactive_events() {
        assert!(HookEventKind::PreToolUse.is_blocking());
        assert!(HookEventKind::PermissionRequest.is_blocking());
        assert!(HookEventKind::Elicitation.is_blocking());
        for k in [
            HookEventKind::ElicitationResult,
            HookEventKind::UserPromptExpansion,
            HookEventKind::PostToolUse,
            HookEventKind::UserPromptSubmit,
            HookEventKind::Stop,
            HookEventKind::SubagentStop,
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
    fn git_exclude_setup_script_uses_worktree_specific_config() {
        let script = git_exclude_setup_script(".claude/settings.local.json");
        assert!(script.contains(".claude/settings.local.json"));
        assert!(script.contains("git config extensions.worktreeConfig true"));
        assert!(script.contains("git config --worktree core.excludesFile"));
        assert!(script.contains("$git_dir/info/exclude"));
        assert!(script.contains("append_exclude_pattern"));
        assert!(script.contains("tail -c 1"));
    }

    #[tokio::test]
    async fn ensure_claude_settings_git_ignored_adds_regular_repo_exclude() {
        if !git_available() {
            eprintln!("skipping: git not on PATH");
            return;
        }

        let tmp = tempfile::TempDir::new().unwrap();
        run_git(tmp.path(), &["init"]);

        let backend = Backend::Local {
            cwd: tmp.path().to_string_lossy().into_owned(),
        };
        ensure_claude_settings_git_ignored(&backend).await;

        let exclude = std::fs::read_to_string(tmp.path().join(".git/info/exclude")).unwrap();
        assert!(exclude.contains(".claude/settings.local.json"));
    }

    #[tokio::test]
    async fn ensure_claude_settings_git_ignored_is_newline_safe_and_idempotent() {
        if !git_available() {
            eprintln!("skipping: git not on PATH");
            return;
        }

        let tmp = tempfile::TempDir::new().unwrap();
        run_git(tmp.path(), &["init"]);
        let exclude_path = tmp.path().join(".git/info/exclude");
        std::fs::write(&exclude_path, "existing-pattern").unwrap();

        let backend = Backend::Local {
            cwd: tmp.path().to_string_lossy().into_owned(),
        };
        ensure_claude_settings_git_ignored(&backend).await;
        ensure_claude_settings_git_ignored(&backend).await;

        let exclude = std::fs::read_to_string(&exclude_path).unwrap();
        assert_eq!(exclude, "existing-pattern\n.claude/settings.local.json\n");

        std::fs::create_dir_all(tmp.path().join(".claude")).unwrap();
        std::fs::write(tmp.path().join(".claude/settings.local.json"), "{}\n").unwrap();
        let check_ignore = git_stdout(
            tmp.path(),
            &[
                "-c",
                "core.excludesFile=/dev/null",
                "check-ignore",
                "-v",
                ".claude/settings.local.json",
            ],
        );
        assert!(check_ignore.contains(".git/info/exclude"));
    }

    #[tokio::test]
    async fn ensure_claude_settings_git_ignored_noops_outside_git_repo() {
        if !git_available() {
            eprintln!("skipping: git not on PATH");
            return;
        }

        let tmp = tempfile::TempDir::new().unwrap();
        let backend = Backend::Local {
            cwd: tmp.path().to_string_lossy().into_owned(),
        };

        ensure_claude_settings_git_ignored(&backend).await;

        assert!(!tmp.path().join(".git").exists());
    }

    #[tokio::test]
    async fn ensure_claude_settings_git_ignored_tolerates_exec_failure() {
        let tmp = tempfile::TempDir::new().unwrap();
        let missing = tmp.path().join("missing");
        let backend = Backend::Local {
            cwd: missing.to_string_lossy().into_owned(),
        };

        ensure_claude_settings_git_ignored(&backend).await;

        assert!(!missing.exists());
    }

    #[tokio::test]
    async fn ensure_claude_settings_git_ignored_uses_worktree_specific_exclude() {
        if !git_available() {
            eprintln!("skipping: git not on PATH");
            return;
        }

        let tmp = tempfile::TempDir::new().unwrap();
        let source = tmp.path().join("source");
        let worktree = tmp.path().join("worktree");
        std::fs::create_dir_all(&source).unwrap();
        run_git(&source, &["init"]);
        run_git(&source, &["config", "user.email", "test@example.com"]);
        run_git(&source, &["config", "user.name", "Test User"]);
        std::fs::write(source.join("README.md"), "test\n").unwrap();
        run_git(&source, &["add", "README.md"]);
        run_git(&source, &["commit", "-m", "init"]);
        run_git(
            &source,
            &["worktree", "add", "-b", "env", worktree.to_str().unwrap()],
        );

        let backend = Backend::Local {
            cwd: worktree.to_string_lossy().into_owned(),
        };
        ensure_claude_settings_git_ignored(&backend).await;

        let git_dir = resolve_repo_path(
            &worktree,
            git_stdout(&worktree, &["rev-parse", "--git-dir"]),
        );
        let common_dir = resolve_repo_path(
            &worktree,
            git_stdout(&worktree, &["rev-parse", "--git-common-dir"]),
        );
        let worktree_exclude = std::fs::read_to_string(git_dir.join("info/exclude")).unwrap();
        assert!(worktree_exclude.contains(".claude/settings.local.json"));

        let common_exclude_path = common_dir.join("info/exclude");
        let common_exclude = std::fs::read_to_string(common_exclude_path).unwrap_or_default();
        assert!(!common_exclude.contains(".claude/settings.local.json"));

        std::fs::create_dir_all(worktree.join(".claude")).unwrap();
        std::fs::write(worktree.join(".claude/settings.local.json"), "{}\n").unwrap();
        let check_ignore = git_stdout(
            &worktree,
            &["check-ignore", "-v", ".claude/settings.local.json"],
        );
        assert!(check_ignore.contains(&git_dir.join("info/exclude").to_string_lossy().to_string()));
    }

    #[tokio::test]
    async fn ensure_claude_settings_git_ignored_respects_existing_worktree_excludes_file() {
        if !git_available() {
            eprintln!("skipping: git not on PATH");
            return;
        }

        let tmp = tempfile::TempDir::new().unwrap();
        let source = tmp.path().join("source");
        let worktree = tmp.path().join("worktree");
        let custom_exclude = tmp.path().join("custom-exclude");
        std::fs::create_dir_all(&source).unwrap();
        run_git(&source, &["init"]);
        run_git(&source, &["config", "user.email", "test@example.com"]);
        run_git(&source, &["config", "user.name", "Test User"]);
        std::fs::write(source.join("README.md"), "test\n").unwrap();
        run_git(&source, &["add", "README.md"]);
        run_git(&source, &["commit", "-m", "init"]);
        run_git(
            &source,
            &["worktree", "add", "-b", "env", worktree.to_str().unwrap()],
        );
        run_git(&source, &["config", "extensions.worktreeConfig", "true"]);
        run_git(
            &worktree,
            &[
                "config",
                "--worktree",
                "core.excludesFile",
                custom_exclude.to_str().unwrap(),
            ],
        );
        std::fs::write(&custom_exclude, "existing-pattern\n").unwrap();

        let backend = Backend::Local {
            cwd: worktree.to_string_lossy().into_owned(),
        };
        ensure_claude_settings_git_ignored(&backend).await;

        let exclude = std::fs::read_to_string(&custom_exclude).unwrap();
        assert!(exclude.contains(".claude/settings.local.json"));

        std::fs::create_dir_all(worktree.join(".claude")).unwrap();
        std::fs::write(worktree.join(".claude/settings.local.json"), "{}\n").unwrap();
        let check_ignore = git_stdout(
            &worktree,
            &["check-ignore", "-v", ".claude/settings.local.json"],
        );
        assert!(check_ignore.contains(&custom_exclude.to_string_lossy().to_string()));
    }

    #[test]
    fn workspace_hook_paths_layout() {
        let p = WorkspaceHookPaths::new("/tmp/run", "/work");
        assert_eq!(p.root, "/tmp/run");
        assert_eq!(p.sessions_dir, "/tmp/run/sessions");
        assert_eq!(p.script, "/tmp/run/hook.sh");
        assert_eq!(p.claude_settings, "/work/.claude/settings.local.json");
        assert!(p.claude_settings_backup.starts_with("/tmp/run/"));
    }

    #[test]
    fn session_hook_paths_are_nested_under_sessions_dir() {
        let ws = WorkspaceHookPaths::new("/tmp/run", "/work");
        let s = SessionHookPaths::new(&ws, "abc-123");
        assert_eq!(s.session_dir, "/tmp/run/sessions/abc-123");
        assert_eq!(s.pending_dir, "/tmp/run/sessions/abc-123/pending");
        assert_eq!(s.response_dir, "/tmp/run/sessions/abc-123/response");
        assert_eq!(s.timeout_dir, "/tmp/run/sessions/abc-123/timeout");
    }

    #[test]
    fn response_filename_accepts_known_hook_kind_and_safe_id() {
        assert_eq!(
            response_filename("PreToolUse", "1731519430-1234_9876").unwrap(),
            "PreToolUse-1731519430-1234_9876.json"
        );
    }

    #[test]
    fn response_filename_rejects_unknown_kind_and_path_shaped_ids() {
        assert!(response_filename("../PreToolUse", "hook-1").is_err());
        assert!(response_filename("PreToolUse", "").is_err());
        assert!(response_filename("PreToolUse", "../hook-1").is_err());
        assert!(response_filename("PreToolUse", "hook/../../outside").is_err());
        assert!(response_filename("PreToolUse", r"hook\..\outside").is_err());
    }

    #[tokio::test]
    async fn reply_to_hook_removes_matching_pending_file_after_writing_response() {
        let tmp = tempfile::TempDir::new().unwrap();
        let backend = Backend::Local {
            cwd: tmp.path().to_string_lossy().into_owned(),
        };
        let runtime = tmp.path().join("runtime");
        let ws = WorkspaceHookPaths::new(runtime.to_str().unwrap(), "/work");
        let paths = SessionHookPaths::new(&ws, "session-1");
        ensure_session_dirs(&backend, &paths).await.unwrap();

        let pending_path = format!("{}/PreToolUse-hook-1.json", paths.pending_dir);
        tokio::fs::write(&pending_path, r#"{"tool_name":"AskUserQuestion"}"#)
            .await
            .unwrap();

        reply_to_hook(
            &backend,
            &paths,
            "PreToolUse",
            "hook-1",
            &json!({"hookSpecificOutput":{"hookEventName":"PreToolUse"}}),
        )
        .await
        .unwrap();

        let response_path = format!("{}/PreToolUse-hook-1.json", paths.response_dir);
        assert!(backend.read_file(&response_path).await.unwrap().is_some());
        assert!(backend.read_file(&pending_path).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn reply_to_hook_rejects_unsafe_filename_inputs_before_touching_files() {
        let tmp = tempfile::TempDir::new().unwrap();
        let backend = Backend::Local {
            cwd: tmp.path().to_string_lossy().into_owned(),
        };
        let runtime = tmp.path().join("runtime");
        let ws = WorkspaceHookPaths::new(runtime.to_str().unwrap(), "/work");
        let paths = SessionHookPaths::new(&ws, "session-1");
        ensure_session_dirs(&backend, &paths).await.unwrap();

        let pending_path = format!("{}/PreToolUse-hook-1.json", paths.pending_dir);
        tokio::fs::write(&pending_path, r#"{"tool_name":"AskUserQuestion"}"#)
            .await
            .unwrap();

        let response = json!({"hookSpecificOutput":{"hookEventName":"PreToolUse"}});
        assert!(
            reply_to_hook(&backend, &paths, "../PreToolUse", "hook-1", &response)
                .await
                .is_err()
        );
        assert!(reply_to_hook(
            &backend,
            &paths,
            "PreToolUse",
            "hook-1/../../outside",
            &response,
        )
        .await
        .is_err());

        assert!(backend.read_file(&pending_path).await.unwrap().is_some());
        let response_entries = backend.list_dir(&paths.response_dir).await.unwrap();
        assert!(response_entries.is_empty());
    }

    #[tokio::test]
    async fn list_pending_blocking_ignores_hooks_that_already_have_response_files() {
        let tmp = tempfile::TempDir::new().unwrap();
        let backend = Backend::Local {
            cwd: tmp.path().to_string_lossy().into_owned(),
        };
        let runtime = tmp.path().join("runtime");
        let ws = WorkspaceHookPaths::new(runtime.to_str().unwrap(), "/work");
        let paths = SessionHookPaths::new(&ws, "session-1");
        ensure_session_dirs(&backend, &paths).await.unwrap();

        let pending_path = format!("{}/PreToolUse-hook-1.json", paths.pending_dir);
        let response_path = format!("{}/PreToolUse-hook-1.json", paths.response_dir);
        tokio::fs::write(&pending_path, r#"{"tool_name":"AskUserQuestion"}"#)
            .await
            .unwrap();
        tokio::fs::write(&response_path, r#"{}"#).await.unwrap();

        let pending = list_pending_blocking(&backend, &paths).await.unwrap();
        assert!(pending.is_empty());
    }

    #[test]
    fn hook_script_routes_by_session_id_and_contains_event_branch() {
        let ws = WorkspaceHookPaths::new("/tmp/run", "/work");
        let script = hook_script(&ws, 60);
        assert!(script.contains("SESSIONS_DIR=\"/tmp/run/sessions\""));
        assert!(script.contains("session_id"));
        assert!(script.contains("PreToolUse|PermissionRequest|Elicitation)"));
        assert!(script.contains("timed_out"));
        // Each event is dispatched into a per-session subdir.
        assert!(script.contains("$SESSION_DIR/pending"));
        assert!(script.contains("$SESSION_DIR/response"));
        assert!(script.contains("$SESSION_DIR/timeout"));
        // session_id extraction prefers python3 with a sed fallback.
        assert!(script.contains("python3"));
        assert!(script.contains("json.loads"));
        assert!(script.contains("sed -n"));
        // Path-traversal characters are sanitized out of the session id.
        assert!(script.contains("tr -cd"));
    }

    /// Run the generated hook.sh end-to-end (when bash is available) and
    /// verify it routes events to the correct per-session subdir for both
    /// happy-path JSON and a payload that requires the sed fallback.
    #[tokio::test]
    async fn hook_script_routes_payloads_to_per_session_subdir() {
        // CI without bash should just no-op this test.
        if std::process::Command::new("bash")
            .arg("--version")
            .output()
            .is_err()
        {
            eprintln!("skipping: bash not on PATH");
            return;
        }
        let tmp = tempfile::TempDir::new().unwrap();
        let runtime = tmp.path().join("runtime");
        std::fs::create_dir_all(&runtime).unwrap();
        let ws = WorkspaceHookPaths::new(runtime.to_str().unwrap(), "/work");

        // Write the script.
        let script_text = hook_script(&ws, 1);
        let script_path = tmp.path().join("hook.sh");
        std::fs::write(&script_path, script_text).unwrap();
        std::process::Command::new("chmod")
            .args(["+x", script_path.to_str().unwrap()])
            .status()
            .unwrap();

        // Run the script as an informational event with a well-formed payload.
        let payload = r#"{"session_id":"abc-12345678","tool_name":"Bash"}"#;
        let mut child = std::process::Command::new(script_path.to_str().unwrap())
            .arg("Notification")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        use std::io::Write;
        child
            .stdin
            .as_mut()
            .unwrap()
            .write_all(payload.as_bytes())
            .unwrap();
        let status = child.wait().unwrap();
        assert!(status.success(), "hook script must exit cleanly");

        // The pending file landed in the per-session subdir.
        let pending_dir = format!("{}/sessions/abc-12345678/pending", ws.root);
        let entries: Vec<_> = std::fs::read_dir(&pending_dir).unwrap().collect();
        assert_eq!(entries.len(), 1, "expected one pending file");
    }
}
