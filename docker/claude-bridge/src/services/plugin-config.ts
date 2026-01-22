/**
 * Plugin Configuration Service
 *
 * Loads plugin configurations from:
 * 1. ~/.claude.json (global configuration)
 * 2. <project>/.claude/plugins.json (project-specific configuration)
 * 3. ~/.claude/plugins/ (CLI-installed plugins)
 *
 * Project-specific configs override global configs for plugins with the same name.
 */

import { readFile, readdir, access } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { PluginInfo, PluginConfig, ClaudeJsonPluginsConfig } from "../types/plugins.js";

/**
 * SDK plugin config type - matching the SDK's expected format
 */
export interface SdkPluginConfig {
  type: "local";
  path: string;
}

/**
 * Read and parse a JSON file, returning null if it doesn't exist or is invalid
 */
async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const content = await readFile(filePath, "utf-8");
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

/**
 * Check if a path exists
 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Load global plugin configurations from ~/.claude.json
 */
export async function loadGlobalPlugins(): Promise<PluginConfig[]> {
  const claudeJsonPath = join(homedir(), ".claude.json");
  const config = await readJsonFile<ClaudeJsonPluginsConfig>(claudeJsonPath);

  if (!config?.plugins) {
    return [];
  }

  return config.plugins;
}

/**
 * Load project-specific plugin configurations from <cwd>/.claude/plugins.json
 */
export async function loadProjectPlugins(cwd: string): Promise<PluginConfig[]> {
  const pluginsJsonPath = join(cwd, ".claude", "plugins.json");
  const config = await readJsonFile<{ plugins?: PluginConfig[] }>(pluginsJsonPath);

  if (!config?.plugins) {
    return [];
  }

  return config.plugins;
}

/**
 * Scan ~/.claude/plugins/ directory for CLI-installed plugins
 */
export async function loadCliInstalledPlugins(): Promise<PluginConfig[]> {
  const pluginsDir = join(homedir(), ".claude", "plugins");

  if (!(await pathExists(pluginsDir))) {
    return [];
  }

  try {
    const entries = await readdir(pluginsDir, { withFileTypes: true });
    const plugins: PluginConfig[] = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const pluginPath = join(pluginsDir, entry.name);
        const manifestPath = join(pluginPath, ".claude-plugin", "plugin.json");

        if (await pathExists(manifestPath)) {
          plugins.push({
            type: "local",
            path: pluginPath,
          });
        }
      }
    }

    return plugins;
  } catch {
    return [];
  }
}

/**
 * Also check for project-specific plugin overrides in ~/.claude.json projects section
 */
export async function loadProjectOverridesFromGlobal(
  cwd: string
): Promise<PluginConfig[]> {
  const claudeJsonPath = join(homedir(), ".claude.json");
  const config = await readJsonFile<ClaudeJsonPluginsConfig>(claudeJsonPath);

  if (!config?.projects) {
    return [];
  }

  // Check for project entry matching the cwd
  const projectConfig = config.projects[cwd];
  if (!projectConfig?.plugins) {
    return [];
  }

  return projectConfig.plugins;
}

/**
 * Read plugin manifest to get name and metadata
 */
async function readPluginManifest(
  pluginPath: string
): Promise<{ name: string; description?: string } | null> {
  const manifestPath = join(pluginPath, ".claude-plugin", "plugin.json");
  const manifest = await readJsonFile<{
    name?: string;
    description?: string;
  }>(manifestPath);

  if (!manifest) {
    return null;
  }

  // Default name to directory name if not specified
  const name = manifest.name || pluginPath.split("/").pop() || "unknown";

  return {
    name,
    description: manifest.description,
  };
}

/**
 * Resolve a plugin path (handles relative paths and ~)
 */
function resolvePath(pluginPath: string, cwd: string): string {
  if (pluginPath.startsWith("~")) {
    return join(homedir(), pluginPath.slice(1));
  }
  if (pluginPath.startsWith("/")) {
    return pluginPath;
  }
  return join(cwd, pluginPath);
}

/**
 * Get merged plugins for a project.
 * Priority (highest to lowest):
 * 1. Project .claude/plugins.json
 * 2. Project entry in ~/.claude.json
 * 3. CLI-installed plugins (~/.claude/plugins/)
 * 4. Global plugins in ~/.claude.json
 *
 * Deduplicates by resolved path
 */
export async function getMergedPlugins(cwd: string): Promise<PluginConfig[]> {
  const [global, cliInstalled, projectGlobal, projectLocal] = await Promise.all([
    loadGlobalPlugins(),
    loadCliInstalledPlugins(),
    loadProjectOverridesFromGlobal(cwd),
    loadProjectPlugins(cwd),
  ]);

  // Merge with priority: projectLocal > projectGlobal > cliInstalled > global
  // Use a Map to deduplicate by resolved path
  const pluginMap = new Map<string, PluginConfig>();

  // Add in reverse priority order so higher priority overwrites
  for (const plugin of global) {
    const resolved = resolvePath(plugin.path, cwd);
    pluginMap.set(resolved, { ...plugin, path: resolved });
  }

  for (const plugin of cliInstalled) {
    const resolved = resolvePath(plugin.path, cwd);
    pluginMap.set(resolved, { ...plugin, path: resolved });
  }

  for (const plugin of projectGlobal) {
    const resolved = resolvePath(plugin.path, cwd);
    pluginMap.set(resolved, { ...plugin, path: resolved });
  }

  for (const plugin of projectLocal) {
    const resolved = resolvePath(plugin.path, cwd);
    pluginMap.set(resolved, { ...plugin, path: resolved });
  }

  return Array.from(pluginMap.values());
}

/**
 * Convert merged configs to SDK-compatible plugin config array
 */
export async function getPluginsForSdk(cwd: string): Promise<SdkPluginConfig[]> {
  const configs = await getMergedPlugins(cwd);

  // Filter to only include plugins that exist
  const validPlugins: SdkPluginConfig[] = [];

  for (const config of configs) {
    if (await pathExists(config.path)) {
      validPlugins.push({
        type: "local",
        path: config.path,
      });
    } else {
      console.warn(`Plugin path does not exist: "${config.path}"`);
    }
  }

  return validPlugins;
}

/**
 * Get plugin info for frontend display
 */
export async function getPluginInfo(cwd: string): Promise<PluginInfo[]> {
  // Load all config sources in parallel
  const [global, cliInstalled, projectGlobal, projectLocal] = await Promise.all([
    loadGlobalPlugins(),
    loadCliInstalledPlugins(),
    loadProjectOverridesFromGlobal(cwd),
    loadProjectPlugins(cwd),
  ]);

  // Track which paths came from which source
  const globalPaths = new Set(global.map((p) => resolvePath(p.path, cwd)));
  const cliPaths = new Set(cliInstalled.map((p) => resolvePath(p.path, cwd)));
  const projectGlobalPaths = new Set(projectGlobal.map((p) => resolvePath(p.path, cwd)));
  const projectLocalPaths = new Set(projectLocal.map((p) => resolvePath(p.path, cwd)));

  // Get merged plugins
  const merged = await getMergedPlugins(cwd);
  const result: PluginInfo[] = [];

  for (const config of merged) {
    const manifest = await readPluginManifest(config.path);
    const exists = await pathExists(config.path);

    // Determine source (highest priority that has this path)
    let source: "global" | "project" | "cli" = "global";
    if (projectLocalPaths.has(config.path) || projectGlobalPaths.has(config.path)) {
      source = "project";
    } else if (cliPaths.has(config.path)) {
      source = "cli";
    } else if (globalPaths.has(config.path)) {
      source = "global";
    }

    result.push({
      name: manifest?.name || config.path.split("/").pop() || "unknown",
      path: config.path,
      description: manifest?.description,
      source,
      enabled: exists,
    });
  }

  return result;
}
