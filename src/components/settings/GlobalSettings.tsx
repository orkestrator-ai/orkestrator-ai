import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useConfigStore } from "@/stores";
import * as tauri from "@/lib/tauri";
import { Loader2, Eye, EyeOff, Key, Github, Shield, CheckCircle2, XCircle, AlertCircle, Code2, Check, Terminal, Bot } from "lucide-react";
import { ClaudeIcon, OpenCodeIcon } from "@/components/icons/AgentIcons";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { DomainTestResult, PreferredEditor, TerminalAppearance, DefaultAgent, OpenCodeMode } from "@/types";
import {
  DEFAULT_TERMINAL_APPEARANCE,
  DEFAULT_TERMINAL_SCROLLBACK,
  FONT_OPTIONS,
  isValidHexColor,
  getPreviewColors,
} from "@/constants/terminal";

// Domain validation regex
const DOMAIN_REGEX = /^([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

interface GlobalSettingsProps {
  onSaveSuccess?: () => void;
}

export function GlobalSettings({ onSaveSuccess }: GlobalSettingsProps) {
  const { config, setConfig } = useConfigStore();
  const global = config.global;

  const [cpuCores, setCpuCores] = useState(global.containerResources.cpuCores);
  const [memoryGb, setMemoryGb] = useState(global.containerResources.memoryGb);
  const [envPatterns, setEnvPatterns] = useState(global.envFilePatterns.join(", "));
  const [anthropicApiKey, setAnthropicApiKey] = useState(global.anthropicApiKey || "");
  const [githubToken, setGithubToken] = useState(global.githubToken || "");
  const [allowedDomains, setAllowedDomains] = useState(
    (global.allowedDomains || []).join("\n")
  );
  const [preferredEditor, setPreferredEditor] = useState<PreferredEditor>(
    global.preferredEditor || "vscode"
  );
  const [defaultAgent, setDefaultAgent] = useState<DefaultAgent>(
    global.defaultAgent || "claude"
  );
  const [opencodeModel, setOpencodeModel] = useState(
    global.opencodeModel || "opencode/grok-code"
  );
  const [opencodeMode, setOpencodeMode] = useState<OpenCodeMode>(
    global.opencodeMode || "terminal"
  );
  const [terminalFontFamily, setTerminalFontFamily] = useState(
    global.terminalAppearance?.fontFamily || DEFAULT_TERMINAL_APPEARANCE.fontFamily
  );
  const [terminalFontSize, setTerminalFontSize] = useState(
    global.terminalAppearance?.fontSize || DEFAULT_TERMINAL_APPEARANCE.fontSize
  );
  const [terminalBackgroundColor, setTerminalBackgroundColor] = useState(
    global.terminalAppearance?.backgroundColor || DEFAULT_TERMINAL_APPEARANCE.backgroundColor
  );
  const [terminalScrollback, setTerminalScrollback] = useState(
    typeof global.terminalScrollback === "number"
      ? global.terminalScrollback
      : DEFAULT_TERMINAL_SCROLLBACK
  );
  const [showApiKey, setShowApiKey] = useState(false);
  const [showGithubToken, setShowGithubToken] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [domainErrors, setDomainErrors] = useState<string[]>([]);
  const [colorError, setColorError] = useState<string | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [testResults, setTestResults] = useState<DomainTestResult[] | null>(null);

  // Sync local state when config changes in the store (e.g., after load from backend)
  useEffect(() => {
    console.log("[settings] Store config updated, syncing local state");
    console.log("[settings] githubToken from store:", global.githubToken);
    setCpuCores(global.containerResources.cpuCores);
    setMemoryGb(global.containerResources.memoryGb);
    setEnvPatterns(global.envFilePatterns.join(", "));
    setAnthropicApiKey(global.anthropicApiKey || "");
    setGithubToken(global.githubToken || "");
    setAllowedDomains((global.allowedDomains || []).join("\n"));
    setPreferredEditor(global.preferredEditor || "vscode");
    setDefaultAgent(global.defaultAgent || "claude");
    setOpencodeModel(global.opencodeModel || "opencode/grok-code");
    setOpencodeMode(global.opencodeMode || "terminal");
    setTerminalFontFamily(global.terminalAppearance?.fontFamily || DEFAULT_TERMINAL_APPEARANCE.fontFamily);
    setTerminalFontSize(global.terminalAppearance?.fontSize || DEFAULT_TERMINAL_APPEARANCE.fontSize);
    setTerminalBackgroundColor(global.terminalAppearance?.backgroundColor || DEFAULT_TERMINAL_APPEARANCE.backgroundColor);
    setTerminalScrollback(
      typeof global.terminalScrollback === "number"
        ? global.terminalScrollback
        : DEFAULT_TERMINAL_SCROLLBACK
    );
  }, [global]);

  // Check for changes (compare local state to store)
  useEffect(() => {
    const terminalAppearance = global.terminalAppearance || DEFAULT_TERMINAL_APPEARANCE;
    const changed =
      cpuCores !== global.containerResources.cpuCores ||
      memoryGb !== global.containerResources.memoryGb ||
      envPatterns !== global.envFilePatterns.join(", ") ||
      anthropicApiKey !== (global.anthropicApiKey || "") ||
      githubToken !== (global.githubToken || "") ||
      allowedDomains !== (global.allowedDomains || []).join("\n") ||
      preferredEditor !== (global.preferredEditor || "vscode") ||
      defaultAgent !== (global.defaultAgent || "claude") ||
      opencodeModel !== (global.opencodeModel || "opencode/grok-code") ||
      opencodeMode !== (global.opencodeMode || "terminal") ||
      terminalFontFamily !== terminalAppearance.fontFamily ||
      terminalFontSize !== terminalAppearance.fontSize ||
      terminalBackgroundColor !== terminalAppearance.backgroundColor ||
      terminalScrollback !== (global.terminalScrollback ?? DEFAULT_TERMINAL_SCROLLBACK);
    setHasChanges(changed);
    // Reset success state when user makes new changes
    if (changed) {
      setSaveSuccess(false);
    }
  }, [cpuCores, memoryGb, envPatterns, anthropicApiKey, githubToken, allowedDomains, preferredEditor, defaultAgent, opencodeModel, opencodeMode, terminalFontFamily, terminalFontSize, terminalBackgroundColor, terminalScrollback, global]);

  // Validate domains on change
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
    setTestResults(null); // Clear test results when domains change
    return errors.length === 0;
  }, []);

  // Handle domain textarea change
  const handleDomainsChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setAllowedDomains(value);
    validateDomainsLocally(value);
  };

  // Handle background color change with validation
  const handleBackgroundColorChange = (value: string) => {
    setTerminalBackgroundColor(value);
    // Validate hex color format (allow empty for intermediate states during typing)
    if (value && !isValidHexColor(value)) {
      setColorError("Invalid hex color format. Use #RGB or #RRGGBB.");
    } else {
      setColorError(null);
    }
  };

  // Test DNS resolution for all domains
  const handleTestDomains = async () => {
    const domains = allowedDomains
      .split("\n")
      .map((d) => d.trim())
      .filter((d) => d.length > 0);

    if (domains.length === 0) {
      return;
    }

    setIsTesting(true);
    setTestResults(null);
    try {
      const results = await tauri.testDomainResolution(domains);
      setTestResults(results);
    } catch (err) {
      console.error("[settings] Failed to test domains:", err);
    } finally {
      setIsTesting(false);
    }
  };

  // Save settings
  const handleSave = async () => {
    console.log("[settings] handleSave called");
    setIsSaving(true);
    try {
      const patterns = envPatterns
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p.length > 0);

      const domains = allowedDomains
        .split("\n")
        .map((d) => d.trim())
        .filter((d) => d.length > 0);

      // Build config object - only include optional fields if they have values
      // Rust expects Option<String> which maps to either a string value or absent field
      const newGlobal: {
        containerResources: { cpuCores: number; memoryGb: number };
        envFilePatterns: string[];
        allowedDomains: string[];
        anthropicApiKey?: string;
        githubToken?: string;
        preferredEditor?: PreferredEditor;
        defaultAgent: DefaultAgent;
        opencodeModel: string;
        opencodeMode: OpenCodeMode;
        terminalAppearance: TerminalAppearance;
        terminalScrollback: number;
      } = {
        containerResources: {
          cpuCores,
          memoryGb,
        },
        envFilePatterns: patterns,
        allowedDomains: domains,
        preferredEditor,
        defaultAgent,
        opencodeModel,
        opencodeMode,
        terminalAppearance: {
          fontFamily: terminalFontFamily,
          fontSize: terminalFontSize,
          backgroundColor: terminalBackgroundColor,
        },
        terminalScrollback,
      };

      // Only add optional fields if they have values
      if (anthropicApiKey) {
        newGlobal.anthropicApiKey = anthropicApiKey;
      }
      if (githubToken) {
        newGlobal.githubToken = githubToken;
      }

      console.log("[settings] Sending to backend:", JSON.stringify(newGlobal, null, 2));

      // Update backend
      const newConfig = await tauri.updateGlobalConfig(newGlobal);
      console.log("[settings] Received from backend:", JSON.stringify(newConfig, null, 2));
      setConfig(newConfig);

      setHasChanges(false);
      console.log("[settings] Save complete");
      setSaveSuccess(true);
      toast.success("Settings saved");
      // Show success state briefly before closing
      setTimeout(() => {
        onSaveSuccess?.();
      }, 500);
    } catch (err) {
      console.error("[settings] Failed to save config:", err);
      const message = err instanceof Error ? err.message : "Failed to save settings";
      toast.error("Failed to save settings", { description: message });
    } finally {
      setIsSaving(false);
    }
  };

  // Reset to defaults
  const handleReset = () => {
    setCpuCores(global.containerResources.cpuCores);
    setMemoryGb(global.containerResources.memoryGb);
    setEnvPatterns(global.envFilePatterns.join(", "));
    setAnthropicApiKey(global.anthropicApiKey || "");
    setGithubToken(global.githubToken || "");
    setAllowedDomains((global.allowedDomains || []).join("\n"));
    setPreferredEditor(global.preferredEditor || "vscode");
    setDefaultAgent(global.defaultAgent || "claude");
    setOpencodeModel(global.opencodeModel || "opencode/grok-code");
    setOpencodeMode(global.opencodeMode || "terminal");
    setTerminalFontFamily(global.terminalAppearance?.fontFamily || DEFAULT_TERMINAL_APPEARANCE.fontFamily);
    setTerminalFontSize(global.terminalAppearance?.fontSize || DEFAULT_TERMINAL_APPEARANCE.fontSize);
    setTerminalBackgroundColor(global.terminalAppearance?.backgroundColor || DEFAULT_TERMINAL_APPEARANCE.backgroundColor);
    setTerminalScrollback(
      typeof global.terminalScrollback === "number"
        ? global.terminalScrollback
        : DEFAULT_TERMINAL_SCROLLBACK
    );
  };

  return (
    <div className="space-y-6">
      {/* Two column layout for all settings */}
      <div className="grid grid-cols-2 gap-4">
        {/* Row 1: Preferred Editor | Default Agent */}
        {/* Preferred Editor */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Code2 className="h-4 w-4" />
              Preferred Editor
            </CardTitle>
            <CardDescription>
              Editor for "Open in Editor" (Cmd+O)
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setPreferredEditor("vscode")}
                className={cn(
                  "p-3 rounded-lg border-2 text-left transition-colors",
                  preferredEditor === "vscode"
                    ? "border-primary bg-primary/5"
                    : "border-muted hover:border-muted-foreground/50"
                )}
              >
                <div className="flex items-center gap-2 font-medium">
                  <Code2 className="h-4 w-4" />
                  VS Code
                </div>
              </button>
              <button
                type="button"
                onClick={() => setPreferredEditor("cursor")}
                className={cn(
                  "p-3 rounded-lg border-2 text-left transition-colors",
                  preferredEditor === "cursor"
                    ? "border-primary bg-primary/5"
                    : "border-muted hover:border-muted-foreground/50"
                )}
              >
                <div className="flex items-center gap-2 font-medium">
                  <Code2 className="h-4 w-4" />
                  Cursor
                </div>
              </button>
            </div>
            <span className="mt-3 block text-xs text-muted-foreground/60">
              *Requires the Dev Containers extension
            </span>
          </CardContent>
        </Card>

        {/* Default Agent */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Bot className="h-4 w-4" />
              Default Agent
            </CardTitle>
            <CardDescription>
              Agent to launch in new environments
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setDefaultAgent("claude")}
                className={cn(
                  "p-3 rounded-lg border-2 text-left transition-colors",
                  defaultAgent === "claude"
                    ? "border-primary bg-primary/5"
                    : "border-muted hover:border-muted-foreground/50"
                )}
              >
                <div className="flex items-center gap-2 font-medium">
                  <ClaudeIcon />
                  Claude
                </div>
              </button>
              <button
                type="button"
                onClick={() => setDefaultAgent("opencode")}
                className={cn(
                  "p-3 rounded-lg border-2 text-left transition-colors",
                  defaultAgent === "opencode"
                    ? "border-primary bg-primary/5"
                    : "border-muted hover:border-muted-foreground/50"
                )}
              >
                <div className="flex items-center gap-2 font-medium">
                  <OpenCodeIcon />
                  OpenCode
                </div>
              </button>
            </div>
            {/* OpenCode Model Input - shown below the agent selector */}
            <div className={cn(
              "mt-3 space-y-1.5 transition-opacity",
              defaultAgent !== "opencode" && "opacity-50"
            )}>
              <Label htmlFor="opencode-model" className="text-xs text-muted-foreground">
                OpenCode Model
              </Label>
              <Input
                id="opencode-model"
                value={opencodeModel}
                onChange={(e) => setOpencodeModel(e.target.value)}
                placeholder="opencode/grok-code"
                className="font-mono text-sm h-8"
              />
            </div>
            {/* OpenCode Mode Toggle - shown below model input */}
            <div className={cn(
              "mt-3 space-y-1.5 transition-opacity",
              defaultAgent !== "opencode" && "opacity-50"
            )}>
              <Label className="text-xs text-muted-foreground">
                OpenCode Mode
              </Label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setOpencodeMode("terminal")}
                  className={cn(
                    "p-2 rounded-lg border-2 text-left transition-colors",
                    opencodeMode === "terminal"
                      ? "border-primary bg-primary/5"
                      : "border-muted hover:border-muted-foreground/50"
                  )}
                >
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Terminal className="h-3.5 w-3.5" />
                    Terminal
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => setOpencodeMode("native")}
                  className={cn(
                    "p-2 rounded-lg border-2 text-left transition-colors",
                    opencodeMode === "native"
                      ? "border-primary bg-primary/5"
                      : "border-muted hover:border-muted-foreground/50"
                  )}
                >
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Bot className="h-3.5 w-3.5" />
                    Native
                  </div>
                </button>
              </div>
              <span className="text-xs text-muted-foreground/60">
                Native mode opens a chat interface instead of terminal
              </span>
            </div>
          </CardContent>
        </Card>

        {/* Row 2: GitHub Token | Anthropic API Key */}
        {/* GitHub Token */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Github className="h-4 w-4" />
              GitHub Token
            </CardTitle>
            <CardDescription>
              For cloning private repos and pushing via HTTPS
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="relative">
              <Input
                type={showGithubToken ? "text" : "password"}
                value={githubToken}
                onChange={(e) => setGithubToken(e.target.value)}
                placeholder="ghp_..."
                className="pr-10 font-mono"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7"
                onClick={() => setShowGithubToken(!showGithubToken)}
              >
                {showGithubToken ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Create at{" "}
              <a
                href="https://github.com/settings/tokens?type=beta"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                github.com/settings/tokens
              </a>
            </p>
          </CardContent>
        </Card>

        {/* Anthropic API Key */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Key className="h-4 w-4" />
              Anthropic API Key
            </CardTitle>
            <CardDescription>
              Required for Claude Code inside containers
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="relative">
              <Input
                type={showApiKey ? "text" : "password"}
                value={anthropicApiKey}
                onChange={(e) => setAnthropicApiKey(e.target.value)}
                placeholder="sk-ant-..."
                className="pr-10 font-mono"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7"
                onClick={() => setShowApiKey(!showApiKey)}
              >
                {showApiKey ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Get key from{" "}
              <a
                href="https://console.anthropic.com/settings/keys"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                console.anthropic.com
              </a>
            </p>
          </CardContent>
        </Card>

        {/* Row 3: Container Resources | Environment Files */}
        {/* Container Resources */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Container Resources</CardTitle>
            <CardDescription>
              Resource limits for new containers
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <div className="flex justify-between">
                <Label className="text-sm">CPU Cores</Label>
                <span className="text-sm font-medium">{cpuCores}</span>
              </div>
              <Slider
                value={[cpuCores]}
                onValueChange={([v]) => v !== undefined && setCpuCores(v)}
                min={1}
                max={16}
                step={1}
              />
            </div>
            <div className="space-y-2">
              <div className="flex justify-between">
                <Label className="text-sm">Memory (GB)</Label>
                <span className="text-sm font-medium">{memoryGb} GB</span>
              </div>
              <Slider
                value={[memoryGb]}
                onValueChange={([v]) => v !== undefined && setMemoryGb(v)}
                min={1}
                max={64}
                step={1}
              />
            </div>
          </CardContent>
        </Card>

        {/* Environment Files */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Environment Files</CardTitle>
            <CardDescription>
              File patterns for .env files to copy (comma-separated)
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Input
              value={envPatterns}
              onChange={(e) => setEnvPatterns(e.target.value)}
              placeholder=".env, .env.local"
            />
            <p className="mt-2 text-xs text-muted-foreground">
              Files matching these patterns will be copied into containers
            </p>
          </CardContent>
        </Card>

        {/* Row 4: Terminal Appearance | Network Whitelist */}
        {/* Terminal Appearance */}
        <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Terminal className="h-4 w-4" />
            Terminal Appearance
          </CardTitle>
          <CardDescription>
            Customize the font and colors for the terminal and code viewer
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Font Family */}
          <div className="space-y-2">
            <Label>Font Family</Label>
            <Select
              value={terminalFontFamily}
              onValueChange={setTerminalFontFamily}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select font" />
              </SelectTrigger>
              <SelectContent>
                {FONT_OPTIONS.map((font) => (
                  <SelectItem key={font.value} value={font.value}>
                    <span style={{ fontFamily: font.value }}>{font.label}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              FiraCode Nerd Font is bundled with the app. Other fonts must be installed on your system.
            </p>
          </div>

          {/* Font Size */}
          <div className="space-y-3">
            <div className="flex justify-between">
              <Label>Font Size</Label>
              <span className="text-sm font-medium">{terminalFontSize}px</span>
            </div>
            <Slider
              value={[terminalFontSize]}
              onValueChange={([v]) => v !== undefined && setTerminalFontSize(v)}
              min={10}
              max={24}
              step={1}
            />
          </div>

          {/* Scrollback Buffer */}
          <div className="space-y-3">
            <div className="flex justify-between">
              <Label>Scrollback Buffer</Label>
              <span className="text-sm font-medium">
                {terminalScrollback.toLocaleString()} lines
              </span>
            </div>
            <Slider
              value={[terminalScrollback]}
              onValueChange={([v]) => v !== undefined && setTerminalScrollback(v)}
              min={100}
              max={20000}
              step={100}
            />
            <p className="text-xs text-muted-foreground">
              More lines keep more history but use more memory.
            </p>
          </div>

          {/* Background Color */}
          <div className="space-y-2">
            <Label>Background Color</Label>
            <div className="flex gap-3 items-center">
              <Input
                type="color"
                value={isValidHexColor(terminalBackgroundColor) ? terminalBackgroundColor : "#1e1e1e"}
                onChange={(e) => handleBackgroundColorChange(e.target.value)}
                className="w-16 h-10 p-1 cursor-pointer"
              />
              <Input
                type="text"
                value={terminalBackgroundColor}
                onChange={(e) => handleBackgroundColorChange(e.target.value)}
                placeholder="#1e1e1e"
                className={`font-mono w-32 ${colorError ? "border-red-500" : ""}`}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  handleBackgroundColorChange("#1e1e1e");
                }}
              >
                Reset
              </Button>
            </div>
            {colorError && (
              <div className="text-sm text-red-500 flex items-center gap-1">
                <XCircle className="h-3 w-3" />
                {colorError}
              </div>
            )}
          </div>

          {/* Preview */}
          <div className="space-y-2">
            <Label>Preview</Label>
            {(() => {
              const previewColors = getPreviewColors(terminalBackgroundColor);
              return (
                <div
                  className="rounded-md p-4 border"
                  style={{
                    backgroundColor: isValidHexColor(terminalBackgroundColor) ? terminalBackgroundColor : "#1e1e1e",
                    fontFamily: `"${terminalFontFamily}", "Fira Code", monospace`,
                    fontSize: `${terminalFontSize}px`,
                    color: previewColors.foreground,
                    lineHeight: 1.4,
                  }}
                >
                  <div><span style={{ color: previewColors.prompt }}>$</span> echo "Hello"</div>
                  <div>Hello</div>
                </div>
              );
            })()}
          </div>
        </CardContent>
        </Card>

        {/* Network Whitelist */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Shield className="h-4 w-4" />
              Network Whitelist
            </CardTitle>
            <CardDescription>
              Domains allowed in "Restricted" mode (one per line)
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Textarea
              value={allowedDomains}
              onChange={handleDomainsChange}
              placeholder={"github.com\nregistry.npmjs.org\napi.anthropic.com"}
              rows={6}
              className={`font-mono text-sm ${domainErrors.length > 0 ? "border-red-500" : ""}`}
            />

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
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleTestDomains}
                disabled={isTesting || domainErrors.length > 0}
              >
                {isTesting ? (
                  <>
                    <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                    Testing...
                  </>
                ) : (
                  "Test DNS"
                )}
              </Button>
            </div>

            {/* Test results */}
            {testResults && (
              <div className="border rounded-md p-2 space-y-1 text-xs">
                {testResults.map((result, i) => (
                  <div key={i} className="flex items-center gap-1">
                    {result.resolvable ? (
                      <CheckCircle2 className="h-3 w-3 text-green-500" />
                    ) : result.valid ? (
                      <AlertCircle className="h-3 w-3 text-yellow-500" />
                    ) : (
                      <XCircle className="h-3 w-3 text-red-500" />
                    )}
                    <span className="font-mono">{result.domain}</span>
                    {result.error && (
                      <span className="text-red-500 ml-1">{result.error}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Actions */}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={handleReset} disabled={!hasChanges}>
          Reset
        </Button>
        <Button onClick={handleSave} disabled={!hasChanges || isSaving || saveSuccess || domainErrors.length > 0 || !!colorError}>
          {saveSuccess ? (
            <>
              <Check className="mr-2 h-4 w-4" />
              Saved!
            </>
          ) : isSaving ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Saving...
            </>
          ) : (
            "Save Changes"
          )}
        </Button>
      </div>
    </div>
  );
}
