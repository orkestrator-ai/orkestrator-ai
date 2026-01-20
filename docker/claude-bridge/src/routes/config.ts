// Configuration routes
import { Hono } from "hono";
import { getAvailableModels } from "../services/session-manager.js";
import type { ModelsResponse } from "../types/index.js";

const config = new Hono();

config.get("/models", async (c) => {
  const models = await getAvailableModels();
  const response: ModelsResponse = { models };
  return c.json(response);
});

export default config;
