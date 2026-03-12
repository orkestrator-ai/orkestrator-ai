/**
 * Slash Command Discovery Service
 *
 * Discovers available slash commands by scanning:
 * 1. Plugin `commands/` directories
 * 2. Project `.claude/commands/` directory (repo-scoped commands)
 * 3. Built-in Claude slash commands
 *
 * Returns commands in the same string format as the SDK's `slash_commands`
 * array (e.g., "/name - description"), which the frontend's `parseSlashCommands()`
 * already handles.
 */

import { readFile, readdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { getMergedPlugins, readPluginManifest } from "./plugin-config.js";

/**
 * Built-in Claude slash commands (always available)
 */
const BUILTIN_COMMANDS: string[] = [
  "/clear - Clear conversation history",
  "/compact - Compact conversation to reduce tokens",
  "/context - Show current context",
  "/cost - Show token usage and cost",
  "/doctor - Check system health",
  "/help - Show available commands",
  "/init - Re-initialize the session",
  "/logout - Log out of Claude",
  "/memory - Show memory usage",
  "/model - Show or change model",
  "/permissions - Manage permissions",
  "/review - Review recent changes",
  "/status - Show session status",
  "/vim - Toggle vim mode",
];

/**
 * Extract the `description` field from YAML frontmatter in a markdown file.
 */
function parseDescription(content: string): string | undefined {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match?.[1]) return undefined;

  const frontmatter = match[1];
  const descMatch = frontmatter.match(
    /^description:\s*(?:"([^"]*?)"|'([^']*?)'|(.+?))\s*$/m
  );
  if (!descMatch) return undefined;

  return (descMatch[1] ?? descMatch[2] ?? descMatch[3])?.trim();
}

/**
 * Scan a `commands/` directory and return command strings.
 * @param commandsDir - Absolute path to the commands directory
 * @param prefix - Optional prefix for the command name (e.g., "superpowers:")
 */
async function scanCommandsDir(
  commandsDir: string,
  prefix: string,
): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(commandsDir);
  } catch {
    return [];
  }

  const commands: string[] = [];

  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;

    const name = basename(entry, ".md");
    const fullName = prefix ? `/${prefix}${name}` : `/${name}`;

    let description: string | undefined;
    try {
      const content = await readFile(join(commandsDir, entry), "utf-8");
      description = parseDescription(content);
    } catch {
      // File unreadable, include command without description
    }

    commands.push(description ? `${fullName} - ${description}` : fullName);
  }

  return commands;
}

/**
 * Discover all available slash commands from plugins, project commands, and built-ins.
 *
 * @param cwd - The working directory (project root)
 * @returns Array of command strings in "/name - description" format
 */
export async function discoverSlashCommands(cwd: string): Promise<string[]> {
  const seen = new Set<string>();
  const result: string[] = [];

  const addCommand = (cmd: string) => {
    // Extract just the command name for deduplication
    const name = cmd.split(" - ")[0]!.trim().toLowerCase();
    if (!seen.has(name)) {
      seen.add(name);
      result.push(cmd);
    }
  };

  // 1. Scan repo-scoped commands (highest priority)
  const repoCommands = await scanCommandsDir(join(cwd, ".claude", "commands"), "");
  for (const cmd of repoCommands) addCommand(cmd);

  // 2. Scan plugin commands
  try {
    const plugins = await getMergedPlugins(cwd);

    for (const plugin of plugins) {
      const manifest = await readPluginManifest(plugin.path);
      const pluginName = manifest?.name || plugin.path.split("/").pop() || "unknown";
      const commandsDir = join(plugin.path, "commands");
      const pluginCommands = await scanCommandsDir(commandsDir, `${pluginName}:`);
      for (const cmd of pluginCommands) addCommand(cmd);
    }
  } catch (error) {
    console.warn("[slash-commands] Failed to scan plugin commands:", error);
  }

  // 3. Add built-in commands (lowest priority)
  for (const cmd of BUILTIN_COMMANDS) addCommand(cmd);

  return result.sort((a, b) => a.localeCompare(b));
}
