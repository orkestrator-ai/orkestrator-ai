/** Tool names that represent file-editing operations across different AI coding agents */
export const EDIT_TOOL_NAMES = new Set([
  "edit",
  "write",
  "patch",
  "apply_patch",
  "file_edit",
  "notebookedit",
  "str_replace_editor",
  "create_file",
  "insert",
  "replace",
]);

/** Check if a tool name is a file-editing tool */
export function isEditTool(toolName?: string): boolean {
  if (!toolName) return false;
  return EDIT_TOOL_NAMES.has(toolName.toLowerCase());
}
