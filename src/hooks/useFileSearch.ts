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

  // Flatten hierarchical file tree into searchable array of files and directories
  const flatFiles = useMemo((): FileCandidate[] => {
    const result: FileCandidate[] = [];

    function flatten(nodes: FileNode[]) {
      for (const node of nodes) {
        if (node.isDirectory) {
          // Add directory to list
          result.push({
            filename: node.name,
            relativePath: node.path,
            isDirectory: true,
          });
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
            isDirectory: false,
          });
        }
      }
    }

    flatten(fileTree);
    return result;
  }, [fileTree]);

  /**
   * Search files by query (case-insensitive).
   * Matches against both filename and path.
   * Prioritizes: filename prefix > path contains > filename contains.
   * Within same priority, shorter paths come first.
   * Returns up to `limit` results (default 30).
   */
  const searchFiles = useCallback(
    (query: string, limit = 30): FileCandidate[] => {
      if (!query) {
        // Return first N files when no query, sorted by path length (shorter first)
        return [...flatFiles]
          .sort((a, b) => a.relativePath.length - b.relativePath.length)
          .slice(0, limit);
      }

      const lowerQuery = query.toLowerCase();

      // Score files:
      // - Filename prefix match = 4 (highest priority)
      // - Path contains query = 3 (useful for typing partial paths)
      // - Filename contains = 2
      // - Path segment match = 1
      const scored = flatFiles
        .map((file) => {
          const lowerFilename = file.filename.toLowerCase();
          const lowerPath = file.relativePath.toLowerCase();
          let score = 0;

          if (lowerFilename.startsWith(lowerQuery)) {
            score = 4; // Filename prefix match is highest priority
          } else if (lowerPath.includes(lowerQuery)) {
            score = 3; // Path contains query (e.g., typing "src/comp" matches src/components/)
          } else if (lowerFilename.includes(lowerQuery)) {
            score = 2; // Filename contains match
          }

          return { file, score };
        })
        .filter(({ score }) => score > 0);

      // Sort by score descending, then by path length (shorter = better)
      scored.sort((a, b) => {
        if (b.score !== a.score) {
          return b.score - a.score;
        }
        return a.file.relativePath.length - b.file.relativePath.length;
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
