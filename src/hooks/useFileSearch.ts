import { useState, useEffect, useMemo, useCallback } from "react";
import { getFileTree, getLocalFileTree, type FileNode } from "@/lib/tauri";
import type { FileCandidate } from "@/types";

/**
 * Hook for loading and searching workspace files for @ mentions.
 * Supports both containerized (Docker) and local (worktree) environments.
 */
export function useFileSearch(
  containerId: string | undefined,
  worktreePath: string | undefined
) {
  const [fileTree, setFileTree] = useState<FileNode[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Determine if environment is available
  const isAvailable = !!(containerId || worktreePath);

  // Load file tree from environment
  const loadFileTree = useCallback(async () => {
    if (!isAvailable) {
      setFileTree([]);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      let tree: FileNode[] = [];
      if (worktreePath) {
        // Local environment - use local file tree command
        tree = await getLocalFileTree(worktreePath);
      } else if (containerId) {
        // Container environment - use container file tree command
        tree = await getFileTree(containerId);
      }
      setFileTree(tree);
    } catch (err) {
      console.error("[useFileSearch] Failed to load file tree:", err);
      setError(err instanceof Error ? err.message : "Failed to load files");
      setFileTree([]);
    } finally {
      setIsLoading(false);
    }
  }, [isAvailable, containerId, worktreePath]);

  // Load file tree on mount and when environment changes
  useEffect(() => {
    loadFileTree();
  }, [loadFileTree]);

  // Flatten hierarchical file tree into searchable array of files only (no directories)
  const flatFiles = useMemo((): FileCandidate[] => {
    const result: FileCandidate[] = [];

    function flatten(nodes: FileNode[]) {
      for (const node of nodes) {
        if (node.isDirectory) {
          // Recurse into directories
          if (node.children) {
            flatten(node.children);
          }
        } else {
          // Add file to flat list
          result.push({
            filename: node.name,
            relativePath: node.path,
            extension: node.extension,
          });
        }
      }
    }

    flatten(fileTree);
    return result;
  }, [fileTree]);

  /**
   * Search files by query (case-insensitive).
   * Prioritizes: exact prefix match > contains match.
   * Returns up to `limit` results (default 8).
   */
  const searchFiles = useCallback(
    (query: string, limit = 8): FileCandidate[] => {
      if (!query) {
        // Return first N files when no query
        return flatFiles.slice(0, limit);
      }

      const lowerQuery = query.toLowerCase();

      // Score files: prefix match = 2, contains = 1
      const scored = flatFiles
        .map((file) => {
          const lowerFilename = file.filename.toLowerCase();
          let score = 0;

          if (lowerFilename.startsWith(lowerQuery)) {
            score = 2; // Prefix match is highest priority
          } else if (lowerFilename.includes(lowerQuery)) {
            score = 1; // Contains match
          }

          return { file, score };
        })
        .filter(({ score }) => score > 0);

      // Sort by score descending, then by filename length (shorter = better)
      scored.sort((a, b) => {
        if (b.score !== a.score) {
          return b.score - a.score;
        }
        return a.file.filename.length - b.file.filename.length;
      });

      return scored.slice(0, limit).map(({ file }) => file);
    },
    [flatFiles]
  );

  return {
    flatFiles,
    searchFiles,
    isLoading,
    error,
    refresh: loadFileTree,
    isAvailable,
  };
}
