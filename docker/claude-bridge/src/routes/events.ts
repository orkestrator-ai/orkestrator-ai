// SSE Events route
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { eventEmitter } from "../services/event-emitter.js";

const events = new Hono();

events.get("/subscribe", (c) => {
  return streamSSE(c, async (stream) => {
    // Send initial connection event
    await stream.writeSSE({
      event: "connected",
      data: JSON.stringify({ status: "connected", timestamp: new Date().toISOString() }),
    });

    // Keep track of whether the connection is still open
    let isOpen = true;

    // Subscribe to events
    const unsubscribe = eventEmitter.subscribe(async (event) => {
      if (!isOpen) return;

      try {
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify({
            sessionId: event.sessionId,
            ...event.data as object,
          }),
        });
      } catch (error) {
        console.error("[events] Error writing SSE:", error);
        isOpen = false;
      }
    });

    // Send keepalive every 30 seconds to prevent connection timeout
    const keepaliveInterval = setInterval(async () => {
      if (!isOpen) {
        clearInterval(keepaliveInterval);
        return;
      }

      try {
        await stream.writeSSE({
          event: "keepalive",
          data: JSON.stringify({ timestamp: new Date().toISOString() }),
        });
      } catch {
        isOpen = false;
        clearInterval(keepaliveInterval);
      }
    }, 30000);

    // Wait for connection to close
    // This uses an AbortController from the request context
    try {
      await new Promise((resolve) => {
        // The stream will close when the client disconnects
        // We use onAbort to detect this
        c.req.raw.signal.addEventListener("abort", () => {
          resolve(undefined);
        });
      });
    } catch {
      // Connection closed
    } finally {
      isOpen = false;
      clearInterval(keepaliveInterval);
      unsubscribe();
    }
  });
});

export default events;
