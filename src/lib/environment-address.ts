import type { Environment } from "@/types";

export function getEnvironmentPortAddress(environment: Environment | null | undefined): string | null {
  if (
    !environment ||
    environment.environmentType === "local" ||
    environment.entryPort == null ||
    environment.hostEntryPort == null
  ) {
    return null;
  }

  return `localhost:${environment.hostEntryPort}`;
}
