import { type ReactNode, type RefObject, useMemo } from "react";
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

export function VirtualizedMessageList<TMessage>({
  messages,
  computeItemKey,
  renderMessage,
  footer,
  emptyState,
  scrollProps,
  virtuosoRef,
}: VirtualizedMessageListProps<TMessage>) {
  const components = useMemo(
    () => ({
      Footer: footer
        ? () => <div className="min-w-[320px]">{footer}</div>
        : undefined,
      EmptyPlaceholder: emptyState
        ? () => <div className="min-w-[320px]">{emptyState}</div>
        : undefined,
    }),
    [footer, emptyState]
  );

  return (
    <div className="flex-1 min-h-0">
      <Virtuoso
        ref={virtuosoRef}
        data={messages}
        computeItemKey={computeItemKey}
        itemContent={(index, data) =>
          renderMessage(index, data, index > 0 ? messages[index - 1] ?? null : null)
        }
        components={components}
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
