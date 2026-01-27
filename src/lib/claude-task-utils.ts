/**
 * Utility functions for Claude Task tool parent-child tracking
 */

import type { ClaudeMessagePart } from "./claude-client";

/** Check if a tool name is a Task tool (subagent) */
export function isTaskTool(toolName?: string): boolean {
  if (!toolName) return false;
  return toolName.toLowerCase() === "task";
}

/** Processed part representing either a single item or a Task with children */
export interface ProcessedPart {
  type: "thinking" | "text" | "file" | "tool-group" | "task-group";
  part?: ClaudeMessagePart;
  childTools?: ClaudeMessagePart[];
}

/**
 * Process message parts to group tools under their parent Tasks while preserving order.
 *
 * Grouping strategy:
 * 1. Explicit parentTaskUseId - tools with this field are grouped under the matching Task
 * 2. Positional fallback - tools following a Task (before text/thinking) belong to that Task
 * 3. Standalone - tools with no parent are rendered independently
 *
 * Non-tool parts (thinking, text, file) reset the positional fallback but preserve
 * the taskGroups map for explicit parentTaskUseId lookups.
 */
export function processPartsInOrder(parts: ClaudeMessagePart[]): ProcessedPart[] {
  const result: ProcessedPart[] = [];

  // Map of Task toolUseId -> ProcessedPart for parent lookup
  const taskGroups = new Map<string, ProcessedPart>();

  // Track current Task for positional fallback (when parentTaskUseId is not available)
  let currentTask: ProcessedPart | null = null;

  for (const part of parts) {
    if (part.type === "thinking" || part.type === "text" || part.type === "file") {
      // Non-tool parts reset positional fallback (currentTask) but taskGroups map
      // is preserved for explicit parentTaskUseId lookups from later tools
      currentTask = null;
      result.push({ type: part.type, part });
    } else if (part.type === "tool-invocation") {
      if (isTaskTool(part.toolName)) {
        // Start a new Task group
        const taskGroup: ProcessedPart = { type: "task-group", part, childTools: [] };
        result.push(taskGroup);

        // Register in map for parent lookup (using toolUseId)
        if (part.toolUseId) {
          taskGroups.set(part.toolUseId, taskGroup);
        }

        // Update current Task for positional fallback
        currentTask = taskGroup;
      } else {
        // Non-Task tool - determine which Task it belongs to
        let parentTaskGroup: ProcessedPart | undefined;

        // First, try to find parent using explicit parentTaskUseId
        if (part.parentTaskUseId) {
          parentTaskGroup = taskGroups.get(part.parentTaskUseId);
        }

        // Fallback to positional logic (most recent Task)
        if (!parentTaskGroup && currentTask) {
          parentTaskGroup = currentTask;
        }

        if (parentTaskGroup) {
          // Add to parent Task's children
          parentTaskGroup.childTools!.push(part);
        } else {
          // Standalone tool (no parent Task found)
          result.push({ type: "tool-group", part });
        }
      }
    }
    // Skip tool-result type - they're shown inline with invocations
  }

  return result;
}
