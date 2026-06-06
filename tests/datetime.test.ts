import { describe, expect, it } from "vitest";
import { buildContextClock, formatContextDateTime } from "../src/sensor/datetime.js";
import {
  createTurnContext,
  redactTurnContextForLog,
} from "../src/context/turn-context.js";

const dialogue = {
  resolveUserDisplayName: (id: string) => id,
};

describe("context datetime", () => {
  it("formats Japanese date time", () => {
    const text = formatContextDateTime(
      new Date("2026-06-03T12:34:00+09:00"),
      "Asia/Tokyo",
    );
    expect(text).toContain("2026");
    expect(text).toContain("JST");
  });

  it("uses single now for executedAt and currentDateTime", () => {
    const now = new Date("2026-06-03T03:00:00.000Z");
    const ctx = createTurnContext({
      turnId: "t-dt",
      state: "対話",
      now,
      trigger: { type: "user_message", content: "hi", speakerId: "u1" },
      dialogue,
      recentTurns: [],
      recalledEpisodes: [],
    });
    expect(ctx.executedAt).toBe(now.toISOString());
    expect(ctx.currentDateTime).toContain("2026");
  });

  it("redacts datetime from verbose log shape", () => {
    const ctx = createTurnContext({
      turnId: "t-dt2",
      state: "対話",
      trigger: { type: "user_message", content: "x", speakerId: "u1" },
      dialogue,
      recentTurns: [],
      recalledEpisodes: [],
    });
    const log = redactTurnContextForLog(ctx);
    expect(log).not.toHaveProperty("executedAt");
    expect(log).not.toHaveProperty("currentDateTime");
    expect(log.dateTime).toBe("(コンテキスト内のみ)");
  });

  it("buildContextClock returns both fields", () => {
    const c = buildContextClock(new Date(0), "UTC");
    expect(c.executedAt).toBe("1970-01-01T00:00:00.000Z");
    expect(c.currentDateTime.length).toBeGreaterThan(5);
  });
});
