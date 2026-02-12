// Container provisioning and lifecycle operations
// Handles creating environments with proper configuration

use super::client::{get_docker_client, CreateContainerConfig, DockerError};
use crate::models::{Environment, EnvironmentStatus, NetworkAccessMode, PortMapping};
use bollard::models::PortBinding;
use std::collections::HashMap;
use tracing::debug;

/// Base image name for Claude Code environments
pub const BASE_IMAGE: &str = "orkestrator-ai:latest";

/// Label key for identifying our containers
pub const CONTAINER_LABEL_APP: &str = "app";
pub const CONTAINER_LABEL_APP_VALUE: &str = "orkestrator-ai";
pub const CONTAINER_LABEL_ENV_ID: &str = "environment-id";
pub const CONTAINER_LABEL_PROJECT_ID: &str = "project-id";

/// Configuration for creating a new container
#[derive(Debug, Clone)]
pub struct ContainerConfig {
    /// Environment ID
    pub environment_id: String,
    /// Project ID
    pub project_id: String,
    /// Container name
    pub name: String,
    /// Git repository URL
    pub git_url: String,
    /// Branch to clone
    pub branch: String,
    /// Base branch to use when creating new environment branches
    pub base_branch: Option<String>,
    /// Path to .env file on host (legacy single file)
    pub env_file_path: Option<String>,
    /// Path to project's local source folder (for mounting .env files)
    pub project_local_path: Option<String>,
    /// Path to ~/.claude directory on host
    pub claude_dir_path: String,
    /// Path to ~/.claude.json file on host (if it exists)
    pub claude_json_path: Option<String>,
    /// Path to ~/.config/opencode directory on host (if it exists)
    pub opencode_config_path: Option<String>,
    /// Path to ~/.local/share/opencode directory on host (if it exists)
    pub opencode_data_path: Option<String>,
    /// Path to ~/.local/state/opencode directory on host (if it exists)
    pub opencode_state_path: Option<String>,
    /// Path to ~/.local/state/opencode/model.json on host (if it exists)
    pub opencode_model_json_path: Option<String>,
    /// Path to ~/.gitconfig on host
    pub gitconfig_path: Option<String>,
    /// GitHub Personal Access Token for HTTPS authentication
    pub github_token: Option<String>,
    /// CPU limit (cores)
    pub cpu_limit: Option<f64>,
    /// Memory limit in bytes
    pub memory_limit: Option<i64>,
    /// Anthropic API key for Claude Code (from settings)
    pub anthropic_api_key: Option<String>,
    /// OAuth credentials JSON for creating .credentials.json in container
    pub oauth_credentials_json: Option<String>,
    /// Enable debug mode for verbose logging in container entrypoint
    pub debug_mode: bool,
    /// Network access mode (full or restricted)
    pub network_access_mode: NetworkAccessMode,
    /// Domains allowed in restricted network mode
    pub allowed_domains: Vec<String>,
    /// Port mappings for container (static, set at creation)
    pub port_mappings: Vec<PortMapping>,
    /// Additional files to copy from local project path (relative paths)
    pub files_to_copy: Vec<String>,
    /// Default model for OpenCode
    pub opencode_model: String,
}

impl ContainerConfig {
    pub fn new(environment: &Environment, git_url: &str) -> Self {
        let home = dirs::home_dir().unwrap_or_default();
        Self::new_with_home(environment, git_url, &home)
    }

    fn new_with_home(environment: &Environment, git_url: &str, home: &std::path::Path) -> Self {
        let claude_dir = home.join(".claude");
        let claude_json = home.join(".claude.json");
        let opencode_config = home.join(".config").join("opencode");
        let opencode_data = home.join(".local").join("share").join("opencode");
        let opencode_state = home.join(".local").join("state").join("opencode");
        let opencode_model_json = opencode_state.join("model.json");
        let gitconfig = home.join(".gitconfig");

        // Only use gitconfig if it exists
        let gitconfig_path = if gitconfig.exists() {
            Some(gitconfig.to_string_lossy().to_string())
        } else {
            None
        };

        // Only use claude.json if it exists
        let claude_json_path = if claude_json.exists() {
            Some(claude_json.to_string_lossy().to_string())
        } else {
            None
        };

        // Only use opencode config if it exists
        let opencode_config_path = if opencode_config.exists() {
            Some(opencode_config.to_string_lossy().to_string())
        } else {
            None
        };

        // Only use opencode data if it exists
        let opencode_data_path = if opencode_data.exists() {
            Some(opencode_data.to_string_lossy().to_string())
        } else {
            None
        };

        // Only use opencode state if it exists
        let opencode_state_path = if opencode_state.exists() {
            Some(opencode_state.to_string_lossy().to_string())
        } else {
            None
        };

        // Only use opencode model file if it exists
        let opencode_model_json_path =
            if opencode_model_json.exists() && opencode_model_json.is_file() {
                Some(opencode_model_json.to_string_lossy().to_string())
            } else {
                None
            };

        Self {
            environment_id: environment.id.clone(),
            project_id: environment.project_id.clone(),
            name: environment.name.clone(),
            git_url: git_url.to_string(),
            branch: "main".to_string(),
            base_branch: None,
            env_file_path: None,
            project_local_path: None,
            claude_dir_path: claude_dir.to_string_lossy().to_string(),
            claude_json_path,
            opencode_config_path,
            opencode_data_path,
            opencode_state_path,
            opencode_model_json_path,
            gitconfig_path,
            github_token: None,
            cpu_limit: None,
            memory_limit: None,
            anthropic_api_key: None,
            oauth_credentials_json: None,
            debug_mode: environment.debug_mode,
            network_access_mode: environment.network_access_mode.clone(),
            allowed_domains: Vec::new(),
            port_mappings: environment.port_mappings.clone().unwrap_or_default(),
            files_to_copy: Vec::new(),
            opencode_model: String::new(),
        }
    }

    pub fn with_project_local_path(mut self, path: Option<String>) -> Self {
        self.project_local_path = path;
        self
    }

    pub fn with_branch(mut self, branch: &str) -> Self {
        self.branch = branch.to_string();
        self
    }

    pub fn with_base_branch(mut self, base_branch: &str) -> Self {
        let trimmed = base_branch.trim();
        if !trimmed.is_empty() {
            self.base_branch = Some(trimmed.to_string());
        }
        self
    }

    pub fn with_files_to_copy(mut self, files: Vec<String>) -> Self {
        self.files_to_copy = files;
        self
    }
}

/// Create a new container for an environment
/// If `custom_image` is provided, uses that image instead of the base image (used for recreate with docker commit)
pub async fn create_environment_container(
    config: &ContainerConfig,
    custom_image: Option<&str>,
) -> Result<String, DockerError> {
    let client = get_docker_client()?;

    let image_name = custom_image.unwrap_or(BASE_IMAGE);

    // Check if image exists
    if !client.image_exists(image_name).await? {
        return Err(DockerError::ImageNotFound(format!(
            "Image {} not found. Please build it first.",
            image_name
        )));
    }

    // Prepare environment variables
    let env = build_container_env(config);

    // Prepare bind mounts - use /home/node paths for non-root container user
    let mut binds = vec![
        // Mount ~/.claude read-only to a separate location for copying config
        // The entrypoint will copy necessary files to the writable ~/.claude directory
        format!("{}:/claude-config:ro", config.claude_dir_path),
    ];

    // Mount ~/.claude.json if it exists - separate config file used by Claude Code
    if let Some(claude_json_path) = &config.claude_json_path {
        debug!(path = %claude_json_path, "Mounting .claude.json");
        binds.push(format!("{}:/claude-config.json:ro", claude_json_path));
    }

    // Mount ~/.config/opencode if it exists - OpenCode configuration
    if let Some(opencode_config_path) = &config.opencode_config_path {
        debug!(path = %opencode_config_path, "Mounting opencode config");
        binds.push(format!("{}:/opencode-config:ro", opencode_config_path));
    }

    // Mount ~/.local/share/opencode if it exists - OpenCode data
    if let Some(opencode_data_path) = &config.opencode_data_path {
        debug!(path = %opencode_data_path, "Mounting opencode data");
        binds.push(format!("{}:/opencode-data:ro", opencode_data_path));
    }

    // Mount ~/.local/state/opencode if it exists - OpenCode state
    if let Some(opencode_state_path) = &config.opencode_state_path {
        debug!(path = %opencode_state_path, "Mounting opencode state");
        binds.push(format!("{}:/opencode-state:ro", opencode_state_path));
    }

    // Mount ~/.local/state/opencode/model.json if it exists - explicit OpenCode model selection
    if let Some(opencode_model_json_path) = &config.opencode_model_json_path {
        debug!(path = %opencode_model_json_path, "Mounting opencode model.json");
        binds.push(format!(
            "{}:/opencode-model.json:ro",
            opencode_model_json_path
        ));
    }

    // Mount gitconfig if it exists - for git user.name, user.email, etc.
    if let Some(gitconfig_path) = &config.gitconfig_path {
        binds.push(format!("{}:/tmp/gitconfig:ro", gitconfig_path));
    }

    // Mount .env file if provided (legacy single file)
    if let Some(env_path) = &config.env_file_path {
        binds.push(format!("{}:/env/.env:ro", env_path));
    }

    // Mount .env and .env.local from project's local source folder if available
    if let Some(local_path) = &config.project_local_path {
        println!("[create_container] Project local path: {}", local_path);
        let local_path = std::path::Path::new(local_path);

        // Mount .env if it exists
        let env_file = local_path.join(".env");
        if env_file.exists() {
            println!(
                "[create_container] Mounting .env from: {}",
                env_file.display()
            );
            binds.push(format!("{}:/project-env/.env:ro", env_file.display()));
        } else {
            println!(
                "[create_container] .env not found at: {}",
                env_file.display()
            );
        }

        // Mount .env.local if it exists
        let env_local_file = local_path.join(".env.local");
        if env_local_file.exists() {
            println!(
                "[create_container] Mounting .env.local from: {}",
                env_local_file.display()
            );
            binds.push(format!(
                "{}:/project-env/.env.local:ro",
                env_local_file.display()
            ));
        } else {
            println!(
                "[create_container] .env.local not found at: {}",
                env_local_file.display()
            );
        }
    } else {
        println!("[create_container] No project local path provided");
    }

    // Mount additional files to copy from project local path
    if let Some(local_path) = &config.project_local_path {
        if !config.files_to_copy.is_empty() {
            debug!(
                count = config.files_to_copy.len(),
                "Mounting additional files to copy"
            );
            let local_path = std::path::Path::new(local_path);

            for relative_path in &config.files_to_copy {
                // Skip empty paths or paths with parent directory traversal
                if relative_path.is_empty()
                    || relative_path.contains("..")
                    || relative_path.starts_with('/')
                {
                    debug!(path = %relative_path, "Skipping invalid path");
                    continue;
                }

                let file_path = local_path.join(relative_path);
                if file_path.exists() && file_path.is_file() {
                    // Mount to /project-files/<relative_path>:ro
                    let container_path = format!("/project-files/{}", relative_path);
                    debug!(source = %file_path.display(), dest = %container_path, "Mounting file");
                    binds.push(format!("{}:{}:ro", file_path.display(), container_path));
                } else {
                    debug!(path = %file_path.display(), "File not found or not a file");
                }
            }
        }
    }

    // Mount opencode.json from project local path if it exists
    // This file configures OpenCode for the project and will be processed by workspace-setup.sh
    if let Some(local_path) = &config.project_local_path {
        let local_path = std::path::Path::new(local_path);
        let opencode_json = local_path.join("opencode.json");
        if opencode_json.exists() && opencode_json.is_file() {
            debug!(path = %opencode_json.display(), "Mounting project opencode.json");
            binds.push(format!(
                "{}:/opencode-project-json:ro",
                opencode_json.display()
            ));
        }
    }

    println!("[create_container] Final binds: {:?}", binds);

    // Prepare labels
    let mut labels = HashMap::new();
    labels.insert(
        CONTAINER_LABEL_APP.to_string(),
        CONTAINER_LABEL_APP_VALUE.to_string(),
    );
    labels.insert(
        CONTAINER_LABEL_ENV_ID.to_string(),
        config.environment_id.clone(),
    );
    labels.insert(
        CONTAINER_LABEL_PROJECT_ID.to_string(),
        config.project_id.clone(),
    );

    // Build port bindings for Docker
    let mut port_bindings: HashMap<String, Option<Vec<PortBinding>>> = HashMap::new();
    let mut exposed_ports: HashMap<String, HashMap<(), ()>> = HashMap::new();

    for mapping in &config.port_mappings {
        let key = format!("{}/{}", mapping.container_port, mapping.protocol);

        // Add to exposed ports
        exposed_ports.insert(key.clone(), HashMap::new());

        // Add to port bindings - bind to localhost only for security
        // This prevents container ports from being accessible from other machines
        let binding = PortBinding {
            host_ip: Some("127.0.0.1".to_string()),
            host_port: Some(mapping.host_port.to_string()),
        };
        port_bindings.insert(key, Some(vec![binding]));
    }

    // Always expose port 4096 for OpenCode server (native mode)
    // Use dynamic host port allocation (empty string) to allow multiple environments
    const OPENCODE_SERVER_PORT: u16 = 4096;
    let opencode_key = format!("{}/tcp", OPENCODE_SERVER_PORT);
    exposed_ports.insert(opencode_key.clone(), HashMap::new());
    let opencode_binding = PortBinding {
        host_ip: Some("127.0.0.1".to_string()),
        host_port: Some("".to_string()), // Empty string = dynamic allocation
    };
    port_bindings.insert(opencode_key, Some(vec![opencode_binding]));
    debug!(
        "Added OpenCode server port {} with dynamic host allocation",
        OPENCODE_SERVER_PORT
    );

    // Always expose port 4097 for Claude Bridge server (Claude native mode)
    // Use dynamic host port allocation (empty string) to allow multiple environments
    const CLAUDE_BRIDGE_PORT: u16 = 4097;
    let claude_key = format!("{}/tcp", CLAUDE_BRIDGE_PORT);
    exposed_ports.insert(claude_key.clone(), HashMap::new());
    let claude_binding = PortBinding {
        host_ip: Some("127.0.0.1".to_string()),
        host_port: Some("".to_string()), // Empty string = dynamic allocation
    };
    port_bindings.insert(claude_key, Some(vec![claude_binding]));
    debug!(
        "Added Claude Bridge server port {} with dynamic host allocation",
        CLAUDE_BRIDGE_PORT
    );

    if !config.port_mappings.is_empty() {
        debug!("User port mappings: {:?}", config.port_mappings);
    }

    // Build container configuration with capabilities and resource limits
    let container_config = CreateContainerConfig {
        env,
        binds,
        labels,
        working_dir: Some("/workspace".to_string()),
        cpu_limit: config.cpu_limit,
        memory_limit: config.memory_limit,
        // Add NET_ADMIN capability for firewall initialization
        cap_add: vec!["NET_ADMIN".to_string()],
        port_bindings,
        exposed_ports,
    };

    // Create the container
    let container_id = client
        .create_container(&config.name, image_name, container_config)
        .await?;

    Ok(container_id)
}

fn build_container_env(config: &ContainerConfig) -> Vec<String> {
    let mut env = vec![
        format!("GIT_URL={}", config.git_url),
        format!("GIT_BRANCH={}", config.branch),
        "TERM=xterm-256color".to_string(),
    ];

    if let Some(base_branch) = &config.base_branch {
        env.push(format!("GIT_BASE_BRANCH={}", base_branch));
    }

    // Add OAuth credentials JSON if available (preferred for Claude Code auth)
    // This is used by the entrypoint to create ~/.claude/.credentials.json
    // which is how Linux containers authenticate with Claude Code
    if let Some(creds_json) = &config.oauth_credentials_json {
        env.push(format!("CLAUDE_OAUTH_CREDENTIALS={}", creds_json));
    }

    // Add Anthropic API key as fallback if configured
    if let Some(api_key) = &config.anthropic_api_key {
        env.push(format!("ANTHROPIC_API_KEY={}", api_key));
    }

    // Add GitHub token for HTTPS authentication if configured
    if let Some(token) = &config.github_token {
        env.push(format!("GITHUB_TOKEN={}", token));
        env.push(format!("GH_TOKEN={}", token));
    }

    // Add OpenCode model if configured
    if !config.opencode_model.is_empty() {
        env.push(format!("OPENCODE_MODEL={}", config.opencode_model));
    }

    // Enable debug mode for verbose entrypoint logging
    if config.debug_mode {
        env.push("DEBUG=1".to_string());
    }

    // Add network access mode configuration
    match &config.network_access_mode {
        NetworkAccessMode::Full => {
            env.push("NETWORK_MODE=full".to_string());
        }
        NetworkAccessMode::Restricted => {
            env.push("NETWORK_MODE=restricted".to_string());
            // Pass allowed domains as comma-separated list
            if !config.allowed_domains.is_empty() {
                env.push(format!(
                    "ALLOWED_DOMAINS={}",
                    config.allowed_domains.join(",")
                ));
            }
        }
    }

    env
}

/// Start an environment container
pub async fn start_environment_container(container_id: &str) -> Result<(), DockerError> {
    let client = get_docker_client()?;
    client.start_container(container_id).await
}

/// Stop an environment container
pub async fn stop_environment_container(container_id: &str) -> Result<(), DockerError> {
    let client = get_docker_client()?;
    client.stop_container(container_id, Some(10)).await
}

/// Remove an environment container
pub async fn remove_environment_container(container_id: &str) -> Result<(), DockerError> {
    let client = get_docker_client()?;
    // Force remove to ensure it's gone
    client.remove_container(container_id, true).await
}

/// Get the status of an environment container
pub async fn get_container_environment_status(
    container_id: &str,
) -> Result<EnvironmentStatus, DockerError> {
    let client = get_docker_client()?;
    let status = client.get_container_status(container_id).await?;

    Ok(match status.to_lowercase().as_str() {
        "running" => EnvironmentStatus::Running,
        "created" | "restarting" => EnvironmentStatus::Creating,
        "exited" | "dead" | "paused" => EnvironmentStatus::Stopped,
        _ => EnvironmentStatus::Error,
    })
}

/// Check if Docker is available
pub async fn is_docker_available() -> bool {
    match get_docker_client() {
        Ok(client) => client.is_available().await,
        Err(_) => false,
    }
}

/// Get Docker version
pub async fn get_docker_version() -> Result<String, DockerError> {
    let client = get_docker_client()?;
    client.version().await
}

/// List all orchestrator-managed containers
pub async fn list_managed_containers() -> Result<Vec<(String, String)>, DockerError> {
    let client = get_docker_client()?;
    let label = format!("{}={}", CONTAINER_LABEL_APP, CONTAINER_LABEL_APP_VALUE);
    let containers = client.list_containers(true, Some(&label)).await?;

    let result: Vec<(String, String)> = containers
        .iter()
        .filter_map(|c| {
            let id = c.id.clone()?;
            let name = c
                .names
                .as_ref()?
                .first()?
                .trim_start_matches('/')
                .to_string();
            Some((id, name))
        })
        .collect();

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn test_container_config() {
        let env = Environment::new("project-123".to_string());
        let config = ContainerConfig::new(&env, "https://github.com/test/repo.git")
            .with_branch("feature/my-change")
            .with_base_branch("develop");

        assert_eq!(config.branch, "feature/my-change");
        assert_eq!(config.base_branch, Some("develop".to_string()));
        assert_eq!(config.git_url, "https://github.com/test/repo.git");
    }

    #[test]
    fn test_build_container_env_includes_base_branch() {
        let env = Environment::new("project-123".to_string());
        let config = ContainerConfig::new(&env, "https://github.com/test/repo.git")
            .with_branch("feature/new-api")
            .with_base_branch("develop");

        let vars = build_container_env(&config);

        assert!(vars.contains(&"GIT_URL=https://github.com/test/repo.git".to_string()));
        assert!(vars.contains(&"GIT_BRANCH=feature/new-api".to_string()));
        assert!(vars.contains(&"GIT_BASE_BRANCH=develop".to_string()));
    }

    #[test]
    fn test_build_container_env_omits_empty_base_branch() {
        let env = Environment::new("project-123".to_string());
        let config = ContainerConfig::new(&env, "https://github.com/test/repo.git")
            .with_branch("feature/new-api")
            .with_base_branch("   ");

        let vars = build_container_env(&config);

        assert!(vars.contains(&"GIT_BRANCH=feature/new-api".to_string()));
        assert!(!vars
            .iter()
            .any(|entry| entry.starts_with("GIT_BASE_BRANCH=")));
    }

    #[test]
    fn test_container_config_detects_opencode_model_json() {
        let tmp = tempdir().unwrap();
        let home = tmp.path();
        let state_dir = home.join(".local").join("state").join("opencode");
        let model_path = state_dir.join("model.json");

        fs::create_dir_all(&state_dir).unwrap();
        fs::write(&model_path, r#"{"model":"opencode/grok-code"}"#).unwrap();

        let env = Environment::new("project-123".to_string());
        let config = ContainerConfig::new_with_home(&env, "https://github.com/test/repo.git", home);

        assert_eq!(
            config.opencode_model_json_path,
            Some(model_path.to_string_lossy().to_string())
        );
    }
}
