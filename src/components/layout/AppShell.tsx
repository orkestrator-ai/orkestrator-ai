import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { Sidebar } from "./Sidebar";
import { ActionBar } from "./ActionBar";
import { FilesPanel } from "@/components/files-panel";
import { useFilesPanelStore } from "@/stores";
import { cn } from "@/lib/utils";

interface AppShellProps {
  children?: React.ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const { isOpen: filesPanelOpen } = useFilesPanelStore();

  const handleTitleBarMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;

    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => getCurrentWindow().startDragging())
      .catch(() => {
        // No-op outside Tauri runtime
      });
  };

  return (
    <div className="h-screen w-screen overflow-hidden">
      {/* Custom title bar - replaces macOS title bar (Overlay mode) */}
      <div
        className="flex h-7 w-full items-center justify-center bg-black"
        data-tauri-drag-region
        onMouseDown={handleTitleBarMouseDown}
      >
        <span className="text-xs font-medium text-muted-foreground" data-tauri-drag-region>
          Orkestrator AI
        </span>
      </div>
      <ResizablePanelGroup orientation="horizontal" className="h-[calc(100vh-1.75rem)]">
        {/* Sidebar Panel */}
        <ResizablePanel defaultSize={28} minSize="280px" maxSize="400px">
          <Sidebar />
        </ResizablePanel>

        {/* Resize Handle */}
        <ResizableHandle />

        {/* Main Content Panel */}
        <ResizablePanel defaultSize={filesPanelOpen ? 50 : 78} minSize={30}>
          <div className="flex h-full flex-col bg-card">
            <ActionBar />
            <main className={cn("main-content-area flex-1 overflow-hidden bg-background")}>
              {children}
            </main>
          </div>
        </ResizablePanel>

        {/* Files Panel (conditional) */}
        {filesPanelOpen && (
          <>
            <ResizableHandle />
            <ResizablePanel defaultSize={22} minSize="240px" maxSize="500px">
              <FilesPanel />
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
    </div>
  );
}
