import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadSession, saveSession } from "../src/state/persist.js";

describe("session persist", () => {
  it("round-trips state and working memory", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "local-bot-session-"));
    const file = path.join(dir, "state.json");
    try {
      expect(await loadSession(file)).toEqual({
        state: "対話",
        workingMemory: [],
      });

      await saveSession(file, {
        state: "静穏",
        workingMemory: [
          { role: "user", speakerId: "u1", content: "買い物の話" },
          { role: "assistant", content: "了解" },
        ],
      });

      expect(await loadSession(file)).toEqual({
        state: "静穏",
        workingMemory: [
          { role: "user", speakerId: "u1", content: "買い物の話" },
          { role: "assistant", content: "了解" },
        ],
      });

      const raw = JSON.parse(await readFile(file, "utf8")) as {
        state: string;
        workingMemory: unknown[];
        updatedAt: string;
      };
      expect(raw.workingMemory).toHaveLength(2);
      expect(raw.updatedAt).toBeTruthy();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("loads legacy state-only file as empty working memory", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "local-bot-session-"));
    const file = path.join(dir, "state.json");
    try {
      await saveSession(file, { state: "静穏", workingMemory: [] });
      const legacy = JSON.stringify({
        state: "静穏",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      await import("node:fs/promises").then((fs) =>
        fs.writeFile(file, legacy, "utf8"),
      );
      expect(await loadSession(file)).toEqual({
        state: "静穏",
        workingMemory: [],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
