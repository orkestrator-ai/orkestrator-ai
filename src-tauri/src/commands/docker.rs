// Docker-related Tauri commands
// Exposes Docker operations to the frontend

use crate::docker::{self, ContainerConfig};
use crate::models::EnvironmentStatus;
use crate::storage::get_storage;
use serde::{Deserialize, Serialize};
use tracing::{debug, info, trace, warn};

/// Check if Docker is available
#[tauri::command]
pub async fn check_docker() -> Result<bool, String> {
    Ok(docker::is_docker_available().await)
}

/// Get Docker version
#[tauri::command]
pub async fn docker_version() -> Result<String, String> {
    docker::get_docker_version()
        .await
        .map_err(|e| e.to_string())
}

/// Provision a new container for an environment
#[tauri::command]
pub async fn provision_environment(environment_id: String) -> Result<String, String> {
    let storage = get_storage().map_err(|e| e.to_string())?;

    // Get the environment
    let environment = storage
        .get_environment(&environment_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Environment not found: {}", environment_id))?;

    // Get the project to get the git URL
    let project = storage
        .get_project(&environment.project_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Project not found: {}", environment.project_id))?;

    // Create container config
    let config = ContainerConfig::new(&environment, &project.git_url);

    // Create the container
    let container_id = docker::create_environment_container(&config, None)
        .await
        .map_err(|e| e.to_string())?;

    // Update environment with container ID
    storage
        .update_environment(
            &environment_id,
            serde_json::json!({
                "containerId": container_id,
                "status": "stopped"
            }),
        )
        .map_err(|e| e.to_string())?;

    Ok(container_id)
}

/// Start a provisioned container
#[tauri::command]
pub async fn docker_start_container(container_id: String) -> Result<(), String> {
    docker::start_environment_container(&container_id)
        .await
        .map_err(|e| e.to_string())
}

/// Stop a running container
#[tauri::command]
pub async fn docker_stop_container(container_id: String) -> Result<(), String> {
    docker::stop_environment_container(&container_id)
        .await
        .map_err(|e| e.to_string())
}

/// Remove a container
#[tauri::command]
pub async fn docker_remove_container(container_id: String) -> Result<(), String> {
    docker::remove_environment_container(&container_id)
        .await
        .map_err(|e| e.to_string())
}

/// Get container status
#[tauri::command]
pub async fn docker_container_status(container_id: String) -> Result<EnvironmentStatus, String> {
    docker::get_container_environment_status(&container_id)
        .await
        .map_err(|e| e.to_string())
}

/// List all managed containers
#[tauri::command]
pub async fn list_docker_containers() -> Result<Vec<(String, String)>, String> {
    docker::list_managed_containers()
        .await
        .map_err(|e| e.to_string())
}

/// Check if base image exists
#[tauri::command]
pub async fn check_base_image() -> Result<bool, String> {
    let client = docker::client::get_docker_client().map_err(|e| e.to_string())?;
    client
        .image_exists(docker::BASE_IMAGE)
        .await
        .map_err(|e| e.to_string())
}

/// Get the total disk space allocated to Docker on macOS by reading the Docker.raw file size.
///
/// This is macOS Docker Desktop specific. Docker Desktop on macOS uses a virtual disk file
/// (Docker.raw) to store all Docker data. The size of this file represents the total disk
/// space allocated to Docker.
///
/// On Linux with native Docker, this will return None since Docker uses the host filesystem
/// directly. In that case, the UI will show only disk usage without a total allocation.
///
/// Returns None if the file cannot be found or read (e.g., on non-macOS systems or
/// if Docker Desktop is not installed).
fn get_docker_disk_total() -> Option<u64> {
    // On macOS, Docker Desktop stores its virtual disk at:
    // ~/Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw
    let home = dirs::home_dir()?;
    let docker_raw_path = home
        .join("Library")
        .join("Containers")
        .join("com.docker.docker")
        .join("Data")
        .join("vms")
        .join("0")
        .join("data")
        .join("Docker.raw");

    if docker_raw_path.exists() {
        let metadata = std::fs::metadata(&docker_raw_path).ok()?;
        Some(metadata.len())
    } else {
        None
    }
}

/// Docker system stats for the UI
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerSystemStats {
    /// Memory currently used by containers (bytes)
    pub memory_used: u64,
    /// Total memory allocated to Docker (bytes)
    pub memory_total: u64,
    /// Number of CPUs available to Docker
    pub cpus: u32,
    /// Total CPU usage percentage across all running containers
    pub cpu_usage_percent: f64,
    /// Total disk space used by Docker (bytes)
    pub disk_used: u64,
    /// Total disk space allocated to Docker (bytes)
    pub disk_total: u64,
    /// Number of running containers
    pub containers_running: u32,
    /// Total number of containers
    pub containers_total: u32,
    /// Total number of images
    pub images_total: u32,
}

/// Container info for display in the UI
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerInfo {
    /// Container ID
    pub id: String,
    /// Container name
    pub name: String,
    /// Container status (running, exited, etc.)
    pub status: String,
    /// Container state (running, exited, created, etc.)
    pub state: String,
    /// Image name
    pub image: String,
    /// Creation timestamp
    pub created: i64,
    /// Environment ID label (if set)
    pub environment_id: Option<String>,
    /// Project ID label (if set)
    pub project_id: Option<String>,
    /// Whether this container is assigned to a known environment
    pub is_assigned: bool,
    /// CPU usage percentage (0-100), None if container is not running
    pub cpu_percent: Option<f64>,
}

/// Get Docker system statistics
#[tauri::command]
pub async fn get_docker_system_stats() -> Result<DockerSystemStats, String> {
    let client = docker::client::get_docker_client().map_err(|e| e.to_string())?;

    // Get system info
    let info = client.system_info().await.map_err(|e| e.to_string())?;

    // Get memory usage from all running containers
    let memory_used = client.get_containers_memory_usage().await.unwrap_or(0);

    // Get total CPU usage from all running containers
    let cpu_usage_percent = client.get_total_cpu_usage().await;

    // Get disk usage from `docker system df`
    let df = client.disk_usage().await.map_err(|e| e.to_string())?;

    // Calculate total disk usage correctly:
    // - layers_size is the total unique size of all image layers (deduplicated)
    // - container size_rw is the writable layer size (don't use size_root_fs as it includes image layers)
    // - volume sizes
    // - build cache sizes

    // Start with image layers size (this is the deduplicated total)
    let mut disk_used: u64 = df.layers_size.unwrap_or(0) as u64;

    // Add container writable layer sizes (size_rw only, not size_root_fs which includes image)
    if let Some(containers) = &df.containers {
        for container in containers {
            if let Some(size) = container.size_rw {
                // size_rw can be negative in some cases, only add positive values
                if size > 0 {
                    disk_used += size as u64;
                }
            }
        }
    }

    // Add volume disk usage
    if let Some(volumes) = &df.volumes {
        for volume in volumes {
            if let Some(usage) = &volume.usage_data {
                // usage.size is i64, only add positive values
                if usage.size > 0 {
                    disk_used += usage.size as u64;
                }
            }
        }
    }

    // Add build cache disk usage
    if let Some(caches) = &df.build_cache {
        for cache in caches {
            if let Some(size) = cache.size {
                disk_used += size as u64;
            }
        }
    }

    // Try to get disk_total from Docker.raw file on macOS (Docker Desktop)
    // This file represents the virtual disk allocated to Docker
    let disk_total = get_docker_disk_total().unwrap_or(0);

    Ok(DockerSystemStats {
        memory_used,
        memory_total: info.mem_total.unwrap_or(0) as u64,
        cpus: info.ncpu.unwrap_or(0) as u32,
        cpu_usage_percent,
        disk_used,
        disk_total,
        containers_running: info.containers_running.unwrap_or(0) as u32,
        containers_total: info.containers.unwrap_or(0) as u32,
        images_total: info.images.unwrap_or(0) as u32,
    })
}

/// Get container IDs that are visible in the sidebar (belonging to environments under existing projects).
/// A container is only "assigned" if it belongs to an environment that would be visible in the sidebar.
fn get_visible_container_ids(storage: &crate::storage::Storage) -> Result<std::collections::HashSet<String>, String> {
    let all_projects = storage.load_projects().map_err(|e| e.to_string())?;
    debug!(project_count = all_projects.len(), "Collecting visible container IDs");

    let mut visible_ids: std::collections::HashSet<String> = std::collections::HashSet::new();

    for project in &all_projects {
        let envs = storage.get_environments_by_project(&project.id).map_err(|e| e.to_string())?;
        trace!(project_name = %project.name, env_count = envs.len(), "Project environments");

        for env in &envs {
            trace!(env_name = %env.name, env_id = %env.id, container_id = ?env.container_id, "Environment");
            if let Some(container_id) = &env.container_id {
                visible_ids.insert(container_id.clone());
            }
        }
    }

    debug!(visible_count = visible_ids.len(), "Visible container IDs collected");
    Ok(visible_ids)
}

/// Get all containers using the orkestrator-ai image with assignment status
#[tauri::command]
pub async fn get_orkestrator_containers() -> Result<Vec<ContainerInfo>, String> {
    let client = docker::client::get_docker_client().map_err(|e| e.to_string())?;
    let storage = get_storage().map_err(|e| e.to_string())?;

    // Get container IDs that are visible in the sidebar
    let visible_container_ids = get_visible_container_ids(&storage)?;

    // List all containers with our app label
    let label = format!("{}={}", docker::CONTAINER_LABEL_APP, docker::CONTAINER_LABEL_APP_VALUE);
    let containers = client.list_containers(true, Some(&label)).await.map_err(|e| e.to_string())?;

    let mut result: Vec<ContainerInfo> = Vec::new();

    for c in containers.iter() {
        let id = match c.id.clone() {
            Some(id) => id,
            None => continue,
        };
        let name = match c.names.as_ref().and_then(|n| n.first()) {
            Some(n) => n.trim_start_matches('/').to_string(),
            None => continue,
        };
        let labels = c.labels.clone().unwrap_or_default();

        let environment_id = labels.get(docker::CONTAINER_LABEL_ENV_ID).cloned();
        let project_id = labels.get(docker::CONTAINER_LABEL_PROJECT_ID).cloned();

        // A container is assigned if its ID matches a container_id from a visible environment
        // This ensures consistency with what the sidebar displays
        let is_assigned = visible_container_ids.contains(&id);
        trace!(container_name = %name, container_id = %&id[..12], is_assigned = is_assigned, "Container assignment check");

        let state = c.state.clone().unwrap_or_else(|| "unknown".to_string());

        // Get CPU percentage for running containers
        let cpu_percent = if state == "running" {
            client.get_container_cpu_percent(&id).await
        } else {
            None
        };

        result.push(ContainerInfo {
            id,
            name,
            status: c.status.clone().unwrap_or_else(|| "unknown".to_string()),
            state,
            image: c.image.clone().unwrap_or_else(|| "unknown".to_string()),
            created: c.created.unwrap_or(0),
            environment_id,
            project_id,
            is_assigned,
            cpu_percent,
        });
    }

    Ok(result)
}

/// Remove orphaned containers (those not visible in the sidebar as environments)
#[tauri::command]
pub async fn cleanup_orphaned_containers() -> Result<u32, String> {
    let client = docker::client::get_docker_client().map_err(|e| e.to_string())?;
    let storage = get_storage().map_err(|e| e.to_string())?;

    // Get container IDs that are visible in the sidebar
    let visible_container_ids = get_visible_container_ids(&storage)?;

    // List all containers with our app label
    let label = format!("{}={}", docker::CONTAINER_LABEL_APP, docker::CONTAINER_LABEL_APP_VALUE);
    let containers = client.list_containers(true, Some(&label)).await.map_err(|e| e.to_string())?;

    let mut removed_count = 0;

    for container in containers {
        if let Some(id) = container.id {
            // Container is orphaned if it's not associated with any visible environment
            if !visible_container_ids.contains(&id) {
                // Force remove the container (it might be running)
                if let Err(e) = client.remove_container(&id, true).await {
                    warn!(container_id = %id, error = %e, "Failed to remove orphaned container");
                } else {
                    removed_count += 1;
                    info!(container_id = %id, "Removed orphaned container");
                }
            }
        }
    }

    Ok(removed_count)
}

/// Result of a Docker system prune operation for the UI
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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

/// Perform Docker system prune - removes unused containers, images, networks, and optionally volumes
#[tauri::command]
pub async fn docker_system_prune(prune_volumes: bool) -> Result<SystemPruneResult, String> {
    info!(prune_volumes = prune_volumes, "Starting Docker system prune");

    let client = docker::client::get_docker_client().map_err(|e| e.to_string())?;
    let result = client.system_prune(prune_volumes).await.map_err(|e| e.to_string())?;

    info!(
        containers = result.containers_deleted,
        images = result.images_deleted,
        networks = result.networks_deleted,
        volumes = result.volumes_deleted,
        space_reclaimed = result.space_reclaimed,
        "Docker system prune completed"
    );

    Ok(SystemPruneResult {
        containers_deleted: result.containers_deleted,
        images_deleted: result.images_deleted,
        networks_deleted: result.networks_deleted,
        volumes_deleted: result.volumes_deleted,
        space_reclaimed: result.space_reclaimed,
    })
}

/// Payload for container log events
#[derive(Clone, Serialize)]
pub struct ContainerLogPayload {
    pub container_id: String,
    pub text: String,
}

/// Get container logs (non-streaming, returns last N lines)
#[tauri::command]
pub async fn get_container_logs(container_id: String, tail: Option<String>) -> Result<String, String> {
    debug!(container_id = %container_id, tail = ?tail, "Getting container logs");
    let client = docker::client::get_docker_client().map_err(|e| e.to_string())?;
    client
        .get_container_logs(&container_id, tail.as_deref())
        .await
        .map_err(|e| e.to_string())
}

/// Start streaming container logs to the frontend via events
/// Emits "container-log" events with ContainerLogPayload
#[tauri::command]
pub async fn stream_container_logs(
    app_handle: tauri::AppHandle,
    container_id: String,
) -> Result<(), String> {
    use tauri::Emitter;

    debug!(container_id = %container_id, "Starting container log stream");
    let client = docker::client::get_docker_client().map_err(|e| e.to_string())?;

    let mut rx = client
        .stream_container_logs(&container_id)
        .await
        .map_err(|e| e.to_string())?;

    let cid = container_id.clone();
    // Spawn a task to receive logs and emit events
    tokio::spawn(async move {
        while let Some(text) = rx.recv().await {
            let payload = ContainerLogPayload {
                container_id: cid.clone(),
                text,
            };
            if let Err(e) = app_handle.emit("container-log", payload) {
                warn!(error = %e, "Failed to emit container log event");
                break;
            }
        }
        debug!(container_id = %cid, "Container log stream ended");
    });

    Ok(())
}
