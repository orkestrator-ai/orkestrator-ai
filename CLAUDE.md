# Orkestrator AI

A Tauri desktop application for managing isolated Docker-based development environments for Claude Code.

## Tech Stack

- **Frontend**: React 19, TypeScript, Tailwind CSS v4, shadcn/ui, Zustand, xterm.js
- **Backend**: Rust, Tauri v2, Bollard (Docker client)
- **Containerization**: Docker with custom base image

## Project Structure

```
orkestrator-ai/
├── src/                    # React frontend
│   ├── components/         # UI components (shadcn/ui based)
│   ├── hooks/              # React hooks
│   ├── stores/             # Zustand state stores
│   ├── contexts/           # React contexts
│   └── lib/                # Utilities and Tauri wrappers
├── src-tauri/              # Rust backend
│   └── src/
│       ├── commands/       # Tauri IPC commands
│       ├── docker/         # Bollard Docker client
│       ├── pty/            # Terminal session management
│       ├── storage/        # JSON file persistence
│       └── models/         # Data models
├── docker/                 # Docker configuration
│   ├── Dockerfile          # Base image definition
│   ├── entrypoint.sh       # Container entrypoint
│   └── init-firewall.sh    # Network firewall setup
└── docs/                   # Documentation and stories
```

## Development

### Prerequisites

- [Bun](https://bun.sh) (package manager and runtime)
- [Rust](https://rustup.rs) (for Tauri backend)
- [Docker](https://docker.com) (for container functionality)

### Setup

```bash
# Install dependencies
bun install

# Build the Docker base image
cd docker && docker build -t orkestrator-ai:latest .
```

### Running

```bash
# Run the full Tauri application (recommended)
bun run tauri dev

# Run just the frontend (for UI development)
bun run dev
```

### Testing

```bash
# Run frontend tests
bun test

# Run Rust tests
cd src-tauri && cargo test
```

### Building

```bash
# Build for production
bun run tauri build
```

## Bun Preferences

Default to using Bun instead of Node.js:

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun install` instead of `npm install`
- Use `bun run <script>` instead of `npm run <script>`
- Use `bunx <package>` instead of `npx <package>`
- Bun automatically loads .env files

## Docker Base Image

The container includes:
- Node.js 20
- Claude Code CLI
- Git and GitHub CLI (gh)
- Network firewall (iptables/ipset) for security isolation
- zsh with powerlevel10k theme
- Non-root user (node) with sudo for firewall

### Network Isolation

Containers have restricted network access via iptables firewall:
- Allowed: GitHub, npm registry, Anthropic API, VS Code marketplace
- All other outbound traffic is blocked

## Key Files

| File | Purpose |
|------|---------|
| `src-tauri/src/docker/client.rs` | Core Docker API client |
| `src-tauri/src/docker/container.rs` | Container provisioning |
| `src-tauri/src/commands/environments.rs` | Environment CRUD commands |
| `src/components/terminal/TerminalContainer.tsx` | xterm.js integration |
| `docker/Dockerfile` | Base image definition |
| `docker/init-firewall.sh` | Network firewall rules |

## Configuration Storage

Application data is stored in:
- **macOS**: `~/Library/Application Support/orkestrator-ai/`
- **Linux**: `~/.config/orkestrator-ai/`

Files:
- `config.json` - Global and per-repo settings
- `projects.json` - Repository metadata
- `environments.json` - Environment metadata and container IDs

## Rust Logging

The backend uses the `tracing` crate for structured logging. **Never use `println!` for logging** - always use the appropriate tracing macros.

### Log Levels

Use the appropriate log level for each message:

| Level | Macro | Use Case |
|-------|-------|----------|
| `error!` | Critical failures that need immediate attention |
| `warn!` | Unexpected conditions that don't prevent operation |
| `info!` | Important operational events (container started, removed, etc.) |
| `debug!` | Detailed information useful for debugging |
| `trace!` | Very detailed information (loop iterations, state changes) |

### Usage Pattern

```rust
use tracing::{debug, info, warn, error, trace};

// Structured logging with named fields (preferred)
debug!(container_id = %id, status = %status, "Container status updated");
warn!(environment_id = %env_id, error = %e, "Failed to rename git branch");
info!(container_id = %id, "Removed orphaned container");

// Simple messages (acceptable for straightforward cases)
debug!("Starting background naming task");
```

### Import Convention

Only import the log levels you need:

```rust
use tracing::{debug, warn};  // Good - only what's needed
use tracing::*;              // Avoid - imports everything
```

### Guidelines

1. **Use structured fields** for IDs, errors, and key values - this enables log filtering and analysis
2. **Keep messages concise** - the structured fields provide context
3. **Don't log sensitive data** - avoid logging API keys, tokens, or credentials
4. **Use `%` for Display trait** and `?` for Debug trait in field values
5. **Prefer `debug!` over `trace!`** for most development logging
