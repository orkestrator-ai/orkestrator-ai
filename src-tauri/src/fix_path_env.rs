//! Fix PATH environment for macOS GUI applications.
//!
//! When a macOS application is launched by double-clicking (GUI mode) rather than
//! from a terminal, it doesn't inherit the user's shell PATH environment variable.
//! This means CLI tools installed via Homebrew, npm global, pip, etc. won't be found.
//!
//! This module reads the PATH from the user's login shell and updates the current
//! process's PATH environment variable so that CLI tool detection works correctly.

use tracing::{debug, info, warn};

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
                    if new_path != current_path && new_path.contains("/usr") {
                        env::set_var("PATH", &new_path);
                        info!(
                            shell = %shell,
                            path_length = new_path.len(),
                            "Updated PATH from login shell"
                        );
                        debug!(new_path = %new_path, "New PATH value");
                        return;
                    } else {
                        debug!(shell = %shell, "PATH unchanged or invalid, trying next");
                    }
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

    #[test]
    fn test_fix_path_env_does_not_panic() {
        // Just ensure the function doesn't panic
        fix_path_env();
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn test_path_contains_common_directories() {
        fix_path_env();
        let path = std::env::var("PATH").unwrap_or_default();
        // After fixing, PATH should contain common directories
        assert!(
            path.contains("/usr/bin") || path.contains("/usr/local/bin"),
            "PATH should contain standard directories: {}",
            path
        );
    }
}
