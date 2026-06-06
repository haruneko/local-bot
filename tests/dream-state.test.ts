import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultDreamState,
  loadDreamState,
  saveDreamState,
} from "../src/state/dream-state.js";

describe("dream-state persist", () => {
  it("returns defaults when file is missing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "local-bot-dream-"));
    const file = path.join(dir, "dream-state.json");
    try {
      expect(await loadDreamState(file)).toEqual({
        ...defaultDreamState(),
        seedAppliedAt: null,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("round-trips lastDreamAt and factCount", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "local-bot-dream-"));
    const file = path.join(dir, "dream-state.json");
    try {
      await saveDreamState(file, {
        lastDreamAt: "2026-06-06T10:00:00.000Z",
        seedAppliedAt: "2026-06-06T09:00:00.000Z",
        factCount: 3,
      });
      expect(await loadDreamState(file)).toEqual({
        lastDreamAt: "2026-06-06T10:00:00.000Z",
        seedAppliedAt: "2026-06-06T09:00:00.000Z",
        factCount: 3,
        updatedAt: expect.any(String),
      });

      const raw = JSON.parse(await readFile(file, "utf8")) as {
        lastDreamAt: string;
        factCount: number;
        updatedAt: string;
      };
      expect(raw.lastDreamAt).toBe("2026-06-06T10:00:00.000Z");
      expect(raw.factCount).toBe(3);
      expect(raw.updatedAt).toBeTruthy();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
