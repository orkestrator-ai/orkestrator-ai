import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Creates a unique session key for agent sessions (Claude/OpenCode).
 * This ensures tab IDs (which may be reused across environments, e.g., "default")
 * don't collide when multiple environments are running.
 *
 * @param environmentId - The environment ID (always required)
 * @param tabId - The tab ID within the environment
 * @returns A unique session key in the format "env-{environmentId}:{tabId}"
 */
export function createSessionKey(environmentId: string, tabId: string): string {
  return `env-${environmentId}:${tabId}`;
}
