import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Mocks — must be declared BEFORE importing the component under test
// ---------------------------------------------------------------------------

const mockUpdateRepositoryConfig = mock(() =>
  Promise.resolve({
    version: "1.0",
    global: {},
    repositories: {},
  })
);

mock.module("@/lib/tauri", () => ({
  updateRepositoryConfig: mockUpdateRepositoryConfig,
  updateProject: mock(() => Promise.resolve({})),
}));

mock.module("@tauri-apps/plugin-dialog", () => ({
  open: mock(() => Promise.resolve(null)),
}));

mock.module("sonner", () => ({
  toast: { success: mock(() => {}), error: mock(() => {}) },
}));

// Render the FullscreenSettingsLayout as a simple div that calls children
// with a configurable section. Default to "agent" section for our tests.
let mockSection = "agent";
mock.module("@/components/settings/FullscreenSettingsLayout", () => ({
  FullscreenSettingsLayout: ({
    open,
    children,
    footer,
  }: {
    open: boolean;
    onOpenChange: (o: boolean) => void;
    title: string;
    menuItems: unknown[];
    children: (section: string) => React.ReactNode;
    footer?: React.ReactNode;
    defaultSection?: string;
  }) => {
    if (!open) return null;
    return (
      <div data-testid="settings-layout">
        <div data-testid="settings-content">{children(mockSection)}</div>
        {footer && <div data-testid="settings-footer">{footer}</div>}
      </div>
    );
  },
}));

mock.module("@/components/ui/button", () => ({
  Button: ({ children, onClick, disabled, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { children: React.ReactNode; variant?: string; size?: string }) => (
    <button onClick={onClick} disabled={disabled} {...props}>{children}</button>
  ),
}));

mock.module("@/components/ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

mock.module("@/components/ui/label", () => ({
  Label: ({ children, ...props }: React.LabelHTMLAttributes<HTMLLabelElement> & { children: React.ReactNode }) => (
    <label {...props}>{children}</label>
  ),
}));

// Select mock that renders as a native <select> for easy interaction
mock.module("@/components/ui/select", () => ({
  Select: ({ children, value, onValueChange, disabled }: {
    children: React.ReactNode;
    value?: string;
    onValueChange?: (v: string) => void;
    disabled?: boolean;
  }) => (
    <select
      value={value}
      onChange={(e) => onValueChange?.(e.target.value)}
      disabled={disabled}
      data-testid="mock-select"
    >
      {children}
    </select>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <option value={value}>{children}</option>
  ),
  SelectTrigger: ({ children, id }: { children: React.ReactNode; id?: string }) => <>{children}</>,
  SelectValue: ({ placeholder }: { placeholder?: string }) => null,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { useConfigStore } from "@/stores/configStore";
import { useClaudeStore } from "@/stores/claudeStore";
import { RepositorySettings } from "../../../src/components/settings/RepositorySettings";
import type { Project, AppConfig } from "@/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "project-1",
    name: "test-repo",
    gitUrl: "git@github.com:test/repo.git",
    localPath: null,
    addedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    version: "1.0",
    global: {
      containerResources: { cpuCores: 2, memoryGb: 4 },
      envFilePatterns: [".env"],
      allowedDomains: [],
      defaultAgent: "claude",
      opencodeModel: "grok",
      codexModel: "codex-1",
      codexReasoningEffort: "medium",
      opencodeMode: "terminal",
      claudeMode: "terminal",
      terminalAppearance: { fontFamily: "monospace", fontSize: 14, backgroundColor: "#000" },
      terminalScrollback: 5000,
      ...overrides.global,
    },
    repositories: overrides.repositories ?? {},
  };
}

function renderSettings(overrides: { project?: Partial<Project>; config?: Partial<AppConfig> } = {}) {
  const project = makeProject(overrides.project);
  const config = makeConfig(overrides.config);

  useConfigStore.setState({
    config,
    isLoading: false,
    error: null,
  });

  return render(
    <RepositorySettings
      project={project}
      open={true}
      onOpenChange={() => {}}
    />
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RepositorySettings - agent/style settings", () => {
  beforeEach(() => {
    mockSection = "agent";
    mockUpdateRepositoryConfig.mockClear();
    useConfigStore.setState({
      config: makeConfig(),
      isLoading: false,
      error: null,
    });
  });

  afterEach(() => {
    cleanup();
  });

  test("renders agent and style dropdowns in the agent section", () => {
    renderSettings();

    // Should have labels for both new dropdowns
    expect(screen.getByText("Default Agent")).toBeTruthy();
    expect(screen.getByText("Agent Style")).toBeTruthy();
  });

  test("agent dropdown defaults to Use App Default when no project override", () => {
    renderSettings();

    const selects = screen.getAllByTestId("mock-select");
    // The first two selects in the agent section are: Default Agent, Agent Style
    const agentSelect = selects[0]!;
    expect(agentSelect.getAttribute("value") || (agentSelect as HTMLSelectElement).value).toBe("__app_default__");
  });

  test("agent dropdown shows project override value when set", () => {
    renderSettings({
      config: {
        repositories: {
          "project-1": {
            defaultBranch: "main",
            prBaseBranch: "main",
            defaultAgent: "opencode",
          },
        },
      },
    });

    const selects = screen.getAllByTestId("mock-select");
    const agentSelect = selects[0]!;
    expect((agentSelect as HTMLSelectElement).value).toBe("opencode");
  });

  test("style dropdown defaults to Use App Default when no project override", () => {
    renderSettings();

    const selects = screen.getAllByTestId("mock-select");
    const styleSelect = selects[1]!;
    expect((styleSelect as HTMLSelectElement).value).toBe("__app_default__");
  });

  test("style dropdown shows project override value when set", () => {
    renderSettings({
      config: {
        repositories: {
          "project-1": {
            defaultBranch: "main",
            prBaseBranch: "main",
            agentStyle: "native",
          },
        },
      },
    });

    const selects = screen.getAllByTestId("mock-select");
    const styleSelect = selects[1]!;
    expect((styleSelect as HTMLSelectElement).value).toBe("native");
  });

  test("agent dropdown has all expected options", () => {
    renderSettings();

    const selects = screen.getAllByTestId("mock-select");
    const agentSelect = selects[0]!;
    const options = agentSelect.querySelectorAll("option");
    const values = Array.from(options).map((o) => o.getAttribute("value"));

    expect(values).toContain("__app_default__");
    expect(values).toContain("claude");
    expect(values).toContain("opencode");
    expect(values).toContain("codex");
  });

  test("style dropdown has all expected options", () => {
    renderSettings();

    const selects = screen.getAllByTestId("mock-select");
    const styleSelect = selects[1]!;
    const options = styleSelect.querySelectorAll("option");
    const values = Array.from(options).map((o) => o.getAttribute("value"));

    expect(values).toContain("__app_default__");
    expect(values).toContain("terminal");
    expect(values).toContain("native");
  });

  test("changing agent resets model and effort selections", async () => {
    const { container } = renderSettings({
      config: {
        repositories: {
          "project-1": {
            defaultBranch: "main",
            prBaseBranch: "main",
            defaultModel: "claude-sonnet-4-6",
            defaultEffort: "high",
          },
        },
      },
    });

    const selects = screen.getAllByTestId("mock-select");
    const agentSelect = selects[0]!;

    // Change agent — this should trigger setDefaultModel("") and setDefaultEffort("")
    fireEvent.change(agentSelect, { target: { value: "opencode" } });

    // After the change, click Save to capture the persisted config
    const saveButton = screen.getByText("Save");
    fireEvent.click(saveButton);

    await new Promise((r) => setTimeout(r, 50));

    expect(mockUpdateRepositoryConfig).toHaveBeenCalledTimes(1);
    const [, savedConfig] = mockUpdateRepositoryConfig.mock.calls[0]!;
    // Model and effort should be cleared (undefined) because "" maps to undefined in the save logic
    expect(savedConfig.defaultModel).toBeUndefined();
    expect(savedConfig.defaultEffort).toBeUndefined();
    expect(savedConfig.defaultAgent).toBe("opencode");
  });

  test("effective agent label updates when project agent override changes", () => {
    const { container } = renderSettings({
      config: {
        global: { defaultAgent: "claude" } as AppConfig["global"],
      },
    });

    // The agent label is rendered in a <span> badge next to "Default Agent Settings"
    const getAgentBadge = () => container.querySelector("span.text-xs.text-muted-foreground.bg-zinc-800");

    // Initially effective agent is claude (app default)
    expect(getAgentBadge()?.textContent).toBe("Claude");

    const selects = screen.getAllByTestId("mock-select");
    const agentSelect = selects[0]!;

    // Change to opencode
    fireEvent.change(agentSelect, { target: { value: "opencode" } });
    expect(getAgentBadge()?.textContent).toBe("OpenCode");

    // Change to codex
    fireEvent.change(agentSelect, { target: { value: "codex" } });
    expect(getAgentBadge()?.textContent).toBe("Codex");
  });

  test("save sends correct config with agent and style overrides", async () => {
    renderSettings();

    const selects = screen.getAllByTestId("mock-select");

    // Set agent to opencode
    fireEvent.change(selects[0]!, { target: { value: "opencode" } });
    // Set style to native
    fireEvent.change(selects[1]!, { target: { value: "native" } });

    // Click Save
    const saveButton = screen.getByText("Save");
    fireEvent.click(saveButton);

    // Wait for async save
    await new Promise((r) => setTimeout(r, 50));

    expect(mockUpdateRepositoryConfig).toHaveBeenCalledTimes(1);
    const [projectId, savedConfig] = mockUpdateRepositoryConfig.mock.calls[0]!;
    expect(projectId).toBe("project-1");
    expect(savedConfig.defaultAgent).toBe("opencode");
    expect(savedConfig.agentStyle).toBe("native");
  });

  test("save sends undefined agent/style when set to Use App Default", async () => {
    renderSettings({
      config: {
        repositories: {
          "project-1": {
            defaultBranch: "main",
            prBaseBranch: "main",
            defaultAgent: "opencode",
            agentStyle: "native",
          },
        },
      },
    });

    const selects = screen.getAllByTestId("mock-select");

    // Reset both to app default
    fireEvent.change(selects[0]!, { target: { value: "__app_default__" } });
    fireEvent.change(selects[1]!, { target: { value: "__app_default__" } });

    // Click Save
    const saveButton = screen.getByText("Save");
    fireEvent.click(saveButton);

    await new Promise((r) => setTimeout(r, 50));

    expect(mockUpdateRepositoryConfig).toHaveBeenCalledTimes(1);
    const [, savedConfig] = mockUpdateRepositoryConfig.mock.calls[0]!;
    expect(savedConfig.defaultAgent).toBeUndefined();
    expect(savedConfig.agentStyle).toBeUndefined();
  });
});
