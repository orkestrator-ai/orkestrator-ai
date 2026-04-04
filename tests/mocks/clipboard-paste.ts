/**
 * Shared mock functions for @/hooks/useClipboardImagePaste.
 *
 * Registered once in tests/setup.ts so that every test file shares the same
 * mock instances.  Individual tests configure behaviour via mockImplementation
 * in their beforeEach blocks.
 */
import { mock } from "bun:test";

export const mockProcessClipboardPaste = mock(async (
  _containerId: string,
  _onImageSaved?: (filePath: string) => void | Promise<void>,
  _onTextPaste?: (text: string) => void | Promise<void>,
  _onError?: (error: string) => void,
) => false as boolean);

export const mockProcessLocalClipboardPaste = mock(async (
  _worktreePath: string,
  _onImageSaved?: (filePath: string) => void | Promise<void>,
  _onTextPaste?: (text: string) => void | Promise<void>,
  _onError?: (error: string) => void,
) => false as boolean);

export const mockUseClipboardImagePaste = mock(() => {});

export function resetClipboardPasteMocks() {
  mockProcessClipboardPaste.mockClear();
  mockProcessLocalClipboardPaste.mockClear();
  mockUseClipboardImagePaste.mockClear();
  mockProcessClipboardPaste.mockImplementation(async () => false);
  mockProcessLocalClipboardPaste.mockImplementation(async () => false);
}
