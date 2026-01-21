// File and git operations Tauri commands
// Executes commands inside Docker containers to get file information

use crate::docker::client::get_docker_client;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Cache for git fetch operations to avoid fetching on every status check.
/// Key is (container_id or worktree_path, branch), value is last fetch time.
static FETCH_CACHE: Mutex<Option<HashMap<(String, String), Instant>>> = Mutex::new(None);

/// Time-to-live for fetch cache entries (30 seconds)
const FETCH_CACHE_TTL: Duration = Duration::from_secs(30);

/// Check if we should fetch based on cache TTL
fn should_fetch(key: &(String, String)) -> bool {
    let mut cache_guard = FETCH_CACHE.lock().unwrap();
    let cache = cache_guard.get_or_insert_with(HashMap::new);

    match cache.get(key) {
        Some(last_fetch) => last_fetch.elapsed() >= FETCH_CACHE_TTL,
        None => true,
    }
}

/// Mark that a fetch was performed
fn mark_fetched(key: (String, String)) {
    let mut cache_guard = FETCH_CACHE.lock().unwrap();
    let cache = cache_guard.get_or_insert_with(HashMap::new);
    cache.insert(key, Instant::now());
}

/// Represents a file changed in the git working tree
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileChange {
    /// Full relative path from workspace root
    pub path: String,
    /// Just the filename
    pub filename: String,
    /// Parent directory path
    pub directory: String,
    /// Lines added
    pub additions: u32,
    /// Lines deleted
    pub deletions: u32,
    /// Git status code (M=modified, A=added, D=deleted, ?=untracked)
    pub status: String,
}

/// Represents a node in the file tree
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileNode {
    /// File or directory name
    pub name: String,
    /// Full path relative to workspace root
    pub path: String,
    /// Whether this node is a directory
    pub is_directory: bool,
    /// Child nodes (only for directories)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<FileNode>>,
    /// File extension (for file type icons)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extension: Option<String>,
}

/// File content with metadata for the viewer
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    /// Relative file path
    pub path: String,
    /// File content as string
    pub content: String,
    /// Monaco editor language ID
    pub language: String,
}

/// Parse git status porcelain output into file changes
fn parse_git_status(output: &str) -> Vec<(String, String)> {
    output
        .lines()
        .filter_map(|line| {
            // Porcelain format: XY PATH where XY are 2 status chars, then a space, then path
            // Minimum valid line is 4 chars: "XY P" (status, space, at least one char path)
            if line.len() < 4 {
                return None;
            }
            let index_status = &line[0..1];
            let worktree_status = &line[1..2];
            // Use get() to safely access the path portion after "XY "
            let path = match line.get(3..) {
                Some(p) => p.trim().to_string(),
                None => return None,
            };

            // Determine status - prefer worktree status over index
            let status = if worktree_status != " " && worktree_status != "?" {
                worktree_status.to_string()
            } else if index_status != " " {
                index_status.to_string()
            } else {
                "?".to_string()
            };

            Some((path, status))
        })
        .collect()
}

/// Parse git diff --name-status output into file changes
/// Format: "M\tpath/to/file" or "A\tpath/to/file" etc.
fn parse_diff_name_status(output: &str) -> Vec<(String, String)> {
    output
        .lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.split('\t').collect();
            if parts.len() < 2 {
                return None;
            }
            let status = parts[0].trim().to_string();
            let path = parts[1].trim().to_string();
            if path.is_empty() {
                return None;
            }
            Some((path, status))
        })
        .collect()
}

/// Parse git diff numstat output into additions/deletions map
fn parse_numstat(output: &str) -> HashMap<String, (u32, u32)> {
    output
        .lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.split('\t').collect();
            if parts.len() != 3 {
                return None;
            }

            // Handle binary files which show as "-"
            let additions = parts[0].parse().unwrap_or(0);
            let deletions = parts[1].parse().unwrap_or(0);
            let path = parts[2].to_string();

            Some((path, (additions, deletions)))
        })
        .collect()
}

/// Detect Monaco editor language from file extension
fn detect_language(file_path: &str) -> String {
    let extension = std::path::Path::new(file_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    match extension.as_str() {
        // TypeScript
        "ts" | "tsx" | "mts" | "cts" => "typescript",
        // JavaScript
        "js" | "jsx" | "mjs" | "cjs" => "javascript",
        // Systems languages
        "rs" => "rust",
        "go" => "go",
        "c" | "h" => "c",
        "cpp" | "hpp" | "cc" | "cxx" | "hxx" => "cpp",
        // JVM languages
        "java" => "java",
        "kt" | "kts" => "kotlin",
        "scala" | "sc" => "scala",
        "groovy" | "gradle" => "groovy",
        // Scripting languages
        "py" | "pyw" | "pyi" => "python",
        "rb" | "erb" | "rake" => "ruby",
        "php" | "phtml" => "php",
        "pl" | "pm" => "perl",
        "lua" => "lua",
        // Shell
        "sh" | "bash" | "zsh" | "fish" => "shell",
        "ps1" | "psm1" | "psd1" => "powershell",
        // Web
        "html" | "htm" => "html",
        "css" => "css",
        "scss" | "sass" => "scss",
        "less" => "less",
        "vue" => "vue",
        "svelte" => "svelte",
        "astro" => "astro",
        // Data formats
        "json" | "jsonc" => "json",
        "yaml" | "yml" => "yaml",
        "toml" => "toml",
        "xml" | "xsl" | "xslt" => "xml",
        "csv" => "plaintext",
        // Database
        "sql" | "mysql" | "pgsql" => "sql",
        "prisma" => "prisma",
        // Documentation
        "md" | "mdx" | "markdown" => "markdown",
        "rst" => "restructuredtext",
        "tex" | "latex" => "latex",
        // Config files
        "ini" | "cfg" | "conf" => "ini",
        "env" => "plaintext",
        "dockerfile" => "dockerfile",
        "makefile" => "makefile",
        // Infrastructure
        "tf" | "tfvars" => "hcl",
        "hcl" => "hcl",
        // GraphQL
        "graphql" | "gql" => "graphql",
        // Mobile
        "swift" => "swift",
        "m" | "mm" => "objective-c",
        "dart" => "dart",
        // Other
        "r" => "r",
        "clj" | "cljs" | "cljc" => "clojure",
        "ex" | "exs" => "elixir",
        "erl" | "hrl" => "erlang",
        "fs" | "fsx" | "fsi" => "fsharp",
        "cs" => "csharp",
        "vb" => "vb",
        "zig" => "zig",
        "nim" => "nim",
        "v" => "v",
        _ => "plaintext",
    }
    .to_string()
}

/// Split a path into directory and filename
fn split_path(path: &str) -> (String, String) {
    if let Some(pos) = path.rfind('/') {
        (path[..pos].to_string(), path[pos + 1..].to_string())
    } else {
        (String::new(), path.to_string())
    }
}

/// Build a tree structure from a list of file paths
fn build_file_tree(file_paths: Vec<String>) -> Vec<FileNode> {
    let mut root: HashMap<String, FileNode> = HashMap::new();

    for path in file_paths {
        let parts: Vec<&str> = path.split('/').collect();
        insert_path_into_tree(&mut root, &parts, &path, 0);
    }

    // Convert to sorted vector
    let mut nodes: Vec<FileNode> = root.into_values().collect();
    sort_file_nodes(&mut nodes);
    nodes
}

/// Recursively insert a path into the tree structure
fn insert_path_into_tree(
    tree: &mut HashMap<String, FileNode>,
    parts: &[&str],
    full_path: &str,
    depth: usize,
) {
    if parts.is_empty() {
        return;
    }

    let name = parts[0].to_string();
    let is_last = parts.len() == 1;

    // Calculate path up to current depth
    let path_parts: Vec<&str> = full_path.split('/').take(depth + 1).collect();
    let node_path = path_parts.join("/");

    if is_last {
        // This is a file
        let extension = std::path::Path::new(&name)
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_string());

        tree.entry(name.clone()).or_insert(FileNode {
            name,
            path: node_path,
            is_directory: false,
            children: None,
            extension,
        });
    } else {
        // This is a directory
        let node = tree.entry(name.clone()).or_insert(FileNode {
            name,
            path: node_path,
            is_directory: true,
            children: Some(Vec::new()),
            extension: None,
        });

        // Recursively insert remaining parts
        if let Some(children) = &mut node.children {
            let mut child_map: HashMap<String, FileNode> = children
                .drain(..)
                .map(|n| (n.name.clone(), n))
                .collect();
            insert_path_into_tree(&mut child_map, &parts[1..], full_path, depth + 1);
            *children = child_map.into_values().collect();
            sort_file_nodes(children);
        }
    }
}

/// Sort file nodes: directories first, then alphabetically
fn sort_file_nodes(nodes: &mut [FileNode]) {
    nodes.sort_by(|a, b| {
        match (a.is_directory, b.is_directory) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });

    // Recursively sort children
    for node in nodes.iter_mut() {
        if let Some(children) = &mut node.children {
            sort_file_nodes(children);
        }
    }
}

/// Get git changes comparing current state against a target branch
/// Shows all changes since the branch diverged from target_branch, plus uncommitted changes
#[tauri::command]
pub async fn get_git_status(
    container_id: String,
    target_branch: String,
) -> Result<Vec<GitFileChange>, String> {
    use tracing::{debug, warn};

    let client = get_docker_client().map_err(|e| e.to_string())?;

    // Check if container is running
    let is_running = client
        .is_container_running(&container_id)
        .await
        .map_err(|e| e.to_string())?;

    if !is_running {
        return Err("Container is not running".to_string());
    }

    // Fetch latest from origin to ensure remote refs are up to date (with caching)
    // Only fetch if more than FETCH_CACHE_TTL has passed since last fetch
    let fetch_key = (container_id.clone(), target_branch.clone());
    if should_fetch(&fetch_key) {
        debug!(target_branch = %target_branch, "Fetching from origin (cache expired or first fetch)");

        // Use timeout to prevent hanging on network issues (10 seconds)
        let fetch_future = client.exec_command(
            &container_id,
            vec!["git", "-C", "/workspace", "fetch", "origin", &target_branch],
        );

        match tokio::time::timeout(Duration::from_secs(10), fetch_future).await {
            Ok(Ok(output)) => {
                // Check for error indicators in output (exec_command doesn't check exit codes)
                if output.contains("fatal:") || output.contains("error:") {
                    warn!(target_branch = %target_branch, output = %output, "git fetch origin returned errors (continuing with local refs)");
                } else {
                    mark_fetched(fetch_key);
                }
            }
            Ok(Err(e)) => {
                warn!(target_branch = %target_branch, error = %e, "git fetch origin failed (continuing with local refs)");
            }
            Err(_) => {
                warn!(target_branch = %target_branch, "git fetch origin timed out after 10s (continuing with local refs)");
            }
        }
    } else {
        debug!(target_branch = %target_branch, "Skipping fetch (cache still valid)");
    }

    // Use a HashMap to collect all changes, keyed by path
    // This allows us to merge branch changes with uncommitted changes
    let mut all_changes: HashMap<String, (String, u32, u32)> = HashMap::new();

    // 1. Get files changed between origin/target_branch and HEAD (committed changes on this branch)
    //    Using origin/target_branch...HEAD to compare against the remote default branch
    //    This ensures we always compare against the remote state, not local (potentially stale) refs
    let branch_diff_ref = format!("origin/{}...HEAD", target_branch);

    let branch_name_status = client
        .exec_command(
            &container_id,
            vec!["git", "-C", "/workspace", "diff", "--name-status", &branch_diff_ref],
        )
        .await
        .unwrap_or_default();

    let branch_numstat = client
        .exec_command(
            &container_id,
            vec!["git", "-C", "/workspace", "diff", "--numstat", &branch_diff_ref],
        )
        .await
        .unwrap_or_default();

    debug!(target_branch = %target_branch, "Branch diff output: {} files", branch_name_status.lines().count());

    let branch_files = parse_diff_name_status(&branch_name_status);
    let branch_stats = parse_numstat(&branch_numstat);

    // Add branch changes to our map
    for (path, status) in branch_files {
        if path.contains('\0') || path.contains('\n') || path.contains('\r') || path.contains("..") {
            continue;
        }
        let (additions, deletions) = branch_stats.get(&path).copied().unwrap_or((0, 0));
        all_changes.insert(path, (status, additions, deletions));
    }

    // 2. Get uncommitted changes (working tree + staged)
    //    Using git status to catch untracked files too
    let status_output = client
        .exec_command(&container_id, vec!["git", "-C", "/workspace", "status", "--porcelain", "-uall"])
        .await
        .unwrap_or_default();

    let unstaged_numstat = client
        .exec_command(&container_id, vec!["git", "-C", "/workspace", "diff", "--numstat"])
        .await
        .unwrap_or_default();

    let staged_numstat = client
        .exec_command(&container_id, vec!["git", "-C", "/workspace", "diff", "--cached", "--numstat"])
        .await
        .unwrap_or_default();

    let uncommitted_files = parse_git_status(&status_output);
    let unstaged_stats = parse_numstat(&unstaged_numstat);
    let staged_stats = parse_numstat(&staged_numstat);

    // Merge uncommitted changes into our map (overwrites if already present from branch diff)
    for (path, status) in uncommitted_files {
        if path.contains('\0') || path.contains('\n') || path.contains('\r') || path.contains("..") {
            continue;
        }

        let (additions, deletions) = if status == "?" {
            // Untracked file - count lines with wc -l
            let full_path = format!("/workspace/{}", path);
            let line_count = client
                .exec_command(&container_id, vec!["wc", "-l", &full_path])
                .await
                .ok()
                .and_then(|output| {
                    output.split_whitespace().next()?.parse::<u32>().ok()
                })
                .unwrap_or(0);
            (line_count, 0u32)
        } else {
            // Get stats from unstaged or staged diff
            unstaged_stats
                .get(&path)
                .or_else(|| staged_stats.get(&path))
                .copied()
                .unwrap_or((0, 0))
        };

        // For uncommitted changes, we may need to combine with branch stats
        // If file was already modified in branch commits AND has more uncommitted changes
        if let Some(existing) = all_changes.get(&path) {
            // File exists in branch diff - combine stats to reflect total changes vs target branch
            // Branch diff shows merge-base..HEAD, uncommitted shows HEAD..working tree
            // These are additive for the same file
            let total_additions = additions.saturating_add(existing.1);
            let total_deletions = deletions.saturating_add(existing.2);
            all_changes.insert(path, (status, total_additions, total_deletions));
        } else {
            // New uncommitted change not in branch diff
            all_changes.insert(path, (status, additions, deletions));
        }
    }

    // 3. Build final changes vector
    let mut changes: Vec<GitFileChange> = Vec::new();

    for (path, (status, additions, deletions)) in all_changes {
        let (directory, filename) = split_path(&path);

        changes.push(GitFileChange {
            path,
            filename,
            directory,
            additions,
            deletions,
            status,
        });
    }

    // Sort by path for consistent ordering
    changes.sort_by(|a, b| a.path.cmp(&b.path));

    Ok(changes)
}

/// Get workspace file tree from a container
#[tauri::command]
pub async fn get_file_tree(container_id: String) -> Result<Vec<FileNode>, String> {
    let client = get_docker_client().map_err(|e| e.to_string())?;

    // Check if container is running
    let is_running = client
        .is_container_running(&container_id)
        .await
        .map_err(|e| e.to_string())?;

    if !is_running {
        return Err("Container is not running".to_string());
    }

    // List files excluding common directories
    let output = client
        .exec_command(
            &container_id,
            vec![
                "find",
                "/workspace",
                "-type", "f",
                "-not", "-path", "*/.git/*",
                "-not", "-path", "*/node_modules/*",
                "-not", "-path", "*/__pycache__/*",
                "-not", "-path", "*/.next/*",
                "-not", "-path", "*/dist/*",
                "-not", "-path", "*/build/*",
                "-not", "-path", "*/.cache/*",
                "-not", "-path", "*/target/*",
            ],
        )
        .await
        .map_err(|e| e.to_string())?;

    // Parse file paths (remove /workspace/ prefix)
    let file_paths: Vec<String> = output
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                return None;
            }
            // Remove /workspace/ prefix
            trimmed.strip_prefix("/workspace/").map(|s| s.to_string())
        })
        .collect();

    // Build tree structure
    let tree = build_file_tree(file_paths);

    Ok(tree)
}

/// Validate that a file path is safe for use in container commands.
/// Returns the sanitized path if valid, or an error if the path is invalid.
fn validate_file_path(file_path: &str) -> Result<String, String> {
    // Reject empty paths
    if file_path.is_empty() {
        return Err("Empty file path".to_string());
    }

    // Reject paths with null bytes (could truncate strings in C APIs)
    if file_path.contains('\0') {
        return Err("Invalid file path: contains null byte".to_string());
    }

    // Reject newlines (could allow command injection in some contexts)
    if file_path.contains('\n') || file_path.contains('\r') {
        return Err("Invalid file path: contains newline".to_string());
    }

    // Use std::path for proper path normalization and traversal detection
    let path = std::path::Path::new(file_path);

    // Check each component for traversal attempts
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                return Err("Invalid file path: parent directory traversal not allowed".to_string());
            }
            std::path::Component::Normal(s) => {
                // Check for hidden traversal patterns that might bypass simple checks
                let s_str = s.to_string_lossy();
                if s_str.starts_with("..") || s_str.ends_with("..") {
                    return Err("Invalid file path: suspicious path component".to_string());
                }
            }
            _ => {}
        }
    }

    // Build the full path - always relative to /workspace for safety
    let full_path = if file_path.starts_with('/') {
        // If absolute path given, verify it's under /workspace
        if !file_path.starts_with("/workspace/") && file_path != "/workspace" {
            return Err("Invalid file path: must be under /workspace".to_string());
        }
        file_path.to_string()
    } else {
        format!("/workspace/{}", file_path)
    };

    // Final check: ensure the normalized path is still under /workspace
    // This catches edge cases like "/workspace/../etc/passwd"
    let normalized = std::path::Path::new(&full_path);
    let mut depth = 0i32;
    for component in normalized.components() {
        match component {
            std::path::Component::ParentDir => depth -= 1,
            std::path::Component::Normal(_) => depth += 1,
            _ => {}
        }
        // If we ever go negative after /workspace, we've escaped
        if depth < 0 {
            return Err("Invalid file path: escapes workspace directory".to_string());
        }
    }

    Ok(full_path)
}

/// Read a file from inside a container
#[tauri::command]
pub async fn read_container_file(
    container_id: String,
    file_path: String,
) -> Result<FileContent, String> {
    let client = get_docker_client().map_err(|e| e.to_string())?;

    // Check if container is running
    let is_running = client
        .is_container_running(&container_id)
        .await
        .map_err(|e| e.to_string())?;

    if !is_running {
        return Err("Container is not running".to_string());
    }

    // Validate and sanitize the path
    let full_path = validate_file_path(&file_path)?;

    // Read file content
    let content = client
        .exec_command(&container_id, vec!["cat", &full_path])
        .await
        .map_err(|e| format!("Failed to read file: {}", e))?;

    // Detect language
    let language = detect_language(&file_path);

    Ok(FileContent {
        path: file_path,
        content,
        language,
    })
}

/// Read a file from the remote version of a branch inside a container.
/// Uses `origin/<branch>` to ensure comparison against remote state.
///
/// Note: This function does NOT fetch from origin. It relies on a recent fetch
/// having been performed by `get_git_status()` (which caches fetches for 30 seconds).
/// This is intentional to avoid redundant network calls when viewing diffs.
///
/// Returns None if the file doesn't exist in the specified branch (e.g., new file)
#[tauri::command]
pub async fn read_file_at_branch(
    container_id: String,
    file_path: String,
    branch: String,
) -> Result<Option<FileContent>, String> {
    let client = get_docker_client().map_err(|e| e.to_string())?;

    // Check if container is running
    let is_running = client
        .is_container_running(&container_id)
        .await
        .map_err(|e| e.to_string())?;

    if !is_running {
        return Err("Container is not running".to_string());
    }

    // Validate the file path (basic check, no full sanitization needed since we're using git show)
    if file_path.contains('\0') || file_path.contains('\n') || file_path.contains('\r') {
        return Err("Invalid file path".to_string());
    }

    // Validate the branch name to prevent injection attacks
    // Git ref names cannot contain: space, ~, ^, :, ?, *, [, \, control chars
    // Also reject shell metacharacters for defense in depth
    if branch.is_empty()
        || branch.contains('\0')
        || branch.contains('\n')
        || branch.contains('\r')
        || branch.contains(' ')
        || branch.contains('~')
        || branch.contains('^')
        || branch.contains(':')
        || branch.contains('?')
        || branch.contains('*')
        || branch.contains('[')
        || branch.contains('\\')
        || branch.contains(';')
        || branch.contains('&')
        || branch.contains('|')
        || branch.contains('$')
        || branch.contains('`')
        || branch.starts_with('-')
    {
        return Err("Invalid branch name".to_string());
    }

    // Normalize the path - remove /workspace/ prefix if present
    let relative_path = if file_path.starts_with("/workspace/") {
        file_path.strip_prefix("/workspace/").unwrap_or(&file_path)
    } else {
        &file_path
    };

    // Use git show to read file content from the remote branch
    // Format: git show origin/<branch>:<path>
    // Using origin/ prefix ensures we compare against remote state, not local refs
    let git_ref = format!("origin/{}:{}", branch, relative_path);

    let result = client
        .exec_command(
            &container_id,
            vec!["git", "-C", "/workspace", "show", &git_ref],
        )
        .await;

    match result {
        Ok(content) => {
            // Check if git returned an error message (file doesn't exist in branch)
            // git show returns non-zero exit code for missing files, which exec_command converts to Err
            let language = detect_language(&file_path);
            Ok(Some(FileContent {
                path: file_path,
                content,
                language,
            }))
        }
        Err(_) => {
            // File doesn't exist in the target branch (new file)
            Ok(None)
        }
    }
}

/// Maximum file size for binary file reads (10MB)
const MAX_BINARY_FILE_SIZE: u64 = 10 * 1024 * 1024;

/// Read a binary file from inside a container as base64
/// Used for images and other binary content that can't be displayed as text
#[tauri::command]
pub async fn read_container_file_base64(
    container_id: String,
    file_path: String,
) -> Result<String, String> {
    let client = get_docker_client().map_err(|e| e.to_string())?;

    // Check if container is running
    let is_running = client
        .is_container_running(&container_id)
        .await
        .map_err(|e| e.to_string())?;

    if !is_running {
        return Err("Container is not running".to_string());
    }

    // Validate and sanitize the path
    let full_path = validate_file_path(&file_path)?;

    // Check file size before reading to prevent memory issues
    let size_output = client
        .exec_command(&container_id, vec!["stat", "-c", "%s", &full_path])
        .await
        .map_err(|e| format!("Failed to get file size: {}", e))?;

    let file_size: u64 = size_output
        .trim()
        .parse()
        .map_err(|_| "Failed to parse file size")?;

    if file_size > MAX_BINARY_FILE_SIZE {
        return Err(format!(
            "File too large: {} bytes (max {} bytes)",
            file_size, MAX_BINARY_FILE_SIZE
        ));
    }

    // Read file and encode as base64 directly in the container
    // Use sh -c with pipe to tr for portability (works on both GNU coreutils and busybox)
    let base64_content = client
        .exec_command(
            &container_id,
            vec!["sh", "-c", &format!("base64 '{}' | tr -d '\\n'", full_path)],
        )
        .await
        .map_err(|e| format!("Failed to read file: {}", e))?;

    Ok(base64_content.trim().to_string())
}

// ============================================================================
// LOCAL ENVIRONMENT FILE COMMANDS
// These commands operate directly on the local filesystem for worktree-based
// environments, without requiring Docker
// ============================================================================

/// Get git changes for a local environment (worktree path)
/// Shows all changes since the branch diverged from target_branch, plus uncommitted changes
#[tauri::command]
pub async fn get_local_git_status(
    worktree_path: String,
    target_branch: String,
) -> Result<Vec<GitFileChange>, String> {
    use std::process::Command;
    use tracing::{debug, warn};

    // Validate the worktree path exists
    let path = std::path::Path::new(&worktree_path);
    if !path.exists() {
        return Err(format!("Worktree path does not exist: {}", worktree_path));
    }
    if !path.is_dir() {
        return Err(format!("Worktree path is not a directory: {}", worktree_path));
    }

    // Use a HashMap to collect all changes, keyed by path
    let mut all_changes: HashMap<String, (String, u32, u32)> = HashMap::new();

    // Fetch latest from origin to ensure remote refs are up to date (with caching)
    // Only fetch if more than FETCH_CACHE_TTL has passed since last fetch
    let fetch_key = (worktree_path.clone(), target_branch.clone());
    if should_fetch(&fetch_key) {
        debug!(target_branch = %target_branch, "Fetching from origin (cache expired or first fetch)");

        // Spawn fetch with timeout to prevent hanging on network issues
        let worktree_for_fetch = worktree_path.clone();
        let branch_for_fetch = target_branch.clone();
        let fetch_task = tokio::task::spawn_blocking(move || {
            Command::new("git")
                .args(["-C", &worktree_for_fetch, "fetch", "origin", &branch_for_fetch])
                .output()
        });

        match tokio::time::timeout(Duration::from_secs(10), fetch_task).await {
            Ok(Ok(Ok(result))) => {
                if !result.status.success() {
                    let stderr = String::from_utf8_lossy(&result.stderr);
                    warn!(target_branch = %target_branch, stderr = %stderr, "git fetch origin failed (continuing with local refs)");
                } else {
                    mark_fetched(fetch_key);
                }
            }
            Ok(Ok(Err(e))) => {
                warn!(target_branch = %target_branch, error = %e, "git fetch command failed to execute (continuing with local refs)");
            }
            Ok(Err(e)) => {
                warn!(target_branch = %target_branch, error = %e, "git fetch task panicked (continuing with local refs)");
            }
            Err(_) => {
                warn!(target_branch = %target_branch, "git fetch origin timed out after 10s (continuing with local refs)");
            }
        }
    } else {
        debug!(target_branch = %target_branch, "Skipping fetch (cache still valid)");
    }

    // 1. Get files changed between origin/target_branch and HEAD (committed changes on this branch)
    //    Using origin/target_branch...HEAD to compare against the remote default branch
    let branch_diff_ref = format!("origin/{}...HEAD", target_branch);

    let branch_name_status = Command::new("git")
        .args(["-C", &worktree_path, "diff", "--name-status", &branch_diff_ref])
        .output()
        .map(|o| {
            if !o.status.success() {
                let stderr = String::from_utf8_lossy(&o.stderr);
                debug!(stderr = %stderr, "git diff --name-status failed for branch comparison");
            }
            String::from_utf8_lossy(&o.stdout).to_string()
        })
        .unwrap_or_default();

    let branch_numstat = Command::new("git")
        .args(["-C", &worktree_path, "diff", "--numstat", &branch_diff_ref])
        .output()
        .map(|o| {
            if !o.status.success() {
                let stderr = String::from_utf8_lossy(&o.stderr);
                debug!(stderr = %stderr, "git diff --numstat failed for branch comparison");
            }
            String::from_utf8_lossy(&o.stdout).to_string()
        })
        .unwrap_or_default();

    debug!(target_branch = %target_branch, "Local branch diff output: {} files", branch_name_status.lines().count());

    let branch_files = parse_diff_name_status(&branch_name_status);
    let branch_stats = parse_numstat(&branch_numstat);

    // Add branch changes to our map
    for (path, status) in branch_files {
        if path.contains('\0') || path.contains('\n') || path.contains('\r') || path.contains("..") {
            continue;
        }
        let (additions, deletions) = branch_stats.get(&path).copied().unwrap_or((0, 0));
        all_changes.insert(path, (status, additions, deletions));
    }

    // 2. Get uncommitted changes (working tree + staged)
    let status_output = Command::new("git")
        .args(["-C", &worktree_path, "status", "--porcelain", "-uall"])
        .output()
        .map(|o| {
            if !o.status.success() {
                let stderr = String::from_utf8_lossy(&o.stderr);
                debug!(stderr = %stderr, "git status failed");
            }
            String::from_utf8_lossy(&o.stdout).to_string()
        })
        .unwrap_or_default();

    let unstaged_numstat = Command::new("git")
        .args(["-C", &worktree_path, "diff", "--numstat"])
        .output()
        .map(|o| {
            if !o.status.success() {
                let stderr = String::from_utf8_lossy(&o.stderr);
                debug!(stderr = %stderr, "git diff --numstat (unstaged) failed");
            }
            String::from_utf8_lossy(&o.stdout).to_string()
        })
        .unwrap_or_default();

    let staged_numstat = Command::new("git")
        .args(["-C", &worktree_path, "diff", "--cached", "--numstat"])
        .output()
        .map(|o| {
            if !o.status.success() {
                let stderr = String::from_utf8_lossy(&o.stderr);
                debug!(stderr = %stderr, "git diff --cached --numstat (staged) failed");
            }
            String::from_utf8_lossy(&o.stdout).to_string()
        })
        .unwrap_or_default();

    let uncommitted_files = parse_git_status(&status_output);
    let unstaged_stats = parse_numstat(&unstaged_numstat);
    let staged_stats = parse_numstat(&staged_numstat);

    // Merge uncommitted changes into our map
    for (file_path, status) in uncommitted_files {
        if file_path.contains('\0') || file_path.contains('\n') || file_path.contains('\r') || file_path.contains("..") {
            continue;
        }

        let (additions, deletions) = if status == "?" {
            // Untracked file - count lines with wc -l
            let full_path = std::path::Path::new(&worktree_path).join(&file_path);
            let line_count = std::fs::read_to_string(&full_path)
                .map(|content| content.lines().count() as u32)
                .unwrap_or(0);
            (line_count, 0u32)
        } else {
            // Get stats from unstaged or staged diff
            unstaged_stats
                .get(&file_path)
                .or_else(|| staged_stats.get(&file_path))
                .copied()
                .unwrap_or((0, 0))
        };

        // For uncommitted changes, take the max of uncommitted vs branch stats
        // to avoid double-counting lines that were modified in both commits and working tree
        if let Some(existing) = all_changes.get(&file_path) {
            let total_additions = additions.max(existing.1);
            let total_deletions = deletions.max(existing.2);
            all_changes.insert(file_path, (status, total_additions, total_deletions));
        } else {
            all_changes.insert(file_path, (status, additions, deletions));
        }
    }

    // 3. Build final changes vector
    let mut changes: Vec<GitFileChange> = Vec::new();

    for (path, (status, additions, deletions)) in all_changes {
        let (directory, filename) = split_path(&path);

        changes.push(GitFileChange {
            path,
            filename,
            directory,
            additions,
            deletions,
            status,
        });
    }

    // Sort by path for consistent ordering
    changes.sort_by(|a, b| a.path.cmp(&b.path));

    Ok(changes)
}

/// Get file tree from a local environment (worktree path)
#[tauri::command]
pub async fn get_local_file_tree(worktree_path: String) -> Result<Vec<FileNode>, String> {
    use std::process::Command;

    // Validate the worktree path exists
    let path = std::path::Path::new(&worktree_path);
    if !path.exists() {
        return Err(format!("Worktree path does not exist: {}", worktree_path));
    }
    if !path.is_dir() {
        return Err(format!("Worktree path is not a directory: {}", worktree_path));
    }

    // Use find command to list files, excluding common directories
    let output = Command::new("find")
        .args([
            &worktree_path,
            "-type", "f",
            "-not", "-path", "*/.git/*",
            "-not", "-path", "*/node_modules/*",
            "-not", "-path", "*/__pycache__/*",
            "-not", "-path", "*/.next/*",
            "-not", "-path", "*/dist/*",
            "-not", "-path", "*/build/*",
            "-not", "-path", "*/.cache/*",
            "-not", "-path", "*/target/*",
            "-not", "-path", "*/.turbo/*",
            "-not", "-path", "*/.venv/*",
            "-not", "-path", "*/venv/*",
            "-not", "-path", "*/coverage/*",
            "-not", "-path", "*/.nyc_output/*",
            "-not", "-path", "*/*.egg-info/*",
        ])
        .output()
        .map_err(|e| format!("Failed to run find command: {}", e))?;

    let output_str = String::from_utf8_lossy(&output.stdout);

    // Parse file paths (remove worktree_path prefix)
    let prefix = format!("{}/", worktree_path.trim_end_matches('/'));
    let file_paths: Vec<String> = output_str
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                return None;
            }
            trimmed.strip_prefix(&prefix).map(|s| s.to_string())
        })
        .collect();

    // Build tree structure
    let tree = build_file_tree(file_paths);

    Ok(tree)
}

/// Read a file from a local environment (worktree path)
#[tauri::command]
pub async fn read_local_file(
    worktree_path: String,
    file_path: String,
) -> Result<FileContent, String> {
    // Validate the worktree path exists
    let base_path = std::path::Path::new(&worktree_path);
    if !base_path.exists() {
        return Err(format!("Worktree path does not exist: {}", worktree_path));
    }

    // Build full path and validate it's within worktree
    let full_path = if file_path.starts_with('/') {
        std::path::PathBuf::from(&file_path)
    } else {
        base_path.join(&file_path)
    };

    // Security check: ensure the resolved path is within the worktree
    let canonical_base = base_path.canonicalize()
        .map_err(|e| format!("Failed to resolve worktree path: {}", e))?;
    let canonical_file = full_path.canonicalize()
        .map_err(|e| format!("Failed to resolve file path: {}", e))?;

    if !canonical_file.starts_with(&canonical_base) {
        return Err("Invalid file path: escapes worktree directory".to_string());
    }

    // Read file content
    let content = std::fs::read_to_string(&canonical_file)
        .map_err(|e| format!("Failed to read file: {}", e))?;

    // Detect language
    let language = detect_language(&file_path);

    Ok(FileContent {
        path: file_path,
        content,
        language,
    })
}

/// Read a binary file from an absolute path as base64
/// Used for reading attachment images that are stored in .orkestrator/clipboard/
/// or within workspace directories.
///
/// For security, paths are validated to ensure they are within allowed directories:
/// - .orkestrator/ directories (for clipboard attachments)
/// - workspaces/ directories (for worktree files)
#[tauri::command]
pub async fn read_file_base64(
    file_path: String,
) -> Result<String, String> {
    use base64::Engine;

    let path = std::path::Path::new(&file_path);

    // Validate path doesn't contain dangerous characters
    if file_path.contains('\0') || file_path.contains('\n') || file_path.contains('\r') {
        return Err("Invalid file path: contains invalid characters".to_string());
    }

    // Check for path traversal attempts before canonicalization
    // This catches obvious attempts like "../../../etc/passwd"
    for component in path.components() {
        if let std::path::Component::ParentDir = component {
            return Err("Invalid file path: parent directory traversal not allowed".to_string());
        }
    }

    // Validate file exists
    if !path.exists() {
        return Err(format!("File does not exist: {}", file_path));
    }

    if !path.is_file() {
        return Err(format!("Path is not a file: {}", file_path));
    }

    // Canonicalize path to resolve symlinks and get absolute path
    let canonical_path = path.canonicalize()
        .map_err(|e| format!("Failed to resolve file path: {}", e))?;
    let canonical_str = canonical_path.to_string_lossy();

    // Validate path is within allowed directories
    // Allowed: .orkestrator/ directories (clipboard attachments) or workspaces/ directories (worktree files)
    let is_orkestrator_dir = canonical_str.contains("/.orkestrator/");
    let is_workspace_dir = canonical_str.contains("/workspaces/");

    if !is_orkestrator_dir && !is_workspace_dir {
        return Err("Invalid file path: must be within .orkestrator/ or workspaces/ directory".to_string());
    }

    // Size limit: 10MB for binary files
    const MAX_FILE_SIZE: u64 = 10 * 1024 * 1024;

    let metadata = std::fs::metadata(&canonical_path)
        .map_err(|e| format!("Failed to read file metadata: {}", e))?;

    if metadata.len() > MAX_FILE_SIZE {
        return Err(format!(
            "File too large (max 10MB, got {}MB)",
            metadata.len() / 1024 / 1024
        ));
    }

    // Read file bytes
    let bytes = std::fs::read(&canonical_path)
        .map_err(|e| format!("Failed to read file: {}", e))?;

    // Encode as base64
    let base64_content = base64::engine::general_purpose::STANDARD.encode(&bytes);

    Ok(base64_content)
}

/// Read a file from the remote version of a branch in a local environment.
/// Uses `origin/<branch>` to ensure comparison against remote state.
///
/// Note: This function does NOT fetch from origin. It relies on a recent fetch
/// having been performed by `get_local_git_status()` (which caches fetches for 30 seconds).
/// This is intentional to avoid redundant network calls when viewing diffs.
///
/// Returns None if the file doesn't exist in the specified branch (e.g., new file)
#[tauri::command]
pub async fn read_local_file_at_branch(
    worktree_path: String,
    file_path: String,
    branch: String,
) -> Result<Option<FileContent>, String> {
    use std::process::Command;
    use tracing::debug;

    // Validate the worktree path exists
    let path = std::path::Path::new(&worktree_path);
    if !path.exists() {
        return Err(format!("Worktree path does not exist: {}", worktree_path));
    }

    // Validate the file path
    if file_path.contains('\0') || file_path.contains('\n') || file_path.contains('\r') {
        return Err("Invalid file path".to_string());
    }

    // Validate the branch name to prevent injection attacks
    if branch.is_empty()
        || branch.contains('\0')
        || branch.contains('\n')
        || branch.contains('\r')
        || branch.contains(' ')
        || branch.contains('~')
        || branch.contains('^')
        || branch.contains(':')
        || branch.contains('?')
        || branch.contains('*')
        || branch.contains('[')
        || branch.contains('\\')
        || branch.contains(';')
        || branch.contains('&')
        || branch.contains('|')
        || branch.contains('$')
        || branch.contains('`')
        || branch.starts_with('-')
    {
        return Err("Invalid branch name".to_string());
    }

    // Normalize the path - remove leading slashes for git show
    let relative_path = file_path.trim_start_matches('/');

    // Use git show to read file content from the remote branch
    // Using origin/ prefix ensures we compare against remote state, not local refs
    let git_ref = format!("origin/{}:{}", branch, relative_path);

    let output = Command::new("git")
        .args(["-C", &worktree_path, "show", &git_ref])
        .output();

    match output {
        Ok(result) if result.status.success() => {
            let content = String::from_utf8_lossy(&result.stdout).to_string();
            let language = detect_language(&file_path);
            Ok(Some(FileContent {
                path: file_path,
                content,
                language,
            }))
        }
        Ok(result) => {
            // Git command ran but failed - check if it's a "file not found" error
            let stderr = String::from_utf8_lossy(&result.stderr);
            if stderr.contains("does not exist") || stderr.contains("exists on disk, but not in") || stderr.contains("fatal: path") {
                // File genuinely doesn't exist in this branch (new file)
                Ok(None)
            } else {
                // Log unexpected git errors for debugging
                debug!(stderr = %stderr, git_ref = %git_ref, "git show failed with unexpected error");
                // Still return None to avoid breaking the diff view, but we've logged the issue
                Ok(None)
            }
        }
        Err(e) => {
            // Failed to run git command entirely
            Err(format!("Failed to run git command: {}", e))
        }
    }
}

/// Write a file to inside a container from base64-encoded data
/// Creates parent directories if they don't exist
/// Uses Docker's tar-based upload API to support files up to 8MB
#[tauri::command]
pub async fn write_container_file(
    container_id: String,
    file_path: String,
    base64_data: String,
) -> Result<String, String> {
    use base64::Engine;

    // Validate and sanitize the path first (cheap operation)
    let full_path = validate_file_path(&file_path)?;

    // Size limit: 8MB (base64 encoded is ~33% larger than raw)
    const MAX_FILE_SIZE: usize = 8 * 1024 * 1024;
    const MAX_BASE64_SIZE: usize = MAX_FILE_SIZE * 4 / 3 + 4; // Account for base64 overhead

    if base64_data.len() > MAX_BASE64_SIZE {
        return Err(format!(
            "File too large (max 8MB, got ~{}MB)",
            base64_data.len() * 3 / 4 / 1024 / 1024
        ));
    }

    // Decode base64 to raw bytes
    let file_data = base64::engine::general_purpose::STANDARD
        .decode(&base64_data)
        .map_err(|_| "Invalid base64 data".to_string())?;

    let client = get_docker_client().map_err(|e| e.to_string())?;

    // Check if container is running
    let is_running = client
        .is_container_running(&container_id)
        .await
        .map_err(|e| e.to_string())?;

    if !is_running {
        return Err("Container is not running".to_string());
    }

    // Extract directory from path and create it if needed
    let parent_dir = std::path::Path::new(&full_path)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "/workspace".to_string());

    // Create parent directory
    client
        .exec_command(&container_id, vec!["mkdir", "-p", &parent_dir])
        .await
        .map_err(|e| format!("Failed to create directory: {}", e))?;

    // Upload file using Docker's tar-based API (supports large files)
    client
        .upload_file_to_container(&container_id, &full_path, file_data)
        .await
        .map_err(|e| format!("Failed to write file: {}", e))?;

    Ok(full_path)
}

/// Write a file to a local environment (worktree path) from base64-encoded data
/// Creates parent directories if they don't exist
#[tauri::command]
pub async fn write_local_file(
    worktree_path: String,
    file_path: String,
    base64_data: String,
) -> Result<String, String> {
    use base64::Engine;

    // Validate the worktree path exists
    let base_path = std::path::Path::new(&worktree_path);
    if !base_path.exists() {
        return Err(format!("Worktree path does not exist: {}", worktree_path));
    }
    if !base_path.is_dir() {
        return Err(format!("Worktree path is not a directory: {}", worktree_path));
    }

    // Validate file path doesn't contain dangerous characters
    if file_path.contains('\0') || file_path.contains('\n') || file_path.contains('\r') {
        return Err("Invalid file path: contains invalid characters".to_string());
    }

    // Check for path traversal attempts
    if file_path.contains("..") {
        return Err("Invalid file path: parent directory traversal not allowed".to_string());
    }

    // Size limit: 8MB (base64 encoded is ~33% larger than raw)
    const MAX_FILE_SIZE: usize = 8 * 1024 * 1024;
    const MAX_BASE64_SIZE: usize = MAX_FILE_SIZE * 4 / 3 + 4;

    if base64_data.len() > MAX_BASE64_SIZE {
        return Err(format!(
            "File too large (max 8MB, got ~{}MB)",
            base64_data.len() * 3 / 4 / 1024 / 1024
        ));
    }

    // Decode base64 to raw bytes
    let file_data = base64::engine::general_purpose::STANDARD
        .decode(&base64_data)
        .map_err(|_| "Invalid base64 data".to_string())?;

    // Build full path - file_path should be relative to worktree
    let relative_path = file_path.trim_start_matches('/');
    let full_path = base_path.join(relative_path);

    // Security check: ensure the resolved path is within the worktree
    // We can't canonicalize yet since the file doesn't exist, so check parent
    let parent_dir = full_path.parent()
        .ok_or_else(|| "Invalid file path: no parent directory".to_string())?;

    // Create parent directories if needed
    std::fs::create_dir_all(parent_dir)
        .map_err(|e| format!("Failed to create directories: {}", e))?;

    // Now we can verify the parent is within worktree
    let canonical_base = base_path.canonicalize()
        .map_err(|e| format!("Failed to resolve worktree path: {}", e))?;
    let canonical_parent = parent_dir.canonicalize()
        .map_err(|e| format!("Failed to resolve parent directory: {}", e))?;

    if !canonical_parent.starts_with(&canonical_base) {
        return Err("Invalid file path: escapes worktree directory".to_string());
    }

    // Write the file
    std::fs::write(&full_path, file_data)
        .map_err(|e| format!("Failed to write file: {}", e))?;

    // Return the full path as string
    Ok(full_path.to_string_lossy().to_string())
}
