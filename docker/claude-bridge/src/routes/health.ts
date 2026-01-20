// Health check route
import { Hono } from "hono";
import type { HealthResponse } from "../types/index.js";

const health = new Hono();

health.get("/health", (c) => {
  const response: HealthResponse = {
    status: "ok",
    version: "1.0.0",
  };
  return c.json(response);
});

export default health;
