import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Trash2, Send, CheckCircle2 } from "lucide-react";
import type { KanbanTask, KanbanStatus } from "@/stores/kanbanStore";
import { useKanbanStore } from "@/stores/kanbanStore";

const STATUS_LABELS: Record<KanbanStatus, string> = {
  backlog: "Backlog",
  "in-progress": "In Progress",
  review: "Review",
  done: "Done",
};

interface KanbanTaskDialogProps {
  task: KanbanTask | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function KanbanTaskDialog({ task, open, onOpenChange }: KanbanTaskDialogProps) {
  const updateTask = useKanbanStore((s) => s.updateTask);
  const deleteTask = useKanbanStore((s) => s.deleteTask);
  const addComment = useKanbanStore((s) => s.addComment);
  const deleteComment = useKanbanStore((s) => s.deleteComment);

  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [commentText, setCommentText] = useState("");
  const [isEditingAC, setIsEditingAC] = useState(false);
  const [editAC, setEditAC] = useState("");

  if (!task) return null;

  const handleStartEdit = () => {
    setEditTitle(task.title);
    setEditDescription(task.description);
    setIsEditing(true);
  };

  const handleSaveEdit = () => {
    if (editTitle.trim()) {
      void updateTask(task.id, { title: editTitle.trim(), description: editDescription.trim() });
    }
    setIsEditing(false);
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
  };

  const handleStartEditAC = () => {
    setEditAC(task.acceptanceCriteria);
    setIsEditingAC(true);
  };

  const handleSaveAC = () => {
    void updateTask(task.id, { acceptanceCriteria: editAC.trim() });
    setIsEditingAC(false);
  };

  const handleCancelAC = () => {
    setIsEditingAC(false);
  };

  const handleDelete = () => {
    void deleteTask(task.id);
    onOpenChange(false);
  };

  const handleAddComment = () => {
    if (commentText.trim()) {
      void addComment(task.id, commentText.trim());
      setCommentText("");
    }
  };

  const handleCommentKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleAddComment();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px] max-h-[85vh] flex flex-col">
        <DialogHeader>
          <div className="flex items-center justify-between pr-6">
            <div className="flex items-center gap-2">
              <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground font-medium">
                {STATUS_LABELS[task.status]}
              </span>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-destructive"
              onClick={handleDelete}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
          {isEditing ? (
            <div className="space-y-2 pt-1">
              <Input
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                className="text-lg font-semibold"
                autoFocus
              />
              <Textarea
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                placeholder="Description..."
                rows={3}
              />
              <div className="flex gap-2">
                <Button size="sm" onClick={handleSaveEdit}>Save</Button>
                <Button size="sm" variant="ghost" onClick={handleCancelEdit}>Cancel</Button>
              </div>
            </div>
          ) : (
            <div className="cursor-pointer" onClick={handleStartEdit}>
              <DialogTitle className="text-lg">{task.title}</DialogTitle>
              {task.description ? (
                <p className="mt-1 text-sm text-muted-foreground whitespace-pre-wrap">
                  {task.description}
                </p>
              ) : (
                <p className="mt-1 text-sm text-muted-foreground/50 italic">
                  Click to add a description...
                </p>
              )}
            </div>
          )}
        </DialogHeader>

        <Separator />

        {/* Acceptance Criteria */}
        <div>
          <div className="flex items-center gap-1.5 mb-2">
            <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
            <h4 className="text-sm font-medium">Acceptance Criteria</h4>
          </div>
          {isEditingAC ? (
            <div className="space-y-2">
              <Textarea
                value={editAC}
                onChange={(e) => setEditAC(e.target.value)}
                placeholder="Define what 'done' looks like..."
                rows={4}
                autoFocus
              />
              <div className="flex gap-2">
                <Button size="sm" onClick={handleSaveAC}>Save</Button>
                <Button size="sm" variant="ghost" onClick={handleCancelAC}>Cancel</Button>
              </div>
            </div>
          ) : (
            <div
              className="cursor-pointer rounded-md border border-border/50 p-2.5 hover:border-border transition-colors min-h-[40px]"
              onClick={handleStartEditAC}
            >
              {task.acceptanceCriteria ? (
                <p className="text-sm text-foreground whitespace-pre-wrap">
                  {task.acceptanceCriteria}
                </p>
              ) : (
                <p className="text-sm text-muted-foreground/50 italic">
                  Click to add acceptance criteria...
                </p>
              )}
            </div>
          )}
        </div>

        <Separator />

        {/* Comments */}
        <div className="flex-1 min-h-0">
          <h4 className="text-sm font-medium mb-2">Comments ({task.comments.length})</h4>
          <ScrollArea className="max-h-[200px]">
            <div className="space-y-3 pr-3">
              {task.comments.length === 0 && (
                <p className="text-xs text-muted-foreground italic">No comments yet</p>
              )}
              {task.comments.map((comment) => (
                <div
                  key={comment.id}
                  className="group/comment rounded-md bg-muted/50 p-2.5 text-sm"
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="whitespace-pre-wrap text-foreground flex-1">{comment.text}</p>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5 shrink-0 opacity-0 group-hover/comment:opacity-100 text-muted-foreground hover:text-destructive transition-opacity"
                      onClick={() => void deleteComment(task.id, comment.id)}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                  <span className="text-[10px] text-muted-foreground mt-1 block">
                    {new Date(comment.createdAt).toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          </ScrollArea>
        </div>

        {/* Add Comment */}
        <div className="flex items-center gap-2 pt-2">
          <Input
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            onKeyDown={handleCommentKeyDown}
            placeholder="Add a comment..."
            className="flex-1"
          />
          <Button
            size="icon"
            variant="ghost"
            onClick={handleAddComment}
            disabled={!commentText.trim()}
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
