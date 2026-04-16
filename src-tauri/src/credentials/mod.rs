// Claude Code credentials management
// Reads OAuth tokens from macOS Keychain using the security CLI,
// refreshes them when expired, and writes updated tokens back.

pub mod sync;

use serde::{Deserialize, Serialize};
use thiserror::Error;
use tracing::{debug, warn};

/// Claude Code OAuth client ID (can be overridden via CLAUDE_CODE_OAUTH_CLIENT_ID)
const DEFAULT_CLIENT_ID: &str = "22422756-60c9-4084-8eb7-27705fd5cf9a";
const TOKEN_URL: &str = "https://platform.claude.com/v1/oauth/token";
const KEYCHAIN_SERVICE: &str = "Claude Code-credentials";
const DEFAULT_SCOPES: &[&str] = &[
    "user:profile",
    "user:inference",
    "user:sessions:claude_code",
    "user:mcp_servers",
    "user:file_upload",
];
/// Refresh the token if it expires within this window (ms).
/// Matches roughly the buffer Claude Code itself uses.
const REFRESH_SKEW_MS: i64 = 5 * 60 * 1000;

#[derive(Error, Debug)]
pub enum CredentialsError {
    #[error("Keychain access error: {0}")]
    KeychainError(String),
    #[error("Credentials not found")]
    NotFound,
    #[error("Failed to parse credentials: {0}")]
    ParseError(String),
    #[error("Token refresh failed: {0}")]
    RefreshFailed(String),
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

fn client_id() -> String {
    std::env::var("CLAUDE_CODE_OAUTH_CLIENT_ID").unwrap_or_else(|_| DEFAULT_CLIENT_ID.to_string())
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Read Claude Code credentials from the system keychain.
///
/// Uses the macOS `security` CLI tool instead of the `security-framework` crate.
/// This is a deliberate tradeoff: the CLI is slightly slower (spawns a subprocess)
/// but doesn't require knowing the account name - only the service name is needed.
#[cfg(target_os = "macos")]
pub fn get_claude_credentials() -> Result<ClaudeCredentials, CredentialsError> {
    use std::process::Command;

    let output = Command::new("security")
        .args(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"])
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

#[cfg(not(target_os = "macos"))]
pub fn get_claude_credentials() -> Result<ClaudeCredentials, CredentialsError> {
    Err(CredentialsError::UnsupportedPlatform)
}

/// Look up the account ("acct") attribute for the Claude Code credentials entry.
/// Needed to update the entry in place via `security add-generic-password -U`.
#[cfg(target_os = "macos")]
fn get_claude_credentials_account() -> Result<String, CredentialsError> {
    use std::process::Command;

    let output = Command::new("security")
        .args(["find-generic-password", "-s", KEYCHAIN_SERVICE])
        .output()
        .map_err(|e| {
            CredentialsError::KeychainError(format!("Failed to run security command: {}", e))
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("could not be found") {
            return Err(CredentialsError::NotFound);
        }
        return Err(CredentialsError::KeychainError(format!(
            "security command failed: {}",
            stderr
        )));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("\"acct\"<blob>=") {
            if let Some(val) = rest.strip_prefix('"').and_then(|s| s.strip_suffix('"')) {
                return Ok(val.to_string());
            }
        }
    }

    Err(CredentialsError::KeychainError(
        "Could not parse account name from keychain entry".to_string(),
    ))
}

/// Write credentials back to the macOS keychain, overwriting any existing entry.
#[cfg(target_os = "macos")]
fn write_claude_credentials(credentials: &ClaudeCredentials) -> Result<(), CredentialsError> {
    use std::process::Command;

    let account = get_claude_credentials_account()?;
    let json = serde_json::to_string(credentials).map_err(|e| {
        CredentialsError::ParseError(format!("Failed to serialize credentials: {}", e))
    })?;

    let output = Command::new("security")
        .args([
            "add-generic-password",
            "-U",
            "-a",
            &account,
            "-s",
            KEYCHAIN_SERVICE,
            "-w",
            &json,
        ])
        .output()
        .map_err(|e| {
            CredentialsError::KeychainError(format!("Failed to run security command: {}", e))
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(CredentialsError::KeychainError(format!(
            "Failed to update keychain entry: {}",
            stderr
        )));
    }

    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn write_claude_credentials(_credentials: &ClaudeCredentials) -> Result<(), CredentialsError> {
    Err(CredentialsError::UnsupportedPlatform)
}

#[derive(Debug, Deserialize)]
struct RefreshTokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    expires_in: i64,
    #[serde(default)]
    scope: Option<String>,
}

/// POST to the Claude OAuth token endpoint to refresh the access token.
/// Returns updated credentials with preserved subscription/rate-limit metadata.
pub async fn refresh_credentials(
    existing: &ClaudeOAuthCredentials,
) -> Result<ClaudeOAuthCredentials, CredentialsError> {
    let body = serde_json::json!({
        "grant_type": "refresh_token",
        "refresh_token": existing.refresh_token,
        "client_id": client_id(),
        "scope": DEFAULT_SCOPES.join(" "),
    });

    let response = reqwest::Client::new()
        .post(TOKEN_URL)
        .header("Content-Type", "application/json")
        .timeout(std::time::Duration::from_secs(15))
        .json(&body)
        .send()
        .await
        .map_err(|e| CredentialsError::RefreshFailed(format!("Request failed: {}", e)))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(CredentialsError::RefreshFailed(format!(
            "HTTP {}: {}",
            status, text
        )));
    }

    let parsed: RefreshTokenResponse = response.json().await.map_err(|e| {
        CredentialsError::RefreshFailed(format!("Failed to parse refresh response: {}", e))
    })?;

    let scopes = parsed
        .scope
        .map(|s| s.split_whitespace().map(String::from).collect())
        .unwrap_or_else(|| existing.scopes.clone());

    Ok(ClaudeOAuthCredentials {
        access_token: parsed.access_token,
        refresh_token: parsed
            .refresh_token
            .unwrap_or_else(|| existing.refresh_token.clone()),
        expires_at: now_ms() + parsed.expires_in * 1000,
        scopes,
        subscription_type: existing.subscription_type.clone(),
        rate_limit_tier: existing.rate_limit_tier.clone(),
    })
}

/// Read credentials from keychain and refresh if within the expiry skew window.
/// On successful refresh, writes the new credentials back to the keychain so
/// the host's `claude` CLI and container injections stay in sync.
pub async fn get_or_refresh_claude_credentials() -> Result<ClaudeCredentials, CredentialsError> {
    let current = get_claude_credentials()?;

    let remaining_ms = current.claude_ai_oauth.expires_at - now_ms();
    if remaining_ms > REFRESH_SKEW_MS {
        return Ok(current);
    }

    debug!(
        remaining_ms = remaining_ms,
        "Claude credentials near/past expiry, attempting refresh"
    );

    match refresh_credentials(&current.claude_ai_oauth).await {
        Ok(refreshed) => {
            let updated = ClaudeCredentials {
                claude_ai_oauth: refreshed,
            };
            if let Err(e) = write_claude_credentials(&updated) {
                warn!(error = ?e, "Refreshed credentials but failed to write back to keychain");
            } else {
                debug!("Refreshed Claude credentials and updated keychain");
            }
            Ok(updated)
        }
        Err(e) => {
            warn!(error = ?e, "Failed to refresh Claude credentials");
            Err(e)
        }
    }
}

/// Check if Claude credentials are available
#[allow(dead_code)]
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

    #[test]
    fn test_credentials_roundtrip_preserves_fields() {
        let json = r#"{"claudeAiOauth":{"accessToken":"a","refreshToken":"r","expiresAt":1,"scopes":["s"],"subscriptionType":"max","rateLimitTier":"high"}}"#;
        let creds: ClaudeCredentials = serde_json::from_str(json).unwrap();
        let serialized = serde_json::to_string(&creds).unwrap();
        let reparsed: ClaudeCredentials = serde_json::from_str(&serialized).unwrap();
        assert_eq!(
            reparsed.claude_ai_oauth.subscription_type.as_deref(),
            Some("max")
        );
        assert_eq!(
            reparsed.claude_ai_oauth.rate_limit_tier.as_deref(),
            Some("high")
        );
    }
}
