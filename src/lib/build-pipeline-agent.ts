import type { AppConfig, DefaultAgent } from "@/types";

export function resolveBuildPipelineAgent(
  config: AppConfig,
  projectId: string,
): DefaultAgent {
  return config.repositories[projectId]?.defaultAgent
    ?? config.global.defaultAgent
    ?? "claude";
}
