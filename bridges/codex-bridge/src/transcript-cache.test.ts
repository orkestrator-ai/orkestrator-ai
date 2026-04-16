import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearTranscriptCache, readCachedTranscript } from "./transcript-cache.js";

const tempDirs: string[] = [];

afterEach(async () => {
  clearTranscriptCache();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function createTempTranscript(filename = "session.jsonl"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "codex-transcript-cache-"));
  tempDirs.push(dir);
  return join(dir, filename);
}

describe("readCachedTranscript", () => {
  test("appends only complete new lines across incremental reads", async () => {
    const transcriptPath = await createTempTranscript();
    await writeFile(
      transcriptPath,
      `${JSON.stringify({
        timestamp: "2026-04-16T11:17:23.623Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          call_id: "call-spawn-1",
          arguments: "{}",
        },
      })}\n{"timestamp":"2026-04-16T11:17:24.000Z","type":"event_msg"`,
      "utf8",
    );

    const initial = await readCachedTranscript(transcriptPath);
    expect(initial.lines).toHaveLength(1);
    expect(initial.records).toHaveLength(1);

    await appendFile(
      transcriptPath,
      `${',"payload":{"type":"agent_message","phase":"commentary","message":"working"}}\n'}${JSON.stringify({
        timestamp: "2026-04-16T11:17:25.000Z",
        type: "event_msg",
        payload: {
          type: "task_complete",
        },
      })}\n`,
      "utf8",
    );

    const updated = await readCachedTranscript(transcriptPath);
    expect(updated.lines).toHaveLength(3);
    expect(updated.records).toHaveLength(3);
    expect(updated.records[1]?.payload?.type).toBe("agent_message");
    expect(updated.records[2]?.payload?.type).toBe("task_complete");
  });

  test("reloads from scratch when the transcript file is replaced", async () => {
    const transcriptPath = await createTempTranscript();
    await writeFile(
      transcriptPath,
      `${JSON.stringify({
        timestamp: "2026-04-16T11:17:23.623Z",
        type: "event_msg",
        payload: { type: "agent_message", message: "old" },
      })}\n`,
      "utf8",
    );

    const initial = await readCachedTranscript(transcriptPath);
    expect(initial.records[0]?.payload?.message).toBe("old");

    await writeFile(
      transcriptPath,
      `${JSON.stringify({
        timestamp: "2026-04-16T11:18:00.000Z",
        type: "event_msg",
        payload: { type: "agent_message", message: "new" },
      })}\n`,
      "utf8",
    );

    const replaced = await readCachedTranscript(transcriptPath);
    expect(replaced.lines).toHaveLength(1);
    expect(replaced.records).toHaveLength(1);
    expect(replaced.records[0]?.payload?.message).toBe("new");
  });
});
