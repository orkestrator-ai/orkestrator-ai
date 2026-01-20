// Claude Bridge Server
// Wraps the Claude Agent SDK and exposes HTTP/SSE endpoints for Orkestrator AI

import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import health from "./routes/health.js";
import config from "./routes/config.js";
import session from "./routes/session.js";
import events from "./routes/events.js";

const app = new Hono();

// Middleware
app.use("*", cors());
app.use("*", logger());

// Mount routes
app.route("/global", health);
app.route("/config", config);
app.route("/session", session);
app.route("/event", events);

// Root endpoint
app.get("/", (c) => {
  return c.json({
    name: "Claude Bridge Server",
    version: "1.0.0",
    endpoints: {
      health: "/global/health",
      models: "/config/models",
      sessions: "/session/list",
      events: "/event/subscribe",
    },
  });
});

// Get port from environment or use default
const port = parseInt(process.env.PORT || "4097", 10);
const hostname = process.env.HOSTNAME || "0.0.0.0";

console.log(`Claude Bridge Server starting on ${hostname}:${port}`);

// Start the server using Node.js built-in serve
import { serve } from "@hono/node-server";

serve({
  fetch: app.fetch,
  port,
  hostname,
});

console.log(`Claude Bridge Server running at http://${hostname}:${port}`);
