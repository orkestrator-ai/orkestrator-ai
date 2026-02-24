import { HierarchicalSidebar } from "@/components/sidebar";

export function Sidebar() {
  return (
    <div className="sidebar-glass flex h-full flex-col border-r border-white/10">
      <HierarchicalSidebar />
    </div>
  );
}
