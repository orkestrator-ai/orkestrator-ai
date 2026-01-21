import type { TabType } from "@/contexts";
import type { SessionType } from "@/types";

/**
 * Strip ANSI escape codes from text for clean log display
 */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

/**
 * Convert tab type to session type for persistence
 */
export function tabTypeToSessionType(tabType: TabType): SessionType {
  switch (tabType) {
    case "claude":
      return "claude";
    case "opencode":
      return "opencode";
    case "root":
      return "root";
    default:
      return "plain";
  }
}

/** Marker that indicates the workspace setup is complete */
export const ENVIRONMENT_READY_MARKER = "=== Workspace Ready ===";

/** Alternate marker formats for workspace ready detection */
export const ENVIRONMENT_READY_MARKER_ALT_TILDE = "~~~ Workspace Ready ~~~";
export const ENVIRONMENT_READY_MARKER_ALT_DASH = "--- Workspace Ready ---";

/** Marker that appears right before "Workspace Ready" in setup scripts */
export const SETUP_COMPLETE_MARKER = "Setup script completed successfully!";

/** Patterns that indicate a shell prompt is ready */
export const SHELL_PROMPT_PATTERNS: (string | RegExp)[] = [
  "=== Container Ready ===",
  /➜\s+\w+\s+git:\(/,
  /➜\s+workspace/,
];
