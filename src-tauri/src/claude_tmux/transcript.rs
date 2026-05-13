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

/// Resolve the absolute JSONL path for the given session ID by globbing
/// `<claude_home>/projects/*/<session_id>.jsonl`. Returns `Ok(None)` if not
/// yet present.
pub async fn find_transcript_path(
    backend: &Backend,
    claude_home: &str,
    session_id: &str,
) -> Result<Option<String>, String> {
    let needle = format!("{}.jsonl", session_id);
    let projects_dir = format!("{}/projects", claude_home);
    let dirs = backend.list_dir(&projects_dir).await?;
    for d in dirs {
        let candidate = format!("{}/{}/{}", projects_dir, d, needle);
        if backend.file_size(&candidate).await.unwrap_or(0) > 0
            || backend.read_file(&candidate).await.ok().flatten().is_some()
        {
            return Ok(Some(candidate));
        }
    }
    Ok(None)
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

    #[tokio::test]
    async fn find_transcript_path_returns_none_when_missing() {
        let dir = TempDir::new().unwrap();
        let backend = local_backend(&dir);
        let claude_home = dir.path().join(".claude");
        let out = find_transcript_path(
            &backend,
            claude_home.to_str().unwrap(),
            "session-xyz",
        )
        .await
        .unwrap();
        assert_eq!(out, None);
    }

    #[tokio::test]
    async fn find_transcript_path_locates_file_in_any_project_dir() {
        let dir = TempDir::new().unwrap();
        let backend = local_backend(&dir);
        let proj_dir = path_in(&dir, ".claude/projects/-some-cwd");
        fs::create_dir_all(&proj_dir).await.unwrap();
        let jsonl = proj_dir.join("session-xyz.jsonl");
        fs::write(&jsonl, b"{\"type\":\"system\"}\n").await.unwrap();

        let claude_home = dir.path().join(".claude");
        let out = find_transcript_path(
            &backend,
            claude_home.to_str().unwrap(),
            "session-xyz",
        )
        .await
        .unwrap();
        assert_eq!(out, Some(jsonl.to_string_lossy().into_owned()));
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
