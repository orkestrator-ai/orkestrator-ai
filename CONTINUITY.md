Goal (incl. success criteria):
- Fix OpenCode Native slash command availability so it matches TUI behavior.
- Success: Native UI lists all slash commands available from OpenCode, not just two.

Constraints/Assumptions:
- Follow project instruction set in AGENTS.md.
- Use Bun tooling where relevant.
- Native and TUI should show equivalent slash-command inventory from OpenCode.

Key decisions:
- Start by tracing slash-command data flow in frontend OpenCode components/store/client wrappers.
- Remove client-side filtering of commands marked `subtask` so native UI reflects all commands returned by OpenCode.
- Add/adjust unit test coverage to lock in command visibility behavior.

State:
- Done: Created continuity ledger file (it was missing).
- Now: Fix implemented and unit-tested; awaiting in-app verification.
- Next: Manual verification in OpenCode Native UI.

Done:
- Confirmed `CONTINUITY.md` did not previously exist.
- Traced slash-command loading path: `OpenCodeChatTab` -> `getAvailableSlashCommands`.
- Identified limiting logic in `src/lib/opencode-client.ts` that dropped `subtask` commands.
- Patched slash-command mapping to include `subtask` commands.
- Updated `src/lib/opencode-client.test.ts` to assert `subtask` commands are preserved.
- Ran `bun test src/lib/opencode-client.test.ts` successfully (11 passed, 0 failed).

Now:
- Awaiting user validation in OpenCode Native UI.

Next:
- Verify in app that typing `/` now lists full command set from OpenCode server.

Open questions (UNCONFIRMED if needed):
- UNCONFIRMED: Whether any OpenCode installations return internal-only commands that should remain hidden.
- UNCONFIRMED: If command visibility should eventually be configurable (e.g., hide internal-only by preference).

Working set (files/ids/commands):
- `CONTINUITY.md`
- `src/lib/opencode-client.ts`
- `src/lib/opencode-client.test.ts`
- Commands: `rg -n "slash|commands|command" ...`, `sed -n ...`, `cat CONTINUITY.md`, `bun test src/lib/opencode-client.test.ts`
