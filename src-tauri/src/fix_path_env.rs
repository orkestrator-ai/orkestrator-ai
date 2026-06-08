//! Fix PATH environment for macOS GUI applications.
//!
//! When a macOS application is launched by double-clicking (GUI mode) rather than
//! from a terminal, it doesn't inherit the user's shell PATH environment variable.
//! This means CLI tools installed via Homebrew, npm global, pip, etc. won't be found.
//!
//! This module reads the PATH from the user's login shell and updates the current
//! process environment so that CLI tools and bridge child processes work correctly.

use tracing::{debug, info, warn};

#[cfg(target_os = "macos")]
const SHELL_ENV_KEYS: &[&str] = &[
    "PATH",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_ORG_ID",
    "OPENAI_ORGANIZATION",
    "OPENAI_PROJECT",
    "CODEX_HOME",
    "CODEX_PATH",
    "CODEX_BINARY",
    "OPENCODE_BINARY",
    "OPENCODE_CLI_PATH",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "SHELL",
];

/// Fix the PATH environment variable on macOS by reading it from the user's login shell.
///
/// This function should be called early in application startup, before any CLI
/// detection or command execution that relies on PATH.
///
/// On non-macOS platforms, this function does nothing.
#[cfg(target_os = "macos")]
pub fn fix_path_env() {
    use std::env;
    use std::process::Command;

    let current_path = env::var("PATH").unwrap_or_default();
    debug!(current_path = %current_path, "Current PATH before fix");

    // Try common shells in order of preference
    // -i: interactive mode (loads .zshrc/.bashrc)
    // -l: login shell (loads .zprofile/.bash_profile)
    // -c: execute command
    let shells = [
        ("/bin/zsh", vec!["-ilc", "echo $PATH"]),
        ("/bin/bash", vec!["-ilc", "echo $PATH"]),
        ("/bin/sh", vec!["-lc", "echo $PATH"]),
    ];

    for (shell, args) in &shells {
        // Check if shell exists
        if !std::path::Path::new(shell).exists() {
            debug!(shell = %shell, "Shell not found, skipping");
            continue;
        }

        match Command::new(shell).args(args).output() {
            Ok(output) => {
                if output.status.success() {
                    let new_path = String::from_utf8_lossy(&output.stdout).trim().to_string();

                    if new_path.is_empty() {
                        debug!(shell = %shell, "Shell returned empty PATH, trying next");
                        continue;
                    }

                    // Only update if the new PATH is different and looks valid
                    // A valid PATH should contain at least /usr/bin or similar
                    if new_path.contains("/usr") {
                        if new_path != current_path {
                            env::set_var("PATH", &new_path);
                            info!(
                                shell = %shell,
                                path_length = new_path.len(),
                                "Updated PATH from login shell"
                            );
                            debug!(new_path = %new_path, "New PATH value");
                        } else {
                            debug!(shell = %shell, "PATH already matches login shell");
                        }

                        import_selected_shell_env(shell);
                        return;
                    }

                    debug!(shell = %shell, "PATH invalid, trying next");
                } else {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    debug!(shell = %shell, stderr = %stderr, "Shell command failed");
                }
            }
            Err(e) => {
                debug!(shell = %shell, error = %e, "Failed to execute shell");
            }
        }
    }

    warn!("Could not read PATH from any login shell - CLI tools may not be found");
}

#[cfg(target_os = "macos")]
fn import_selected_shell_env(shell: &str) {
    use std::process::Command;

    let joined_keys = SHELL_ENV_KEYS.join(" ");
    let script = format!(
        "for key in {joined_keys}; do\n  eval \"value=\\${{$key:-}}\"\n  printf '%s=%s\\n' \"$key\" \"$value\"\ndone"
    );

    let output = match Command::new(shell).args(["-ilc", &script]).output() {
        Ok(output) => output,
        Err(error) => {
            debug!(shell = %shell, error = %error, "Failed to import shell environment");
            return;
        }
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        debug!(shell = %shell, stderr = %stderr, "Shell environment import command failed");
        return;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let imported_count = apply_selected_shell_env(&stdout);

    if imported_count > 0 {
        info!(
            imported_count = imported_count,
            "Imported bridge-relevant environment variables from login shell"
        );
    } else {
        debug!("No bridge-relevant environment variables imported from login shell");
    }
}

#[cfg(target_os = "macos")]
fn apply_selected_shell_env(stdout: &str) -> usize {
    use std::env;

    let mut imported_count = 0;
    for line in stdout.lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };

        if !SHELL_ENV_KEYS.contains(&key) {
            continue;
        }

        if value.is_empty() {
            continue;
        }

        let should_override = matches!(key, "PATH" | "SHELL") || env::var_os(key).is_none();
        if !should_override {
            continue;
        }

        env::set_var(key, value);
        imported_count += 1;
        debug!(key = %key, "Imported environment variable from login shell");
    }

    imported_count
}

/// No-op implementation for non-macOS platforms.
#[cfg(not(target_os = "macos"))]
pub fn fix_path_env() {
    // On Linux and Windows, GUI apps typically inherit PATH correctly
    // or the issue manifests differently. No action needed.
    debug!("fix_path_env: not macOS, skipping");
}

#[cfg(test)]
mod tests {
    use super::*;

    struct EnvGuard {
        originals: Vec<(&'static str, Option<std::ffi::OsString>)>,
    }

    impl EnvGuard {
        fn capture(keys: &[&'static str]) -> Self {
            Self {
                originals: keys
                    .iter()
                    .map(|key| (*key, std::env::var_os(key)))
                    .collect(),
            }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            for (key, original) in self.originals.drain(..) {
                match original {
                    Some(value) => std::env::set_var(key, value),
                    None => std::env::remove_var(key),
                }
            }
        }
    }

    #[cfg(target_os = "macos")]
    fn shell_env_guard() -> EnvGuard {
        EnvGuard::capture(SHELL_ENV_KEYS)
    }

    #[cfg(not(target_os = "macos"))]
    fn shell_env_guard() -> EnvGuard {
        EnvGuard::capture(&["PATH"])
    }

    #[tokio::test]
    async fn test_fix_path_env_does_not_panic() {
        let _guard = crate::claude_tmux::TEST_PATH_LOCK
            .get_or_init(|| tokio::sync::Mutex::new(()))
            .lock()
            .await;
        let _env_guard = shell_env_guard();

        // Just ensure the function doesn't panic
        fix_path_env();
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn test_path_contains_common_directories() {
        let _guard = crate::claude_tmux::TEST_PATH_LOCK
            .get_or_init(|| tokio::sync::Mutex::new(()))
            .lock()
            .await;
        let _env_guard = shell_env_guard();

        fix_path_env();
        let path = std::env::var("PATH").unwrap_or_default();
        // After fixing, PATH should contain common directories
        assert!(
            path.contains("/usr/bin") || path.contains("/usr/local/bin"),
            "PATH should contain standard directories: {}",
            path
        );
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn test_apply_selected_shell_env_respects_allowlist_and_override_rules() {
        let _guard = crate::claude_tmux::TEST_PATH_LOCK
            .get_or_init(|| tokio::sync::Mutex::new(()))
            .lock()
            .await;
        let _env_guard = EnvGuard::capture(&[
            "PATH",
            "SHELL",
            "OPENAI_API_KEY",
            "CODEX_HOME",
            "UNRELATED_FROM_SHELL",
        ]);

        std::env::set_var("PATH", "/old/bin");
        std::env::set_var("SHELL", "/bin/old");
        std::env::set_var("OPENAI_API_KEY", "existing-key");
        std::env::remove_var("CODEX_HOME");
        std::env::remove_var("UNRELATED_FROM_SHELL");

        let imported = apply_selected_shell_env(
            "PATH=/new/bin:/usr/bin\n\
             SHELL=/bin/zsh\n\
             OPENAI_API_KEY=shell-key\n\
             CODEX_HOME=/tmp/codex-home\n\
             UNRELATED_FROM_SHELL=ignored\n\
             MALFORMED_LINE\n\
             OPENCODE_BINARY=\n",
        );

        assert_eq!(imported, 3);
        assert_eq!(std::env::var("PATH").unwrap(), "/new/bin:/usr/bin");
        assert_eq!(std::env::var("SHELL").unwrap(), "/bin/zsh");
        assert_eq!(std::env::var("OPENAI_API_KEY").unwrap(), "existing-key");
        assert_eq!(std::env::var("CODEX_HOME").unwrap(), "/tmp/codex-home");
        assert!(std::env::var_os("UNRELATED_FROM_SHELL").is_none());
        assert!(std::env::var_os("OPENCODE_BINARY").is_none());
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn test_apply_selected_shell_env_ignores_empty_or_malformed_output() {
        let _guard = crate::claude_tmux::TEST_PATH_LOCK
            .get_or_init(|| tokio::sync::Mutex::new(()))
            .lock()
            .await;
        let _env_guard = EnvGuard::capture(&["CODEX_BINARY", "CODEX_HOME"]);

        std::env::remove_var("CODEX_BINARY");
        std::env::remove_var("CODEX_HOME");

        let imported = apply_selected_shell_env(
            "CODEX_BINARY=\n\
             CODEX_HOME\n\
             NOT_ALLOWED=/tmp/value\n",
        );

        assert_eq!(imported, 0);
        assert!(std::env::var_os("CODEX_BINARY").is_none());
        assert!(std::env::var_os("CODEX_HOME").is_none());
    }
}
