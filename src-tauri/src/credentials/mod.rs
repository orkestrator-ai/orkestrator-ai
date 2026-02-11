// Claude Code credentials management
// Reads OAuth tokens from macOS Keychain using the security CLI

use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Error, Debug)]
pub enum CredentialsError {
    #[error("Keychain access error: {0}")]
    KeychainError(String),
    #[error("Credentials not found")]
    NotFound,
    #[error("Failed to parse credentials: {0}")]
    ParseError(String),
    #[allow(dead_code)]
    #[error("Platform not supported")]
    UnsupportedPlatform,
}

/// OAuth credentials for Claude Code
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeOAuthCredentials {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: i64,
    pub scopes: Vec<String>,
    pub subscription_type: Option<String>,
    pub rate_limit_tier: Option<String>,
}

/// Full credentials structure from keychain
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeCredentials {
    pub claude_ai_oauth: ClaudeOAuthCredentials,
}

/// Read Claude Code credentials from the system keychain.
///
/// Uses the macOS `security` CLI tool instead of the `security-framework` crate.
/// This is a deliberate tradeoff: the CLI is slightly slower (spawns a subprocess)
/// but doesn't require knowing the account name - only the service name is needed.
///
/// The `security-framework` crate's `get_generic_password()` requires both service
/// and account names to match exactly, but Claude Code stores credentials with
/// user-specific account fields (email/identifier) that vary per installation.
/// The `security` CLI can search by service name alone using `-s` flag.
#[cfg(target_os = "macos")]
pub fn get_claude_credentials() -> Result<ClaudeCredentials, CredentialsError> {
    use std::process::Command;

    // Use security CLI - doesn't require account name, just service
    // The -w flag outputs only the password (credentials JSON)
    let output = Command::new("security")
        .args([
            "find-generic-password",
            "-s",
            "Claude Code-credentials",
            "-w",
        ])
        .output()
        .map_err(|e| {
            CredentialsError::KeychainError(format!("Failed to run security command: {}", e))
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("could not be found") || stderr.contains("SecKeychainSearchCopyNext") {
            return Err(CredentialsError::NotFound);
        }
        return Err(CredentialsError::KeychainError(format!(
            "security command failed: {}",
            stderr
        )));
    }

    let json_str = String::from_utf8(output.stdout)
        .map_err(|e| CredentialsError::ParseError(format!("Invalid UTF-8 in credentials: {}", e)))?
        .trim()
        .to_string();

    if json_str.is_empty() {
        return Err(CredentialsError::NotFound);
    }

    let credentials: ClaudeCredentials = serde_json::from_str(&json_str).map_err(|e| {
        CredentialsError::ParseError(format!("Failed to parse credentials JSON: {}", e))
    })?;

    Ok(credentials)
}

/// Read Claude Code credentials - stub for non-macOS platforms
#[cfg(not(target_os = "macos"))]
pub fn get_claude_credentials() -> Result<ClaudeCredentials, CredentialsError> {
    Err(CredentialsError::UnsupportedPlatform)
}

/// Check if Claude credentials are available
pub fn has_claude_credentials() -> bool {
    get_claude_credentials().is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_credentials_parsing() {
        let json = r#"{"claudeAiOauth":{"accessToken":"sk-test","refreshToken":"sk-refresh","expiresAt":1234567890,"scopes":["user:inference"],"subscriptionType":null,"rateLimitTier":null}}"#;
        let creds: ClaudeCredentials = serde_json::from_str(json).unwrap();
        assert_eq!(creds.claude_ai_oauth.access_token, "sk-test");
        assert_eq!(creds.claude_ai_oauth.scopes, vec!["user:inference"]);
    }
}
