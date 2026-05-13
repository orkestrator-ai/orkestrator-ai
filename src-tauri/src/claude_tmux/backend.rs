//! Backend dispatch for tmux mode.
//!
//! The same `claude_tmux` code path serves both local worktrees and Docker
//! containers. The only difference is *where* the shell commands run: on the
//! host directly, or via `docker exec` inside the environment's container.

use std::path::Path;
use std::process::Stdio;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tracing::debug;

#[derive(Debug, Clone)]
pub enum Backend {
    /// Run commands directly on the host. `cwd` is the worktree path.
    Local { cwd: String },
    /// Run commands via `docker exec` as the `node` user in `/workspace`.
    Container { container_id: String },
}

#[derive(Debug)]
pub struct ExecOutput {
    pub status: i32,
    pub stdout: String,
    pub stderr: String,
}

impl ExecOutput {
    pub fn success(&self) -> bool {
        self.status == 0
    }
}

impl Backend {
    /// Run a shell command. `args[0]` is the executable; the rest are its args.
    /// For [`Backend::Container`], the command runs as `node` inside `/workspace`.
    pub async fn exec(&self, args: &[&str]) -> Result<ExecOutput, String> {
        self.exec_with_stdin(args, None).await
    }

    /// Run a command, optionally piping `stdin` to it.
    pub async fn exec_with_stdin(
        &self,
        args: &[&str],
        stdin: Option<&str>,
    ) -> Result<ExecOutput, String> {
        let mut cmd = match self {
            Backend::Local { cwd } => {
                let mut c = Command::new(args[0]);
                c.args(&args[1..]);
                c.current_dir(cwd);
                c
            }
            Backend::Container { container_id } => {
                let mut c = Command::new("docker");
                c.arg("exec");
                c.arg("-u");
                c.arg("node");
                c.arg("-w");
                c.arg("/workspace");
                if stdin.is_some() {
                    c.arg("-i");
                }
                c.arg(container_id);
                for a in args {
                    c.arg(a);
                }
                c
            }
        };

        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
        if stdin.is_some() {
            cmd.stdin(Stdio::piped());
        }

        debug!(backend = ?self, args = ?args, "claude_tmux exec");

        let mut child = cmd.spawn().map_err(|e| format!("spawn failed: {e}"))?;

        if let Some(input) = stdin {
            if let Some(mut sin) = child.stdin.take() {
                sin.write_all(input.as_bytes())
                    .await
                    .map_err(|e| format!("stdin write failed: {e}"))?;
                sin.shutdown().await.ok();
            }
        }

        let output = child
            .wait_with_output()
            .await
            .map_err(|e| format!("wait failed: {e}"))?;

        Ok(ExecOutput {
            status: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    }

    /// Read a file from the backend. Returns `Ok(None)` if missing.
    pub async fn read_file(&self, path: &str) -> Result<Option<String>, String> {
        match self {
            Backend::Local { .. } => match tokio::fs::read_to_string(path).await {
                Ok(s) => Ok(Some(s)),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(e) => Err(e.to_string()),
            },
            Backend::Container { .. } => {
                // `test -f` first so we can distinguish "missing" from "read error".
                let probe = self.exec(&["test", "-f", path]).await?;
                if !probe.success() {
                    return Ok(None);
                }
                let out = self.exec(&["cat", path]).await?;
                if !out.success() {
                    return Err(out.stderr);
                }
                Ok(Some(out.stdout))
            }
        }
    }

    /// Write a file. Creates parent dirs.
    pub async fn write_file(&self, path: &str, content: &str) -> Result<(), String> {
        match self {
            Backend::Local { .. } => {
                if let Some(parent) = Path::new(path).parent() {
                    tokio::fs::create_dir_all(parent)
                        .await
                        .map_err(|e| e.to_string())?;
                }
                tokio::fs::write(path, content)
                    .await
                    .map_err(|e| e.to_string())
            }
            Backend::Container { .. } => {
                let parent = Path::new(path)
                    .parent()
                    .and_then(|p| p.to_str())
                    .unwrap_or("/");
                self.exec(&["mkdir", "-p", parent]).await?;
                let out = self
                    .exec_with_stdin(&["sh", "-c", &format!("cat > {}", shell_quote(path))], Some(content))
                    .await?;
                if !out.success() {
                    return Err(out.stderr);
                }
                Ok(())
            }
        }
    }

    /// Remove a file (idempotent).
    pub async fn remove_file(&self, path: &str) -> Result<(), String> {
        match self {
            Backend::Local { .. } => match tokio::fs::remove_file(path).await {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(e.to_string()),
            },
            Backend::Container { .. } => {
                self.exec(&["rm", "-f", path]).await?;
                Ok(())
            }
        }
    }

    pub async fn ensure_dir(&self, path: &str) -> Result<(), String> {
        match self {
            Backend::Local { .. } => tokio::fs::create_dir_all(path)
                .await
                .map_err(|e| e.to_string()),
            Backend::Container { .. } => {
                let out = self.exec(&["mkdir", "-p", path]).await?;
                if !out.success() {
                    return Err(out.stderr);
                }
                Ok(())
            }
        }
    }

    /// List entries (filenames only) in a directory. Empty Vec if missing.
    pub async fn list_dir(&self, path: &str) -> Result<Vec<String>, String> {
        match self {
            Backend::Local { .. } => match tokio::fs::read_dir(path).await {
                Ok(mut rd) => {
                    let mut entries = Vec::new();
                    while let Some(entry) = rd.next_entry().await.map_err(|e| e.to_string())? {
                        if let Some(name) = entry.file_name().to_str() {
                            entries.push(name.to_string());
                        }
                    }
                    Ok(entries)
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
                Err(e) => Err(e.to_string()),
            },
            Backend::Container { .. } => {
                let out = self
                    .exec(&["sh", "-c", &format!("ls -1 {} 2>/dev/null || true", shell_quote(path))])
                    .await?;
                Ok(out
                    .stdout
                    .lines()
                    .filter(|l| !l.is_empty())
                    .map(|l| l.to_string())
                    .collect())
            }
        }
    }

    /// Return the size of `path` in bytes, or 0 if it doesn't exist.
    pub async fn file_size(&self, path: &str) -> Result<u64, String> {
        match self {
            Backend::Local { .. } => match tokio::fs::metadata(path).await {
                Ok(m) => Ok(m.len()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(0),
                Err(e) => Err(e.to_string()),
            },
            Backend::Container { .. } => {
                let out = self
                    .exec(&[
                        "sh",
                        "-c",
                        &format!("stat -c %s {} 2>/dev/null || echo 0", shell_quote(path)),
                    ])
                    .await?;
                Ok(out.stdout.trim().parse().unwrap_or(0))
            }
        }
    }
}

/// Minimal shell single-quote escape for embedding paths into `sh -c`.
fn shell_quote(s: &str) -> String {
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
