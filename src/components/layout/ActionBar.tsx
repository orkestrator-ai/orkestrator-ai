import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { GitPullRequest, GitMerge, GitPullRequestClosed, ExternalLink, Loader2, SlidersHorizontal, Plus, Shield, Code2, FolderTree, Container, Eye, Upload, Play, Trash2, AlertTriangle, FolderGit2 } from "lucide-react";
import { ClaudeIcon, OpenCodeIcon, DockerIcon } from "@/components/icons/AgentIcons";
import { useUIStore, useEnvironmentStore, useProjectStore, useConfigStore, useFilesPanelStore } from "@/stores";
import { useShallow } from "zustand/react/shallow";
import { useTerminalContext, MAX_TABS } from "@/contexts";
import { usePullRequest, useProjects, useEnvironments } from "@/hooks";
import { RepositorySettings, SettingsPage } from "@/components/settings";
import { EnvironmentSettingsDialog } from "@/components/environments/EnvironmentSettingsDialog";
import { DockerStatsDialog } from "@/components/docker";
import * as tauri from "@/lib/tauri";

/**
 * Generates the prompt for the code review workflow.
 * This prompt instructs Claude to commit changes and perform a code review.
 */
function createReviewPrompt(targetBranch: string): string {
  return `You are performing a commit and code review workflow. Execute these steps in order:

## Step 1: Commit Changes

Based on the current git status and diff, create a single git commit:
1. Run \`git status --porcelain\` and \`git diff HEAD\` to see all changes
2. Add any untracked files that should be committed: \`git add <files>\`
3. Create a commit with a well-formatted message following conventional commit format
4. Do NOT reference Claude or add Claude as a contributor
5. Use this format for the commit message:
   - First line: type(scope): brief description
   - Blank line
   - Bullet points describing the changes

## Step 2: Code Review

Compare the current branch against \`${targetBranch}\` and conduct a thorough code review:
1. Run \`git diff ${targetBranch}...HEAD\` to see all changes since branching
2. Review the diff focusing on:
   - **Logic and correctness**: Check for bugs, edge cases, and potential issues
   - **Readability**: Is the code clear and maintainable? Does it follow repository patterns?
   - **Performance**: Are there obvious performance concerns or optimizations?
   - **Test coverage**: If the repo has testing patterns, are there adequate tests?
3. Ask clarifying questions if needed about unclear changes

## Output Format

After completing both steps:
1. Confirm the commit was created with its message
2. Provide a summary overview of the general code quality
3. List any identified issues in numbered sections with:
   - Title
   - File and line number(s)
   - Description of the issue
   - Code snippet (if relevant)
   - Potential solution(s)
4. If no issues found, state that the code meets best practices

Begin by running the git commands to understand the current state.`;
}

/**
 * Generates the prompt for the PR creation workflow.
 * This prompt instructs Claude to commit all changes, push, and create a PR.
 */
function createPRPrompt(targetBranch: string): string {
  return `You are performing a complete PR creation workflow. Execute these steps in order:

## Step 1: Stage All Changes

Add all files (including untracked files) to staging:
1. Run \`git status --porcelain\` to see all changes and untracked files
2. Run \`git add -A\` to stage ALL changes including untracked files
3. Verify with \`git status\` that everything is staged

## Step 2: Create Commit

Create a well-formatted commit with all staged changes:
1. Run \`git diff --cached\` to review what will be committed
2. Create a commit with a well-formatted message following conventional commit format:
   - First line: type(scope): brief description
   - Blank line
   - Bullet points describing the key changes
3. Do NOT reference Claude or add Claude as a contributor
4. Do NOT use --no-verify or skip any hooks

## Step 3: Push to Remote

Push the current branch to the remote:
1. Run \`git branch --show-current\` to get the current branch name
2. Push with: \`git push -u origin <branch-name>\`
3. If the push fails due to upstream changes, handle appropriately (pull --rebase if needed, then push again)

## Step 4: Create Pull Request

Create a PR against the \`${targetBranch}\` branch:
1. Run \`git diff ${targetBranch}...HEAD\` to see all changes that will be in the PR
2. Run \`git log ${targetBranch}..HEAD --oneline\` to see all commits
3. Create the PR using: \`gh pr create --base ${targetBranch} --fill\`
   - If --fill doesn't provide enough context, use --title and --body with a detailed description
4. The PR description should:
   - Summarize the key changes and their purpose
   - List the main features or fixes included
   - Note any breaking changes or migration steps if applicable

## Output

After completing all steps:
1. Confirm each step completed successfully
2. Provide the PR URL at the end so the user can review it

Begin by running git status to understand the current state.`;
}

/**
 * Generates the prompt for pushing changes to an existing PR.
 * This prompt instructs Claude to commit all changes and push to the current branch.
 */
function createPushChangesPrompt(): string {
  return `You are performing a commit and push workflow to update an existing PR. Execute these steps in order:

## Step 1: Stage All Changes

Add all files (including untracked files) to staging:
1. Run \`git status --porcelain\` to see all changes and untracked files
2. Run \`git add -A\` to stage ALL changes including untracked files
3. Verify with \`git status\` that everything is staged

## Step 2: Create Commit

Create a well-formatted commit with all staged changes:
1. Run \`git diff --cached\` to review what will be committed
2. Create a commit with a well-formatted message following conventional commit format:
   - First line: type(scope): brief description
   - Blank line
   - Bullet points describing the key changes
3. Do NOT reference Claude or add Claude as a contributor
4. Do NOT use --no-verify or skip any hooks

## Step 3: Push to Remote

Push the current branch to update the PR:
1. Run \`git branch --show-current\` to get the current branch name
2. Push with: \`git push\`
3. If the push fails due to upstream changes, handle appropriately (pull --rebase if needed, then push again)

## Output

After completing all steps:
1. Confirm each step completed successfully
2. Note that the PR has been updated with the new changes

Begin by running git status to understand the current state.`;
}

/**
 * Generates the prompt for resolving merge conflicts with the target branch.
 * This prompt instructs Claude to fetch, merge, resolve conflicts, and push.
 */
function createResolveConflictsPrompt(targetBranch: string): string {
  return `Resolve any merge conflicts with the target remote branch (${targetBranch}). Subsequently, commit and push all changes.

Execute these steps in order:

## Step 1: Fetch Latest Changes

1. Run \`git fetch origin\` to get the latest changes from remote
2. Run \`git status\` to understand the current state

## Step 2: Merge Target Branch

1. Run \`git merge origin/${targetBranch}\` to merge the target branch
2. If there are conflicts, they will be shown in the output

## Step 3: Resolve Conflicts

If there are merge conflicts:
1. Run \`git status\` to see which files have conflicts
2. For each conflicted file:
   - Read the file to understand the conflict markers (<<<<<<<, =======, >>>>>>>)
   - Analyze both versions and determine the correct resolution
   - Edit the file to resolve the conflict, removing all conflict markers
   - Ensure the resolved code is correct and functional
3. After resolving all conflicts, run \`git add -A\` to stage the resolved files

## Step 4: Complete the Merge

1. Create a merge commit with: \`git commit -m "Merge ${targetBranch} and resolve conflicts"\`
2. Do NOT use --no-verify or skip any hooks

## Step 5: Push Changes

1. Push the resolved changes: \`git push\`
2. If the push fails, handle appropriately

## Output

After completing all steps:
1. Summarize which files had conflicts and how they were resolved
2. Confirm the merge commit was created
3. Confirm the changes were pushed successfully

Begin by fetching the latest changes.`;
}

export function ActionBar() {
  const { selectedEnvironmentId, selectedProjectId } = useUIStore();
  const { getEnvironmentById, updateEnvironment, isWorkspaceReady } = useEnvironmentStore(
    useShallow((state) => ({
      getEnvironmentById: state.getEnvironmentById,
      updateEnvironment: state.updateEnvironment,
      isWorkspaceReady: state.isWorkspaceReady,
    }))
  );
  const { getProjectById } = useProjectStore();
  const { updateProject } = useProjects();
  const { config } = useConfigStore();
  const { createTab, selectTab, closeActiveTab, tabCount } = useTerminalContext();
  const { isOpen: filesPanelOpen, togglePanel: toggleFilesPanel, changes } = useFilesPanelStore();

  const [repoSettingsOpen, setRepoSettingsOpen] = useState(false);
  const [globalSettingsOpen, setGlobalSettingsOpen] = useState(false);
  const [envSettingsOpen, setEnvSettingsOpen] = useState(false);
  const [dockerStatsOpen, setDockerStatsOpen] = useState(false);
  const [isOpeningEditor, setIsOpeningEditor] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [runCommands, setRunCommands] = useState<string[] | null>(null);
  const [isLoadingRunCommands, setIsLoadingRunCommands] = useState(false);
  const [cleanupDialogOpen, setCleanupDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [cleanupError, setCleanupError] = useState<string | null>(null);
  const [mergeDialogOpen, setMergeDialogOpen] = useState(false);
  const [isMerging, setIsMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);

  // Drag-to-scroll state for toolbar
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [startX, setStartX] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);

  const selectedEnvironment = selectedEnvironmentId
    ? getEnvironmentById(selectedEnvironmentId)
    : null;
  const selectedProject = selectedProjectId
    ? getProjectById(selectedProjectId)
    : null;

  const repoName = selectedProject?.name ?? null;
  const isLocalEnvironment = selectedEnvironment?.environmentType === "local";
  const isLocalReady = isLocalEnvironment && !!selectedEnvironment?.worktreePath;
  const isRunning = isLocalReady || selectedEnvironment?.status === "running";
  const workspaceReady = selectedEnvironmentId ? isWorkspaceReady(selectedEnvironmentId) : false;

  const { prUrl, prState, hasMergeConflicts, viewPR, setModeCreatePending, setModeMergePending } = usePullRequest({
    environmentId: selectedEnvironmentId,
  });

  const { deleteEnvironment } = useEnvironments(selectedProjectId);

  const hasPR = !!prUrl;
  const isPRMerged = prState === "merged";
  const isPRClosed = prState === "closed";
  const isPRFinished = isPRMerged || isPRClosed;
  const canCreateTab = !!createTab && tabCount < MAX_TABS;
  // For containers, we need containerId; for local environments, we need worktreePath
  const canOpenEditor = isRunning && (
    (isLocalEnvironment && !!selectedEnvironment?.worktreePath) ||
    (!isLocalEnvironment && !!selectedEnvironment?.containerId)
  );

  // Handler for opening in editor
  const handleOpenInEditor = useCallback(async () => {
    // For local environments, use worktreePath; for containers, use containerId
    if (isLocalEnvironment) {
      if (!selectedEnvironment?.worktreePath) return;
    } else {
      if (!selectedEnvironment?.containerId) return;
    }

    setIsOpeningEditor(true);
    setEditorError(null);
    try {
      const editor = config.global.preferredEditor || "vscode";
      if (isLocalEnvironment) {
        await tauri.openLocalInEditor(selectedEnvironment!.worktreePath!, editor);
      } else {
        await tauri.openInEditor(selectedEnvironment!.containerId!, editor);
      }
    } catch (err) {
      console.error("[ActionBar] Failed to open editor:", err);
      const errorMessage = err instanceof Error ? err.message : String(err);
      setEditorError(errorMessage);
    } finally {
      setIsOpeningEditor(false);
    }
  }, [selectedEnvironment?.containerId, selectedEnvironment?.worktreePath, isLocalEnvironment, config.global.preferredEditor]);

  // Get the default agent from global config
  const defaultAgent = config.global.defaultAgent || "claude";

  // Handler for code review
  const handleReview = useCallback(() => {
    if (!createTab || !selectedProjectId || !canCreateTab) return;

    const repoConfig = config.repositories[selectedProjectId];
    const targetBranch = repoConfig?.prBaseBranch || "main";
    const reviewPrompt = createReviewPrompt(targetBranch);

    createTab(defaultAgent, { initialPrompt: reviewPrompt });
  }, [createTab, selectedProjectId, canCreateTab, config.repositories, defaultAgent]);

  // Load run commands from orkestrator-ai.json when workspace is ready
  useEffect(() => {
    // For container environments, we need containerId
    // For local environments, we need worktreePath
    const hasContainer = !isLocalEnvironment && !!selectedEnvironment?.containerId;
    const hasWorktree = isLocalEnvironment && !!selectedEnvironment?.worktreePath;

    if ((!hasContainer && !hasWorktree) || !isRunning || !workspaceReady) {
      setRunCommands(null);
      return;
    }

    let cancelled = false;
    setIsLoadingRunCommands(true);

    const readConfigPromise = isLocalEnvironment
      ? tauri.readLocalFile(selectedEnvironment!.worktreePath!, "orkestrator-ai.json")
      : tauri.readContainerFile(selectedEnvironment!.containerId!, "orkestrator-ai.json");

    readConfigPromise
      .then((result) => {
        if (cancelled) return;
        try {
          const config = JSON.parse(result.content);
          if (Array.isArray(config.run) && config.run.length > 0) {
            setRunCommands(config.run);
          } else {
            setRunCommands(null);
          }
        } catch {
          setRunCommands(null);
        }
      })
      .catch((error) => {
        console.error("[ActionBar] Failed to read orkestrator-ai.json:", error);
        if (!cancelled) {
          setRunCommands(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingRunCommands(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedEnvironment?.containerId, selectedEnvironment?.worktreePath, isLocalEnvironment, isRunning, workspaceReady]);

  // Handler for run commands
  const handleRun = useCallback(() => {
    if (!createTab || !canCreateTab || !runCommands || runCommands.length === 0) return;

    createTab("plain", { initialCommands: runCommands });
  }, [createTab, canCreateTab, runCommands]);

  const hasRunCommands = runCommands && runCommands.length > 0;

  // Drag-to-scroll handlers for toolbar
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const container = scrollContainerRef.current;
    if (!container) return;

    setIsDragging(true);
    setStartX(e.pageX - container.offsetLeft);
    setScrollLeft(container.scrollLeft);
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging) return;
    const container = scrollContainerRef.current;
    if (!container) return;

    e.preventDefault();
    const x = e.pageX - container.offsetLeft;
    const walk = (x - startX) * 1.5; // Multiplier for scroll speed
    container.scrollLeft = scrollLeft - walk;
  }, [isDragging, startX, scrollLeft]);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  const handleMouseLeave = useCallback(() => {
    setIsDragging(false);
  }, []);

  // Keyboard shortcuts for terminal tabs
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Handle Ctrl+number for tab selection (1-9) - works on all platforms
      // Using Ctrl specifically to avoid conflicts with ⌘+number on Mac (used for other OS shortcuts)
      // Note: selectTab internally bounds-checks against the active pane's tab count
      if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        // Use e.code (physical key) as primary since e.key can vary with keyboard layouts
        // e.code is "Digit1", "Digit2", etc. for number keys
        let num = NaN;
        if (e.code?.startsWith("Digit")) {
          num = parseInt(e.code.slice(5), 10);
        } else {
          // Fallback to e.key for compatibility
          num = parseInt(e.key, 10);
        }

        if (num >= 1 && num <= 9 && selectTab) {
          e.preventDefault();
          selectTab(num - 1); // Convert to 0-based index
          return;
        }
      }

      // ⌘ shortcuts on Mac only to avoid conflicts
      // (Ctrl+T/N/O are commonly used by browsers and other apps on Windows/Linux)
      if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;

      switch (e.key.toLowerCase()) {
        case "t":
          if (canCreateTab) {
            e.preventDefault();
            createTab?.("plain");
          }
          break;
        case "n":
          if (canCreateTab) {
            e.preventDefault();
            createTab?.("claude");
          }
          break;
        case "m":
          if (canCreateTab) {
            e.preventDefault();
            createTab?.("opencode");
          }
          break;
        case "o":
          if (canOpenEditor) {
            e.preventDefault();
            handleOpenInEditor();
          }
          break;
        case "w":
          // Close active tab - always prevent default to avoid closing window
          if (closeActiveTab && tabCount > 0) {
            e.preventDefault();
            closeActiveTab();
          }
          break;
        case "e":
          // Toggle files panel
          if (selectedEnvironment) {
            e.preventDefault();
            toggleFilesPanel();
          }
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [createTab, selectTab, closeActiveTab, tabCount, canCreateTab, canOpenEditor, handleOpenInEditor, selectedEnvironment, toggleFilesPanel]);

  // Handler for PR creation - launches agent tab with PR workflow prompt
  const handleCreatePR = useCallback(() => {
    if (!createTab || !selectedProjectId || !canCreateTab) return;

    const repoConfig = config.repositories[selectedProjectId];
    const targetBranch = repoConfig?.prBaseBranch || "main";
    const prPrompt = createPRPrompt(targetBranch);

    // Set monitoring mode to create-pending for faster PR detection (5s intervals)
    setModeCreatePending();

    createTab(defaultAgent, { initialPrompt: prPrompt });
  }, [createTab, selectedProjectId, canCreateTab, config.repositories, defaultAgent, setModeCreatePending]);

  // Handler for pushing changes to an existing PR - launches agent tab with commit/push prompt
  const handlePushChanges = useCallback(() => {
    if (!createTab || !canCreateTab) return;

    const pushPrompt = createPushChangesPrompt();
    createTab(defaultAgent, { initialPrompt: pushPrompt });
  }, [createTab, canCreateTab, defaultAgent]);

  // Handler for resolving merge conflicts - launches agent tab with conflict resolution prompt
  const handleResolveConflicts = useCallback(() => {
    if (!createTab || !selectedProjectId || !canCreateTab) return;

    const repoConfig = config.repositories[selectedProjectId];
    const targetBranch = repoConfig?.prBaseBranch || "main";
    const resolvePrompt = createResolveConflictsPrompt(targetBranch);

    createTab(defaultAgent, { initialPrompt: resolvePrompt });
  }, [createTab, selectedProjectId, canCreateTab, config.repositories, defaultAgent]);

  // Handler for cleaning up (deleting) an environment after PR is merged/closed
  const handleCleanup = useCallback(async () => {
    if (!selectedEnvironmentId) return;

    setIsDeleting(true);
    setCleanupError(null);
    try {
      await deleteEnvironment(selectedEnvironmentId);
      setCleanupDialogOpen(false);
    } catch (err) {
      console.error("[ActionBar] Failed to delete environment:", err);
      const message = err instanceof Error ? err.message : "An unexpected error occurred";
      setCleanupError(message);
    } finally {
      setIsDeleting(false);
    }
  }, [selectedEnvironmentId, deleteEnvironment]);

  // Handler for merging a PR
  const handleMergePR = useCallback(async () => {
    if (!selectedEnvironmentId || !prUrl) return;

    // For container environments, we need a containerId
    // For local environments, we use the environmentId
    if (!isLocalEnvironment && !selectedEnvironment?.containerId) return;

    // Close dialog immediately and show spinner on main button
    setMergeDialogOpen(false);
    setIsMerging(true);
    setMergeError(null);

    try {
      // Use appropriate merge method based on environment type
      console.log("[ActionBar] Starting PR merge...");
      if (isLocalEnvironment) {
        await tauri.mergePrLocal(selectedEnvironmentId, "squash", true);
      } else {
        await tauri.mergePr(selectedEnvironment!.containerId!, "squash", true);
      }
      console.log("[ActionBar] Merge command completed, starting merge-pending monitoring...");

      // Set monitoring mode to merge-pending for fast PR state detection (1s intervals for 20s)
      // The prMonitorService will automatically detect when PR is merged and update the state
      setModeMergePending();

      // Clear the merging spinner - the PR state will update automatically via monitoring
      setIsMerging(false);

    } catch (err) {
      console.error("[ActionBar] Failed to merge PR:", err);
      // Tauri invoke errors come as strings, not Error objects
      const message = err instanceof Error ? err.message : typeof err === "string" ? err : "An unexpected error occurred";
      setMergeError(message);
      setMergeDialogOpen(true); // Re-open dialog to show error
      setIsMerging(false);
    }
  }, [selectedEnvironment?.containerId, selectedEnvironmentId, prUrl, isLocalEnvironment, setModeMergePending]);

  return (
    <>
      <div className="flex h-12 items-center border-b border-border bg-card">
        {/* Scrollable toolbar area */}
        <div
          ref={scrollContainerRef}
          className={`flex min-w-0 flex-1 items-center gap-2 overflow-x-auto px-4 [&::-webkit-scrollbar]:hidden ${isDragging ? "cursor-grabbing select-none" : ""}`}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseLeave}
          style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
        >
          {/* Left side: Controls */}
          <div className="flex shrink-0 items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => setGlobalSettingsOpen(true)}
              >
                <SlidersHorizontal className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Global settings</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => setDockerStatsOpen(true)}
              >
                <DockerIcon className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Docker configuration</TooltipContent>
          </Tooltip>

          {repoName && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => setRepoSettingsOpen(true)}
                >
                  <FolderGit2 className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Repository settings</TooltipContent>
            </Tooltip>
          )}

          {selectedEnvironment && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => setEnvSettingsOpen(true)}
                >
                  <Container className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Environment settings</TooltipContent>
            </Tooltip>
          )}

          {/* Terminal tab buttons */}
          {selectedEnvironment && (
            <>
              <div className="mx-2 h-4 w-px bg-border" />
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => createTab?.("plain")}
                    disabled={!canCreateTab}
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>New Terminal Tab</p>
                  <p className="text-xs text-muted-foreground">⌘T</p>
                </TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => createTab?.("root")}
                    disabled={!canCreateTab}
                  >
                    <Shield className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>New Root Terminal</p>
                  <p className="text-xs text-red-500">Full root privileges inside container</p>
                </TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => createTab?.("claude")}
                    disabled={!canCreateTab}
                  >
                    <ClaudeIcon className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>New Tab with Claude</p>
                  <p className="text-xs text-muted-foreground">⌘N</p>
                </TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => createTab?.("opencode")}
                    disabled={!canCreateTab}
                  >
                    <OpenCodeIcon className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>New Tab with OpenCode</p>
                  <p className="text-xs text-muted-foreground">⌘M</p>
                </TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={handleReview}
                    disabled={!canCreateTab}
                  >
                    <Eye className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Code Review</p>
                  <p className="text-xs text-muted-foreground">Commit changes and review code</p>
                </TooltipContent>
              </Tooltip>

              {/* Play Button - Run Commands */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={handleRun}
                    disabled={!canCreateTab || isLoadingRunCommands || !hasRunCommands}
                  >
                    {isLoadingRunCommands ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Play className="h-4 w-4" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Run Commands</p>
                  <p className="text-xs text-muted-foreground">
                    {hasRunCommands
                      ? "Execute run commands from orkestrator-ai.json"
                      : "Add 'run' array to orkestrator-ai.json to enable"}
                  </p>
                </TooltipContent>
              </Tooltip>

              <div className="mx-2 h-4 w-px bg-border" />

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={handleOpenInEditor}
                    disabled={!canOpenEditor || isOpeningEditor}
                  >
                    {isOpeningEditor ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Code2 className="h-4 w-4" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Open in {config.global.preferredEditor === "cursor" ? "Cursor" : "VS Code"}</p>
                  <p className="text-xs text-muted-foreground">⌘O</p>
                </TooltipContent>
              </Tooltip>

              <div className="mx-2 h-4 w-px bg-border" />
            </>
          )}

          {selectedEnvironment && !hasPR && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="default"
                  size="sm"
                  className="gap-2"
                  onClick={handleCreatePR}
                  disabled={!isRunning || !canCreateTab}
                >
                  <GitPullRequest className="h-4 w-4" />
                  Create PR
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {!isRunning
                  ? "Container must be running"
                  : !canCreateTab
                    ? "Maximum tabs reached"
                    : "Launch agent to create a pull request"}
              </TooltipContent>
            </Tooltip>
          )}

          {selectedEnvironment && hasPR && (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant={isPRFinished ? "secondary" : "outline"}
                    size="sm"
                    className="gap-2"
                    onClick={viewPR}
                  >
                    {isPRMerged ? (
                      <GitMerge className="h-4 w-4" />
                    ) : isPRClosed ? (
                      <GitPullRequestClosed className="h-4 w-4" />
                    ) : (
                      <ExternalLink className="h-4 w-4" />
                    )}
                    {isPRMerged ? "PR Merged" : isPRClosed ? "PR Closed" : "View PR"}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {isPRMerged
                    ? "PR has been merged - click to view"
                    : isPRClosed
                      ? "PR was closed without merging - click to view"
                      : "Open PR in browser"}
                </TooltipContent>
              </Tooltip>

              {!isPRFinished && hasMergeConflicts === false && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="default"
                      size="sm"
                      className="gap-2 bg-green-600 text-white hover:bg-green-700"
                      onClick={() => !isMerging && setMergeDialogOpen(true)}
                      disabled={!isRunning || isMerging}
                    >
                      {isMerging ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Merging...
                        </>
                      ) : (
                        <>
                          <GitMerge className="h-4 w-4" />
                          Merge PR
                        </>
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {isMerging
                      ? "Merge in progress..."
                      : !isRunning
                        ? (isLocalEnvironment ? "Environment must be ready" : "Container must be running")
                        : "Squash and merge this PR"}
                  </TooltipContent>
                </Tooltip>
              )}

              {!isPRFinished && hasMergeConflicts && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="destructive"
                      size="sm"
                      className="gap-2"
                      onClick={handleResolveConflicts}
                      disabled={!isRunning || !canCreateTab}
                    >
                      <AlertTriangle className="h-4 w-4" />
                      Resolve
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {!isRunning
                      ? (isLocalEnvironment ? "Environment must be ready" : "Container must be running")
                      : !canCreateTab
                        ? "Maximum tabs reached"
                        : "PR has merge conflicts - launch agent to resolve them"}
                  </TooltipContent>
                </Tooltip>
              )}

              {isPRFinished && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="destructive"
                      size="sm"
                      className="gap-2"
                      onClick={() => setCleanupDialogOpen(true)}
                    >
                      <Trash2 className="h-4 w-4" />
                      Clean Up
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    Delete this environment (PR is {isPRMerged ? "merged" : "closed"})
                  </TooltipContent>
                </Tooltip>
              )}

              {!isPRFinished && changes.length > 0 && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="default"
                      size="sm"
                      className="gap-2"
                      onClick={handlePushChanges}
                      disabled={!isRunning || !canCreateTab}
                    >
                      <Upload className="h-4 w-4" />
                      Push Changes
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {!isRunning
                      ? "Container must be running"
                      : !canCreateTab
                        ? "Maximum tabs reached"
                        : "Launch agent to commit and push changes"}
                  </TooltipContent>
                </Tooltip>
              )}
            </>
          )}
        </div>

          {/* Spacer to push right side content to the end */}
          <div className="min-w-4 flex-1" />

          {/* Right side: Repo name and Files toggle */}
          <div className="flex shrink-0 items-center gap-2">
            {repoName ? (
              <span className="whitespace-nowrap text-sm font-medium text-foreground">
                {repoName}
              </span>
            ) : (
              <span className="whitespace-nowrap text-sm text-muted-foreground">
                Select an environment to get started
              </span>
            )}

            {selectedEnvironment && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant={filesPanelOpen ? "secondary" : "ghost"}
                    size="icon"
                    className="relative h-8 w-8"
                    onClick={toggleFilesPanel}
                  >
                    <FolderTree className="h-4 w-4" />
                    {changes.length > 0 && !filesPanelOpen && (
                      <span className="absolute right-0.5 top-0.5 h-2 w-2 rounded-full bg-primary" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{filesPanelOpen ? "Hide" : "Show"} file panel</p>
                  <p className="text-xs text-muted-foreground">⌘E</p>
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>
      </div>

      {/* Settings Dialogs */}
      <SettingsPage open={globalSettingsOpen} onOpenChange={setGlobalSettingsOpen} />
      <DockerStatsDialog open={dockerStatsOpen} onOpenChange={setDockerStatsOpen} />

      {selectedProject && (
        <RepositorySettings
          project={selectedProject}
          open={repoSettingsOpen}
          onOpenChange={setRepoSettingsOpen}
          onUpdateProject={updateProject}
        />
      )}

      {selectedEnvironment && (
        <EnvironmentSettingsDialog
          open={envSettingsOpen}
          onOpenChange={setEnvSettingsOpen}
          environment={selectedEnvironment}
          onUpdate={(updated) => updateEnvironment(updated.id, updated)}
          onRestart={tauri.recreateEnvironment}
        />
      )}

      {/* Editor Error Dialog */}
      <AlertDialog open={!!editorError} onOpenChange={() => setEditorError(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Failed to Open Editor</AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              <p>{editorError}</p>
              <p className="text-xs">
                Make sure you have the {config.global.preferredEditor === "cursor" ? "Cursor" : "VS Code"} CLI
                installed and the Dev Containers extension is enabled.
              </p>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setEditorError(null)}>OK</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Cleanup Environment Confirmation Dialog */}
      <AlertDialog
        open={cleanupDialogOpen}
        onOpenChange={(open) => {
          setCleanupDialogOpen(open);
          if (!open) setCleanupError(null); // Clear error when closing
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clean Up Environment</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the environment "{selectedEnvironment?.name}".
              The PR has been {isPRMerged ? "merged" : "closed"}, so this environment is no longer needed.
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {cleanupError && (
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              Failed to delete environment: {cleanupError}
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleCleanup}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Deleting...
                </>
              ) : (
                "Delete Environment"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Merge PR Confirmation Dialog */}
      <AlertDialog
        open={mergeDialogOpen}
        onOpenChange={(open) => {
          setMergeDialogOpen(open);
          if (!open) setMergeError(null); // Clear error when closing
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Merge Pull Request</AlertDialogTitle>
            <AlertDialogDescription>
              This will squash and merge your PR into the target branch.
              The feature branch will be deleted after merging.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {mergeError && (
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              Failed to merge PR: {mergeError}
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleMergePR}
              className="bg-green-600 text-white hover:bg-green-700"
            >
              Merge PR
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
