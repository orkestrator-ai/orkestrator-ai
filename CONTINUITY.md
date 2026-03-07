Goal (incl. success criteria):
- Add queued messages to Codex native tabs, matching the behavior already available in Claude Native and OpenCode Native tabs.
- Success: Codex tabs can queue prompts while a session is busy, show/manage the queue in the compose UI, and automatically send queued prompts when the session becomes idle.

Constraints/Assumptions:
- Follow `AGENTS.md` workflow; keep this ledger current.
- Use Bun-based project commands when verification is needed.
- Do not revert unrelated user changes.
- Preserve existing Codex native tab behavior outside queue support.
- Codex prompt requests do not accept per-message model/mode/reasoning overrides; queued settings are stored for replay metadata and queue UI consistency.

Key decisions:
- Reuse the existing queue pattern from Claude/OpenCode: tab-scoped queue state in the store, queue dialog in the compose bar, and idle-driven draining in the chat tab.
- Store queued Codex prompts with the settings needed to describe the queued work correctly: mode, model, reasoning effort, and attachments.
- Drain the queue by sending the next prompt after the current session reports idle, guarded by a processing ref to avoid double-send races.

State:
- Done: implemented Codex queue state, queue UI, and queue draining; verification completed.
- Now: ready to report the change and any relevant caveats.
- Next: optional manual UI smoke test in the app if the user wants runtime confirmation.

Done:
- Read `CONTINUITY.md` and refreshed it for this task.
- Inspected existing queue implementations in:
  - `src/stores/claudeStore.ts`
  - `src/stores/openCodeStore.ts`
  - `src/components/claude/ClaudeComposeBar.tsx`
  - `src/components/claude/ClaudeChatTab.tsx`
  - `src/components/opencode/OpenCodeComposeBar.tsx`
  - `src/components/opencode/OpenCodeChatTab.tsx`
- Updated `src/stores/codexStore.ts`:
  - added `CodexQueuedMessage`
  - added tab-scoped `messageQueue`
  - added queue actions (`addToQueue`, `removeFromQueue`, `removeQueueItem`, `moveQueueItem`, `clearQueue`, `getQueueLength`, `getQueuedMessages`)
  - cleared queued messages during environment cleanup
- Updated `src/components/codex/CodexComposeBar.tsx`:
  - when Codex is loading, send now queues instead of no-op
  - added queued-prompt badge/button
  - added queued prompts dialog with reorder/remove/edit-back-into-draft controls
- Updated `src/components/codex/CodexChatTab.tsx`:
  - added queue length subscription
  - added `handleQueue`
  - added guarded `processQueue()` idle-drain flow
  - passed queue props into `CodexComposeBar`
- Verified successfully:
  - `bunx tsc --noEmit`

Now:
- Report implemented behavior and touched files to the user.

Next:
- If requested, run a manual app-level smoke test for Codex queue behavior.

Open questions (UNCONFIRMED if needed):
- None.

Working set (files/ids/commands):
- `/Users/arkaydeus/orkestrator-ai/workspaces/orkestrator-ai-dfbta7/CONTINUITY.md`
- `/Users/arkaydeus/orkestrator-ai/workspaces/orkestrator-ai-dfbta7/src/stores/codexStore.ts`
- `/Users/arkaydeus/orkestrator-ai/workspaces/orkestrator-ai-dfbta7/src/components/codex/CodexComposeBar.tsx`
- `/Users/arkaydeus/orkestrator-ai/workspaces/orkestrator-ai-dfbta7/src/components/codex/CodexChatTab.tsx`
- Commands run: `sed -n '1,220p' CONTINUITY.md`, targeted `rg`/`sed -n` reads for Claude/OpenCode/Codex queue paths, `bunx tsc --noEmit`
