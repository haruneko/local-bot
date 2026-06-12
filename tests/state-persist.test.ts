import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadSession, saveSession } from "../src/state/persist.js";

describe("session persist", () => {
  it("T-IS03: round-trips state, working memory, affect, and concern", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "local-bot-session-"));
    const file = path.join(dir, "state.json");
    try {
      expect(await loadSession(file)).toEqual({
        state: "対話",
        workingMemory: [],
        affect: "",
        concern: "",
        focusPlan: "",
      });

      await saveSession(file, {
        state: "静穏",
        workingMemory: [
          { role: "user", speakerId: "u1", content: "買い物の話" },
          { role: "assistant", content: "了解" },
        ],
        affect: "少し落ち着いた気分",
        concern: "買い物リストの整理",
        focusPlan: "shopping",
      });

      expect(await loadSession(file)).toEqual({
        state: "静穏",
        workingMemory: [
          { role: "user", speakerId: "u1", content: "買い物の話" },
          { role: "assistant", content: "了解" },
        ],
        affect: "少し落ち着いた気分",
        concern: "買い物リストの整理",
        focusPlan: "shopping",
      });

      const raw = JSON.parse(await readFile(file, "utf8")) as {
        state: string;
        workingMemory: unknown[];
        affect: string;
        concern: string;
        updatedAt: string;
      };
      expect(raw.workingMemory).toHaveLength(2);
      expect(raw.updatedAt).toBeTruthy();
      expect("innerState" in raw).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("loads legacy state-only file as empty working memory, affect, concern", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "local-bot-session-"));
    const file = path.join(dir, "state.json");
    try {
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
        affect: "",
        concern: "",
        focusPlan: "",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("migrates legacy innerState to affect on load", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "local-bot-session-"));
    const file = path.join(dir, "state.json");
    try {
      const legacy = JSON.stringify({
        state: "静穏",
        workingMemory: [],
        innerState: "古い内心フィールド",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      await import("node:fs/promises").then((fs) =>
        fs.writeFile(file, legacy, "utf8"),
      );
      const loaded = await loadSession(file);
      expect(loaded.affect).toBe("古い内心フィールド");
      expect(loaded.concern).toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
