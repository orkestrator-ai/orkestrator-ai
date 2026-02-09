// Custom Docker image building for ejected Dockerfiles
// Handles building, caching, and tagging of project-specific images

use sha2::{Digest, Sha256};
use std::path::Path;
use tauri::Manager;
use tracing::{debug, info};

use super::client::{get_docker_client, DockerError};

/// Generate a unique image tag for a project's custom Dockerfile
/// Format: orkestrator-{project_id_prefix}:v{content_hash_prefix}
///
/// The tag encodes the Dockerfile content hash, so a changed Dockerfile
/// will produce a different tag, triggering a rebuild.
pub fn custom_image_tag(project_id: &str, dockerfile_content: &str) -> String {
    // Use first 8 chars of project ID
    let project_prefix = &project_id[..8.min(project_id.len())];

    // Hash the Dockerfile content
    let mut hasher = Sha256::new();
    hasher.update(dockerfile_content.as_bytes());
    let hash = hasher.finalize();
    let hash_prefix = hex::encode(&hash[..4]); // First 4 bytes = 8 hex chars

    format!("orkestrator-{}:v{}", project_prefix, hash_prefix)
}

/// Check if a custom image with the given tag exists locally
pub async fn image_exists(tag: &str) -> Result<bool, DockerError> {
    let docker = get_docker_client()?;
    docker.image_exists(tag).await
}

/// Build a custom Docker image from a Dockerfile
///
/// # Arguments
/// * `project_path` - Absolute path to the project root (build context)
/// * `dockerfile_rel` - Relative path to Dockerfile from project root (e.g., ".orkestrator/Dockerfile")
/// * `tag` - Tag for the built image
///
/// # Returns
/// Ok(()) on successful build, or DockerError on failure
pub async fn build_custom_image(
    project_path: &Path,
    dockerfile_rel: &str,
    tag: &str,
) -> Result<(), DockerError> {
    let docker = get_docker_client()?;

    let dockerfile_path = project_path.join(dockerfile_rel);
    if !dockerfile_path.exists() {
        return Err(DockerError::OperationFailed(format!(
            "Dockerfile not found at: {}",
            dockerfile_path.display()
        )));
    }

    info!(
        tag = %tag,
        dockerfile = %dockerfile_rel,
        context = %project_path.display(),
        "Building custom Docker image"
    );

    docker
        .build_image(project_path, dockerfile_rel, tag)
        .await?;

    info!(tag = %tag, "Custom Docker image built successfully");
    Ok(())
}

/// Get the image tag to use for a project
///
/// If a custom Dockerfile is configured and exists, returns the custom image tag.
/// Otherwise returns None (caller should use the default base image).
///
/// # Arguments
/// * `project_id` - The project's unique ID
/// * `project_path` - Absolute path to the project root
/// * `dockerfile_rel` - Optional relative path to custom Dockerfile
///
/// # Returns
/// Some(tag) if custom Dockerfile should be used, None for default image
pub async fn get_custom_image_tag(
    project_id: &str,
    project_path: &Path,
    dockerfile_rel: Option<&str>,
) -> Result<Option<String>, DockerError> {
    let dockerfile_rel = match dockerfile_rel {
        Some(path) => path,
        None => return Ok(None),
    };

    let dockerfile_path = project_path.join(dockerfile_rel);
    if !dockerfile_path.exists() {
        debug!(
            dockerfile = %dockerfile_path.display(),
            "Custom Dockerfile not found, using default image"
        );
        return Ok(None);
    }

    // Read Dockerfile content to generate content-based tag
    let content = std::fs::read_to_string(&dockerfile_path).map_err(|e| {
        DockerError::OperationFailed(format!("Failed to read Dockerfile: {}", e))
    })?;

    let tag = custom_image_tag(project_id, &content);
    Ok(Some(tag))
}

/// Ensure a custom image exists, building it if necessary
///
/// # Arguments
/// * `project_id` - The project's unique ID
/// * `project_path` - Absolute path to the project root
/// * `dockerfile_rel` - Relative path to custom Dockerfile
///
/// # Returns
/// The image tag to use (either existing or newly built)
pub async fn ensure_custom_image(
    project_id: &str,
    project_path: &Path,
    dockerfile_rel: &str,
) -> Result<String, DockerError> {
    let dockerfile_path = project_path.join(dockerfile_rel);

    // Read Dockerfile content
    let content = std::fs::read_to_string(&dockerfile_path).map_err(|e| {
        DockerError::OperationFailed(format!("Failed to read Dockerfile: {}", e))
    })?;

    let tag = custom_image_tag(project_id, &content);

    // Check if image already exists
    if image_exists(&tag).await? {
        debug!(tag = %tag, "Custom image already exists, reusing");
        return Ok(tag);
    }

    // Build the image
    build_custom_image(project_path, dockerfile_rel, &tag).await?;

    Ok(tag)
}

/// Ensure the base orkestrator-ai image exists, building it if missing
///
/// # Arguments
/// * `docker_context_path` - Path to the docker/ directory containing Dockerfile and scripts
///
/// # Returns
/// Ok(()) if image exists or was built successfully
pub async fn ensure_base_image(docker_context_path: &Path) -> Result<(), DockerError> {
    let docker = get_docker_client()?;

    if docker.image_exists(super::BASE_IMAGE).await? {
        debug!("Base image {} already exists", super::BASE_IMAGE);
        return Ok(());
    }

    info!(
        image = super::BASE_IMAGE,
        context = %docker_context_path.display(),
        "Base image not found, building automatically"
    );

    if !docker_context_path.join("Dockerfile").exists() {
        return Err(DockerError::OperationFailed(format!(
            "Dockerfile not found in docker context: {}",
            docker_context_path.display()
        )));
    }

    docker
        .build_image(docker_context_path, "Dockerfile", super::BASE_IMAGE)
        .await?;

    info!(image = super::BASE_IMAGE, "Base image built successfully");
    Ok(())
}

/// Resolve the docker build context path for both development and production
///
/// In development: uses CARGO_MANIFEST_DIR to find the docker/ directory
/// In production: uses Tauri bundled resources
pub fn resolve_docker_context_path(app_handle: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    use tracing::warn;

    // In debug mode, prefer development path
    #[cfg(debug_assertions)]
    {
        let manifest_dir = env!("CARGO_MANIFEST_DIR");
        let manifest_path = std::path::PathBuf::from(manifest_dir);
        if let Some(workspace_root) = manifest_path.parent() {
            let docker_path = workspace_root.join("docker");
            if docker_path.join("Dockerfile").exists() {
                debug!(path = %docker_path.display(), "Using dev docker context path");
                return Some(docker_path);
            }
        }
    }

    // Try bundled resource path (production)
    if let Ok(bundled) = app_handle.path().resolve("docker", tauri::path::BaseDirectory::Resource) {
        if bundled.join("Dockerfile").exists() {
            debug!(path = %bundled.display(), "Using bundled docker context path");
            return Some(bundled);
        }
    }

    // Fallback: resource_dir
    if let Ok(res_dir) = app_handle.path().resource_dir() {
        let docker_path = res_dir.join("docker");
        if docker_path.join("Dockerfile").exists() {
            debug!(path = %docker_path.display(), "Using resource_dir docker context path");
            return Some(docker_path);
        }
    }

    warn!("Could not resolve docker context path");
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_custom_image_tag_format() {
        let tag = custom_image_tag("a33f9026-8cfe-4077-aefd-4db2c2637dcc", "FROM node:20\nRUN echo hello");
        // Should be: orkestrator-{8 chars}:v{8 hex chars}
        assert!(tag.starts_with("orkestrator-a33f9026:v"));
        assert_eq!(tag.len(), "orkestrator-a33f9026:v".len() + 8);
    }

    #[test]
    fn test_custom_image_tag_changes_with_content() {
        let tag1 = custom_image_tag("project-id", "FROM node:20");
        let tag2 = custom_image_tag("project-id", "FROM node:22");
        assert_ne!(tag1, tag2, "Different Dockerfile content should produce different tags");
    }

    #[test]
    fn test_custom_image_tag_same_content() {
        let tag1 = custom_image_tag("project-id", "FROM node:20");
        let tag2 = custom_image_tag("project-id", "FROM node:20");
        assert_eq!(tag1, tag2, "Same Dockerfile content should produce same tag");
    }
}
