import { describe, expect, it } from "vitest";
import { DEFAULT_RECALL_DISTANCE_THRESHOLDS } from "../src/recall/distance.js";
import { presentRecallEpisodes } from "../src/recall/present.js";

describe("presentRecallEpisodes", () => {
  it("summarizeMax 以下は本文そのまま・超は omit（LLM 要約なし）", () => {
    const recalled = presentRecallEpisodes(
      [
        { body: "原文A", distance: 0.4 }, // 旧 full 帯
        { body: "原文Bは長い記憶の本文です", distance: 0.65 }, // 旧 summarize 帯 → 本文そのまま
        { body: "原文Cの遠い記憶", distance: 0.8 }, // omit
        { body: "原文D", distance: 1.0 }, // omit
      ],
      DEFAULT_RECALL_DISTANCE_THRESHOLDS,
    );

    expect(recalled).toHaveLength(2);
    expect(recalled.map((e) => e.presented)).toEqual([
      "原文A",
      "原文Bは長い記憶の本文です",
    ]);
    // 提示は常に full ラベル（「（要約）」タグは fitTurnContext の予算超過フォールバック専用）
    expect(recalled.every((e) => e.presentation === "full")).toBe(true);
  });

  it("omit 帯のみのヒットは空", () => {
    const recalled = presentRecallEpisodes(
      [{ body: "無関係な昔話", distance: 0.8 }],
      DEFAULT_RECALL_DISTANCE_THRESHOLDS,
    );
    expect(recalled).toEqual([]);
  });

  it("空ヒットは空", () => {
    expect(presentRecallEpisodes([], DEFAULT_RECALL_DISTANCE_THRESHOLDS)).toEqual([]);
  });

  it("本文が空白のみのヒットは載せない", () => {
    const recalled = presentRecallEpisodes(
      [{ body: "  \n ", distance: 0.4 }],
      DEFAULT_RECALL_DISTANCE_THRESHOLDS,
    );
    expect(recalled).toEqual([]);
  });

  it("relevance 降順に並ぶ（近い方が上）", () => {
    const recalled = presentRecallEpisodes(
      [
        { body: "b", distance: 0.7 },
        { body: "a", distance: 0.4 },
      ],
      DEFAULT_RECALL_DISTANCE_THRESHOLDS,
    );
    expect(recalled[0]!.presented).toBe("a");
    expect(recalled[0]!.relevance).toBeGreaterThan(recalled[1]!.relevance);
  });

  it("timestamp を occurredAt として通す（時刻前置き用）", () => {
    const ts = "2026-07-01T12:00:00.000Z";
    const recalled = presentRecallEpisodes(
      [{ body: "記憶", distance: 0.4, timestamp: ts }],
      DEFAULT_RECALL_DISTANCE_THRESHOLDS,
    );
    expect(recalled[0]!.occurredAt).toBe(ts);
  });

  it("同距離なら古い timestamp が新しいものより下位", () => {
    const now = new Date();
    const recent = now.toISOString();
    const old = new Date(now.getTime() - 200 * 86_400_000).toISOString();
    const recalled = presentRecallEpisodes(
      [
        { body: "old", distance: 0.4, timestamp: old },
        { body: "new", distance: 0.4, timestamp: recent },
      ],
      DEFAULT_RECALL_DISTANCE_THRESHOLDS,
    );
    expect(recalled[0]!.presented).toBe("new");
  });
});
