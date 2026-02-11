// Credentials management Tauri commands

use crate::credentials;
use serde::Serialize;

/// Response for credential status check
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialStatus {
    pub available: bool,
    pub expires_at: Option<i64>,
}

/// Check if Claude credentials are available
#[tauri::command]
pub fn has_claude_credentials() -> bool {
    credentials::has_claude_credentials()
}

/// Get credential status (available + expiry)
#[tauri::command]
pub fn get_credential_status() -> CredentialStatus {
    match credentials::get_claude_credentials() {
        Ok(creds) => CredentialStatus {
            available: true,
            expires_at: Some(creds.claude_ai_oauth.expires_at),
        },
        Err(_) => CredentialStatus {
            available: false,
            expires_at: None,
        },
    }
}
