import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { GlobalSettings } from "./GlobalSettings";
import { useConfigStore } from "@/stores";
import * as tauri from "@/lib/tauri";
import { Loader2 } from "lucide-react";

interface SettingsPageProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SettingsPage({ open, onOpenChange }: SettingsPageProps) {
  const { setConfig, isLoading, setLoading } = useConfigStore();
  const [initialLoadDone, setInitialLoadDone] = useState(false);

  // Load config when dialog opens
  useEffect(() => {
    if (open && !initialLoadDone) {
      const loadConfig = async () => {
        console.log("[settings-page] Loading config from backend...");
        setLoading(true);
        try {
          const config = await tauri.getConfig();
          console.log("[settings-page] Loaded config:", JSON.stringify(config, null, 2));
          setConfig(config);
          setInitialLoadDone(true);
        } catch (err) {
          console.error("[settings-page] Failed to load config:", err);
        } finally {
          setLoading(false);
        }
      };
      loadConfig();
    }
  }, [open, initialLoadDone, setConfig, setLoading]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>

        {isLoading && !initialLoadDone ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <Tabs defaultValue="global" className="w-full">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="global">Global</TabsTrigger>
              <TabsTrigger value="about">About</TabsTrigger>
            </TabsList>

            <TabsContent value="global" className="mt-4">
              <GlobalSettings onSaveSuccess={() => onOpenChange(false)} />
            </TabsContent>

            <TabsContent value="about" className="mt-4">
              <div className="space-y-4 text-sm text-muted-foreground">
                <h3 className="text-lg font-medium text-foreground">
                  Claude Code Environment Orchestrator
                </h3>
                <p>
                  A desktop application for managing isolated Docker-based development
                  environments for Claude Code.
                </p>
                <div className="space-y-2">
                  <p><strong>Version:</strong> 0.1.0</p>
                  <p><strong>Framework:</strong> Tauri + React</p>
                  <p><strong>Docker Backend:</strong> Bollard</p>
                </div>
                <p className="pt-4 text-xs">
                  Built with Tauri, React, TypeScript, and Rust.
                </p>
              </div>
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}
