import { useEffect, useCallback, useRef } from "react";
import { readImage, readText } from "@tauri-apps/plugin-clipboard-manager";
import { writeContainerFile } from "@/lib/tauri";
import { resizeCanvasIfNeeded } from "@/lib/canvas-utils";

interface UseClipboardImagePasteOptions {
  containerId: string | null;
  isActive: boolean;
  onImageSaved?: (filePath: string) => void;
  onError?: (error: string) => void;
}

/** Maximum image size in bytes (8MB) */
const MAX_IMAGE_SIZE = 8 * 1024 * 1024;

/** Maximum raw RGBA buffer size (32MB - allows for ~2800x2800 images before PNG compression) */
const MAX_RGBA_SIZE = 32 * 1024 * 1024;

/** Generate a unique filename for clipboard images */
function generateImageFilename(): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .slice(0, 19);
  const random = Math.random().toString(36).substring(2, 8);
  // Tauri clipboard returns PNG images
  return `clipboard-${timestamp}-${random}.png`;
}

/**
 * Process clipboard content - tries image first, then falls back to text.
 * Returns true if something was processed, false otherwise.
 */
export async function processClipboardPaste(
  containerId: string,
  onImageSaved?: (filePath: string) => void,
  onTextPaste?: (text: string) => void,
  onError?: (error: string) => void
): Promise<boolean> {
  try {
    // First, try to read an image from clipboard
    let imageData: string | null = null;
    try {
      const image = await readImage();
      const rgba = await image.rgba();
      const { width, height } = await image.size();

      // Create a canvas to convert RGBA to PNG
      let canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        const imageDataObj = new ImageData(new Uint8ClampedArray(rgba), width, height);
        ctx.putImageData(imageDataObj, 0, 0);

        // Resize if needed to fit within RGBA size limit
        canvas = resizeCanvasIfNeeded(canvas, MAX_RGBA_SIZE);

        const dataUrl = canvas.toDataURL("image/png");
        imageData = dataUrl.split(",")[1] || null;
      }
      // Release canvas memory
      canvas.width = 0;
      canvas.height = 0;
    } catch (imgError) {
      // No image in clipboard or processing failed - we'll try text
      // (Size errors no longer thrown since we resize instead)
    }

    if (imageData) {
      // Check final PNG size
      const estimatedSize = (imageData.length * 3) / 4;
      if (estimatedSize > MAX_IMAGE_SIZE) {
        const sizeMB = (estimatedSize / 1024 / 1024).toFixed(1);
        throw new Error(`Image too large (${sizeMB}MB). Maximum size is 8MB.`);
      }

      // Generate filename and path
      const filename = generateImageFilename();
      const filePath = `.orkestrator/clipboard/${filename}`;

      // Write to container
      const fullPath = await writeContainerFile(containerId, filePath, imageData);
      onImageSaved?.(fullPath);
      return true;
    } else {
      // No image - try to paste text instead
      try {
        const text = await readText();
        if (text) {
          onTextPaste?.(text);
          return true;
        }
      } catch {
        // No text either - nothing to paste
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to process paste";
    console.error("[processClipboardPaste] Error:", message);
    onError?.(message);
  }
  return false;
}

/**
 * Hook to intercept right-click paste events and save images to the container.
 *
 * For keyboard shortcuts (Cmd+V / Ctrl+V), use xterm's attachCustomKeyEventHandler
 * and call processClipboardPaste directly.
 *
 * This hook only handles DOM paste events (right-click menu).
 */
export function useClipboardImagePaste({
  containerId,
  isActive,
  onImageSaved,
  onError,
}: UseClipboardImagePasteOptions) {
  const isProcessingRef = useRef(false);

  // Handle DOM paste events (for right-click paste menu)
  const handlePaste = useCallback(
    async (event: ClipboardEvent) => {
      // Only handle when active and container is available
      if (!isActive || !containerId) return;

      // Don't process if focus is within a compose bar (it handles its own paste)
      if (document.activeElement?.closest("[data-compose-bar]")) return;

      // Check for image in clipboard
      const clipboardItems = event.clipboardData?.items;
      if (!clipboardItems) return;

      // Find image item
      let imageBlob: Blob | null = null;
      for (const item of clipboardItems) {
        if (item.type.startsWith("image/")) {
          imageBlob = item.getAsFile();
          break;
        }
      }

      // If no image, let the event continue to xterm.js for text paste
      if (!imageBlob) return;

      // Prevent default paste and xterm.js handling
      event.preventDefault();
      event.stopPropagation();

      // Prevent double processing
      if (isProcessingRef.current) return;
      isProcessingRef.current = true;

      try {
        // Check file size
        if (imageBlob.size > MAX_IMAGE_SIZE) {
          const sizeMB = (imageBlob.size / 1024 / 1024).toFixed(1);
          throw new Error(`Image too large (${sizeMB}MB). Maximum size is 8MB.`);
        }

        // Convert blob to base64
        const base64Data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => {
            const dataUrl = reader.result as string;
            const commaIndex = dataUrl.indexOf(",");
            if (commaIndex === -1) {
              reject(new Error("Invalid data URL format"));
              return;
            }
            resolve(dataUrl.slice(commaIndex + 1));
          };
          reader.onerror = reject;
          reader.readAsDataURL(imageBlob);
        });

        // Generate filename and path
        const filename = generateImageFilename();
        const filePath = `.orkestrator/clipboard/${filename}`;

        // Write to container
        const fullPath = await writeContainerFile(containerId, filePath, base64Data);
        onImageSaved?.(fullPath);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to save image";
        console.error("[useClipboardImagePaste] Error:", message);
        onError?.(message);
      } finally {
        isProcessingRef.current = false;
      }
    },
    [containerId, isActive, onImageSaved, onError]
  );

  useEffect(() => {
    if (!isActive) return;

    // Use capture phase to intercept before xterm.js
    document.addEventListener("paste", handlePaste, { capture: true });

    return () => {
      document.removeEventListener("paste", handlePaste, { capture: true });
    };
  }, [isActive, handlePaste]);
}
