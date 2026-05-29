import { describe, expect, test } from "bun:test";

import { remapInstalledPlugins } from "./plugin-config.js";
import type { InstalledPluginsFile } from "../types/plugins.js";

const PLUGINS_DIR = "/home/node/.claude/plugins";

function installed(
  plugins: InstalledPluginsFile["plugins"]
): InstalledPluginsFile {
  return { version: 1, plugins };
}

function entry(installPath: string) {
  return {
    scope: "user",
    installPath,
    version: "1.0.0",
    installedAt: "2026-01-01T00:00:00Z",
    lastUpdated: "2026-01-01T00:00:00Z",
    gitCommitSha: "abc123",
  };
}

describe("remapInstalledPlugins", () => {
  test("rebases a host-absolute path onto the local plugins dir", () => {
    const result = remapInstalledPlugins(
      PLUGINS_DIR,
      installed({
        market: [entry("/Users/alice/.claude/plugins/marketplaces/foo")],
      })
    );

    expect(result).toEqual([
      { type: "local", path: "/home/node/.claude/plugins/marketplaces/foo" },
    ]);
  });

  test("passes through paths that lack the .claude/plugins marker unchanged", () => {
    const result = remapInstalledPlugins(
      PLUGINS_DIR,
      installed({ custom: [entry("/opt/custom/my-plugin")] })
    );

    expect(result).toEqual([{ type: "local", path: "/opt/custom/my-plugin" }]);
  });

  test("drops entries whose rebased path escapes the plugins dir (traversal)", () => {
    const result = remapInstalledPlugins(
      PLUGINS_DIR,
      installed({
        evil: [
          entry("/x/.claude/plugins/../../../../../../../etc/passwd"),
          entry("/Users/bob/.claude/plugins/marketplaces/safe"),
        ],
      })
    );

    // Only the safe, in-bounds entry survives; the traversal entry is skipped.
    expect(result).toEqual([
      { type: "local", path: "/home/node/.claude/plugins/marketplaces/safe" },
    ]);
  });

  test("flattens every entry across every plugin group", () => {
    const result = remapInstalledPlugins(
      PLUGINS_DIR,
      installed({
        groupA: [
          entry("/Users/a/.claude/plugins/marketplaces/one"),
          entry("/Users/a/.claude/plugins/marketplaces/two"),
        ],
        groupB: [entry("/opt/external/three")],
      })
    );

    expect(result).toEqual([
      { type: "local", path: "/home/node/.claude/plugins/marketplaces/one" },
      { type: "local", path: "/home/node/.claude/plugins/marketplaces/two" },
      { type: "local", path: "/opt/external/three" },
    ]);
  });

  test("returns an empty array when there are no installed plugins", () => {
    expect(remapInstalledPlugins(PLUGINS_DIR, installed({}))).toEqual([]);
  });
});
