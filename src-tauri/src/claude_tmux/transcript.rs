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
