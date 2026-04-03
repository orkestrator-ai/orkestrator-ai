import { Loader2 } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { AgentActivityState } from "@/stores/agentActivityStore";

interface AgentActivityIndicatorProps {
  state: AgentActivityState;
  showLabel?: boolean;
  className?: string;
}

const stateConfig: Record<
  AgentActivityState,
  { color: string; textColor: string; label: string }
> = {
  working: {
    color: "bg-blue-500",
    textColor: "text-blue-500",
    label: "Working",
  },
  waiting: {
    color: "bg-amber-500",
    textColor: "text-amber-500",
    label: "Waiting for input",
  },
  idle: {
    color: "bg-zinc-500",
    textColor: "text-zinc-500",
    label: "Idle",
  },
};

export function AgentActivityIndicator({
  state,
  showLabel = false,
  className,
}: AgentActivityIndicatorProps) {
  const config = stateConfig[state];

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className={cn("flex items-center gap-1.5", className)}>
          {state === "working" ? (
            <Loader2 className={cn("h-3 w-3 animate-spin", config.textColor)} />
          ) : (
            <div
              className={cn(
                "h-2 w-2 rounded-full",
                config.color,
                state === "waiting" && "animate-pulse"
              )}
            />
          )}
          {showLabel && (
            <span className={cn("text-xs", config.textColor)}>
              {config.label}
            </span>
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <p>{config.label}</p>
      </TooltipContent>
    </Tooltip>
  );
}
