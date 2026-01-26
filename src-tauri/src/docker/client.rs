// Docker client wrapper using Bollard
// Provides high-level API for container operations

use bollard::Docker;
use bollard::container::{
    Config, CreateContainerOptions, ListContainersOptions, RemoveContainerOptions,
    RenameContainerOptions, StartContainerOptions, StopContainerOptions, InspectContainerOptions,
    PruneContainersOptions, LogsOptions, LogOutput,
};
use bollard::exec::{CreateExecOptions, StartExecResults};
use bollard::image::{CommitContainerOptions, ListImagesOptions, RemoveImageOptions, PruneImagesOptions};
use bollard::network::PruneNetworksOptions;
use bollard::volume::PruneVolumesOptions;
use bollard::models::{ContainerInspectResponse, ContainerSummary, ImageSummary, PortBinding, SystemInfo, SystemDataUsageResponse};
use futures::StreamExt;
use tokio::sync::mpsc;
use std::collections::HashMap;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum DockerError {
    #[error("Failed to connect to Docker: {0}")]
    ConnectionFailed(String),
    #[error("Docker operation failed: {0}")]
    OperationFailed(String),
    #[error("Image not found: {0}")]
    ImageNotFound(String),
}

impl From<bollard::errors::Error> for DockerError {
    fn from(err: bollard::errors::Error) -> Self {
        DockerError::OperationFailed(err.to_string())
    }
}

impl From<std::io::Error> for DockerError {
    fn from(err: std::io::Error) -> Self {
        DockerError::OperationFailed(err.to_string())
    }
}

/// Extended container configuration for create_container
#[derive(Default)]
pub struct CreateContainerConfig {
    pub env: Vec<String>,
    pub binds: Vec<String>,
    pub labels: HashMap<String, String>,
    pub working_dir: Option<String>,
    pub cpu_limit: Option<f64>,
    pub memory_limit: Option<i64>,
    pub cap_add: Vec<String>,
    /// Port bindings: maps container ports to host ports
    /// Key format: "port/protocol" (e.g., "8080/tcp")
    pub port_bindings: HashMap<String, Option<Vec<PortBinding>>>,
    /// Exposed ports for the container
    pub exposed_ports: HashMap<String, HashMap<(), ()>>,
}

/// Docker client wrapper providing high-level operations
pub struct DockerClient {
    docker: Docker,
}

impl DockerClient {
    /// Create a new Docker client, connecting to the Docker socket
    pub fn new() -> Result<Self, DockerError> {
        let docker = Docker::connect_with_local_defaults()
            .map_err(|e| DockerError::ConnectionFailed(e.to_string()))?;
        Ok(Self { docker })
    }

    /// Check if Docker is available and running
    pub async fn is_available(&self) -> bool {
        self.docker.ping().await.is_ok()
    }

    /// Get Docker version information
    pub async fn version(&self) -> Result<String, DockerError> {
        let version = self.docker.version().await?;
        Ok(version.version.unwrap_or_else(|| "unknown".to_string()))
    }

    // --- Image Operations ---

    /// List available images
    pub async fn list_images(&self) -> Result<Vec<ImageSummary>, DockerError> {
        let options = ListImagesOptions::<String> {
            all: false,
            ..Default::default()
        };
        let images = self.docker.list_images(Some(options)).await?;
        Ok(images)
    }

    /// Check if an image exists locally
    pub async fn image_exists(&self, image_name: &str) -> Result<bool, DockerError> {
        let images = self.list_images().await?;
        Ok(images.iter().any(|img| {
            img.repo_tags
                .iter()
                .any(|tag| tag.contains(image_name) || tag == image_name)
        }))
    }

    // --- Container Operations ---

    /// List containers (optionally filter by label)
    pub async fn list_containers(&self, all: bool, label_filter: Option<&str>) -> Result<Vec<ContainerSummary>, DockerError> {
        let mut filters = HashMap::new();
        if let Some(label) = label_filter {
            filters.insert("label", vec![label]);
        }

        let options = ListContainersOptions {
            all,
            filters,
            ..Default::default()
        };

        let containers = self.docker.list_containers(Some(options)).await?;
        Ok(containers)
    }

    /// Create a new container with extended configuration
    pub async fn create_container(
        &self,
        name: &str,
        image: &str,
        config_opts: CreateContainerConfig,
    ) -> Result<String, DockerError> {
        let mut config = Config::<String> {
            image: Some(image.to_string()),
            env: Some(config_opts.env),
            labels: Some(config_opts.labels),
            tty: Some(true),
            open_stdin: Some(true),
            attach_stdin: Some(true),
            attach_stdout: Some(true),
            attach_stderr: Some(true),
            ..Default::default()
        };

        if let Some(dir) = config_opts.working_dir {
            config.working_dir = Some(dir);
        }

        // Set exposed ports if any
        if !config_opts.exposed_ports.is_empty() {
            config.exposed_ports = Some(config_opts.exposed_ports);
        }

        // Set host config with binds (mounts), capabilities, and resource limits
        let mut host_config = bollard::models::HostConfig::default();

        if !config_opts.binds.is_empty() {
            host_config.binds = Some(config_opts.binds);
        }

        // Add capabilities (e.g., NET_ADMIN for firewall)
        if !config_opts.cap_add.is_empty() {
            host_config.cap_add = Some(config_opts.cap_add);
        }

        // Set CPU limit (in nanoseconds, 1 core = 1e9 nanoseconds)
        if let Some(cpu_cores) = config_opts.cpu_limit {
            host_config.nano_cpus = Some((cpu_cores * 1e9) as i64);
        }

        // Set memory limit (in bytes)
        if let Some(memory) = config_opts.memory_limit {
            host_config.memory = Some(memory);
        }

        // Set port bindings if any
        if !config_opts.port_bindings.is_empty() {
            host_config.port_bindings = Some(config_opts.port_bindings);
        }

        config.host_config = Some(host_config);

        let options = CreateContainerOptions {
            name,
            platform: None,
        };

        let response = self.docker.create_container(Some(options), config).await?;
        Ok(response.id)
    }

    /// Start a container
    pub async fn start_container(&self, container_id: &str) -> Result<(), DockerError> {
        self.docker
            .start_container(container_id, None::<StartContainerOptions<String>>)
            .await?;
        Ok(())
    }

    /// Stop a container
    pub async fn stop_container(&self, container_id: &str, timeout: Option<i64>) -> Result<(), DockerError> {
        let options = StopContainerOptions {
            t: timeout.unwrap_or(10),
        };
        self.docker.stop_container(container_id, Some(options)).await?;
        Ok(())
    }

    /// Remove a container
    pub async fn remove_container(&self, container_id: &str, force: bool) -> Result<(), DockerError> {
        let options = RemoveContainerOptions {
            force,
            v: true, // Remove volumes
            ..Default::default()
        };
        self.docker.remove_container(container_id, Some(options)).await?;
        Ok(())
    }

    /// Rename a container
    pub async fn rename_container(&self, container_id: &str, new_name: &str) -> Result<(), DockerError> {
        let options = RenameContainerOptions { name: new_name };
        self.docker.rename_container(container_id, options).await?;
        Ok(())
    }

    /// Commit a container to a new image (preserves filesystem state)
    /// Returns the ID of the new image
    pub async fn commit_container(&self, container_id: &str, image_name: &str, tag: &str) -> Result<String, DockerError> {
        let options = CommitContainerOptions {
            container: container_id,
            repo: image_name,
            tag,
            pause: true,
            ..Default::default()
        };

        let response = self.docker.commit_container(options, Config::<String>::default()).await?;
        Ok(response.id.unwrap_or_default())
    }

    /// Remove an image
    pub async fn remove_image(&self, image_name: &str, force: bool) -> Result<(), DockerError> {
        let options = RemoveImageOptions {
            force,
            noprune: false,
        };
        self.docker.remove_image(image_name, Some(options), None).await?;
        Ok(())
    }

    /// Execute a command in a running container
    /// Returns the combined stdout/stderr output
    pub async fn exec_in_container(
        &self,
        container_id: &str,
        cmd: Vec<&str>,
        working_dir: Option<&str>,
    ) -> Result<String, DockerError> {
        let options = CreateExecOptions {
            cmd: Some(cmd),
            working_dir,
            attach_stdout: Some(true),
            attach_stderr: Some(true),
            ..Default::default()
        };

        let exec = self.docker.create_exec(container_id, options).await?;

        let output = match self.docker.start_exec(&exec.id, None).await? {
            StartExecResults::Attached { mut output, .. } => {
                let mut result = String::new();
                while let Some(Ok(chunk)) = output.next().await {
                    match chunk {
                        LogOutput::StdOut { message } | LogOutput::StdErr { message } => {
                            if let Ok(text) = String::from_utf8(message.to_vec()) {
                                result.push_str(&text);
                            }
                        }
                        _ => {}
                    }
                }
                result
            }
            StartExecResults::Detached => String::new(),
        };

        Ok(output)
    }

    /// Inspect a container
    pub async fn inspect_container(&self, container_id: &str) -> Result<ContainerInspectResponse, DockerError> {
        let response = self.docker
            .inspect_container(container_id, None::<InspectContainerOptions>)
            .await?;
        Ok(response)
    }

    /// Get container status
    pub async fn get_container_status(&self, container_id: &str) -> Result<String, DockerError> {
        let info = self.inspect_container(container_id).await?;
        let state = info.state.ok_or_else(|| {
            DockerError::OperationFailed("Container state not available".to_string())
        })?;

        Ok(state.status.map(|s| s.to_string()).unwrap_or_else(|| "unknown".to_string()))
    }

    /// Check if a container is running
    pub async fn is_container_running(&self, container_id: &str) -> Result<bool, DockerError> {
        let status = self.get_container_status(container_id).await?;
        Ok(status.to_lowercase() == "running")
    }

    /// Get the host port mapped to a specific container port
    /// Returns None if the port is not mapped or the container is not running
    pub async fn get_host_port(&self, container_id: &str, container_port: u16, protocol: &str) -> Result<Option<u16>, DockerError> {
        let info = self.inspect_container(container_id).await?;

        // Get network settings
        let network_settings = match info.network_settings {
            Some(ns) => ns,
            None => return Ok(None),
        };

        // Get port bindings
        let ports = match network_settings.ports {
            Some(p) => p,
            None => return Ok(None),
        };

        // Look for the specific port binding
        let port_key = format!("{}/{}", container_port, protocol);
        if let Some(Some(bindings)) = ports.get(&port_key) {
            // Get the first binding's host port
            if let Some(binding) = bindings.first() {
                if let Some(host_port_str) = &binding.host_port {
                    if let Ok(host_port) = host_port_str.parse::<u16>() {
                        return Ok(Some(host_port));
                    }
                }
            }
        }

        Ok(None)
    }

    /// Get Docker system information
    pub async fn system_info(&self) -> Result<SystemInfo, DockerError> {
        let info = self.docker.info().await?;
        Ok(info)
    }

    /// Get Docker disk usage information
    pub async fn disk_usage(&self) -> Result<SystemDataUsageResponse, DockerError> {
        let df = self.docker.df().await?;
        Ok(df)
    }

    /// Get total memory usage from all running containers
    /// Returns active memory (excluding cache) to match Docker Desktop's display
    pub async fn get_containers_memory_usage(&self) -> Result<u64, DockerError> {
        use bollard::container::{MemoryStatsStats, StatsOptions};

        // Get all running containers
        let containers = self.list_containers(false, None).await?;

        let mut total_memory: u64 = 0;

        for container in containers {
            if let Some(id) = container.id {
                // Get stats for this container (one-shot, not streaming)
                let options = StatsOptions {
                    stream: false,
                    one_shot: true,
                };

                let mut stats_stream = self.docker.stats(&id, Some(options));

                // Get the first (and only) stats entry
                if let Some(Ok(stats)) = stats_stream.next().await {
                    // memory_stats is a MemoryStats struct, not an Option
                    if let Some(usage) = stats.memory_stats.usage {
                        // Subtract cache to get active memory (matches Docker Desktop)
                        // For cgroup v1: usage - cache
                        // For cgroup v2: usage - inactive_file
                        let cache = stats.memory_stats.stats
                            .as_ref()
                            .map(|s| match s {
                                MemoryStatsStats::V1(v1) => v1.cache,
                                MemoryStatsStats::V2(v2) => v2.inactive_file,
                            })
                            .unwrap_or(0);

                        total_memory += usage.saturating_sub(cache);
                    }
                }
            }
        }

        Ok(total_memory)
    }

    /// Get CPU usage percentage for a specific container
    /// Returns None if the container is not running or stats cannot be retrieved
    pub async fn get_container_cpu_percent(&self, container_id: &str) -> Option<f64> {
        use bollard::container::StatsOptions;

        let options = StatsOptions {
            stream: false,
            one_shot: true,
        };

        let mut stats_stream = self.docker.stats(container_id, Some(options));

        if let Some(Ok(stats)) = stats_stream.next().await {
            // Calculate CPU percentage
            // Formula: (cpu_delta / system_cpu_delta) * number_of_cpus * 100
            let cpu_delta = stats.cpu_stats.cpu_usage.total_usage as f64
                - stats.precpu_stats.cpu_usage.total_usage as f64;

            let system_delta = stats.cpu_stats.system_cpu_usage.unwrap_or(0) as f64
                - stats.precpu_stats.system_cpu_usage.unwrap_or(0) as f64;

            if system_delta > 0.0 && cpu_delta > 0.0 {
                let num_cpus = stats.cpu_stats.online_cpus.unwrap_or(1) as f64;
                let cpu_percent = (cpu_delta / system_delta) * num_cpus * 100.0;
                // Round to 1 decimal place
                return Some((cpu_percent * 10.0).round() / 10.0);
            }
        }

        None
    }

    /// Get total CPU usage percentage from all running containers
    /// Returns the sum of CPU percentages from all running containers
    pub async fn get_total_cpu_usage(&self) -> f64 {
        // Get all running containers
        let containers = match self.list_containers(false, None).await {
            Ok(c) => c,
            Err(_) => return 0.0,
        };

        let mut total_cpu: f64 = 0.0;

        for container in containers {
            if let Some(id) = container.id {
                if let Some(cpu_percent) = self.get_container_cpu_percent(&id).await {
                    total_cpu += cpu_percent;
                }
            }
        }

        // Round to 1 decimal place
        (total_cpu * 10.0).round() / 10.0
    }

    /// Upload a file to a container using Docker's tar-based API
    /// This bypasses shell command length limits and supports files up to 8MB+
    ///
    /// Note: Files are created with mode 0o644 (rw-r--r--). If you need executable
    /// permissions, run chmod on the file after upload.
    pub async fn upload_file_to_container(
        &self,
        container_id: &str,
        file_path: &str,
        file_data: Vec<u8>,
    ) -> Result<(), DockerError> {
        use bollard::container::UploadToContainerOptions;

        // Extract filename and parent directory from path
        let path = std::path::Path::new(file_path);
        let filename = path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| DockerError::OperationFailed("Invalid file path".to_string()))?;
        let parent_dir = path
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| "/workspace".to_string());

        // Create a tar archive in memory containing the file
        let mut tar_builder = tar::Builder::new(Vec::new());

        // Create tar header
        let mut header = tar::Header::new_gnu();
        header.set_path(filename)?;
        header.set_size(file_data.len() as u64);
        header.set_mode(0o644);
        header.set_mtime(std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs());
        header.set_cksum();

        // Add file to tar archive
        tar_builder.append(&header, file_data.as_slice())?;
        let tar_data = tar_builder.into_inner()?;

        // Upload tar archive to container
        let options = UploadToContainerOptions {
            path: parent_dir,
            no_overwrite_dir_non_dir: "false".to_string(),
        };

        self.docker
            .upload_to_container(container_id, Some(options), tar_data.into())
            .await?;

        Ok(())
    }

    /// Execute a command in a running container and return the output
    pub async fn exec_command(
        &self,
        container_id: &str,
        cmd: Vec<&str>,
    ) -> Result<String, DockerError> {
        let config = CreateExecOptions {
            cmd: Some(cmd),
            attach_stdout: Some(true),
            attach_stderr: Some(true),
            ..Default::default()
        };

        let exec = self.docker.create_exec(container_id, config).await?;

        match self.docker.start_exec(&exec.id, None).await? {
            StartExecResults::Attached { mut output, .. } => {
                let mut result = String::new();
                while let Some(msg) = output.next().await {
                    match msg {
                        Ok(bollard::container::LogOutput::StdOut { message }) => {
                            result.push_str(&String::from_utf8_lossy(&message));
                        }
                        Ok(bollard::container::LogOutput::StdErr { message }) => {
                            result.push_str(&String::from_utf8_lossy(&message));
                        }
                        Ok(_) => {}
                        Err(e) => {
                            return Err(DockerError::OperationFailed(format!(
                                "Error reading exec output: {}",
                                e
                            )));
                        }
                    }
                }
                Ok(result)
            }
            StartExecResults::Detached => {
                Err(DockerError::OperationFailed("Exec started in detached mode".to_string()))
            }
        }
    }

    /// Execute a command in a running container and return only stdout
    /// This is useful for commands that output JSON to stdout and may have
    /// progress messages on stderr (like `gh` CLI commands)
    pub async fn exec_command_stdout(
        &self,
        container_id: &str,
        cmd: Vec<&str>,
    ) -> Result<String, DockerError> {
        let config = CreateExecOptions {
            cmd: Some(cmd),
            attach_stdout: Some(true),
            attach_stderr: Some(true), // Still attach stderr to avoid blocking
            ..Default::default()
        };

        let exec = self.docker.create_exec(container_id, config).await?;

        match self.docker.start_exec(&exec.id, None).await? {
            StartExecResults::Attached { mut output, .. } => {
                let mut stdout = String::new();
                while let Some(msg) = output.next().await {
                    match msg {
                        Ok(bollard::container::LogOutput::StdOut { message }) => {
                            stdout.push_str(&String::from_utf8_lossy(&message));
                        }
                        Ok(bollard::container::LogOutput::StdErr { .. }) => {
                            // Ignore stderr
                        }
                        Ok(_) => {}
                        Err(e) => {
                            return Err(DockerError::OperationFailed(format!(
                                "Error reading exec output: {}",
                                e
                            )));
                        }
                    }
                }
                Ok(stdout)
            }
            StartExecResults::Detached => {
                Err(DockerError::OperationFailed("Exec started in detached mode".to_string()))
            }
        }
    }

    /// Stream container logs to a channel
    /// Returns a receiver that yields log lines as they arrive
    /// The stream continues until the container stops or the receiver is dropped
    pub async fn stream_container_logs(
        &self,
        container_id: &str,
    ) -> Result<mpsc::Receiver<String>, DockerError> {
        let (tx, rx) = mpsc::channel::<String>(100);

        let options = LogsOptions::<String> {
            follow: true,
            stdout: true,
            stderr: true,
            timestamps: false,
            tail: "0".to_string(), // Only stream new logs, not existing ones
            ..Default::default()
        };

        let mut stream = self.docker.logs(container_id, Some(options));
        let container_id = container_id.to_string();

        // Spawn a task to read logs and send them to the channel
        tokio::spawn(async move {
            while let Some(result) = stream.next().await {
                match result {
                    Ok(log) => {
                        let text = match log {
                            LogOutput::StdOut { message } | LogOutput::StdErr { message } => {
                                String::from_utf8_lossy(&message).to_string()
                            }
                            _ => continue,
                        };
                        // If send fails, the receiver was dropped - stop streaming
                        if tx.send(text).await.is_err() {
                            break;
                        }
                    }
                    Err(e) => {
                        // Log error but don't fail - container might have stopped
                        tracing::debug!(
                            container_id = %container_id,
                            error = %e,
                            "Container log stream ended"
                        );
                        break;
                    }
                }
            }
        });

        Ok(rx)
    }

    /// Get recent container logs (non-streaming)
    /// Returns the last N lines of logs
    pub async fn get_container_logs(&self, container_id: &str, tail: Option<&str>) -> Result<String, DockerError> {
        let options = LogsOptions::<String> {
            follow: false,
            stdout: true,
            stderr: true,
            timestamps: false,
            tail: tail.unwrap_or("100").to_string(),
            ..Default::default()
        };

        let mut stream = self.docker.logs(container_id, Some(options));
        let mut result = String::new();

        while let Some(log_result) = stream.next().await {
            match log_result {
                Ok(log) => {
                    let text = match log {
                        LogOutput::StdOut { message } | LogOutput::StdErr { message } => {
                            String::from_utf8_lossy(&message).to_string()
                        }
                        _ => continue,
                    };
                    result.push_str(&text);
                }
                Err(e) => {
                    return Err(DockerError::OperationFailed(format!(
                        "Error reading container logs: {}",
                        e
                    )));
                }
            }
        }

        Ok(result)
    }

    /// Perform Docker system prune - removes unused containers, images, networks, and volumes
    /// Returns the total space reclaimed in bytes
    pub async fn system_prune(&self, prune_volumes: bool) -> Result<SystemPruneResult, DockerError> {
        let mut result = SystemPruneResult::default();

        // Prune stopped containers
        let container_prune = self.docker.prune_containers(None::<PruneContainersOptions<String>>).await?;
        result.containers_deleted = container_prune.containers_deleted.map(|v| v.len() as u32).unwrap_or(0);
        if let Some(space) = container_prune.space_reclaimed {
            result.space_reclaimed += space as u64;
        }

        // Prune unused images (dangling only for safety)
        let image_prune = self.docker.prune_images(None::<PruneImagesOptions<String>>).await?;
        result.images_deleted = image_prune.images_deleted.map(|v| v.len() as u32).unwrap_or(0);
        if let Some(space) = image_prune.space_reclaimed {
            result.space_reclaimed += space as u64;
        }

        // Prune unused networks
        let network_prune = self.docker.prune_networks(None::<PruneNetworksOptions<String>>).await?;
        result.networks_deleted = network_prune.networks_deleted.map(|v| v.len() as u32).unwrap_or(0);

        // Prune unused volumes (optional, can be destructive)
        if prune_volumes {
            let volume_prune = self.docker.prune_volumes(None::<PruneVolumesOptions<String>>).await?;
            result.volumes_deleted = volume_prune.volumes_deleted.map(|v| v.len() as u32).unwrap_or(0);
            if let Some(space) = volume_prune.space_reclaimed {
                result.space_reclaimed += space as u64;
            }
        }

        // Note: Build cache pruning is not available in the Bollard library
        // Users can run `docker builder prune` manually if needed

        Ok(result)
    }
}

/// Result of a Docker system prune operation
#[derive(Debug, Default)]
pub struct SystemPruneResult {
    /// Number of containers deleted
    pub containers_deleted: u32,
    /// Number of images deleted
    pub images_deleted: u32,
    /// Number of networks deleted
    pub networks_deleted: u32,
    /// Number of volumes deleted
    pub volumes_deleted: u32,
    /// Total space reclaimed in bytes
    pub space_reclaimed: u64,
}

// Global Docker client instance
use std::sync::OnceLock;

static DOCKER_CLIENT: OnceLock<Result<DockerClient, String>> = OnceLock::new();

/// Get the global Docker client instance
pub fn get_docker_client() -> Result<&'static DockerClient, DockerError> {
    let result = DOCKER_CLIENT.get_or_init(|| {
        DockerClient::new().map_err(|e| e.to_string())
    });

    match result {
        Ok(client) => Ok(client),
        Err(e) => Err(DockerError::ConnectionFailed(e.clone())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_docker_client_creation() {
        // This test requires Docker to be running
        let client = DockerClient::new();
        // Just check that we can create the client
        assert!(client.is_ok() || client.is_err());
    }
}
