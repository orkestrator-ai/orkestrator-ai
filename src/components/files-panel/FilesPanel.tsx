import { FilesPanelHeader } from "./FilesPanelHeader";
import { ChangesView } from "./ChangesView";
import { AllFilesView } from "./AllFilesView";
import { useFilesPanelStore } from "@/stores";
import { useFilesPanel } from "@/hooks";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";

export function FilesPanel() {
  const { activeTab } = useFilesPanelStore();

  // Initialize the files panel data loading
  useFilesPanel();

  return (
    <div className="flex h-full flex-col border-l border-border bg-card">
      <FilesPanelHeader />
      <Separator />
      <ScrollArea className="min-h-0 flex-1">
        {activeTab === "changes" ? <ChangesView /> : <AllFilesView />}
      </ScrollArea>
    </div>
  );
}
