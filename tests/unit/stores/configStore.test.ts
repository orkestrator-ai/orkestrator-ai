import { describe, test, expect, beforeEach } from "bun:test";
import { useConfigStore } from "../../../src/stores/configStore";
import type { RepositoryConfig } from "../../../src/types";

describe("configStore", () => {
  beforeEach(() => {
    // Reset store between tests
    useConfigStore.setState({
      config: {
        version: "1.0",
        global: {
          containerResources: {
            cpuCores: 2,
            memoryGb: 4,
          },
          envFilePatterns: [".env.local", ".env"],
        },
        repositories: {},
      },
      isLoading: false,
      error: null,
    });
  });

  test("initial state has default config", () => {
    const state = useConfigStore.getState();
    expect(state.config.version).toBe("1.0");
    expect(state.config.global.containerResources.cpuCores).toBe(2);
    expect(state.config.global.containerResources.memoryGb).toBe(4);
    expect(state.config.global.envFilePatterns).toEqual([".env.local", ".env"]);
    expect(state.config.repositories).toEqual({});
    expect(state.isLoading).toBe(false);
    expect(state.error).toBeNull();
  });

  test("setConfig replaces entire config", () => {
    const newConfig = {
      version: "2.0",
      global: {
        containerResources: {
          cpuCores: 4,
          memoryGb: 8,
        },
        envFilePatterns: [".env"],
      },
      repositories: {
        "repo-1": {
          defaultBranch: "main",
          prBaseBranch: "develop",
        },
      },
    };

    useConfigStore.getState().setConfig(newConfig);

    const state = useConfigStore.getState();
    expect(state.config).toEqual(newConfig);
  });

  test("updateGlobalConfig partially updates global config", () => {
    useConfigStore.getState().updateGlobalConfig({
      containerResources: {
        cpuCores: 8,
        memoryGb: 16,
      },
    });

    const state = useConfigStore.getState();
    expect(state.config.global.containerResources.cpuCores).toBe(8);
    expect(state.config.global.containerResources.memoryGb).toBe(16);
    // Original envFilePatterns should be preserved
    expect(state.config.global.envFilePatterns).toEqual([".env.local", ".env"]);
  });

  test("updateGlobalConfig preserves other global fields", () => {
    useConfigStore.getState().updateGlobalConfig({
      envFilePatterns: [".env.production"],
    });

    const state = useConfigStore.getState();
    // Container resources should be preserved
    expect(state.config.global.containerResources.cpuCores).toBe(2);
    expect(state.config.global.containerResources.memoryGb).toBe(4);
    expect(state.config.global.envFilePatterns).toEqual([".env.production"]);
  });

  test("setRepositoryConfig adds a new repository config", () => {
    const repoConfig: RepositoryConfig = {
      defaultBranch: "main",
      prBaseBranch: "develop",
    };

    useConfigStore.getState().setRepositoryConfig("repo-1", repoConfig);

    const state = useConfigStore.getState();
    expect(state.config.repositories["repo-1"]).toEqual(repoConfig);
  });

  test("setRepositoryConfig updates existing repository config", () => {
    const initialConfig: RepositoryConfig = {
      defaultBranch: "main",
      prBaseBranch: "main",
    };
    const updatedConfig: RepositoryConfig = {
      defaultBranch: "develop",
      prBaseBranch: "staging",
    };

    useConfigStore.getState().setRepositoryConfig("repo-1", initialConfig);
    useConfigStore.getState().setRepositoryConfig("repo-1", updatedConfig);

    const state = useConfigStore.getState();
    expect(state.config.repositories["repo-1"]).toEqual(updatedConfig);
  });

  test("setRepositoryConfig preserves other repositories", () => {
    const config1: RepositoryConfig = {
      defaultBranch: "main",
      prBaseBranch: "main",
    };
    const config2: RepositoryConfig = {
      defaultBranch: "develop",
      prBaseBranch: "develop",
    };

    useConfigStore.getState().setRepositoryConfig("repo-1", config1);
    useConfigStore.getState().setRepositoryConfig("repo-2", config2);

    const state = useConfigStore.getState();
    expect(state.config.repositories["repo-1"]).toEqual(config1);
    expect(state.config.repositories["repo-2"]).toEqual(config2);
  });

  test("removeRepositoryConfig removes the specified repository", () => {
    const config: RepositoryConfig = {
      defaultBranch: "main",
      prBaseBranch: "main",
    };

    useConfigStore.getState().setRepositoryConfig("repo-1", config);
    useConfigStore.getState().removeRepositoryConfig("repo-1");

    const state = useConfigStore.getState();
    expect(state.config.repositories["repo-1"]).toBeUndefined();
  });

  test("removeRepositoryConfig preserves other repositories", () => {
    const config1: RepositoryConfig = {
      defaultBranch: "main",
      prBaseBranch: "main",
    };
    const config2: RepositoryConfig = {
      defaultBranch: "develop",
      prBaseBranch: "develop",
    };

    useConfigStore.getState().setRepositoryConfig("repo-1", config1);
    useConfigStore.getState().setRepositoryConfig("repo-2", config2);
    useConfigStore.getState().removeRepositoryConfig("repo-1");

    const state = useConfigStore.getState();
    expect(state.config.repositories["repo-1"]).toBeUndefined();
    expect(state.config.repositories["repo-2"]).toEqual(config2);
  });

  test("removeRepositoryConfig handles non-existent repository", () => {
    useConfigStore.getState().removeRepositoryConfig("non-existent");

    const state = useConfigStore.getState();
    expect(state.config.repositories).toEqual({});
  });

  test("getRepositoryConfig returns the correct config", () => {
    const config: RepositoryConfig = {
      defaultBranch: "main",
      prBaseBranch: "develop",
    };

    useConfigStore.getState().setRepositoryConfig("repo-1", config);

    const result = useConfigStore.getState().getRepositoryConfig("repo-1");
    expect(result).toEqual(config);
  });

  test("getRepositoryConfig returns undefined for non-existent repository", () => {
    const result = useConfigStore.getState().getRepositoryConfig("non-existent");
    expect(result).toBeUndefined();
  });

  test("setLoading updates loading state", () => {
    useConfigStore.getState().setLoading(true);
    expect(useConfigStore.getState().isLoading).toBe(true);

    useConfigStore.getState().setLoading(false);
    expect(useConfigStore.getState().isLoading).toBe(false);
  });

  test("setError updates error state", () => {
    useConfigStore.getState().setError("Test error");
    expect(useConfigStore.getState().error).toBe("Test error");

    useConfigStore.getState().setError(null);
    expect(useConfigStore.getState().error).toBeNull();
  });
});
