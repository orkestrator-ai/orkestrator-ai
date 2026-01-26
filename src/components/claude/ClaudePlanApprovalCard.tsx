import { useState, useCallback } from "react";
import { FileText, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { ClaudePlanApprovalRequest, ClaudeClient } from "@/lib/claude-client";
import { respondToPlanApproval } from "@/lib/claude-client";
import { useClaudeStore } from "@/stores/claudeStore";

interface ClaudePlanApprovalCardProps {
  approval: ClaudePlanApprovalRequest;
  client: ClaudeClient;
  sessionId: string;
}

export function ClaudePlanApprovalCard({
  approval,
  client,
  sessionId,
}: ClaudePlanApprovalCardProps) {
  const { removePendingPlanApproval } = useClaudeStore();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedback, setFeedback] = useState("");

  const handleApprove = useCallback(async () => {
    setIsSubmitting(true);
    try {
      const success = await respondToPlanApproval(client, sessionId, approval.id, true);
      if (success) {
        removePendingPlanApproval(approval.id);
        // Plan mode will be disabled via the plan.exit-requested event from the server
      }
    } catch (error) {
      console.error("[ClaudePlanApprovalCard] Failed to approve plan:", error);
    } finally {
      setIsSubmitting(false);
    }
  }, [client, sessionId, approval.id, removePendingPlanApproval]);

  const handleReject = useCallback(async () => {
    if (!showFeedback) {
      // Show feedback input first
      setShowFeedback(true);
      return;
    }

    setIsSubmitting(true);
    try {
      const success = await respondToPlanApproval(
        client,
        sessionId,
        approval.id,
        false,
        feedback.trim() || undefined
      );
      if (success) {
        removePendingPlanApproval(approval.id);
        // Keep plan mode enabled so Claude can revise the plan
        // The plan.exit-requested event will NOT be sent on rejection
      }
    } catch (error) {
      console.error("[ClaudePlanApprovalCard] Failed to reject plan:", error);
    } finally {
      setIsSubmitting(false);
    }
  }, [client, sessionId, approval.id, feedback, showFeedback, removePendingPlanApproval]);

  const handleDismiss = useCallback(() => {
    // Dismissing is treated as rejection without feedback
    setIsSubmitting(true);
    respondToPlanApproval(client, sessionId, approval.id, false)
      .then((success) => {
        if (success) {
          removePendingPlanApproval(approval.id);
        }
      })
      .catch((error) => {
        console.error("[ClaudePlanApprovalCard] Failed to dismiss plan:", error);
      })
      .finally(() => {
        setIsSubmitting(false);
      });
  }, [client, sessionId, approval.id, removePendingPlanApproval]);

  return (
    <div className="mx-4 my-3 rounded-lg border border-border bg-card shadow-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2.5 bg-amber-500/10 border-b border-border">
        <FileText className="w-4 h-4 text-amber-500" />
        <span className="text-sm font-medium text-foreground">Plan Ready for Review</span>
        <span className="text-xs text-muted-foreground ml-auto">
          Review the plan above and approve or request changes
        </span>
      </div>

      {/* Content */}
      <div className="p-4 space-y-3">
        <p className="text-sm text-foreground leading-relaxed">
          Claude has created a plan for your task. Please review the plan in the conversation
          above and decide whether to approve it or request revisions.
        </p>

        {showFeedback && (
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">
              What changes would you like? (optional)
            </label>
            <Textarea
              placeholder="Describe what you'd like Claude to change about the plan..."
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              className="min-h-[80px] text-sm bg-transparent border-muted-foreground/20 focus:border-primary resize-none"
              disabled={isSubmitting}
            />
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center justify-between px-4 py-3 bg-muted/30 border-t border-border">
        <Button
          variant="ghost"
          size="sm"
          onClick={handleDismiss}
          disabled={isSubmitting}
          className="text-muted-foreground hover:text-foreground"
        >
          Dismiss
        </Button>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleReject}
            disabled={isSubmitting}
            className={cn(
              "gap-1.5",
              showFeedback && "text-destructive hover:text-destructive"
            )}
          >
            <X className="w-3.5 h-3.5" />
            {showFeedback ? "Submit Feedback" : "Request Changes"}
          </Button>
          <Button
            size="sm"
            onClick={handleApprove}
            disabled={isSubmitting}
            className="gap-1.5 bg-green-600 hover:bg-green-700"
          >
            <Check className="w-3.5 h-3.5" />
            {isSubmitting ? "Approving..." : "Approve Plan"}
          </Button>
        </div>
      </div>
    </div>
  );
}
