import { useErrorDialogStore } from "@/stores";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Copy } from "lucide-react";
import { toast } from "sonner";

export function ErrorDetailsDialog() {
  const { error, closeError } = useErrorDialogStore();

  const handleCopyError = async () => {
    if (!error) return;

    const errorText = `${error.title}\n\n${error.message}\n\nTimestamp: ${error.timestamp.toISOString()}`;
    try {
      await navigator.clipboard.writeText(errorText);
      toast.success("Error details copied to clipboard");
    } catch {
      toast.error("Failed to copy to clipboard");
    }
  };

  return (
    <AlertDialog open={error !== null} onOpenChange={(open) => !open && closeError()}>
      <AlertDialogContent className="max-w-lg max-h-[85vh] flex flex-col">
        <AlertDialogHeader className="flex-shrink-0">
          <AlertDialogTitle className="text-destructive">
            {error?.title ?? "Error"}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3">
              <pre className="whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-sm font-mono text-foreground max-h-[50vh] overflow-y-auto">
                {error?.message}
              </pre>
              <p className="text-xs text-muted-foreground">
                {error?.timestamp.toLocaleString()}
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="outline" onClick={handleCopyError}>
            <Copy className="mr-2 h-4 w-4" />
            Copy
          </Button>
          <AlertDialogAction onClick={closeError}>Close</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
