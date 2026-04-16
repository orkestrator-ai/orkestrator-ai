import { open, readFile, stat } from "node:fs/promises";
import {
  parseTranscriptRecords,
  type TranscriptRecord,
} from "./subagent-transcript.js";

interface CachedTranscript {
  size: number;
  modifiedAtMs: number;
  remainder: string;
  lines: string[];
  records: TranscriptRecord[];
}

const transcriptCache = new Map<string, CachedTranscript>();

function normalizeTranscriptLines(lines: string[]): string[] {
  return lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function splitTranscriptChunk(
  chunk: string,
  remainder: string,
): { lines: string[]; remainder: string } {
  if (!chunk && !remainder) {
    return { lines: [], remainder: "" };
  }

  const combined = `${remainder}${chunk}`;
  const rawLines = combined.split("\n");
  const trailingRemainder = combined.endsWith("\n") ? "" : (rawLines.pop() ?? "");

  return {
    lines: normalizeTranscriptLines(rawLines),
    remainder: trailingRemainder,
  };
}

async function readTranscriptChunk(
  path: string,
  start: number,
  length: number,
): Promise<string> {
  if (length <= 0) {
    return "";
  }

  const handle = await open(path, "r");
  try {
    let remaining = length;
    let position = start;
    const chunks: Buffer[] = [];

    while (remaining > 0) {
      const buffer = Buffer.alloc(Math.min(remaining, 64 * 1024));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead <= 0) {
        break;
      }
      chunks.push(buffer.subarray(0, bytesRead));
      remaining -= bytesRead;
      position += bytesRead;
    }

    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function loadTranscriptFromScratch(path: string): Promise<CachedTranscript> {
  const raw = await readFile(path, "utf8");
  const stats = await stat(path);
  const { lines, remainder } = splitTranscriptChunk(raw, "");
  return {
    size: Buffer.byteLength(raw, "utf8"),
    modifiedAtMs: stats.mtimeMs,
    remainder,
    lines,
    records: parseTranscriptRecords(lines),
  };
}

export async function readCachedTranscript(path: string): Promise<CachedTranscript> {
  try {
    const stats = await stat(path);
    const size = stats.size;
    const modifiedAtMs = stats.mtimeMs;
    const cached = transcriptCache.get(path);

    if (!cached || size < cached.size || modifiedAtMs !== cached.modifiedAtMs) {
      const loaded = await loadTranscriptFromScratch(path);
      transcriptCache.set(path, loaded);
      return loaded;
    }

    if (size === cached.size) {
      return cached;
    }

    const appendedChunk = await readTranscriptChunk(path, cached.size, size - cached.size);
    const { lines: appendedLines, remainder } = splitTranscriptChunk(
      appendedChunk,
      cached.remainder,
    );
    const next: CachedTranscript = {
      size,
      modifiedAtMs,
      remainder,
      lines: appendedLines.length > 0 ? [...cached.lines, ...appendedLines] : cached.lines,
      records:
        appendedLines.length > 0
          ? [...cached.records, ...parseTranscriptRecords(appendedLines)]
          : cached.records,
    };
    transcriptCache.set(path, next);
    return next;
  } catch {
    transcriptCache.delete(path);
    return {
      size: 0,
      modifiedAtMs: 0,
      remainder: "",
      lines: [],
      records: [],
    };
  }
}

export function clearTranscriptCache(): void {
  transcriptCache.clear();
}
