import {
  deriveSubagentPartsFromTranscriptRecords,
  type TranscriptRecord,
  type TranscriptSubagentPart,
} from "./subagent-transcript.js";

export interface PersistedSessionMetaLike {
  transcriptPath?: string | null;
}

export interface TranscriptLike {
  records: TranscriptRecord[];
}

interface DeriveTranscriptSubagentPartsOptions {
  threadId?: string | null;
  currentTurnStartedAt?: string;
  loadSessionMeta: (threadId: string) => Promise<PersistedSessionMetaLike | null>;
  loadTranscript: (path: string) => Promise<TranscriptLike>;
}

function parseAgentIdFromFunctionCallOutput(record: TranscriptRecord): string | null {
  if (
    record.type !== "response_item"
    || record.payload?.type !== "function_call_output"
    || typeof record.payload.output !== "string"
  ) {
    return null;
  }

  try {
    const parsedOutput = JSON.parse(record.payload.output) as { agent_id?: unknown };
    return typeof parsedOutput.agent_id === "string" && parsedOutput.agent_id.length > 0
      ? parsedOutput.agent_id
      : null;
  } catch {
    return null;
  }
}

export async function deriveTranscriptSubagentPartsForTurn({
  threadId,
  currentTurnStartedAt,
  loadSessionMeta,
  loadTranscript,
}: DeriveTranscriptSubagentPartsOptions): Promise<TranscriptSubagentPart[]> {
  if (!threadId || !currentTurnStartedAt) {
    return [];
  }

  const parentMeta = await loadSessionMeta(threadId);
  if (!parentMeta?.transcriptPath) {
    return [];
  }

  const turnStartedAt = new Date(currentTurnStartedAt).getTime();
  if (Number.isNaN(turnStartedAt)) {
    return [];
  }

  const parentTranscript = await loadTranscript(parentMeta.transcriptPath);
  const parentRecords = parentTranscript.records.filter((record) => {
    if (!record.timestamp) {
      return false;
    }

    const timestamp = new Date(record.timestamp).getTime();
    return !Number.isNaN(timestamp) && timestamp >= turnStartedAt;
  });

  if (parentRecords.length === 0) {
    return [];
  }

  const childRecordsByAgentId = new Map<string, TranscriptRecord[]>();

  for (const record of parentRecords) {
    const agentId = parseAgentIdFromFunctionCallOutput(record);
    if (!agentId || childRecordsByAgentId.has(agentId)) {
      continue;
    }

    const childMeta = await loadSessionMeta(agentId);
    if (!childMeta?.transcriptPath) {
      childRecordsByAgentId.set(agentId, []);
      continue;
    }

    childRecordsByAgentId.set(agentId, (await loadTranscript(childMeta.transcriptPath)).records);
  }

  return deriveSubagentPartsFromTranscriptRecords(parentRecords, childRecordsByAgentId);
}
