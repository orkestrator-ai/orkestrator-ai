# Orkestrator AI

A desktop application for managing isolated Docker-based development environments for Claude Code. Create multiple sandboxed environments per repository, each with its own terminal session, Git branch, and PR workflow.

## Features

- **Project Management**: Add Git repositories and manage multiple environments per project
- **Isolated Environments**: Each environment runs in its own Docker container with network isolation
- **Embedded Terminal**: Full xterm.js terminal with ANSI color support
- **GitHub Integration**: Create and view pull requests directly from the UI
- **Configuration**: Global and per-repository settings for SSH keys, resource limits, and branches
- **Security**: Network firewall restricts outbound traffic to approved domains only

## Screenshots

```
+------------------+----------------------------------------+
| < Back           |  my-repo [gear]           [Create PR] |
+------------------+----------------------------------------+
| + Create New     |                                        |
|   Environment    |  $ claude                              |
+------------------+                                        |
| [green] my-repo- |  Welcome to Claude Code!               |
|   20260106  [x]  |                                        |
+------------------+  > _                                   |
| [grey] my-repo-  |                                        |
|   20260105  [x]  |                                        |
+------------------+----------------------------------------+
```

## Prerequisites

- [Bun](https://bun.sh) - JavaScript runtime and package manager
- [Rust](https://rustup.rs) - Required for Tauri backend
- [Docker](https://docker.com) - Container runtime

## Quick Start

```bash
# Clone the repository
git clone <repo-url>
cd orkestrator-ai

# Run setup (downloads bun binary, installs dependencies, builds Claude bridge)
bun run setup

# Build the Docker base image (required for container functionality)
cd docker && docker build -t orkestrator-ai:latest . && cd ..

# Run the application
bun run tauri dev
```

## Usage

### Adding a Project

1. Click "Add Project" in the sidebar
2. Enter the Git repository URL or select a local folder
3. The project appears in the sidebar

### Creating an Environment

1. Click on a project to expand it
2. Click "Create New Environment"
3. A new container is provisioned with:
   - Your `~/.claude` credentials (read-only)
   - SSH key for Git operations
   - Repository cloned to `/workspace`
   - Claude Code CLI ready to use

### Working with Environments

- Click an environment to open its terminal
- The terminal connects to the running container
- Use "Create PR" to run `gh pr create` interactively
- After PR creation, the button becomes "View PR"

### Configuration

Access settings via the gear icon:

**Global Settings:**
- SSH key path (default: `~/.ssh/id_rsa`)
- CPU cores limit (default: 2)
- Memory limit (default: 4GB)
- .env file patterns

**Per-Repository Settings:**
- Default branch to clone
- PR base branch

**Per-Environment Settings:**
- Debug mode - enables verbose logging during container startup

### Debug Mode

Each environment can have debug mode enabled, which provides verbose logging during container startup. This is useful for troubleshooting credential injection, configuration copying, and other initialization issues.

When debug mode is enabled, the container entrypoint will output:
- List of files copied from `~/.claude`
- `.claude.json` processing details (file sizes, keys)
- Credential injection status

To enable debug mode, use the `set_environment_debug_mode` Tauri command before starting the environment. Note: Debug mode only takes effect when the container is created - changing it on a running environment requires recreating the container.

## Development

```bash
# Run with hot reload
bun run tauri dev

# Run frontend only (without Tauri)
bun run dev

# Run tests
bun test
cd src-tauri && cargo test

# Build for production
bun run tauri build
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Tauri Application                     │
├─────────────────────────┬───────────────────────────────┤
│      React Frontend     │        Rust Backend           │
│  ┌───────────────────┐  │  ┌─────────────────────────┐  │
│  │ shadcn/ui + xterm │  │  │ Bollard Docker Client   │  │
│  │ Zustand stores    │◄─┼──┤ PTY Terminal Sessions   │  │
│  │ Tauri IPC         │  │  │ JSON File Storage       │  │
│  └───────────────────┘  │  └─────────────────────────┘  │
├─────────────────────────┴───────────────────────────────┤
│                    Docker Containers                     │
│  ┌────────────────────────────────────────────────────┐ │
│  │ orkestrator-ai:latest                              │ │
│  │ - Node.js 20 + Claude Code CLI                     │ │
│  │ - Git + GitHub CLI                                 │ │
│  │ - Network firewall (GitHub, npm, Anthropic only)   │ │
│  └────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

## Network Security

Containers have restricted network access via iptables firewall:

**Allowed domains:**
- GitHub (api.github.com, github.com)
- npm registry (registry.npmjs.org)
- Anthropic API (api.anthropic.com, statsig.anthropic.com)
- VS Code marketplace (for extensions)
- Sentry.io (error reporting)

All other outbound traffic is blocked.

## Configuration Storage

Application data is stored in:
- **macOS**: `~/Library/Application Support/orkestrator-ai/`
- **Linux**: `~/.config/orkestrator-ai/`

## Tech Stack

- **Frontend**: React 19, TypeScript, Tailwind CSS v4, shadcn/ui, Zustand, xterm.js
- **Backend**: Rust, Tauri v2, Bollard
- **Container**: Docker with custom base image

## License

MIT
