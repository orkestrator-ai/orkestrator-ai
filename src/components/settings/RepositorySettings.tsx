import { useState, useEffect, useCallback, useMemo } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useConfigStore } from "@/stores";
import * as tauri from "@/lib/tauri";
import { Loader2, Network, Plus, Trash2, ChevronDown, FolderOpen, ExternalLink, FileText, Container, RefreshCw } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { cn } from "@/lib/utils";
import type { Project, RepositoryConfig, PortMapping, PortProtocol } from "@/types";

interface RepositorySettingsProps {
  project: Project;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdateProject?: (project: Project) => Promise<Project | void>;
}

const DEFAULT_CONFIG: RepositoryConfig = {
  defaultBranch: "main",
  prBaseBranch: "main",
};

export function RepositorySettings({
  project,
  open,
  onOpenChange,
  onUpdateProject,
}: RepositorySettingsProps) {
  const { getRepositoryConfig, setRepositoryConfig, setConfig } = useConfigStore();

  const existingConfig = getRepositoryConfig(project.id);
  const initialConfig = existingConfig ?? DEFAULT_CONFIG;

  // Project fields
  const [projectName, setProjectName] = useState(project.name);
  const [localPath, setLocalPath] = useState(project.localPath || "");
  const [projectNameError, setProjectNameError] = useState<string | null>(null);

  // Repository config fields
  const [defaultBranch, setDefaultBranch] = useState(initialConfig.defaultBranch);
  const [prBaseBranch, setPrBaseBranch] = useState(initialConfig.prBaseBranch);
  const [portMappings, setPortMappings] = useState<PortMapping[]>(
    initialConfig.defaultPortMappings ?? []
  );
  const [showPortConfig, setShowPortConfig] = useState(false);
  const [filesToCopy, setFilesToCopy] = useState<string[]>(
    initialConfig.filesToCopy ?? []
  );
  const [showFilesConfig, setShowFilesConfig] = useState(false);
  const [showDockerConfig, setShowDockerConfig] = useState(false);
  const [dockerfile, setDockerfile] = useState<string | undefined>(initialConfig.dockerfile);
  const [isEjecting, setIsEjecting] = useState(false);
  const [isRebuilding, setIsRebuilding] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Reset form when project changes or dialog opens
  useEffect(() => {
    if (open) {
      // Reset project fields
      setProjectName(project.name);
      setLocalPath(project.localPath || "");
      setProjectNameError(null);

      // Reset repo config fields
      const config = getRepositoryConfig(project.id) ?? DEFAULT_CONFIG;
      setDefaultBranch(config.defaultBranch);
      setPrBaseBranch(config.prBaseBranch);
      setPortMappings(config.defaultPortMappings ?? []);
      setShowPortConfig((config.defaultPortMappings ?? []).length > 0);
      setFilesToCopy(config.filesToCopy ?? []);
      setShowFilesConfig((config.filesToCopy ?? []).length > 0);
      setDockerfile(config.dockerfile);
      setShowDockerConfig(!!config.dockerfile);
    }
  }, [open, project.id, project.name, project.localPath, getRepositoryConfig]);

  // Validate project name
  const validateProjectName = (value: string): boolean => {
    const trimmed = value.trim();
    if (!trimmed) {
      setProjectNameError("Name cannot be empty");
      return false;
    }
    if (trimmed.length > 100) {
      setProjectNameError("Name cannot exceed 100 characters");
      return false;
    }
    setProjectNameError(null);
    return true;
  };

  // Handle project name change
  const handleProjectNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setProjectName(value);
    validateProjectName(value);
  };

  // Browse for local directory
  const handleBrowse = async () => {
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: "Select Repository Directory",
        defaultPath: localPath || undefined,
      });

      if (selected && typeof selected === "string") {
        setLocalPath(selected);
      }
    } catch (err) {
      console.error("Failed to open directory picker:", err);
    }
  };

  const addPortMapping = useCallback(() => {
    setPortMappings((prev) => [
      ...prev,
      { containerPort: 3000, hostPort: 3000, protocol: "tcp" as PortProtocol },
    ]);
  }, []);

  const removePortMapping = useCallback((index: number) => {
    setPortMappings((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const updatePortMapping = useCallback(
    (index: number, updates: Partial<PortMapping>) => {
      setPortMappings((prev) =>
        prev.map((m, i) => (i === index ? { ...m, ...updates } : m))
      );
    },
    []
  );

  // File to copy management
  const addFileToCopy = useCallback(() => {
    setFilesToCopy((prev) => [...prev, ""]);
  }, []);

  const removeFileToCopy = useCallback((index: number) => {
    setFilesToCopy((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const updateFileToCopy = useCallback((index: number, value: string) => {
    setFilesToCopy((prev) => prev.map((f, i) => (i === index ? value : f)));
  }, []);

  // Browse for file to copy (relative to project local path)
  const handleBrowseFile = async (index: number) => {
    if (!localPath) {
      toast.error("Set a local path first", {
        description: "You need to set the local path before browsing for files.",
      });
      return;
    }

    try {
      const selected = await openDialog({
        directory: false,
        multiple: false,
        title: "Select File to Copy",
        defaultPath: localPath,
      });

      if (selected && typeof selected === "string") {
        // Convert absolute path to relative path
        if (selected.startsWith(localPath)) {
          let relativePath = selected.slice(localPath.length);
          // Remove leading slash if present
          if (relativePath.startsWith("/")) {
            relativePath = relativePath.slice(1);
          }
          updateFileToCopy(index, relativePath);
        } else {
          toast.error("Invalid file location", {
            description: "The file must be inside the project's local path.",
          });
        }
      }
    } catch (err) {
      console.error("Failed to open file picker:", err);
    }
  };

  // Docker eject handler
  const handleEjectDockerfile = async () => {
    if (!localPath) {
      toast.error("Local path required", {
        description: "Set a local path before ejecting the Dockerfile.",
      });
      return;
    }

    setIsEjecting(true);
    try {
      const path = await tauri.ejectDockerfile(project.id);
      // Backend updated the config - reload it to sync the store
      const freshConfig = await tauri.getConfig();
      setConfig(freshConfig);
      setDockerfile(freshConfig.repositories[project.id]?.dockerfile);
      toast.success("Dockerfile ejected", {
        description: path,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error("Failed to eject Dockerfile", { description: message });
    } finally {
      setIsEjecting(false);
    }
  };

  // Docker rebuild handler
  const handleRebuildImage = async () => {
    setIsRebuilding(true);
    try {
      const tag = await tauri.rebuildCustomImage(project.id);
      toast.success("Image rebuilt", {
        description: `Tag: ${tag}`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error("Failed to rebuild image", { description: message });
    } finally {
      setIsRebuilding(false);
    }
  };

  // Validate files to copy - returns { valid: boolean, error?: string }
  const validateFilesToCopy = useCallback((): { valid: boolean; error?: string } => {
    for (const file of filesToCopy) {
      const trimmed = file.trim();
      if (trimmed === "") continue; // Empty entries are removed on save
      if (trimmed.startsWith("/")) {
        return { valid: false, error: "Paths must be relative (cannot start with /)" };
      }
      if (trimmed.includes("..")) {
        return { valid: false, error: "Paths cannot contain .." };
      }
    }
    // Check for duplicates (excluding empty entries)
    // Use case-insensitive comparison for macOS filesystem compatibility
    const nonEmpty = filesToCopy.filter((f) => f.trim() !== "");
    const normalized = nonEmpty.map((f) => f.toLowerCase());
    const hasDuplicates = new Set(normalized).size !== normalized.length;
    if (hasDuplicates) {
      return { valid: false, error: "Duplicate file paths are not allowed" };
    }
    return { valid: true };
  }, [filesToCopy]);

  // Validate port mappings - returns { valid: boolean, error?: string }
  const validatePortMappings = useCallback((): { valid: boolean; error?: string } => {
    for (const mapping of portMappings) {
      if (mapping.containerPort < 1 || mapping.containerPort > 65535) {
        return { valid: false, error: "Port numbers must be between 1 and 65535" };
      }
      if (mapping.hostPort < 1 || mapping.hostPort > 65535) {
        return { valid: false, error: "Port numbers must be between 1 and 65535" };
      }
    }
    // Check for duplicate host ports
    const hostPorts = portMappings.map((m) => m.hostPort);
    const hasDuplicates = new Set(hostPorts).size !== hostPorts.length;
    if (hasDuplicates) {
      return { valid: false, error: "Each host port can only be used once" };
    }
    return { valid: true };
  }, [portMappings]);

  const handleSave = async () => {
    // Validate project name
    if (!validateProjectName(projectName)) {
      return;
    }

    // Validate port mappings
    const portValidation = validatePortMappings();
    if (!portValidation.valid) {
      toast.error("Invalid port mappings", {
        description: portValidation.error,
      });
      return;
    }

    // Validate files to copy
    const filesValidation = validateFilesToCopy();
    if (!filesValidation.valid) {
      toast.error("Invalid files to copy", {
        description: filesValidation.error,
      });
      return;
    }

    setIsSaving(true);
    try {
      // Update project if name or localPath changed
      const trimmedName = projectName.trim();
      const trimmedPath = localPath.trim() || null;
      const projectChanged = trimmedName !== project.name || trimmedPath !== project.localPath;

      if (projectChanged && onUpdateProject) {
        await onUpdateProject({
          ...project,
          name: trimmedName,
          localPath: trimmedPath,
        });
      }

      // Update repository config - filter out empty file paths
      const cleanedFilesToCopy = filesToCopy.filter((f) => f.trim() !== "");
      const repoConfig: RepositoryConfig = {
        defaultBranch,
        prBaseBranch,
        defaultPortMappings: portMappings.length > 0 ? portMappings : undefined,
        filesToCopy: cleanedFilesToCopy.length > 0 ? cleanedFilesToCopy : undefined,
        dockerfile,
      };

      // Update backend
      const newConfig = await tauri.updateRepositoryConfig(project.id, repoConfig);
      setConfig(newConfig);

      // Also update local store
      setRepositoryConfig(project.id, repoConfig);

      toast.success("Settings saved");
      onOpenChange(false);
    } catch (err) {
      console.error("Failed to save settings:", err);
      const message = err instanceof Error ? err.message : "Failed to save settings";
      toast.error("Failed to save settings", { description: message });
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancel = () => {
    // Reset project fields
    setProjectName(project.name);
    setLocalPath(project.localPath || "");
    setProjectNameError(null);

    // Reset repo config fields
    const config = getRepositoryConfig(project.id) ?? DEFAULT_CONFIG;
    setDefaultBranch(config.defaultBranch);
    setPrBaseBranch(config.prBaseBranch);
    setPortMappings(config.defaultPortMappings ?? []);
    setFilesToCopy(config.filesToCopy ?? []);
    setDockerfile(config.dockerfile);
    onOpenChange(false);
  };

  // Memoize validation results to avoid recalculating on every render
  const portValidationResult = useMemo(() => validatePortMappings(), [validatePortMappings]);
  const filesValidationResult = useMemo(() => validateFilesToCopy(), [validateFilesToCopy]);

  // Memoize non-empty file count for UI display
  const nonEmptyFilesCount = useMemo(
    () => filesToCopy.filter((f) => f.trim() !== "").length,
    [filesToCopy]
  );

  const hasErrors = projectNameError !== null || !portValidationResult.valid || !filesValidationResult.valid;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px] max-h-[85vh] flex flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle>Repository Settings</DialogTitle>
          <DialogDescription>
            Configure settings for this repository
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4 overflow-y-auto flex-1 pr-2">
          {/* Project Settings Section */}
          <div className="grid gap-2">
            <Label htmlFor="projectName">Name</Label>
            <Input
              id="projectName"
              value={projectName}
              onChange={handleProjectNameChange}
              placeholder="Project name"
              disabled={isSaving}
            />
            {projectNameError && (
              <p className="text-sm text-destructive">{projectNameError}</p>
            )}
          </div>

          <div className="grid gap-2">
            <Label>Git URL</Label>
            <div className="flex items-center gap-2">
              <Input
                value={project.gitUrl}
                readOnly
                className="bg-muted cursor-default flex-1"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => window.open(project.gitUrl, "_blank")}
                title="Open in browser"
              >
                <ExternalLink className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              The Git URL cannot be changed after adding the project.
            </p>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="localPath">Local Path</Label>
            <div className="flex gap-2">
              <Input
                id="localPath"
                value={localPath}
                onChange={(e) => setLocalPath(e.target.value)}
                placeholder="/path/to/repository"
                className="flex-1"
                disabled={isSaving}
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={handleBrowse}
                disabled={isSaving}
              >
                <FolderOpen className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              If you have a local clone, select it to copy .env files to environments.
            </p>
          </div>

          {/* Separator */}
          <div className="border-t border-border my-2" />

          {/* Repository Config Section */}
          <div className="grid gap-2">
            <Label htmlFor="defaultBranch">Default Branch</Label>
            <Input
              id="defaultBranch"
              value={defaultBranch}
              onChange={(e) => setDefaultBranch(e.target.value)}
              placeholder="main"
            />
            <p className="text-xs text-muted-foreground">
              The branch to clone when creating new environments
            </p>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="prBaseBranch">PR Base Branch</Label>
            <Input
              id="prBaseBranch"
              value={prBaseBranch}
              onChange={(e) => setPrBaseBranch(e.target.value)}
              placeholder="main"
            />
            <p className="text-xs text-muted-foreground">
              The target branch for pull requests
            </p>
          </div>

          {/* Default Port Configuration */}
          <Collapsible open={showPortConfig} onOpenChange={setShowPortConfig}>
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                className="w-full justify-between p-3 h-auto rounded-lg border border-input bg-muted/30 hover:bg-muted/50"
                disabled={isSaving}
              >
                <div className="flex items-center gap-2">
                  <Network className="h-4 w-4" />
                  <span className="text-sm font-medium">Default Port Mappings</span>
                  {portMappings.length > 0 && (
                    <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                      {portMappings.length} port{portMappings.length !== 1 ? "s" : ""}
                    </span>
                  )}
                </div>
                <ChevronDown
                  className={cn(
                    "h-4 w-4 transition-transform duration-200",
                    showPortConfig && "rotate-180"
                  )}
                />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-3 space-y-3">
              <p className="text-xs text-muted-foreground">
                These port mappings will be pre-filled when creating new environments for this repository.
              </p>
              {portMappings.map((mapping, index) => (
                <div key={index} className="flex items-center gap-2">
                  <div className="flex-1 grid grid-cols-[1fr_auto_1fr_auto_auto] items-center gap-2">
                    <Input
                      type="number"
                      placeholder="Container"
                      value={mapping.containerPort}
                      onChange={(e) =>
                        updatePortMapping(index, {
                          containerPort: parseInt(e.target.value) || 0,
                        })
                      }
                      className="text-sm"
                      min={1}
                      max={65535}
                      disabled={isSaving}
                    />
                    <span className="text-muted-foreground">:</span>
                    <Input
                      type="number"
                      placeholder="Host"
                      value={mapping.hostPort}
                      onChange={(e) =>
                        updatePortMapping(index, {
                          hostPort: parseInt(e.target.value) || 0,
                        })
                      }
                      className="text-sm"
                      min={1}
                      max={65535}
                      disabled={isSaving}
                    />
                    <Select
                      value={mapping.protocol}
                      onValueChange={(value: PortProtocol) =>
                        updatePortMapping(index, { protocol: value })
                      }
                      disabled={isSaving}
                    >
                      <SelectTrigger className="w-20">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="tcp">TCP</SelectItem>
                        <SelectItem value="udp">UDP</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => removePortMapping(index)}
                      disabled={isSaving}
                      className="h-8 w-8"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addPortMapping}
                disabled={isSaving}
                className="w-full"
              >
                <Plus className="h-4 w-4 mr-2" />
                Add Port Mapping
              </Button>
            </CollapsibleContent>
          </Collapsible>

          {/* Files to Copy Configuration */}
          <Collapsible open={showFilesConfig} onOpenChange={setShowFilesConfig}>
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                className="w-full justify-between p-3 h-auto rounded-lg border border-input bg-muted/30 hover:bg-muted/50"
                disabled={isSaving}
              >
                <div className="flex items-center gap-2">
                  <FileText className="h-4 w-4" />
                  <span className="text-sm font-medium">Files to Copy</span>
                  {nonEmptyFilesCount > 0 && (
                    <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                      {nonEmptyFilesCount} file{nonEmptyFilesCount !== 1 ? "s" : ""}
                    </span>
                  )}
                </div>
                <ChevronDown
                  className={cn(
                    "h-4 w-4 transition-transform duration-200",
                    showFilesConfig && "rotate-180"
                  )}
                />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-3 space-y-3">
              <p className="text-xs text-muted-foreground">
                Specify files from your local repository to copy into environments. Use relative paths from the project root.
              </p>
              {filesToCopy.map((filePath, index) => (
                <div key={index} className="flex items-center gap-2">
                  <Input
                    value={filePath}
                    onChange={(e) => updateFileToCopy(index, e.target.value)}
                    placeholder="config/settings.json"
                    className="flex-1 text-sm"
                    disabled={isSaving}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={() => handleBrowseFile(index)}
                    disabled={isSaving || !localPath}
                    title={localPath ? "Browse for file" : "Set local path first"}
                    className="h-8 w-8"
                  >
                    <FolderOpen className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => removeFileToCopy(index)}
                    disabled={isSaving}
                    className="h-8 w-8"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addFileToCopy}
                disabled={isSaving}
                className="w-full"
              >
                <Plus className="h-4 w-4 mr-2" />
                Add File
              </Button>
            </CollapsibleContent>
          </Collapsible>

          {/* Docker Configuration */}
          <Collapsible open={showDockerConfig} onOpenChange={setShowDockerConfig}>
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                className="w-full justify-between p-3 h-auto rounded-lg border border-input bg-muted/30 hover:bg-muted/50"
                disabled={isSaving}
              >
                <div className="flex items-center gap-2">
                  <Container className="h-4 w-4" />
                  <span className="text-sm font-medium">Docker Configuration</span>
                  {dockerfile && (
                    <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                      Custom
                    </span>
                  )}
                </div>
                <ChevronDown
                  className={cn(
                    "h-4 w-4 transition-transform duration-200",
                    showDockerConfig && "rotate-180"
                  )}
                />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-3 space-y-3">
              {!dockerfile ? (
                <>
                  <p className="text-xs text-muted-foreground">
                    Eject the built-in Dockerfile to customize the container base image, installed packages, and build steps.
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleEjectDockerfile}
                    disabled={isSaving || isEjecting || !localPath}
                    className="w-full"
                  >
                    {isEjecting ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Ejecting...
                      </>
                    ) : (
                      <>
                        <Container className="h-4 w-4 mr-2" />
                        Eject Dockerfile
                      </>
                    )}
                  </Button>
                  {!localPath && (
                    <p className="text-xs text-destructive">
                      A local path is required to eject the Dockerfile.
                    </p>
                  )}
                </>
              ) : (
                <>
                  <div className="flex items-center gap-2 text-sm text-muted-foreground bg-muted/50 rounded-md px-3 py-2">
                    <FileText className="h-4 w-4 shrink-0" />
                    <span className="font-mono text-xs truncate">{dockerfile}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Edit the Dockerfile in your project, then rebuild to apply changes. The image is cached and only rebuilt when content changes.
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleRebuildImage}
                    disabled={isSaving || isRebuilding}
                    className="w-full"
                  >
                    {isRebuilding ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Rebuilding...
                      </>
                    ) : (
                      <>
                        <RefreshCw className="h-4 w-4 mr-2" />
                        Rebuild Image
                      </>
                    )}
                  </Button>
                </>
              )}
            </CollapsibleContent>
          </Collapsible>
        </div>

        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={handleCancel}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isSaving || hasErrors}>
            {isSaving ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving...
              </>
            ) : (
              "Save"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
