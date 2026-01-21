// Claude Bridge Server
// Wraps the Claude Agent SDK and exposes HTTP/SSE endpoints for Orkestrator AI

import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import health from "./routes/health.js";
import config from "./routes/config.js";
import session from "./routes/session.js";
import events from "./routes/events.js";
import mcp from "./routes/mcp.js";

const app = new Hono();

// Middleware
app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  })
);
app.use("*", logger());
app.use("*", async (c, next) => {
  await next();
  c.header("Access-Control-Allow-Private-Network", "true");
});
app.options("*", (c) => c.body(null, 204));

// Mount routes
app.route("/global", health);
app.route("/config", config);
app.route("/session", session);
app.route("/event", events);
app.route("/mcp", mcp);

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
      mcp: "/mcp/servers",
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
