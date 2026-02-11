import { describe, expect, test } from "bun:test";
import { listSessions, type OpencodeClient } from "./opencode-client";

describe("opencode-client listSessions", () => {
  test("maps SDK sessions into UI session shape", async () => {
    const createdMs = 1739232000000;
    const client = {
      session: {
        list: async () => ({
          data: [
            {
              id: "session-1",
              title: "My Session",
              time: {
                created: createdMs,
              },
            },
          ],
        }),
      },
    } as unknown as OpencodeClient;

    const sessions = await listSessions(client);

    expect(sessions).toEqual([
      {
        id: "session-1",
        title: "My Session",
        createdAt: new Date(createdMs).toISOString(),
      },
    ]);
  });

  test("rethrows errors so callers can display failure state", async () => {
    const expectedError = new Error("network unavailable");
    const client = {
      session: {
        list: async () => {
          throw expectedError;
        },
      },
    } as unknown as OpencodeClient;

    await expect(listSessions(client)).rejects.toThrow("network unavailable");
  });
});
