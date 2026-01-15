// CLI detection and onboarding check Tauri commands
//
// This module provides commands for checking the availability of various CLI tools:
// - Claude CLI (primary AI CLI)
// - OpenCode CLI (fallback AI CLI)
// - GitHub CLI (gh command for PR operations)

use crate::claude_cli;

/// Check if the Claude CLI binary is installed and available
#[tauri::command]
pub fn check_claude_cli() -> bool {
    claude_cli::is_claude_cli_available()
}

/// Check if the Claude configuration file (~/.claude.json) exists
/// This file is created when the user logs in to Claude Code
#[tauri::command]
pub fn check_claude_config() -> bool {
    claude_cli::has_claude_config_file()
}

/// Check if the OpenCode CLI binary is installed and available
#[tauri::command]
pub fn check_opencode_cli() -> bool {
    claude_cli::is_opencode_cli_available()
}

/// Check if the GitHub CLI (gh) binary is installed and available
#[tauri::command]
pub fn check_github_cli() -> bool {
    claude_cli::is_github_cli_available()
}

/// Check if any AI CLI (Claude or OpenCode) is available for name generation
#[tauri::command]
pub fn check_any_ai_cli() -> bool {
    claude_cli::is_any_ai_cli_available()
}

/// Get the name of the available AI CLI ("claude", "opencode", or null if none)
/// Prefers Claude over OpenCode
#[tauri::command]
pub fn get_available_ai_cli() -> Option<String> {
    claude_cli::get_available_ai_cli().map(|s| s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_check_claude_cli_returns_bool() {
        // Smoke test: verify the function doesn't panic and returns a boolean
        // The actual result depends on whether Claude CLI is installed
        let result = check_claude_cli();
        assert!(result == true || result == false);
    }

    #[test]
    fn test_check_claude_config_returns_bool() {
        // Smoke test: verify the function doesn't panic and returns a boolean
        // The actual result depends on whether the config file exists
        let result = check_claude_config();
        assert!(result == true || result == false);
    }

    #[test]
    fn test_check_opencode_cli_returns_bool() {
        let result = check_opencode_cli();
        assert!(result == true || result == false);
    }

    #[test]
    fn test_check_github_cli_returns_bool() {
        let result = check_github_cli();
        assert!(result == true || result == false);
    }

    #[test]
    fn test_check_any_ai_cli_returns_bool() {
        let result = check_any_ai_cli();
        assert!(result == true || result == false);
    }

    #[test]
    fn test_get_available_ai_cli_returns_valid_option() {
        let result = get_available_ai_cli();
        match result {
            None => {}
            Some(ref cli) if cli == "claude" || cli == "opencode" => {}
            Some(other) => panic!("Unexpected AI CLI: {}", other),
        }
    }
}
