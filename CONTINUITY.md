Goal (incl. success criteria):
- Address the review finding in Codex bridge session discovery without regressing the resume-session fix.
- Success: resume-session listing avoids repeated full transcript-tree scans while still returning indexed and not-yet-indexed sessions for the current cwd.

Constraints/Assumptions:
- Follow `AGENTS.md`: read and refresh this ledger at turn start and when state changes.
- Do not revert unrelated user changes.
- Preserve the existing resume-session behavior fix.
- Prefer targeted code changes and verification in the affected bridge code.

Key decisions:
- Rework the bridge to build transcript metadata once and reuse it for both index-backed and direct transcript discovery.
- Keep the fix localized to `docker/codex-bridge/src/index.ts` unless testing support is straightforward.

State:
- Done: Updated the ledger for the follow-up task, refactored session discovery to reuse a per-request transcript catalog, and checked the resulting diff.
- Now: Summarizing the fix and verification status for the user.
- Next: If requested, stage/commit this follow-up fix or add targeted tests once a suitable harness is available.

- Read `CONTINUITY.md`.
- Ran `git status --porcelain`.
- Re-read `docker/codex-bridge/src/index.ts` around transcript discovery and session listing.
- Patched `docker/codex-bridge/src/index.ts` to build one transcript catalog and reuse it for indexed and direct-discovery session lookups.
- Ran `bunx tsc --noEmit`; it failed due missing workspace dependencies and many unrelated pre-existing module resolution/type errors, so it was not a valid targeted verification signal for this change.
- Reviewed the resulting `git diff` for the bridge change.

Now:
- Report the session discovery refactor and verification caveat.

Next:
- Wait for user direction on whether to commit this follow-up change.

Open questions (UNCONFIRMED if needed):
- UNCONFIRMED: Whether the user wants this follow-up fix committed now.

Working set (files/ids/commands):
- `/Users/arkaydeus/orkestrator-ai/workspaces/orkestrator-ai-zr9akm/CONTINUITY.md`
- `/Users/arkaydeus/orkestrator-ai/workspaces/orkestrator-ai-zr9akm/docker/codex-bridge/src/index.ts`
- Commands used/planned: `git status --porcelain`, `sed`, `rg`, `git diff`, `bunx tsc --noEmit`
