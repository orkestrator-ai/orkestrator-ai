//! Watches the Claude Code JSONL transcript for a session and emits each new
//! line as it appears.
//!
//! Claude Code writes one JSON object per line to
//! `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` (host or container).
//! The encoded-cwd is the absolute path with `/` replaced by `-`. We find the
//! file by globbing for `<session-id>.jsonl` so we don't need to compute the
//! encoding ourselves (and we tolerate Claude Code changing it).
//!
//! Strategy:
//!   - poll `find ~/.claude/projects -name '<session>.jsonl'` until the file
//!     appears (Claude may take a beat after launch).
//!   - then poll the file size and, whenever it grows, read the new tail and
//!     parse out complete lines.
//!
//! Polling at ~250ms is plenty for chat UX and uses negligible CPU.

use super::backend::Backend;
use serde_json::Value;

const POLL_MS: u64 = 250;

/// Encode an absolute cwd path the way Claude Code names its project
/// directory under `~/.claude/projects/`. The scheme observed in practice:
/// drop the trailing slash, then replace every `/` with `-`. An absolute
/// path like `/Users/foo/proj` therefore becomes `-Users-foo-proj`.
pub fn encode_cwd(cwd: &str) -> String {
    let trimmed = cwd.trim_end_matches('/');
    trimmed.replace('/', "-")
}

/// Resolve the absolute JSONL path for the given session ID for a *specific*
/// worktree/workspace. The search is intentionally scoped to the encoded-cwd
/// directory so concurrent Claude sessions in unrelated projects on the same
/// machine cannot bleed into our chat.
///
/// `min_mtime_unix` constrains the mtime fallback (only files modified at or
/// after this time are considered). This is the safety net for installed
/// `claude` builds that ignore `--session-id` and assign their own UUID.
pub async fn find_transcript_path(
    backend: &Backend,
    claude_home: &str,
    cwd: &str,
    session_id: &str,
    min_mtime_unix: Option<u64>,
) -> Result<Option<String>, String> {
    let encoded = encode_cwd(cwd);
    let project_dir = format!("{}/projects/{}", claude_home, encoded);

    // Pass 1: exact session-id match in our project directory.
    let exact = format!("{}/{}.jsonl", project_dir, session_id);
    if backend.file_size(&exact).await.unwrap_or(0) > 0
        || backend.read_file(&exact).await.ok().flatten().is_some()
    {
        return Ok(Some(exact));
    }

    // Pass 2: newest JSONL inside *only* our project's encoded dir, gated by
    // mtime so we don't pick up an older session from a previous run.
    if let Some(t) = min_mtime_unix {
        if let Some(p) = newest_jsonl_in_dir(backend, &project_dir, t).await? {
            return Ok(Some(p));
        }
    }

    Ok(None)
}

/// Return the absolute path of the most recently modified `*.jsonl` file
/// inside `dir` whose mtime ≥ `min_mtime_unix` seconds.
async fn newest_jsonl_in_dir(
    backend: &Backend,
    dir: &str,
    min_mtime_unix: u64,
) -> Result<Option<String>, String> {
    match backend {
        Backend::Container { .. } => {
            // GNU `find` is reliable on our Debian container image.
            let script = format!(
                "find {}/ -mindepth 1 -maxdepth 1 -type f -name '*.jsonl' -newermt @{} -printf '%T@ %p\\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-",
                shell_q(dir),
                min_mtime_unix,
            );
            let out = backend.exec(&["sh", "-c", &script]).await?;
            let path = out.stdout.trim().to_string();
            if path.is_empty() {
                Ok(None)
            } else {
                Ok(Some(path))
            }
        }
        Backend::Local { .. } => {
            // BSD `find` on macOS does not support `-newermt @<epoch>`; scan
            // via Rust fs APIs instead.
            let mut newest: Option<(u64, String)> = None;
            let names = backend.list_dir(dir).await.unwrap_or_default();
            for name in names {
                if !name.ends_with(".jsonl") {
                    continue;
                }
                let full = format!("{}/{}", dir, name);
                if let Ok(meta) = tokio::fs::metadata(&full).await {
                    if let Ok(mtime) = meta.modified() {
                        if let Ok(dur) = mtime.duration_since(std::time::UNIX_EPOCH) {
                            let secs = dur.as_secs();
                            if secs >= min_mtime_unix
                                && newest.as_ref().is_none_or(|(t, _)| secs > *t)
                            {
                                newest = Some((secs, full));
                            }
                        }
                    }
                }
            }
            Ok(newest.map(|(_, p)| p))
        }
    }
}

fn shell_q(s: &str) -> String {
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

/// State for incrementally reading a JSONL file as it grows.
pub struct TranscriptTail {
    pub path: String,
    /// Byte offset we've already read up to. Lines starting at `offset` and
    /// later are unread.
    pub offset: u64,
    /// Buffer for a partial trailing line that hasn't been newline-terminated.
    pub partial: String,
}

impl TranscriptTail {
    pub fn new(path: String) -> Self {
        TranscriptTail {
            path,
            offset: 0,
            partial: String::new(),
        }
    }

    /// Read everything new from `offset` to EOF, advance `offset`, and return
    /// every complete JSONL line parsed as a value.
    pub async fn read_new(&mut self, backend: &Backend) -> Result<Vec<Value>, String> {
        let size = backend.file_size(&self.path).await?;
        if size <= self.offset {
            return Ok(Vec::new());
        }
        // Simple approach: re-read the full file. For real-world chat-size
        // transcripts (≤ a few MB) this is fine and avoids range-read complexity
        // across both local and container backends.
        let full = backend.read_file(&self.path).await?.unwrap_or_default();
        let new_chunk = full
            .get(self.offset as usize..)
            .unwrap_or("")
            .to_string();
        self.offset = full.len() as u64;

        let combined = std::mem::take(&mut self.partial) + &new_chunk;
        let mut lines: Vec<Value> = Vec::new();
        let mut last_newline = 0usize;
        for (idx, b) in combined.bytes().enumerate() {
            if b == b'\n' {
                let line = &combined[last_newline..idx];
                last_newline = idx + 1;
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                match serde_json::from_str::<Value>(trimmed) {
                    Ok(v) => lines.push(v),
                    Err(_) => {
                        // Keep parsing; drop unparseable lines.
                    }
                }
            }
        }
        // Anything after the last newline is a partial line.
        if last_newline < combined.len() {
            self.partial = combined[last_newline..].to_string();
        }

        Ok(lines)
    }
}

pub const POLL_INTERVAL_MS: u64 = POLL_MS;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claude_tmux::backend::Backend;
    use serde_json::json;
    use std::path::PathBuf;
    use tempfile::TempDir;
    use tokio::fs;

    fn local_backend(dir: &TempDir) -> Backend {
        Backend::Local {
            cwd: dir.path().to_string_lossy().into_owned(),
        }
    }

    fn path_in(dir: &TempDir, rel: &str) -> PathBuf {
        dir.path().join(rel)
    }

    #[test]
    fn encode_cwd_matches_claude_codes_scheme() {
        assert_eq!(encode_cwd("/Users/foo/proj"), "-Users-foo-proj");
        assert_eq!(encode_cwd("/Users/foo/proj/"), "-Users-foo-proj");
        assert_eq!(encode_cwd("/workspace"), "-workspace");
    }

    #[tokio::test]
    async fn find_transcript_path_returns_none_when_missing() {
        let dir = TempDir::new().unwrap();
        let backend = local_backend(&dir);
        let claude_home = dir.path().join(".claude");
        let out = find_transcript_path(
            &backend,
            claude_home.to_str().unwrap(),
            "/Users/me/proj",
            "session-xyz",
            None,
        )
        .await
        .unwrap();
        assert_eq!(out, None);
    }

    #[tokio::test]
    async fn find_transcript_path_locates_file_in_encoded_cwd() {
        let dir = TempDir::new().unwrap();
        let backend = local_backend(&dir);
        let cwd = "/Users/me/proj";
        let proj_dir = path_in(&dir, &format!(".claude/projects/{}", encode_cwd(cwd)));
        fs::create_dir_all(&proj_dir).await.unwrap();
        let jsonl = proj_dir.join("session-xyz.jsonl");
        fs::write(&jsonl, b"{\"type\":\"system\"}\n").await.unwrap();

        let claude_home = dir.path().join(".claude");
        let out = find_transcript_path(
            &backend,
            claude_home.to_str().unwrap(),
            cwd,
            "session-xyz",
            None,
        )
        .await
        .unwrap();
        assert_eq!(out, Some(jsonl.to_string_lossy().into_owned()));
    }

    #[tokio::test]
    async fn find_transcript_path_falls_back_to_newest_jsonl_when_id_misses() {
        let dir = TempDir::new().unwrap();
        let backend = local_backend(&dir);
        let cwd = "/Users/me/proj";
        let proj_dir = path_in(&dir, &format!(".claude/projects/{}", encode_cwd(cwd)));
        fs::create_dir_all(&proj_dir).await.unwrap();
        // Wrong session id but freshly written → fallback should pick it.
        let jsonl = proj_dir.join("other-session.jsonl");
        fs::write(&jsonl, b"{\"type\":\"system\"}\n").await.unwrap();

        let claude_home = dir.path().join(".claude");
        let start = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            .saturating_sub(60);

        let out = find_transcript_path(
            &backend,
            claude_home.to_str().unwrap(),
            cwd,
            "session-xyz",
            Some(start),
        )
        .await
        .unwrap();
        assert_eq!(out, Some(jsonl.to_string_lossy().into_owned()));
    }

    #[tokio::test]
    async fn find_transcript_path_ignores_concurrent_sessions_in_other_projects() {
        // Regression: when another Claude session is actively writing under a
        // *different* project dir, our cwd-scoped search must NOT pick it up.
        let dir = TempDir::new().unwrap();
        let backend = local_backend(&dir);
        let our_cwd = "/Users/me/proj-a";
        let our_dir = path_in(&dir, &format!(".claude/projects/{}", encode_cwd(our_cwd)));
        let other_dir = path_in(&dir, ".claude/projects/-Users-me-proj-b");
        fs::create_dir_all(&our_dir).await.unwrap();
        fs::create_dir_all(&other_dir).await.unwrap();
        // Only the OTHER project has any JSONL file, and it's fresh.
        fs::write(
            other_dir.join("other-session.jsonl"),
            b"{\"type\":\"user\"}\n",
        )
        .await
        .unwrap();

        let claude_home = dir.path().join(".claude");
        let start = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            .saturating_sub(60);

        let out = find_transcript_path(
            &backend,
            claude_home.to_str().unwrap(),
            our_cwd,
            "session-xyz",
            Some(start),
        )
        .await
        .unwrap();
        assert_eq!(
            out, None,
            "must NOT bleed across project directories — got {out:?}"
        );
    }

    #[tokio::test]
    async fn transcript_tail_returns_empty_for_unchanged_file() {
        let dir = TempDir::new().unwrap();
        let backend = local_backend(&dir);
        let path = path_in(&dir, "t.jsonl");
        fs::write(&path, b"{\"type\":\"user\"}\n").await.unwrap();

        let mut tail = TranscriptTail::new(path.to_string_lossy().into_owned());
        let first = tail.read_new(&backend).await.unwrap();
        assert_eq!(first.len(), 1);

        let second = tail.read_new(&backend).await.unwrap();
        assert!(second.is_empty());
    }

    #[tokio::test]
    async fn transcript_tail_reads_appended_lines() {
        let dir = TempDir::new().unwrap();
        let backend = local_backend(&dir);
        let path = path_in(&dir, "t.jsonl");
        let path_str = path.to_string_lossy().into_owned();
        fs::write(&path, b"").await.unwrap();
        let mut tail = TranscriptTail::new(path_str.clone());

        fs::write(&path, b"{\"type\":\"user\",\"i\":1}\n{\"type\":\"assistant\",\"i\":2}\n")
            .await
            .unwrap();
        let first = tail.read_new(&backend).await.unwrap();
        assert_eq!(first.len(), 2);
        assert_eq!(first[0]["i"], 1);
        assert_eq!(first[1]["i"], 2);

        // Append a third line.
        let cur = fs::read_to_string(&path).await.unwrap();
        fs::write(&path, format!("{cur}{{\"type\":\"user\",\"i\":3}}\n"))
            .await
            .unwrap();
        let second = tail.read_new(&backend).await.unwrap();
        assert_eq!(second.len(), 1);
        assert_eq!(second[0]["i"], 3);
    }

    #[tokio::test]
    async fn transcript_tail_buffers_partial_lines_until_newline() {
        let dir = TempDir::new().unwrap();
        let backend = local_backend(&dir);
        let path = path_in(&dir, "t.jsonl");
        let path_str = path.to_string_lossy().into_owned();
        let mut tail = TranscriptTail::new(path_str.clone());

        // Write a partial line (no newline).
        fs::write(&path, b"{\"type\":\"user\"").await.unwrap();
        let first = tail.read_new(&backend).await.unwrap();
        assert!(first.is_empty(), "partial line should not emit");

        // Complete the line.
        fs::write(&path, b"{\"type\":\"user\",\"i\":1}\n").await.unwrap();
        let second = tail.read_new(&backend).await.unwrap();
        assert_eq!(second.len(), 1);
        assert_eq!(second[0]["i"], 1);
    }

    #[tokio::test]
    async fn transcript_tail_drops_unparseable_lines_but_keeps_going() {
        let dir = TempDir::new().unwrap();
        let backend = local_backend(&dir);
        let path = path_in(&dir, "t.jsonl");
        let path_str = path.to_string_lossy().into_owned();
        fs::write(&path, b"not json\n{\"type\":\"user\"}\n").await.unwrap();

        let mut tail = TranscriptTail::new(path_str);
        let lines = tail.read_new(&backend).await.unwrap();
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0]["type"], json!("user"));
    }
}
