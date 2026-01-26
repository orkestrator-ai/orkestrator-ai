/**
 * Shared terminal paste utilities for handling clipboard paste in terminal components.
 */

import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { processClipboardPaste } from "@/hooks/useClipboardImagePaste";

export interface TerminalPasteOptions {
  /** Container ID for container environments, null/undefined for local */
  containerId: string | null | undefined;
  /** Function to write text to the terminal */
  writeToTerminal: (text: string) => Promise<void>;
  /** Function to focus the terminal after paste */
  focusTerminal: () => void;
  /** Component name for error logging */
  componentName: string;
}

/**
 * Handle paste operations for terminal components.
 * For container environments, uses processClipboardPaste to handle both images and text.
 * For local environments, only text paste is supported via the Tauri clipboard API.
 */
export async function handleTerminalPaste({
  containerId,
  writeToTerminal,
  focusTerminal,
  componentName,
}: TerminalPasteOptions): Promise<void> {
  if (containerId) {
    // Container environment - supports both image and text paste
    processClipboardPaste(
      containerId,
      async (filePath) => {
        await writeToTerminal(filePath + " ");
        focusTerminal();
      },
      async (text) => {
        await writeToTerminal(text);
        focusTerminal();
      },
      (error) => {
        console.error(`[${componentName}] Clipboard paste error:`, error);
      }
    );
  } else {
    // Local environment - text-only paste using Tauri clipboard API
    try {
      const text = await readText();
      if (text) {
        await writeToTerminal(text);
        focusTerminal();
      }
    } catch (err) {
      console.error(`[${componentName}] Clipboard text paste error:`, err);
    }
  }
}
