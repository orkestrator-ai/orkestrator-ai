import { type ReactNode, type RefObject } from "react";
import { Virtuoso, type VirtuosoHandle, type StateSnapshot } from "react-virtuoso";

interface VirtualizedMessageListProps<TMessage> {
  messages: TMessage[];
  computeItemKey: (index: number, message: TMessage) => string;
  renderMessage: (index: number, message: TMessage, previousMessage: TMessage | null) => ReactNode;
  footer?: ReactNode;
  emptyState?: ReactNode;
  scrollProps: {
    followOutput: (isAtBottom: boolean) => "smooth" | false;
    atBottomStateChange: (atBottom: boolean) => void;
    atBottomThreshold: number;
    restoreStateFrom: StateSnapshot | undefined;
  };
  virtuosoRef: RefObject<VirtuosoHandle | null>;
}

function FooterWrapper({ children }: { children: ReactNode }) {
  return <div className="min-w-[320px]">{children}</div>;
}

function EmptyPlaceholderWrapper({ children }: { children: ReactNode }) {
  return <div className="min-w-[320px]">{children}</div>;
}

export function VirtualizedMessageList<TMessage>({
  messages,
  computeItemKey,
  renderMessage,
  footer,
  emptyState,
  scrollProps,
  virtuosoRef,
}: VirtualizedMessageListProps<TMessage>) {
  return (
    <div className="flex-1 min-h-0">
      <Virtuoso
        ref={virtuosoRef}
        data={messages}
        computeItemKey={computeItemKey}
        itemContent={(index, data) =>
          renderMessage(index, data, index > 0 ? messages[index - 1] ?? null : null)
        }
        components={{
          Footer: footer
            ? () => <FooterWrapper>{footer}</FooterWrapper>
            : undefined,
          EmptyPlaceholder: emptyState
            ? () => <EmptyPlaceholderWrapper>{emptyState}</EmptyPlaceholderWrapper>
            : undefined,
        }}
        followOutput={scrollProps.followOutput}
        atBottomStateChange={scrollProps.atBottomStateChange}
        atBottomThreshold={scrollProps.atBottomThreshold}
        restoreStateFrom={scrollProps.restoreStateFrom}
        increaseViewportBy={{ top: 400, bottom: 200 }}
        style={{ height: "100%" }}
        className="py-4"
      />
    </div>
  );
}
