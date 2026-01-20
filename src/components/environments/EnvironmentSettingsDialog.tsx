import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Loader2,
  Shield,
  Globe,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Settings2,
  Network,
  Plus,
  Trash2,
  Laptop,
  FolderOpen,
} from "lucide-react";
import * as tauri from "@/lib/tauri";
import { useConfigStore } from "@/stores";
import type { Environment, DomainTestResult, PortMapping, PortProtocol } from "@/types";

// Domain validation regex
const DOMAIN_REGEX = /^([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

interface EnvironmentSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environment: Environment;
  onUpdate: (environment: Environment) => void;
  onRestart?: (environmentId: string) => Promise<void>;
}

export function EnvironmentSettingsDialog({
  open,
  onOpenChange,
  environment,
  onUpdate,
  onRestart,
}: EnvironmentSettingsDialogProps) {
  const { config } = useConfigStore();
  const globalDomains = config.global.allowedDomains || [];

  // Name state
  const [name, setName] = useState(environment.name);
  const [nameError, setNameError] = useState<string | null>(null);

  // Network state
  const [useGlobalDefaults, setUseGlobalDefaults] = useState(
    !environment.allowedDomains || environment.allowedDomains.length === 0
  );
  const [customDomains, setCustomDomains] = useState(
    (environment.allowedDomains || globalDomains).join("\n")
  );
  const [domainErrors, setDomainErrors] = useState<string[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [testResults, setTestResults] = useState<DomainTestResult[] | null>(null);

  // Port mapping state
  const [portMappings, setPortMappings] = useState<PortMapping[]>(
    environment.portMappings || []
  );
  const [showAddPortForm, setShowAddPortForm] = useState(false);
  const [newPortMapping, setNewPortMapping] = useState<PortMapping>({
    containerPort: 3000,
    hostPort: 3000,
    protocol: "tcp",
  });
  const [portError, setPortError] = useState<string | null>(null);
  const [showRestartConfirm, setShowRestartConfirm] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);

  // Track if port mappings have changed
  const portMappingsChanged = JSON.stringify(portMappings) !== JSON.stringify(environment.portMappings || []);

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      // Reset name
      setName(environment.name);
      setNameError(null);

      // Reset network settings
      const customDomainList = environment.allowedDomains ?? [];
      const hasCustom = customDomainList.length > 0;
      setUseGlobalDefaults(!hasCustom);
      setCustomDomains(
        (hasCustom ? customDomainList : globalDomains).join("\n")
      );
      setDomainErrors([]);
      setTestResults(null);

      // Reset port state
      setPortMappings(environment.portMappings || []);
      setShowAddPortForm(false);
      setNewPortMapping({ containerPort: 3000, hostPort: 3000, protocol: "tcp" });
      setPortError(null);
      setShowRestartConfirm(false);
      setIsRestarting(false);
    }
  }, [open, environment.name, environment.allowedDomains, environment.portMappings, globalDomains]);

  // Update custom domains when toggling to global
  useEffect(() => {
    if (useGlobalDefaults) {
      setCustomDomains(globalDomains.join("\n"));
      setDomainErrors([]);
      setTestResults(null);
    }
  }, [useGlobalDefaults, globalDomains]);

  // Validate name
  const validateName = (value: string): boolean => {
    const trimmed = value.trim();
    if (!trimmed) {
      setNameError("Name cannot be empty");
      return false;
    }
    if (trimmed.length > 100) {
      setNameError("Name cannot exceed 100 characters");
      return false;
    }
    setNameError(null);
    return true;
  };

  // Handle name change
  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setName(value);
    validateName(value);
  };

  // Validate domains locally
  const validateDomainsLocally = useCallback((domainsText: string) => {
    const domains = domainsText
      .split("\n")
      .map((d) => d.trim())
      .filter((d) => d.length > 0);

    const errors: string[] = [];
    for (const domain of domains) {
      if (!DOMAIN_REGEX.test(domain)) {
        errors.push(`Invalid domain format: ${domain}`);
      }
    }
    setDomainErrors(errors);
    setTestResults(null);
    return errors.length === 0;
  }, []);

  // Handle domain textarea change
  const handleDomainsChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setCustomDomains(value);
    validateDomainsLocally(value);
  };

  // Test DNS resolution
  const handleTestDomains = async () => {
    const domains = customDomains
      .split("\n")
      .map((d) => d.trim())
      .filter((d) => d.length > 0);

    if (domains.length === 0) return;

    setIsTesting(true);
    setTestResults(null);
    try {
      const results = await tauri.testDomainResolution(domains);
      setTestResults(results);
    } catch (err) {
      console.error("[EnvironmentSettingsDialog] Failed to test domains:", err);
    } finally {
      setIsTesting(false);
    }
  };

  // Add a port mapping (locally, will be saved on save)
  const handleAddPortMapping = () => {
    // Validate port numbers
    if (newPortMapping.containerPort < 1 || newPortMapping.containerPort > 65535) {
      setPortError("Container port must be between 1 and 65535");
      return;
    }
    if (newPortMapping.hostPort < 1 || newPortMapping.hostPort > 65535) {
      setPortError("Host port must be between 1 and 65535");
      return;
    }

    // Check for duplicate container port
    if (portMappings.some(m => m.containerPort === newPortMapping.containerPort && m.protocol === newPortMapping.protocol)) {
      setPortError(`Port ${newPortMapping.containerPort}/${newPortMapping.protocol} is already mapped`);
      return;
    }

    setPortError(null);
    setPortMappings([...portMappings, { ...newPortMapping }]);
    setShowAddPortForm(false);
    setNewPortMapping({ containerPort: 3000, hostPort: 3000, protocol: "tcp" });
  };

  // Remove a port mapping (locally, will be saved on save)
  const handleRemovePortMapping = (index: number) => {
    setPortMappings(portMappings.filter((_, i) => i !== index));
    setPortError(null);
  };

  // Handle restart with port changes
  const handleRestartWithChanges = async () => {
    if (!onRestart) return;

    setIsRestarting(true);
    try {
      // First save the port mappings
      await tauri.updatePortMappings(environment.id, portMappings);

      // Optimistically update status to "creating" so the UI shows a spinner immediately
      onUpdate({ ...environment, status: "creating" });

      // Close the dialog immediately so user can see the spinner in the sidebar
      setShowRestartConfirm(false);
      onOpenChange(false);

      // Then recreate the environment (this creates a new container with new port mappings)
      await onRestart(environment.id);

      // Sync the environment to get the updated container_id and status
      const synced = await tauri.syncEnvironmentStatus(environment.id);
      onUpdate(synced);

      toast.success("Environment recreated with new port mappings");
    } catch (err) {
      console.error("[EnvironmentSettingsDialog] Failed to restart with changes:", err);
      const message = err instanceof Error ? err.message : String(err);
      toast.error("Failed to recreate environment", { description: message });

      // Try to sync even on error to get the correct state
      try {
        const synced = await tauri.syncEnvironmentStatus(environment.id);
        onUpdate(synced);
      } catch {
        // Ignore sync errors
      }
    } finally {
      setIsRestarting(false);
    }
  };

  // Save changes
  const handleSave = async () => {
    // Validate name
    if (!validateName(name)) {
      return;
    }

    // If port mappings changed and environment is running, show restart confirmation
    if (portMappingsChanged && environment.status === "running" && onRestart) {
      setShowRestartConfirm(true);
      return;
    }

    const domains = useGlobalDefaults
      ? undefined
      : customDomains
          .split("\n")
          .map((d) => d.trim())
          .filter((d) => d.length > 0);

    setIsSaving(true);
    try {
      let updated = environment;

      // Update name if changed
      const trimmedName = name.trim();
      if (trimmedName !== environment.name) {
        updated = await tauri.renameEnvironment(environment.id, trimmedName);
      }

      // Update domains if not in full access mode
      const isFullAccess = (environment.networkAccessMode ?? "restricted") === "full";
      if (!isFullAccess) {
        const domainsToSave = useGlobalDefaults ? [] : (domains || []);
        updated = await tauri.updateEnvironmentAllowedDomains(
          environment.id,
          domainsToSave
        );
      }

      // Update port mappings if changed (only effective after restart for running containers)
      if (portMappingsChanged) {
        updated = await tauri.updatePortMappings(environment.id, portMappings);
      }

      onUpdate(updated);
      toast.success("Environment settings saved");
      onOpenChange(false);
    } catch (err) {
      console.error("[EnvironmentSettingsDialog] Failed to save:", err);
      const message = err instanceof Error ? err.message : "Failed to save settings";
      setNameError(message);
      toast.error("Failed to save settings", { description: message });
    } finally {
      setIsSaving(false);
    }
  };

  const isFullAccess = (environment.networkAccessMode ?? "restricted") === "full";
  const isLocalEnvironment = environment.environmentType === "local";
  const hasErrors = nameError !== null || domainErrors.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[700px] max-h-[90vh] flex flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <Settings2 className="h-5 w-5" />
            Environment Settings
          </DialogTitle>
          <DialogDescription>
            Configure settings for this environment.
          </DialogDescription>
        </DialogHeader>

        <div className={`${isLocalEnvironment ? "space-y-6" : "grid grid-cols-2 gap-6"} py-4 overflow-y-auto flex-1 pr-2`}>
          {/* For local environments: single column, for containerized: two columns */}
          <div className="space-y-6">
            {/* Name section */}
            <div className="space-y-2">
              <Label htmlFor="env-name">Name</Label>
              <Input
                id="env-name"
                value={name}
                onChange={handleNameChange}
                placeholder="Environment name"
              />
              {nameError && (
                <p className="text-sm text-destructive">{nameError}</p>
              )}
            </div>

            {/* Local Environment Info */}
            {isLocalEnvironment && (
              <div className="space-y-4">
                <Label>Environment Type</Label>
                <div className="flex items-center gap-2 p-3 rounded-md bg-muted border border-input">
                  <Laptop className="h-4 w-4 text-blue-500 shrink-0" />
                  <div>
                    <div className="font-medium text-sm">Local Environment</div>
                    <div className="text-xs text-muted-foreground">
                      Uses a git worktree on your machine (no Docker container)
                    </div>
                  </div>
                </div>
                {environment.worktreePath && (
                  <div className="space-y-2">
                    <Label>Worktree Location</Label>
                    <div className="flex items-center gap-2 p-2 rounded-md bg-muted/50 border border-input">
                      <FolderOpen className="h-4 w-4 text-muted-foreground shrink-0" />
                      <span className="text-sm font-mono truncate">
                        {environment.worktreePath}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Network Access - only for containerized environments */}
            {!isLocalEnvironment && (
            <div className="space-y-4">
              <Label>Network Access</Label>
              <div className="flex items-center gap-2 p-3 rounded-md bg-muted border border-input">
                {isFullAccess ? (
                  <>
                    <Globe className="h-4 w-4 text-blue-500 shrink-0" />
                    <div>
                      <div className="font-medium text-sm">Full Network Access</div>
                      <div className="text-xs text-muted-foreground">
                        Unrestricted internet access. Whitelist does not apply.
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    <Shield className="h-4 w-4 text-green-500 shrink-0" />
                    <div>
                      <div className="font-medium text-sm">Restricted Network Access</div>
                      <div className="text-xs text-muted-foreground">
                        Only whitelisted domains are accessible.
                      </div>
                    </div>
                  </>
                )}
              </div>

              {/* Only show whitelist controls for restricted mode */}
              {!isFullAccess && (
                <>
                  {/* Global defaults toggle */}
                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label>Use Global Defaults</Label>
                      <p className="text-xs text-muted-foreground">
                        Use default allowed domains
                      </p>
                    </div>
                    <Switch
                      checked={useGlobalDefaults}
                      onCheckedChange={setUseGlobalDefaults}
                    />
                  </div>

                  {/* Custom domains textarea */}
                  <div className="space-y-2">
                    <Label>Allowed Domains</Label>
                    <Textarea
                      value={customDomains}
                      onChange={handleDomainsChange}
                      disabled={useGlobalDefaults}
                      placeholder={"github.com\nregistry.npmjs.org\napi.anthropic.com"}
                      rows={8}
                      className={`font-mono text-sm ${
                        domainErrors.length > 0 ? "border-red-500" : ""
                      } ${useGlobalDefaults ? "opacity-50" : ""}`}
                    />
                  </div>

                  {/* Validation errors */}
                  {domainErrors.length > 0 && (
                    <div className="text-sm text-red-500 space-y-1">
                      {domainErrors.map((error, i) => (
                        <div key={i} className="flex items-center gap-1">
                          <XCircle className="h-3 w-3" />
                          {error}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Test button */}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleTestDomains}
                    disabled={isTesting || domainErrors.length > 0 || useGlobalDefaults}
                  >
                    {isTesting ? (
                      <>
                        <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                        Testing...
                      </>
                    ) : (
                      "Test DNS Resolution"
                    )}
                  </Button>

                  {/* Test results */}
                  {testResults && (
                    <div className="border rounded-md p-3 space-y-2 text-sm max-h-32 overflow-y-auto">
                      <div className="font-medium">DNS Test Results:</div>
                      {testResults.map((result, i) => (
                        <div key={i} className="flex items-start gap-2">
                          {result.resolvable ? (
                            <CheckCircle2 className="h-4 w-4 text-green-500 mt-0.5 shrink-0" />
                          ) : result.valid ? (
                            <AlertCircle className="h-4 w-4 text-yellow-500 mt-0.5 shrink-0" />
                          ) : (
                            <XCircle className="h-4 w-4 text-red-500 mt-0.5 shrink-0" />
                          )}
                          <div className="min-w-0">
                            <span className="font-mono text-xs break-all">{result.domain}</span>
                            {result.error && (
                              <span className="text-red-500 text-xs block">{result.error}</span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Running container note */}
                  {environment.status === "running" && (
                    <p className="text-xs text-muted-foreground">
                      Changes will be applied to the running container immediately.
                    </p>
                  )}
                </>
              )}
            </div>
            )}
          </div>

          {/* RIGHT COLUMN: Port Mappings - only for containerized environments */}
          {!isLocalEnvironment && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Network className="h-4 w-4" />
                <Label>Port Mappings</Label>
              </div>
              {!showAddPortForm && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setShowAddPortForm(true)}
                >
                  <Plus className="h-4 w-4 mr-1" />
                  Add Port
                </Button>
              )}
            </div>

            <p className="text-xs text-muted-foreground">
              Expose container ports to the host machine. Changes require a container restart to take effect.
            </p>

            {/* Port mappings list */}
            {portMappings.length > 0 && (
              <div className="space-y-2">
                {portMappings.map((mapping, index) => (
                  <div
                    key={`port-${index}`}
                    className="flex items-center justify-between p-2 rounded-md bg-muted/50 border border-input"
                  >
                    <span className="text-sm font-mono">
                      {mapping.containerPort}:{mapping.hostPort}/{mapping.protocol}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => handleRemovePortMapping(index)}
                      className="h-7 w-7"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}

            {/* Port error message */}
            {portError && (
              <div className="flex items-center gap-2 p-2 rounded-md bg-destructive/10 text-destructive text-sm">
                <XCircle className="h-4 w-4 shrink-0" />
                <span>{portError}</span>
              </div>
            )}

            {/* No ports message */}
            {portMappings.length === 0 && !showAddPortForm && (
              <p className="text-sm text-muted-foreground">
                No port mappings configured. Click "Add Port" to expose a container port.
              </p>
            )}

            {/* Restart warning for running containers with changes */}
            {portMappingsChanged && environment.status === "running" && (
              <div className="flex items-center gap-2 p-2 rounded-md bg-yellow-500/10 text-yellow-700 dark:text-yellow-400 text-sm">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span>Port changes require a container restart to take effect.</span>
              </div>
            )}

            {/* Add new port mapping form */}
            {showAddPortForm && (
              <div className="space-y-3 p-3 rounded-md border">
                <p className="text-sm font-medium">Add Port Mapping</p>
                <div className="space-y-2">
                  <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                    <Input
                      type="number"
                      placeholder="Container"
                      value={newPortMapping.containerPort}
                      onChange={(e) =>
                        setNewPortMapping({
                          ...newPortMapping,
                          containerPort: parseInt(e.target.value) || 0,
                        })
                      }
                      className="text-sm"
                      min={1}
                      max={65535}
                    />
                    <span className="text-muted-foreground">:</span>
                    <Input
                      type="number"
                      placeholder="Host"
                      value={newPortMapping.hostPort}
                      onChange={(e) =>
                        setNewPortMapping({
                          ...newPortMapping,
                          hostPort: parseInt(e.target.value) || 0,
                        })
                      }
                      className="text-sm"
                      min={1}
                      max={65535}
                    />
                  </div>
                  <Select
                    value={newPortMapping.protocol}
                    onValueChange={(value: PortProtocol) =>
                      setNewPortMapping({ ...newPortMapping, protocol: value })
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="tcp">TCP</SelectItem>
                      <SelectItem value="udp">UDP</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowAddPortForm(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    onClick={handleAddPortMapping}
                    disabled={newPortMapping.containerPort < 1 || newPortMapping.hostPort < 1}
                  >
                    Add
                  </Button>
                </div>
              </div>
            )}
          </div>
          )}
        </div>

        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={isSaving || hasErrors}
          >
            {isSaving ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving...
              </>
            ) : (
              "Save Changes"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>

      {/* Restart confirmation dialog */}
      <AlertDialog open={showRestartConfirm} onOpenChange={setShowRestartConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Container Recreate Required</AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              <p>
                Port mapping changes require the container to be recreated.
                <strong> All running processes will be terminated.</strong>
              </p>
              <p className="text-sm">
                Your filesystem state (installed packages, file changes) will be preserved.
                However, any dev servers, build processes, or other running programs will need to be restarted.
              </p>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isRestarting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRestartWithChanges}
              disabled={isRestarting}
            >
              {isRestarting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Restarting...
                </>
              ) : (
                "Restart Environment"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
