Goal (incl. success criteria):
- Fix local environment UI so clicking a local environment opens a working terminal tab and enables toolbar buttons (new terminal/agent tabs), matching container env behavior.

Constraints/Assumptions:
- Follow AGENTS.md instructions (Bun, OpenCode SDK v2, logging, etc.).
- Workspace: /Users/arkaydeus/conductor/workspaces/orkestrator-ai/dhaka-v1 on branch main.
- Issue reported: local envs only; container envs work.

Key decisions:
- Treat local environments as “running” when a worktreePath exists, regardless of container status.
- Auto-start local environments on selection if worktreePath missing.
- Reuse existing git branch when creating worktree if branch already exists; if branch is already checked out by another worktree, generate a unique branch name and persist it.
- Auto-build claude-bridge (bun install/build) in dev if dist missing; otherwise surface explicit error.
- Resolve claude-bridge dev path using CARGO_MANIFEST_DIR/../docker/claude-bridge.
- Add explicit CORS + Private Network headers in claude-bridge to allow WebView access.
- Use c.body(null, 204) for OPTIONS to satisfy Hono types.
- Bind local claude-bridge to 127.0.0.1 instead of 0.0.0.0 to avoid PNA/CORS issues.
- Add more logging in claude-bridge (/config/models) and use cwd for SDK query.
- Add fetch timeouts in claude-client to avoid hanging UI.
- Use process.cwd() for Claude Agent SDK query in sendPrompt.
- Pass PATH/NODE hints to claude-bridge process and resolve node/bun runtime.

State:
- Backend logs show Claude bridge starting twice for the same env; second instance fails with “port in use”.

Done:
- Updated TerminalContainer to use isEnvironmentRunning (container running OR local worktree ready) for init, tab creation, overlays, and terminal display.
- Updated ActionBar running state to account for local worktree readiness.
- Added auto-start for local environments on selection in sidebar (keyed off missing worktreePath).
- Added detailed logging in local worktree creation and local environment start.
- Added branch-exists/in-use handling and unique branch fallback in local worktree creation; persist adjusted branch.
- Added frontend logging around startEnvironment and local auto-start.
- Added storage.update_environment handling for worktreePath and other local env fields.
- Fixed PID type casts in storage update; removed unused import warning.
- Added claude-bridge readiness check and auto-build (bun install/build) if dist missing.
- Added dev claude-bridge path resolution using CARGO_MANIFEST_DIR.
- Added explicit CORS headers + Access-Control-Allow-Private-Network and OPTIONS handler in claude-bridge.
- Fixed Hono OPTIONS handler typing using c.body(null, 204).
- Bind claude-bridge HOSTNAME to 127.0.0.1.
- Added process stdout/stderr capture for local servers.
- Added detailed ClaudeChatTab init logging + health check + model fetch timing.
- Added /config/models logging + use process.cwd() for SDK query.
- Added fetch timeouts for model/session calls.
- Added logging + process.cwd() usage for SDK sendPrompt.
- Added PATH propagation, NODE hints, bun runtime selection, and node path resolution.
- Added extensive logging for Claude bridge SSE (subscribe/emit), session prompt handling, SDK message flow, and client-side SSE/prompt flows.
- Added tracing subscriber init with env filter; replaced println init logs with tracing.
- Identified duplicate local Claude-bridge starts causing port-in-use errors.
- Added port-in-use recovery: kill stored PID if alive; otherwise reassign Claude port to a free one and clear PID.

Now:
- Rebuild Tauri; confirm Claude-bridge starts once and that prompt logs appear from session-manager.

Next:
- If ENOENT persists, hardcode node path via config or bundle node.

Open questions (UNCONFIRMED if needed):
- Is node available on PATH for the Tauri process?
- Are SSE/event subscriptions receiving any events after send?

Working set (files/ids/commands):
- src-tauri/src/local/servers.rs
- docker/claude-bridge/src/services/session-manager.ts
- docker/claude-bridge/src/routes/config.ts
- src/lib/claude-client.ts
- src/components/claude/ClaudeChatTab.tsx
- src-tauri/src/local/process.rs
- src-tauri/src/commands/local_servers.rs
- docker/claude-bridge/src/index.ts
- src-tauri/src/storage/mod.rs
- src/hooks/useEnvironments.ts
- src/components/sidebar/HierarchicalSidebar.tsx
- src-tauri/src/local/worktree.rs
- src-tauri/src/commands/environments.rs
- src/components/terminal/TerminalContainer.tsx
- src/components/layout/ActionBar.tsx
- http:/CONTINUITY.md
