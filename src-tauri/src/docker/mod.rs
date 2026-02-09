// Docker integration module using Bollard
// Handles container lifecycle, image management, and terminal sessions

pub mod client;
pub mod container;
pub mod image;

pub use client::{get_docker_client, DockerError};
pub use container::*;
