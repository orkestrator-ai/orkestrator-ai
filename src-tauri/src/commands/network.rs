// Network-related commands for domain validation and DNS testing

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::net::ToSocketAddrs;

/// Result of testing a single domain
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DomainTestResult {
    /// The domain that was tested
    pub domain: String,
    /// Whether the domain format is valid
    pub valid: bool,
    /// Whether DNS resolution succeeded (None if not tested due to invalid format)
    pub resolvable: Option<bool>,
    /// Resolved IP addresses (empty if resolution failed or wasn't attempted)
    pub ips: Vec<String>,
    /// Error message if any
    pub error: Option<String>,
}

/// Validate domain format using regex
fn is_valid_domain_format(domain: &str) -> bool {
    // Domain validation regex - matches standard domain names
    // Allows alphanumeric characters, hyphens (not at start/end of labels), and dots
    let domain_regex =
        Regex::new(r"^([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$").unwrap();
    domain_regex.is_match(domain)
}

/// Resolve a domain to IP addresses
fn resolve_domain(domain: &str) -> Result<Vec<String>, String> {
    // Use port 80 for resolution (the port doesn't matter, we just need the IPs)
    let addr = format!("{}:80", domain);

    match addr.to_socket_addrs() {
        Ok(addrs) => {
            let ips: Vec<String> = addrs.map(|a| a.ip().to_string()).collect();
            if ips.is_empty() {
                Err("No IP addresses found".to_string())
            } else {
                Ok(ips)
            }
        }
        Err(e) => Err(format!("DNS resolution failed: {}", e)),
    }
}

/// Test domain resolution for a list of domains
/// Returns validation and resolution results for each domain
#[tauri::command]
pub async fn test_domain_resolution(domains: Vec<String>) -> Result<Vec<DomainTestResult>, String> {
    let mut results = Vec::new();

    for domain in domains {
        let domain = domain.trim().to_string();

        if domain.is_empty() {
            continue;
        }

        // First check format validity
        let valid = is_valid_domain_format(&domain);

        if !valid {
            results.push(DomainTestResult {
                domain,
                valid: false,
                resolvable: None,
                ips: Vec::new(),
                error: Some("Invalid domain format".to_string()),
            });
            continue;
        }

        // Try to resolve the domain
        match resolve_domain(&domain) {
            Ok(ips) => {
                results.push(DomainTestResult {
                    domain,
                    valid: true,
                    resolvable: Some(true),
                    ips,
                    error: None,
                });
            }
            Err(e) => {
                results.push(DomainTestResult {
                    domain,
                    valid: true,
                    resolvable: Some(false),
                    ips: Vec::new(),
                    error: Some(e),
                });
            }
        }
    }

    Ok(results)
}

/// Validate domain format only (no DNS resolution)
/// Returns a list of invalid domains with error messages
#[tauri::command]
pub fn validate_domains(domains: Vec<String>) -> Vec<DomainTestResult> {
    domains
        .into_iter()
        .filter(|d| !d.trim().is_empty())
        .map(|domain| {
            let domain = domain.trim().to_string();
            let valid = is_valid_domain_format(&domain);

            DomainTestResult {
                domain,
                valid,
                resolvable: None,
                ips: Vec::new(),
                error: if valid {
                    None
                } else {
                    Some("Invalid domain format".to_string())
                },
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_valid_domains() {
        assert!(is_valid_domain_format("example.com"));
        assert!(is_valid_domain_format("api.github.com"));
        assert!(is_valid_domain_format("registry.npmjs.org"));
        assert!(is_valid_domain_format("my-domain.co.uk"));
        assert!(is_valid_domain_format("sub.domain.example.com"));
    }

    #[test]
    fn test_invalid_domains() {
        assert!(!is_valid_domain_format(""));
        assert!(!is_valid_domain_format("example")); // No TLD
        assert!(!is_valid_domain_format("-example.com")); // Starts with hyphen
        assert!(!is_valid_domain_format("example-.com")); // Ends with hyphen
        assert!(!is_valid_domain_format("example..com")); // Double dots
        assert!(!is_valid_domain_format("example.c")); // TLD too short
        assert!(!is_valid_domain_format("http://example.com")); // URL, not domain
        assert!(!is_valid_domain_format("example.com/path")); // Has path
        assert!(!is_valid_domain_format("*.example.com")); // Wildcard
    }
}
