import Markdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

const DEFAULT_MARKDOWN_CLASSNAME =
  "text-sm text-foreground leading-relaxed prose prose-sm dark:prose-invert max-w-none prose-p:my-2 prose-headings:my-3 prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5 prose-pre:my-2 prose-code:text-xs prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-pre:bg-muted prose-pre:p-3 prose-pre:rounded-md prose-table:text-xs prose-table:my-2";

interface MessageMarkdownProps {
  content: string;
  components?: Components;
  className?: string;
}

export function MessageMarkdown({
  content,
  components,
  className,
}: MessageMarkdownProps) {
  return (
    <div className={cn(DEFAULT_MARKDOWN_CLASSNAME, className)}>
      <Markdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={components}
      >
        {content}
      </Markdown>
    </div>
  );
}
