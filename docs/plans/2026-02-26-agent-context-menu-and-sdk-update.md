# Agent Context Menu & SDK Update Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** (1) Add right-click context menus to all agent-driven action buttons allowing Claude/OpenCode selection, (2) update Claude Agent SDK to latest, (3) add clickable queue dialog to Claude native compose bar (matching OpenCode native).

**Architecture:** Wrap 4 agent-action buttons in `ContextMenu`. Add `removeQueueItem` and `moveQueueItem` to Claude store. Add queue dialog to Claude compose bar with reorder/remove/click-to-edit. SDK version bump.

**Tech Stack:** React, shadcn/ui ContextMenu (Radix), Tailwind CSS, Bun

---

### Task 1: Update Claude Agent SDK

**Files:**
- Modify: `docker/claude-bridge/package.json:13`

**Step 1: Bump the SDK version**

In `docker/claude-bridge/package.json`, change line 13:

```json
"@anthropic-ai/claude-agent-sdk": "^0.2.59",
```

**Step 2: Install updated dependency**

Run: `cd docker/claude-bridge && bun install`

Expected: Lockfile updated, no errors.

**Step 3: Verify no type errors**

Run: `cd docker/claude-bridge && bunx tsc --noEmit`

Expected: No type errors (API is backward-compatible).

**Step 4: Commit**

```bash
git add docker/claude-bridge/package.json docker/claude-bridge/bun.lock
git commit -m "chore(deps): update claude-agent-sdk to ^0.2.59"
```

---

### Task 2: Refactor action handlers to accept agent override

**Files:**
- Modify: `src/components/layout/ActionBar.tsx`

The 4 handlers (`handleReview`, `handleCreatePR`, `handlePushChanges`, `handleResolveConflicts`) currently hardcode `defaultAgent`. Refactor each to accept an optional `agentOverride` parameter so context menu items can pass `"claude"` or `"opencode"` explicitly.

**Step 1: Refactor `handleReview` to accept agent override**

Change `handleReview` (around line 318) from:

```typescript
const handleReview = useCallback(() => {
  if (!createTab || !selectedProjectId || !canCreateTab) return;

  const repoConfig = config.repositories[selectedProjectId];
  const targetBranch = repoConfig?.prBaseBranch || "main";
  const reviewPrompt = createReviewPrompt(targetBranch);

  createTab(defaultAgent, { initialPrompt: reviewPrompt });
}, [createTab, selectedProjectId, canCreateTab, config.repositories, defaultAgent]);
```

To:

```typescript
const handleReview = useCallback((agentOverride?: "claude" | "opencode") => {
  if (!createTab || !selectedProjectId || !canCreateTab) return;

  const repoConfig = config.repositories[selectedProjectId];
  const targetBranch = repoConfig?.prBaseBranch || "main";
  const reviewPrompt = createReviewPrompt(targetBranch);

  createTab(agentOverride || defaultAgent, { initialPrompt: reviewPrompt });
}, [createTab, selectedProjectId, canCreateTab, config.repositories, defaultAgent]);
```

**Step 2: Refactor `handleCreatePR` to accept agent override**

Change `handleCreatePR` (around line 529) from:

```typescript
const handleCreatePR = useCallback(() => {
  if (!createTab || !selectedProjectId || !canCreateTab) return;

  const repoConfig = config.repositories[selectedProjectId];
  const targetBranch = repoConfig?.prBaseBranch || "main";
  const prPrompt = createPRPrompt(targetBranch);

  setModeCreatePending();

  createTab(defaultAgent, { initialPrompt: prPrompt });
}, [createTab, selectedProjectId, canCreateTab, config.repositories, defaultAgent, setModeCreatePending]);
```

To:

```typescript
const handleCreatePR = useCallback((agentOverride?: "claude" | "opencode") => {
  if (!createTab || !selectedProjectId || !canCreateTab) return;

  const repoConfig = config.repositories[selectedProjectId];
  const targetBranch = repoConfig?.prBaseBranch || "main";
  const prPrompt = createPRPrompt(targetBranch);

  setModeCreatePending();

  createTab(agentOverride || defaultAgent, { initialPrompt: prPrompt });
}, [createTab, selectedProjectId, canCreateTab, config.repositories, defaultAgent, setModeCreatePending]);
```

**Step 3: Refactor `handlePushChanges` to accept agent override**

Change `handlePushChanges` (around line 543) from:

```typescript
const handlePushChanges = useCallback(() => {
  if (!createTab || !canCreateTab) return;

  const pushPrompt = createPushChangesPrompt();
  createTab(defaultAgent, { initialPrompt: pushPrompt });
}, [createTab, canCreateTab, defaultAgent]);
```

To:

```typescript
const handlePushChanges = useCallback((agentOverride?: "claude" | "opencode") => {
  if (!createTab || !canCreateTab) return;

  const pushPrompt = createPushChangesPrompt();
  createTab(agentOverride || defaultAgent, { initialPrompt: pushPrompt });
}, [createTab, canCreateTab, defaultAgent]);
```

**Step 4: Refactor `handleResolveConflicts` to accept agent override**

Change `handleResolveConflicts` (around line 551) from:

```typescript
const handleResolveConflicts = useCallback(() => {
  if (!createTab || !selectedProjectId || !canCreateTab) return;

  const repoConfig = config.repositories[selectedProjectId];
  const targetBranch = repoConfig?.prBaseBranch || "main";
  const resolvePrompt = createResolveConflictsPrompt(targetBranch);

  createTab(defaultAgent, { initialPrompt: resolvePrompt });
}, [createTab, selectedProjectId, canCreateTab, config.repositories, defaultAgent]);
```

To:

```typescript
const handleResolveConflicts = useCallback((agentOverride?: "claude" | "opencode") => {
  if (!createTab || !selectedProjectId || !canCreateTab) return;

  const repoConfig = config.repositories[selectedProjectId];
  const targetBranch = repoConfig?.prBaseBranch || "main";
  const resolvePrompt = createResolveConflictsPrompt(targetBranch);

  createTab(agentOverride || defaultAgent, { initialPrompt: resolvePrompt });
}, [createTab, selectedProjectId, canCreateTab, config.repositories, defaultAgent]);
```

**Step 5: Update keyboard shortcut to call handleReview with no override**

The existing `handleReview()` call in the keyboard handler (line 477) works as-is since `agentOverride` is optional and defaults to `defaultAgent`.

**Step 6: Commit**

```bash
git add src/components/layout/ActionBar.tsx
git commit -m "refactor(actionbar): add agent override parameter to action handlers"
```

---

### Task 3: Add ContextMenu imports to ActionBar

**Files:**
- Modify: `src/components/layout/ActionBar.tsx` (top of file)

**Step 1: Add the ContextMenu imports**

Add after the existing AlertDialog import block (around line 17):

```typescript
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
```

**Step 2: Commit**

```bash
git add src/components/layout/ActionBar.tsx
git commit -m "feat(actionbar): add context menu imports"
```

---

### Task 4: Wrap Code Review button in ContextMenu

**Files:**
- Modify: `src/components/layout/ActionBar.tsx`

**Step 1: Wrap the Eye button (Code Review) in a ContextMenu**

Replace the Code Review button block (around lines 789-806):

```tsx
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
    <p className="text-xs text-muted-foreground">⌘R</p>
  </TooltipContent>
</Tooltip>
```

With:

```tsx
<ContextMenu>
  <Tooltip>
    <ContextMenuTrigger asChild>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={() => handleReview()}
          disabled={!canCreateTab}
        >
          <Eye className="h-4 w-4" />
        </Button>
      </TooltipTrigger>
    </ContextMenuTrigger>
    <TooltipContent>
      <p>Code Review</p>
      <p className="text-xs text-muted-foreground">Commit changes and review code</p>
      <p className="text-xs text-muted-foreground">⌘R &middot; Right-click for agent</p>
    </TooltipContent>
  </Tooltip>
  <ContextMenuContent>
    <ContextMenuItem onClick={() => handleReview("claude")}>
      <ClaudeIcon className="h-4 w-4" />
      Review with Claude
    </ContextMenuItem>
    <ContextMenuItem onClick={() => handleReview("opencode")}>
      <OpenCodeIcon className="h-4 w-4" />
      Review with OpenCode
    </ContextMenuItem>
  </ContextMenuContent>
</ContextMenu>
```

**Step 2: Verify the app compiles**

Run: `bunx tsc --noEmit`

Expected: No type errors.

**Step 3: Commit**

```bash
git add src/components/layout/ActionBar.tsx
git commit -m "feat(actionbar): add agent context menu to code review button"
```

---

### Task 5: Wrap Create PR button in ContextMenu

**Files:**
- Modify: `src/components/layout/ActionBar.tsx`

**Step 1: Wrap the Create PR button**

Replace the Create PR button block (around lines 864-886):

```tsx
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
```

With:

```tsx
<ContextMenu>
  <Tooltip>
    <ContextMenuTrigger asChild>
      <TooltipTrigger asChild>
        <Button
          variant="default"
          size="sm"
          className="gap-2"
          onClick={() => handleCreatePR()}
          disabled={!isRunning || !canCreateTab}
        >
          <GitPullRequest className="h-4 w-4" />
          Create PR
        </Button>
      </TooltipTrigger>
    </ContextMenuTrigger>
    <TooltipContent>
      {!isRunning
        ? "Container must be running"
        : !canCreateTab
          ? "Maximum tabs reached"
          : "Launch agent to create a pull request (right-click for agent)"}
    </TooltipContent>
  </Tooltip>
  <ContextMenuContent>
    <ContextMenuItem onClick={() => handleCreatePR("claude")}>
      <ClaudeIcon className="h-4 w-4" />
      Create PR with Claude
    </ContextMenuItem>
    <ContextMenuItem onClick={() => handleCreatePR("opencode")}>
      <OpenCodeIcon className="h-4 w-4" />
      Create PR with OpenCode
    </ContextMenuItem>
  </ContextMenuContent>
</ContextMenu>
```

**Step 2: Commit**

```bash
git add src/components/layout/ActionBar.tsx
git commit -m "feat(actionbar): add agent context menu to create PR button"
```

---

### Task 6: Wrap Push Changes button in ContextMenu

**Files:**
- Modify: `src/components/layout/ActionBar.tsx`

**Step 1: Wrap the Push Changes button**

Replace the Push Changes button block (around lines 993-1015):

```tsx
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
```

With:

```tsx
<ContextMenu>
  <Tooltip>
    <ContextMenuTrigger asChild>
      <TooltipTrigger asChild>
        <Button
          variant="default"
          size="sm"
          className="gap-2"
          onClick={() => handlePushChanges()}
          disabled={!isRunning || !canCreateTab}
        >
          <Upload className="h-4 w-4" />
          Push Changes
        </Button>
      </TooltipTrigger>
    </ContextMenuTrigger>
    <TooltipContent>
      {!isRunning
        ? "Container must be running"
        : !canCreateTab
          ? "Maximum tabs reached"
          : "Launch agent to commit and push changes (right-click for agent)"}
    </TooltipContent>
  </Tooltip>
  <ContextMenuContent>
    <ContextMenuItem onClick={() => handlePushChanges("claude")}>
      <ClaudeIcon className="h-4 w-4" />
      Push with Claude
    </ContextMenuItem>
    <ContextMenuItem onClick={() => handlePushChanges("opencode")}>
      <OpenCodeIcon className="h-4 w-4" />
      Push with OpenCode
    </ContextMenuItem>
  </ContextMenuContent>
</ContextMenu>
```

**Step 2: Commit**

```bash
git add src/components/layout/ActionBar.tsx
git commit -m "feat(actionbar): add agent context menu to push changes button"
```

---

### Task 7: Wrap Resolve Conflicts button in ContextMenu

**Files:**
- Modify: `src/components/layout/ActionBar.tsx`

**Step 1: Wrap the Resolve Conflicts button**

Replace the Resolve Conflicts button block (around lines 950-972):

```tsx
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
```

With:

```tsx
<ContextMenu>
  <Tooltip>
    <ContextMenuTrigger asChild>
      <TooltipTrigger asChild>
        <Button
          variant="destructive"
          size="sm"
          className="gap-2"
          onClick={() => handleResolveConflicts()}
          disabled={!isRunning || !canCreateTab}
        >
          <AlertTriangle className="h-4 w-4" />
          Resolve
        </Button>
      </TooltipTrigger>
    </ContextMenuTrigger>
    <TooltipContent>
      {!isRunning
        ? (isLocalEnvironment ? "Environment must be ready" : "Container must be running")
        : !canCreateTab
          ? "Maximum tabs reached"
          : "PR has merge conflicts - launch agent to resolve them (right-click for agent)"}
    </TooltipContent>
  </Tooltip>
  <ContextMenuContent>
    <ContextMenuItem onClick={() => handleResolveConflicts("claude")}>
      <ClaudeIcon className="h-4 w-4" />
      Resolve with Claude
    </ContextMenuItem>
    <ContextMenuItem onClick={() => handleResolveConflicts("opencode")}>
      <OpenCodeIcon className="h-4 w-4" />
      Resolve with OpenCode
    </ContextMenuItem>
  </ContextMenuContent>
</ContextMenu>
```

**Step 2: Verify full build**

Run: `bunx tsc --noEmit`

Expected: No type errors.

**Step 3: Commit**

```bash
git add src/components/layout/ActionBar.tsx
git commit -m "feat(actionbar): add agent context menu to resolve conflicts button"
```

---

### Task 8: Add queue management methods to Claude store

**Files:**
- Modify: `src/stores/claudeStore.ts`

The Claude store currently has `addToQueue`, `removeFromQueue`, `clearQueue`, and `getQueueLength`. It's missing `removeQueueItem` (remove by ID) and `moveQueueItem` (reorder) which are needed for the queue dialog.

**Step 1: Add method signatures to the store interface**

In the store interface (around line 122-125), add after the existing queue actions:

```typescript
  // Queue actions - keyed by sessionKey
  addToQueue: (sessionKey: ClaudeSessionKey, message: QueuedMessage) => void;
  removeFromQueue: (sessionKey: ClaudeSessionKey) => QueuedMessage | undefined;
  removeQueueItem: (sessionKey: ClaudeSessionKey, messageId: string) => void;
  moveQueueItem: (sessionKey: ClaudeSessionKey, fromIndex: number, toIndex: number) => void;
  clearQueue: (sessionKey: ClaudeSessionKey) => void;
  getQueueLength: (sessionKey: ClaudeSessionKey) => number;
  getQueuedMessages: (sessionKey: ClaudeSessionKey) => QueuedMessage[];
```

**Step 2: Add the implementations after the existing `getQueueLength` (around line 569)**

```typescript
  removeQueueItem: (sessionKey, messageId) =>
    set((state) => {
      const current = state.messageQueue.get(sessionKey) || [];
      const newMap = new Map(state.messageQueue);
      newMap.set(sessionKey, current.filter((m) => m.id !== messageId));
      return { messageQueue: newMap };
    }),

  moveQueueItem: (sessionKey, fromIndex, toIndex) =>
    set((state) => {
      const current = [...(state.messageQueue.get(sessionKey) || [])];
      if (fromIndex < 0 || fromIndex >= current.length || toIndex < 0 || toIndex >= current.length) return {};
      const [item] = current.splice(fromIndex, 1);
      current.splice(toIndex, 0, item);
      const newMap = new Map(state.messageQueue);
      newMap.set(sessionKey, current);
      return { messageQueue: newMap };
    }),

  getQueuedMessages: (sessionKey) => {
    return get().messageQueue.get(sessionKey) || [];
  },
```

**Step 3: Commit**

```bash
git add src/stores/claudeStore.ts
git commit -m "feat(claude-store): add removeQueueItem, moveQueueItem, getQueuedMessages"
```

---

### Task 9: Add clickable queue dialog to Claude compose bar

**Files:**
- Modify: `src/components/claude/ClaudeComposeBar.tsx`

This mirrors OpenCode's queue dialog implementation. The static queue indicator div becomes a clickable button, and a Dialog is added to show/manage queued messages.

**Step 1: Add missing imports**

Add to the existing imports at the top of the file:

```typescript
import { ChevronUp, ChevronDown } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
```

**Step 2: Add store methods and state to the component**

In the destructured `useClaudeStore()` call (around line 78-93), add:

```typescript
  const {
    // ... existing destructured methods ...
    getQueuedMessages,
    removeQueueItem,
    moveQueueItem,
  } = useClaudeStore();
```

Add state and computed values after the existing state declarations:

```typescript
  const [queueDialogOpen, setQueueDialogOpen] = useState(false);
  const queuedMessages = getQueuedMessages(sessionKey);
```

**Step 3: Add queue dialog handlers**

Add after the existing `handleStop` function:

```typescript
  const handleRemoveQueuedMessage = useCallback(
    (messageId: string) => {
      removeQueueItem(sessionKey, messageId);
    },
    [removeQueueItem, sessionKey]
  );

  const handleMoveQueuedMessage = useCallback(
    (fromIndex: number, toIndex: number) => {
      moveQueueItem(sessionKey, fromIndex, toIndex);
    },
    [moveQueueItem, sessionKey]
  );

  const handleQueuedMessageClick = useCallback(
    (message: QueuedMessage) => {
      removeQueueItem(sessionKey, message.id);
      setDraftText(sessionKey, message.text);
      setThinkingEnabled(sessionKey, message.thinkingEnabled);
      setPlanMode(sessionKey, message.planModeEnabled);
      setQueueDialogOpen(false);
      inputRef.current?.focus();
    },
    [removeQueueItem, sessionKey, setDraftText, setThinkingEnabled, setPlanMode]
  );
```

**Step 4: Make queue indicator clickable**

Replace the static queue indicator div (around lines 664-668):

```tsx
{queueLength > 0 && (
  <div className="flex items-center gap-1 px-2 py-1 rounded text-xs text-muted-foreground bg-muted/50">
    <span>+{queueLength} queued</span>
  </div>
)}
```

With:

```tsx
{queueLength > 0 && (
  <button
    type="button"
    onClick={() => setQueueDialogOpen(true)}
    className="flex items-center gap-1 px-2 py-1 rounded text-xs text-muted-foreground bg-muted/50 hover:bg-muted transition-colors"
    title="View queued prompts"
  >
    <span>+{queueLength} queued</span>
  </button>
)}
```

**Step 5: Add the queue dialog before the closing `</div>` of the component**

Add right before the final `</div>` at the end of the component's return:

```tsx
      <Dialog open={queueDialogOpen} onOpenChange={setQueueDialogOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Queued Prompts</DialogTitle>
            <DialogDescription>
              Review pending prompts. Click a message to edit it, or reorder and remove items.
            </DialogDescription>
          </DialogHeader>

          {queuedMessages.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              Queue is empty.
            </div>
          ) : (
            <ScrollArea className="max-h-[380px] pr-3">
              <div className="space-y-2">
                {queuedMessages.map((message, index) => (
                  <div
                    key={message.id}
                    className="rounded-md border border-border bg-muted/20 p-3"
                  >
                    <div className="flex items-start gap-3">
                      <div className="mt-0.5 shrink-0 text-xs font-medium text-muted-foreground">
                        #{index + 1}
                      </div>

                      <div className="min-w-0 flex-1">
                        <p
                          className="cursor-pointer rounded px-1 -mx-1 text-sm whitespace-pre-wrap break-words line-clamp-4 hover:bg-muted/50 transition-colors"
                          onClick={() => handleQueuedMessageClick(message)}
                          title="Click to edit this message"
                        >
                          {message.text}
                        </p>
                        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                          {message.thinkingEnabled && <span>Thinking</span>}
                          {message.planModeEnabled && <span>Plan mode</span>}
                          {message.attachments.length > 0 && (
                            <span>
                              {message.attachments.length} attachment
                              {message.attachments.length === 1 ? "" : "s"}
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="flex shrink-0 flex-col gap-1">
                        <button
                          type="button"
                          onClick={() => handleMoveQueuedMessage(index, index - 1)}
                          disabled={index === 0}
                          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
                          title="Move up"
                        >
                          <ChevronUp className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleMoveQueuedMessage(index, index + 1)}
                          disabled={index === queuedMessages.length - 1}
                          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
                          title="Move down"
                        >
                          <ChevronDown className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRemoveQueuedMessage(message.id)}
                          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive"
                          title="Remove queued prompt"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        </DialogContent>
      </Dialog>
```

**Step 6: Import QueuedMessage type**

Update the import from claudeStore at the top of the file to include `QueuedMessage`:

```typescript
import { useClaudeStore, createClaudeSessionKey, type ClaudeAttachment, type QueuedMessage } from "@/stores/claudeStore";
```

**Step 7: Verify build**

Run: `bunx tsc --noEmit`

Expected: No type errors.

**Step 8: Commit**

```bash
git add src/components/claude/ClaudeComposeBar.tsx
git commit -m "feat(claude-native): add clickable queue dialog with reorder, remove, and click-to-edit"
```

---

### Summary of Changes

| File | Change |
|------|--------|
| `docker/claude-bridge/package.json` | Bump `@anthropic-ai/claude-agent-sdk` from `^0.2.37` to `^0.2.59` |
| `docker/claude-bridge/bun.lock` | Updated lockfile |
| `src/components/layout/ActionBar.tsx` | Add ContextMenu imports; refactor 4 handlers with `agentOverride` param; wrap 4 buttons in `ContextMenu` with Claude/OpenCode items |
| `src/stores/claudeStore.ts` | Add `removeQueueItem`, `moveQueueItem`, `getQueuedMessages` methods |
| `src/components/claude/ClaudeComposeBar.tsx` | Make queue indicator clickable; add queue dialog with reorder/remove/click-to-edit |

No new files created. No new dependencies. Uses existing components from shadcn/ui.
