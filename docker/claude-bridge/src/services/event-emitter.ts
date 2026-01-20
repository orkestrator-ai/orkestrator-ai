// SSE Event broadcasting service
// Manages connections and broadcasts events to all subscribers

import type { SSEEvent } from "../types/index.js";

type EventCallback = (event: SSEEvent) => void;

class EventEmitter {
  private subscribers: Set<EventCallback> = new Set();

  /**
   * Subscribe to SSE events
   */
  subscribe(callback: EventCallback): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  /**
   * Broadcast an event to all subscribers
   */
  emit(event: SSEEvent): void {
    for (const callback of this.subscribers) {
      try {
        callback(event);
      } catch (error) {
        console.error("[event-emitter] Error in subscriber callback:", error);
      }
    }
  }

  /**
   * Get the number of active subscribers
   */
  get subscriberCount(): number {
    return this.subscribers.size;
  }
}

// Singleton instance
export const eventEmitter = new EventEmitter();
