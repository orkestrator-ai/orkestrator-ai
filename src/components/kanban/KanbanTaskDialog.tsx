import { useState, useCallback, useRef, useEffect } from "react";
import {
  Dialog,
  DialogContent,
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
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Trash2, Send, CheckCircle2, Container, FolderGit2, ExternalLink, Loader2, Paperclip, ImageIcon, X } from "lucide-react";
import { toast } from "sonner";
import type { KanbanTask, KanbanStatus } from "@/stores/kanbanStore";
import { useKanbanStore } from "@/stores/kanbanStore";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { useBuildPipeline } from "@/hooks/useBuildPipeline";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { readFileBase64 } from "@/lib/tauri";

const STATUS_LABELS: Record<KanbanStatus, string> = {
  backlog: "Backlog",
  "in-progress": "In Progress",
  review: "Review",
  done: "Done",
};

/** Max image file size in bytes (5 MB) */
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;

/** Convert a File to base64 data string (without data URL prefix) */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Strip the data URL prefix (data:image/png;base64,...)
      const base64 = result.split(",")[1];
      if (base64) resolve(base64);
      else reject(new Error("Failed to convert file to base64"));
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/** Pending image for create mode (before task exists) */
interface PendingImage {
  id: string;
  filename: string;
  data: string; // base64
  previewUrl: string; // data URL for display
}

interface KanbanTaskDialogProps {
  task: KanbanTask | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When set, dialog opens in create mode for this project */
  createForProjectId?: string;
}

export function KanbanTaskDialog({ task, open, onOpenChange, createForProjectId }: KanbanTaskDialogProps) {
  const updateTask = useKanbanStore((s) => s.updateTask);
  const deleteTask = useKanbanStore((s) => s.deleteTask);
  const addTaskStore = useKanbanStore((s) => s.addTask);
  const addComment = useKanbanStore((s) => s.addComment);
  const deleteComment = useKanbanStore((s) => s.deleteComment);
  const addImage = useKanbanStore((s) => s.addImage);
  const deleteImage = useKanbanStore((s) => s.deleteImage);

  const { startBuild, navigateToBuild } = useBuildPipeline();
  const getPipelineByTaskId = useBuildPipelineStore((s) => s.getPipelineByTaskId);
  const [isBuildStarting, setIsBuildStarting] = useState(false);
  const [confirmBuildType, setConfirmBuildType] = useState<"containerized" | "local" | null>(null);

  const isCreateMode = !!createForProjectId;

  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editAC, setEditAC] = useState("");
  const [commentText, setCommentText] = useState("");
  const [isEditingAC, setIsEditingAC] = useState(false);

  // Image state
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [previewImage, setPreviewImage] = useState<{ url: string; filename: string } | null>(null);
  const dialogContentRef = useRef<HTMLDivElement>(null);

  // Reset create mode fields when dialog opens in create mode
  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      setEditTitle("");
      setEditDescription("");
      setEditAC("");
      setIsEditing(false);
      setIsEditingAC(false);
      setPendingImages([]);
      setPreviewImage(null);
    }
    onOpenChange(newOpen);
  };

  // Process an image file (File object) into base64
  const processImageFile = useCallback(async (file: File): Promise<{ filename: string; data: string; previewUrl: string } | null> => {
    if (!file.type.startsWith("image/")) {
      toast.error("Only image files are supported");
      return null;
    }
    if (file.size > MAX_IMAGE_SIZE) {
      toast.error("Image is too large (max 5 MB)");
      return null;
    }
    try {
      const data = await fileToBase64(file);
      const previewUrl = `data:${file.type};base64,${data}`;
      return { filename: file.name, data, previewUrl };
    } catch {
      toast.error("Failed to read image file");
      return null;
    }
  }, []);

  // Handle paste events for image attachment
  const handlePaste = useCallback(async (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (const item of items) {
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;

        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const ext = file.type.split("/")[1] || "png";
        const renamedFile = new File([file], `clipboard-${timestamp}.${ext}`, { type: file.type });

        const result = await processImageFile(renamedFile);
        if (!result) continue;

        if (isCreateMode || !task) {
          setPendingImages((prev) => [...prev, { id: crypto.randomUUID(), ...result }]);
        } else {
          void addImage(task.id, result.filename, result.data);
        }
        toast.success("Image pasted");
        break;
      }
    }
  }, [isCreateMode, task, addImage, processImageFile]);

  // Register paste listener on the dialog content
  useEffect(() => {
    if (!open) return;
    const el = dialogContentRef.current;
    if (!el) return;

    const listener = (e: Event) => { void handlePaste(e as ClipboardEvent); };
    el.addEventListener("paste", listener);
    return () => el.removeEventListener("paste", listener);
  }, [open, handlePaste]);

  // Handle file picker for attaching images
  const handleAttachImage = useCallback(async () => {
    try {
      const selected = await openDialog({
        multiple: true,
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"] }],
      });
      if (!selected) return;

      // openDialog with multiple:true returns string[] | null
      const paths: string[] = Array.isArray(selected) ? selected : [selected];
      for (const path of paths) {
        const filename = path.split("/").pop() || path.split("\\").pop() || "image.png";
        try {
          const data = await readFileBase64(path);
          // Validate size (base64 encodes 3 bytes as 4 chars)
          if (data.length * 0.75 > MAX_IMAGE_SIZE) {
            toast.error(`${filename} is too large (max 5 MB)`);
            continue;
          }
          // Determine mime type from extension
          const ext = filename.split(".").pop()?.toLowerCase() || "png";
          const mimeMap: Record<string, string> = {
            png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
            gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml",
          };
          const mime = mimeMap[ext] || "image/png";
          const previewUrl = `data:${mime};base64,${data}`;

          if (isCreateMode || !task) {
            setPendingImages((prev) => [...prev, { id: crypto.randomUUID(), filename, data, previewUrl }]);
          } else {
            void addImage(task.id, filename, data);
          }
        } catch {
          toast.error(`Failed to read ${filename}`);
        }
      }
    } catch {
      // Dialog cancelled
    }
  }, [isCreateMode, task, addImage]);

  if (!task && !isCreateMode) return null;

  const handleStartEdit = () => {
    if (task) {
      setEditTitle(task.title);
      setEditDescription(task.description);
    }
    setIsEditing(true);
  };

  const handleSaveEdit = () => {
    if (editTitle.trim() && task) {
      void updateTask(task.id, { title: editTitle.trim(), description: editDescription.trim() });
    }
    setIsEditing(false);
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
  };

  const handleCreate = () => {
    if (editTitle.trim() && createForProjectId) {
      const title = editTitle.trim();
      const description = editDescription.trim();
      const ac = editAC.trim();
      const imagesToSave = [...pendingImages];
      handleOpenChange(false);
      void addTaskStore(createForProjectId, title, description).then(async (newTaskId) => {
        if (!newTaskId) return;
        if (ac) {
          void updateTask(newTaskId, { acceptanceCriteria: ac });
        }
        // Save pending images to the newly created task
        const results = await Promise.allSettled(imagesToSave.map((img) => addImage(newTaskId, img.filename, img.data)));
        const failed = results.filter((r) => r.status === "rejected").length;
        if (failed > 0) {
          toast.error(`Failed to save ${failed} image${failed > 1 ? "s" : ""}`);
        }
      });
    }
  };

  const handleCreateKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleCreate();
    }
  };

  const handleStartEditAC = () => {
    if (task) {
      setEditAC(task.acceptanceCriteria);
    }
    setIsEditingAC(true);
  };

  const handleSaveAC = () => {
    if (task) {
      void updateTask(task.id, { acceptanceCriteria: editAC.trim() });
    }
    setIsEditingAC(false);
  };

  const handleCancelAC = () => {
    setIsEditingAC(false);
  };

  const handleDelete = () => {
    if (task) {
      void deleteTask(task.id);
    }
    handleOpenChange(false);
  };

  const handleAddComment = () => {
    if (commentText.trim() && task) {
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

  const handleStartBuild = async (type: "containerized" | "local") => {
    if (!task) return;
    setIsBuildStarting(true);
    try {
      await startBuild(task, type);
      handleOpenChange(false);
    } finally {
      setIsBuildStarting(false);
    }
  };

  const handleCreateAndBuild = async (type: "containerized" | "local") => {
    if (!editTitle.trim() || !createForProjectId) return;

    const title = editTitle.trim();
    const description = editDescription.trim();
    const ac = editAC.trim();
    const imagesToSave = [...pendingImages];

    setIsBuildStarting(true);
    try {
      const newTaskId = await addTaskStore(createForProjectId, title, description);
      if (!newTaskId) {
        toast.error("Failed to create task");
        return;
      }

      if (ac) {
        try {
          await updateTask(newTaskId, { acceptanceCriteria: ac });
        } catch {
          toast.error("Task created but acceptance criteria could not be saved");
        }
      }

      // Save pending images in parallel
      await Promise.allSettled(imagesToSave.map((img) => addImage(newTaskId, img.filename, img.data)));

      const newTask = useKanbanStore.getState().tasks.find((t) => t.id === newTaskId);
      if (!newTask) {
        toast.error("Task created but could not start build");
        handleOpenChange(false);
        return;
      }

      await startBuild(newTask, type);
      handleOpenChange(false);
    } finally {
      setIsBuildStarting(false);
    }
  };

  // Images to display (from task or pending)
  const displayImages = task ? task.images : [];
  const allImages = isCreateMode ? pendingImages : displayImages;

  // Image thumbnails component — show in create mode always, in edit mode only when images exist
  const renderImageSection = () => {
    if (!isCreateMode && allImages.length === 0) return null;

    return (
      <>
        <Separator />
        <div>
          <div className="flex items-center gap-1.5 mb-2">
            <ImageIcon className="h-4 w-4 text-muted-foreground" />
            <h4 className="text-sm font-medium">Images ({allImages.length})</h4>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 ml-auto"
              onClick={() => void handleAttachImage()}
              title="Attach image"
            >
              <Paperclip className="h-3.5 w-3.5" />
            </Button>
          </div>
          {allImages.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">No images attached. Paste or click the attach button.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {allImages.map((img) => {
                const previewUrl = "previewUrl" in img
                  ? (img as PendingImage).previewUrl
                  : `data:image/png;base64,${img.data}`;
                return (
                  <div
                    key={img.id}
                    className="group/img relative rounded-md border border-border overflow-hidden cursor-pointer hover:border-primary/50 transition-colors"
                    style={{ width: 80, height: 80 }}
                    onClick={() => setPreviewImage({ url: previewUrl, filename: img.filename })}
                  >
                    <img
                      src={previewUrl}
                      alt={img.filename}
                      className="w-full h-full object-cover"
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="absolute top-0 right-0 h-5 w-5 bg-background/80 opacity-0 group-hover/img:opacity-100 transition-opacity rounded-none rounded-bl-md"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (isCreateMode) {
                          setPendingImages((prev) => prev.filter((i) => i.id !== img.id));
                        } else if (task) {
                          void deleteImage(task.id, img.id);
                        }
                      }}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                    <div className="absolute bottom-0 left-0 right-0 bg-background/80 px-1 py-0.5 text-[9px] text-muted-foreground truncate opacity-0 group-hover/img:opacity-100 transition-opacity">
                      {img.filename}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </>
    );
  };

  // Fullscreen image preview dialog
  const renderPreviewDialog = () => {
    if (!previewImage) return null;
    return (
      <Dialog open={!!previewImage} onOpenChange={(open) => { if (!open) setPreviewImage(null); }}>
        <DialogContent className="max-w-[90vw] max-h-[90vh] p-2 flex flex-col items-center justify-center">
          <DialogTitle className="sr-only">{previewImage.filename}</DialogTitle>
          <div className="text-xs text-muted-foreground mb-1">{previewImage.filename}</div>
          <img
            src={previewImage.url}
            alt={previewImage.filename}
            className="max-w-full max-h-[80vh] object-contain rounded"
          />
        </DialogContent>
      </Dialog>
    );
  };

  if (isCreateMode) {
    return (
      <>
        <Dialog open={open} onOpenChange={handleOpenChange}>
          <DialogContent
            ref={dialogContentRef}
            className="sm:max-w-[560px] max-h-[85vh] flex flex-col"
            onInteractOutside={(e) => e.preventDefault()}
          >
            <DialogHeader>
              <div className="flex items-center gap-2">
                <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground font-medium">
                  Backlog
                </span>
              </div>
              <div className="space-y-2 pt-1">
                <DialogTitle className="sr-only">New Task</DialogTitle>
                <Input
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  onKeyDown={handleCreateKeyDown}
                  placeholder="Task title..."
                  className="text-lg font-semibold"
                  autoFocus
                />
                <Textarea
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  placeholder="Description..."
                  rows={3}
                />
              </div>
            </DialogHeader>

            <Separator />

            {/* Acceptance Criteria */}
            <div>
              <div className="flex items-center gap-1.5 mb-2">
                <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
                <h4 className="text-sm font-medium">Acceptance Criteria</h4>
              </div>
              <Textarea
                value={editAC}
                onChange={(e) => setEditAC(e.target.value)}
                placeholder="Define what 'done' looks like..."
                rows={4}
              />
            </div>

            {/* Images */}
            {renderImageSection()}

            {/* Create Actions */}
            <div className="flex gap-2 pt-2">
              <Button size="sm" onClick={handleCreate} disabled={!editTitle.trim() || isBuildStarting}>
                Create Task
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                disabled={!editTitle.trim() || isBuildStarting}
                onClick={() => void handleCreateAndBuild("containerized")}
              >
                {isBuildStarting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Container className="h-3.5 w-3.5" />
                )}
                Build Container
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                disabled={!editTitle.trim() || isBuildStarting}
                onClick={() => void handleCreateAndBuild("local")}
              >
                {isBuildStarting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <FolderGit2 className="h-3.5 w-3.5" />
                )}
                Build Local
              </Button>
              <Button size="sm" variant="ghost" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
            </div>
          </DialogContent>
        </Dialog>
        {renderPreviewDialog()}
      </>
    );
  }

  if (!task) return null;

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent
          ref={dialogContentRef}
          className="sm:max-w-[560px] max-h-[85vh] flex flex-col"
          onInteractOutside={(e) => e.preventDefault()}
        >
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

          {/* Images */}
          {renderImageSection()}

          <Separator />

          {/* Build Actions */}
          {(() => {
            const existingPipeline = getPipelineByTaskId(task.id);
            const hasActiveBuild = existingPipeline && !["complete", "failed"].includes(existingPipeline.phase);

            return (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5 flex-1"
                    disabled={isBuildStarting || !!hasActiveBuild}
                    onClick={() => {
                      if (task.environmentId) {
                        setConfirmBuildType("containerized");
                      } else {
                        void handleStartBuild("containerized");
                      }
                    }}
                  >
                    {isBuildStarting ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Container className="h-3.5 w-3.5" />
                    )}
                    Build Container
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5 flex-1"
                    disabled={isBuildStarting || !!hasActiveBuild}
                    onClick={() => {
                      if (task.environmentId) {
                        setConfirmBuildType("local");
                      } else {
                        void handleStartBuild("local");
                      }
                    }}
                  >
                    {isBuildStarting ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <FolderGit2 className="h-3.5 w-3.5" />
                    )}
                    Build Local
                  </Button>
                  {task.environmentId && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5"
                      onClick={() => {
                        navigateToBuild(task);
                        handleOpenChange(false);
                      }}
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      View Build
                      {existingPipeline && (
                        <span className="text-xs text-muted-foreground ml-1">
                          ({existingPipeline.phase})
                        </span>
                      )}
                    </Button>
                  )}
                </div>
              </div>
            );
          })()}

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

        <AlertDialog open={!!confirmBuildType} onOpenChange={(open) => { if (!open) setConfirmBuildType(null); }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Environment Already Exists</AlertDialogTitle>
              <AlertDialogDescription>
                This task already has an environment linked to it. Starting a new build will create an additional environment.
                <span className="block mt-2">
                  Are you sure you want to start a new{" "}
                  <strong>{confirmBuildType === "containerized" ? "container" : "local"}</strong> build?
                </span>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  if (confirmBuildType) {
                    void handleStartBuild(confirmBuildType);
                  }
                  setConfirmBuildType(null);
                }}
              >
                Start Build
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </Dialog>
      {renderPreviewDialog()}
    </>
  );
}
