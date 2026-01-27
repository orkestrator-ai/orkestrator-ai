import { useState, useCallback, useMemo } from "react";
import type { FileMention, FileCandidate } from "@/types";

interface UseFileMentionsOptions {
  /** Callback to search files */
  searchFiles: (query: string, limit?: number) => FileCandidate[];
  /** Max files to show in menu */
  maxResults?: number;
}

interface UseFileMentionsReturn {
  /** Whether the file mention menu is open */
  isMenuOpen: boolean;
  /** Current search query (text after @) */
  searchQuery: string;
  /** Selected index in menu for keyboard navigation */
  selectedIndex: number;
  /** Filtered file candidates */
  filteredFiles: FileCandidate[];
  /** Update cursor position and detect @ trigger */
  handleCursorChange: (position: number, text: string) => void;
  /** Handle keyboard navigation */
  handleKeyDown: (
    event: React.KeyboardEvent,
    onSelect: (file: FileCandidate) => void
  ) => boolean;
  /** Close the menu */
  closeMenu: () => void;
  /** Set selected index */
  setSelectedIndex: (index: number) => void;
  /** Serialize text for LLM (replace @filename with full path) */
  serializeForLLM: (text: string, mentions: FileMention[]) => string;
  /** Create a mention from a file candidate */
  createMention: (file: FileCandidate) => FileMention;
}

/**
 * Hook for managing file @mentions in the compose bar.
 * Handles detection, menu state, keyboard navigation, and LLM serialization.
 */
export function useFileMentions({
  searchFiles,
  maxResults = 8,
}: UseFileMentionsOptions): UseFileMentionsReturn {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Filter files based on current search query
  const filteredFiles = useMemo(() => {
    if (!isMenuOpen) return [];
    return searchFiles(searchQuery, maxResults);
  }, [isMenuOpen, searchQuery, searchFiles, maxResults]);

  // Reset selected index when filtered files change
  const safeSelectedIndex = useMemo(() => {
    if (filteredFiles.length === 0) return 0;
    return Math.min(selectedIndex, filteredFiles.length - 1);
  }, [selectedIndex, filteredFiles.length]);

  /**
   * Detect @ trigger at cursor position.
   * Opens menu if @ is found with optional query text.
   */
  const handleCursorChange = useCallback(
    (position: number, text: string) => {
      const textBefore = text.slice(0, position);
      const atMatch = textBefore.match(/@([^\s@]*)$/);

      if (atMatch) {
        // Found @ trigger
        const query = atMatch[1] ?? "";
        setSearchQuery(query);
        setIsMenuOpen(true);
        // Reset selection when query changes
        if (query !== searchQuery) {
          setSelectedIndex(0);
        }
      } else {
        // No @ trigger - close menu
        setIsMenuOpen(false);
        setSearchQuery("");
      }
    },
    [searchQuery]
  );

  /**
   * Handle keyboard navigation for the menu.
   * Returns true if the event was handled (should prevent default).
   */
  const handleKeyDown = useCallback(
    (
      event: React.KeyboardEvent,
      onSelect: (file: FileCandidate) => void
    ): boolean => {
      if (!isMenuOpen || filteredFiles.length === 0) {
        return false;
      }

      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          setSelectedIndex((prev) =>
            prev < filteredFiles.length - 1 ? prev + 1 : prev
          );
          return true;

        case "ArrowUp":
          event.preventDefault();
          setSelectedIndex((prev) => (prev > 0 ? prev - 1 : prev));
          return true;

        case "Tab":
        case "Enter":
          if (filteredFiles[safeSelectedIndex]) {
            event.preventDefault();
            onSelect(filteredFiles[safeSelectedIndex]);
            setIsMenuOpen(false);
            setSearchQuery("");
            return true;
          }
          break;

        case "Escape":
          event.preventDefault();
          setIsMenuOpen(false);
          setSearchQuery("");
          return true;
      }

      return false;
    },
    [isMenuOpen, filteredFiles, safeSelectedIndex]
  );

  /**
   * Close the menu.
   */
  const closeMenu = useCallback(() => {
    setIsMenuOpen(false);
    setSearchQuery("");
  }, []);

  /**
   * Serialize text for LLM by replacing @filename with markdown link.
   * Format: [@filename](path/to/file.txt)
   * This allows the mention to be rendered as a clickable link in messages.
   */
  const serializeForLLM = useCallback(
    (text: string, mentions: FileMention[]): string => {
      if (mentions.length === 0) {
        return text;
      }

      let result = text;

      // Sort by filename length descending to avoid partial replacements
      const sorted = [...mentions].sort(
        (a, b) => b.filename.length - a.filename.length
      );

      for (const mention of sorted) {
        // Replace @filename with markdown link: [@filename](relativePath)
        result = result.replace(
          new RegExp(`@${escapeRegExp(mention.filename)}`, "g"),
          `[@${mention.filename}](${mention.relativePath})`
        );
      }

      return result;
    },
    []
  );

  /**
   * Create a FileMention from a FileCandidate.
   */
  const createMention = useCallback((file: FileCandidate): FileMention => {
    return {
      id: crypto.randomUUID(),
      filename: file.filename,
      relativePath: file.relativePath,
    };
  }, []);

  return {
    isMenuOpen,
    searchQuery,
    selectedIndex: safeSelectedIndex,
    filteredFiles,
    handleCursorChange,
    handleKeyDown,
    closeMenu,
    setSelectedIndex,
    serializeForLLM,
    createMention,
  };
}

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
