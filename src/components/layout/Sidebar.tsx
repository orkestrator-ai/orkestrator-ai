import { HierarchicalSidebar } from "@/components/sidebar";

export function Sidebar() {
  return (
    <div className="flex h-full flex-col border-r border-border bg-card">
      <HierarchicalSidebar />
    </div>
  );
}
