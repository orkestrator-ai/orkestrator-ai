interface TerminalViewportLike {
  cols: number;
  rows: number;
  refresh: (start: number, end: number) => void;
}

interface FitAddonLike {
  fit: () => void;
}

interface ForceTerminalVisibilityRedrawOptions {
  terminal: TerminalViewportLike;
  fitAddon: FitAddonLike;
  resize: (cols: number, rows: number) => Promise<void>;
  isCancelled?: () => boolean;
  requestAnimationFrameFn?: (callback: FrameRequestCallback) => number;
  setTimeoutFn?: typeof setTimeout;
  finalRefreshDelayMs?: number;
}

interface ShouldTriggerVisibilityRedrawOptions {
  isEnvironmentVisible: boolean;
  wasEnvironmentVisible: boolean;
  isActive: boolean;
  terminalIsOpened: boolean;
  isConnected: boolean;
}

export function getTerminalResizeBounceDimensions(cols: number, rows: number): { cols: number; rows: number } | null {
  if (cols <= 0 || rows <= 0) {
    return null;
  }

  const nudgedRows = rows < 65535 ? rows + 1 : rows;
  const nudgedCols = nudgedRows === rows && cols < 65535 ? cols + 1 : cols;

  if (nudgedRows === rows && nudgedCols === cols) {
    return null;
  }

  return { cols: nudgedCols, rows: nudgedRows };
}

export function shouldTriggerEnvironmentVisibilityRedraw({
  isEnvironmentVisible,
  wasEnvironmentVisible,
  isActive,
  terminalIsOpened,
  isConnected,
}: ShouldTriggerVisibilityRedrawOptions): boolean {
  return (
    isEnvironmentVisible &&
    !wasEnvironmentVisible &&
    isActive &&
    terminalIsOpened &&
    isConnected
  );
}

export async function forceTerminalVisibilityRedraw({
  terminal,
  fitAddon,
  resize,
  isCancelled = () => false,
  requestAnimationFrameFn = requestAnimationFrame,
  setTimeoutFn = setTimeout,
  finalRefreshDelayMs = 50,
}: ForceTerminalVisibilityRedrawOptions): Promise<void> {
  const refreshViewport = () => {
    fitAddon.fit();
    if (terminal.rows > 0) {
      terminal.refresh(0, terminal.rows - 1);
    }
  };

  await new Promise<void>((resolve) => {
    requestAnimationFrameFn(() => {
      if (!isCancelled()) {
        refreshViewport();
      }
      resolve();
    });
  });

  if (isCancelled()) return;

  const { cols, rows } = terminal;
  if (cols <= 0 || rows <= 0) {
    return;
  }

  const bounceSize = getTerminalResizeBounceDimensions(cols, rows);
  if (bounceSize) {
    await resize(bounceSize.cols, bounceSize.rows);
  }

  if (isCancelled()) return;

  await resize(cols, rows);

  if (isCancelled()) return;

  refreshViewport();
  setTimeoutFn(() => {
    if (isCancelled()) return;
    refreshViewport();
  }, finalRefreshDelayMs);
}
