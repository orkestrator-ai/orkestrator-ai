/**
 * Generates the prompt for the PR creation workflow.
 * This prompt instructs Claude to commit all changes, push, and create a PR.
 *
 * Used by both the manual "Create PR" action bar button and the
 * automated build pipeline PR creation session.
 */
export function buildPRPrompt(targetBranch: string): string {
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
1. Run \`git diff origin/${targetBranch}...HEAD\` to see all changes that will be in the PR
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
