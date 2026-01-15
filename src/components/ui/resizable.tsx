import * as React from "react"
import { Group, Panel, Separator } from "react-resizable-panels"

import { cn } from "@/lib/utils"

function ResizablePanelGroup({
  className,
  ...props
}: React.ComponentProps<typeof Group>) {
  return (
    <Group
      data-slot="resizable-panel-group"
      className={cn("h-full w-full", className)}
      {...props}
    />
  )
}

function ResizablePanel({
  ...props
}: React.ComponentProps<typeof Panel>) {
  return <Panel data-slot="resizable-panel" {...props} />
}

interface ResizableHandleProps extends React.ComponentProps<typeof Separator> {
  /** Explicitly set orientation when auto-detection doesn't work */
  orientation?: "horizontal" | "vertical"
}

function ResizableHandle({
  className,
  orientation,
  style,
  ...props
}: ResizableHandleProps) {
  const isVertical = orientation === "vertical"

  // Use inline styles to ensure dimensions are set correctly and avoid
  // specificity issues with the library's inline styles
  const handleStyle: React.CSSProperties = {
    ...style,
    // Ensure the handle has proper dimensions
    ...(isVertical
      ? { height: "4px", width: "100%" }
      : { width: "4px", height: "100%" }),
  }

  return (
    <Separator
      data-slot="resizable-handle"
      style={handleStyle}
      className={cn(
        // Base styles - always applied
        "bg-border focus-visible:ring-ring relative z-30 flex items-center justify-center hover:bg-primary/20 transition-colors",
        // Prevent flex from collapsing the handle
        "shrink-0",
        // Focus styles
        "focus-visible:ring-1 focus-visible:ring-offset-1 focus-visible:outline-hidden",
        // Orientation-specific cursor
        isVertical ? "cursor-row-resize" : "cursor-col-resize",
        className
      )}
      {...props}
    />
  )
}

export { ResizablePanelGroup, ResizablePanel, ResizableHandle }
