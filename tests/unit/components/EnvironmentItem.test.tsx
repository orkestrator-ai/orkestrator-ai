import { describe, test, expect, mock } from "bun:test";
import { render } from "@testing-library/react";
import type { Environment } from "../../../src/types";

// Mock UI components that require providers.
// NOTE: @/components/ui/tooltip is already mocked by StatusIndicator.test.tsx
// with data-testid="tooltip-content". We re-use that shape here so both files
// share the same mock regardless of test execution order.
mock.module("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
}));

mock.module("@/components/ui/context-menu", () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuContent: () => null,
  ContextMenuItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuSeparator: () => <hr />,
}));

mock.module("@/components/ui/alert-dialog", () => ({
  AlertDialog: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  AlertDialogAction: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  AlertDialogCancel: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

mock.module("@/components/ui/checkbox", () => ({
  Checkbox: () => <input type="checkbox" />,
}));

mock.module("@/components/environments/EnvironmentSettingsDialog", () => ({
  EnvironmentSettingsDialog: () => null,
}));

mock.module("@/lib/tauri", () => ({
  getEnvironments: async () => [],
  getEnvironment: async () => null,
  startEnvironment: async () => ({}),
  stopEnvironment: async () => {},
  createEnvironment: async () => ({}),
  deleteEnvironment: async () => {},
  recreateEnvironment: async () => {},
  updateEnvironmentStatus: async () => ({}),
  getContainerDiffStats: async () => null,
  getLocalDiffStats: async () => null,
  openInBrowser: async () => {},
  readFileBase64: async () => "",
}));

import { EnvironmentItem } from "../../../src/components/environments/EnvironmentItem";

function makeEnvironment(overrides: Partial<Environment> = {}): Environment {
  return {
    id: "env-1",
    projectId: "project-1",
    name: "test-env",
    branch: "main",
    containerId: "container-1",
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "containerized",
    ...overrides,
  };
}

const noopHandler = () => {};

function renderItem(env: Environment) {
  return render(
    <EnvironmentItem
      environment={env}
      isSelected={false}
      onSelect={noopHandler}
      onDelete={noopHandler}
      onStart={noopHandler}
      onStop={noopHandler}
      onRestart={noopHandler}
    />,
  );
}

describe("EnvironmentItem tooltip port display", () => {
  test("shows full port mapping when both entryPort and hostEntryPort are set", () => {
    const env = makeEnvironment({ entryPort: 3000, hostEntryPort: 49152 });
    const { container } = renderItem(env);

    const html = container.innerHTML;
    expect(html).toContain("localhost:49152");
    expect(html).toContain("3000/tcp");
  });

  test("shows 'not mapped' when entryPort is set but hostEntryPort is missing", () => {
    const env = makeEnvironment({ entryPort: 8080 });
    const { container } = renderItem(env);

    const html = container.innerHTML;
    expect(html).toContain("8080/tcp");
    expect(html).toContain("(not mapped)");
  });

  test("does not show port info when entryPort is not set", () => {
    const env = makeEnvironment();
    const { container } = renderItem(env);

    const html = container.innerHTML;
    expect(html).not.toContain("Port:");
    expect(html).not.toContain("/tcp");
  });

  test("does not show port info for local environments even with entryPort", () => {
    const env = makeEnvironment({
      environmentType: "local",
      entryPort: 3000,
      hostEntryPort: 49152,
    });
    const { container } = renderItem(env);

    const html = container.innerHTML;
    expect(html).not.toContain("Port:");
    expect(html).not.toContain("3000/tcp");
  });
});
