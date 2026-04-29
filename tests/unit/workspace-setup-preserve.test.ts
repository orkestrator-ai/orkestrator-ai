import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..");

function read(rel: string): string {
  return readFileSync(join(repoRoot, rel), "utf8");
}

describe("workspace setup attachment preservation", () => {
  test("preserves .orkestrator state while clearing the workspace for clone", () => {
    const setup = read("docker/workspace-setup.sh");

    const preserveFunction = setup.indexOf("preserve_orkestrator_workspace_state() {");
    const restoreFunction = setup.indexOf("restore_orkestrator_workspace_state() {");
    const preserveCall = setup.indexOf("preserve_orkestrator_workspace_state", restoreFunction);
    const workspaceCleanup = setup.indexOf("rm -rf /workspace/*");
    const restoreCall = setup.indexOf("restore_orkestrator_workspace_state", workspaceCleanup);
    const envSetup = setup.indexOf(">>> Setting up environment files <<<");

    expect(preserveFunction).toBeGreaterThan(-1);
    expect(restoreFunction).toBeGreaterThan(preserveFunction);
    expect(preserveCall).toBeGreaterThan(restoreFunction);
    expect(preserveCall).toBeLessThan(workspaceCleanup);
    expect(restoreCall).toBeGreaterThan(workspaceCleanup);
    expect(restoreCall).toBeLessThan(envSetup);
    expect(setup).toContain("cp -R /workspace/.orkestrator/. \"$ORKESTRATOR_WORKSPACE_STATE_BACKUP\"/");
    expect(setup).toContain("cp -R \"$ORKESTRATOR_WORKSPACE_STATE_BACKUP\"/. /workspace/.orkestrator/");
  });
});
