import { describe, expect, it } from "vitest";
import {
  classifyRecallHits,
  cosineSimilarity,
  DEFAULT_RECALL_DISTANCE_THRESHOLDS,
  distanceToRelevance,
  recencyDecay,
} from "../src/recall/distance.js";

describe("recall distance gating", () => {
  it("summarizeMax 以下は通し、超は omit（vague 廃止・LLM 要約廃止＝提示は本文そのまま）", () => {
    const result = classifyRecallHits(
      [
        { body: "原文A", distance: 0.4 },
        { body: "原文B", distance: 0.65 },
        { body: "原文C", distance: 0.8 }, // omit
        { body: "原文D", distance: 1.0 }, // omit
      ],
      DEFAULT_RECALL_DISTANCE_THRESHOLDS,
    );

    expect(result).toHaveLength(2);
    expect(result.map((h) => h.body)).toEqual(["原文A", "原文B"]);
  });

  it("returns empty for no hits", () => {
    expect(classifyRecallHits([])).toEqual([]);
  });

  it("sorts by relevance descending", () => {
    const result = classifyRecallHits([
      { body: "b", distance: 0.7 },
      { body: "a", distance: 0.4 },
    ]);
    expect(result[0]!.body).toBe("a");
    expect(result[0]!.relevance).toBeGreaterThan(result[1]!.relevance);
  });

  it("distanceToRelevance returns 0 above vagueMax", () => {
    expect(distanceToRelevance(0.9, 0.85)).toBe(0);
    expect(distanceToRelevance(0.425, 0.85)).toBeCloseTo(0.5, 5);
  });

  it("recencyDecay: no timestamp returns 1", () => {
    expect(recencyDecay(undefined)).toBe(1);
  });

  it("recencyDecay: future timestamp returns 1", () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect(recencyDecay(future)).toBe(1);
  });

  it("recencyDecay: 70 days ≈ 0.5 (half-life)", () => {
    const now = new Date();
    const past = new Date(now.getTime() - 70 * 86_400_000).toISOString();
    expect(recencyDecay(past, now)).toBeCloseTo(0.5, 1);
  });

  it("older timestamp ranks below newer one at same distance", () => {
    const now = new Date();
    const recent = now.toISOString();
    const old = new Date(now.getTime() - 200 * 86_400_000).toISOString();
    const result = classifyRecallHits([
      { body: "old", distance: 0.4, timestamp: old },
      { body: "new", distance: 0.4, timestamp: recent },
    ]);
    expect(result[0]!.body).toBe("new");
  });
});

describe("cosineSimilarity", () => {
  it("identical vectors → 1", () => {
    const v = [1, 0, 0];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  it("orthogonal vectors → 0", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
  });

  it("opposite vectors → -1", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 5);
  });

  it("empty vectors → 0", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

describe("inhibition scoring", () => {
  const v1 = [1, 0, 0];
  const v2 = [0, 1, 0];
  const vSimilar = [0.99, 0.14, 0]; // v1 に近い

  it("高類似度のベクトルは inhibition バッファにより relevance が下がる", () => {
    const withoutInhibition = classifyRecallHits(
      [{ turnId: "a", body: "A", distance: 0.4, vector: vSimilar }],
      DEFAULT_RECALL_DISTANCE_THRESHOLDS,
      {},
    );
    const withInhibition = classifyRecallHits(
      [{ turnId: "a", body: "A", distance: 0.4, vector: vSimilar }],
      DEFAULT_RECALL_DISTANCE_THRESHOLDS,
      { inhibitionBuffer: [v1] },
    );
    expect(withInhibition[0]!.relevance).toBeLessThan(withoutInhibition[0]!.relevance);
  });

  it("非類似ベクトルは inhibition の影響を受けない", () => {
    const withoutInhibition = classifyRecallHits(
      [{ turnId: "b", body: "B", distance: 0.4, vector: v2 }],
      DEFAULT_RECALL_DISTANCE_THRESHOLDS,
      {},
    );
    const withInhibition = classifyRecallHits(
      [{ turnId: "b", body: "B", distance: 0.4, vector: v2 }],
      DEFAULT_RECALL_DISTANCE_THRESHOLDS,
      { inhibitionBuffer: [v1] },
    );
    // v2 と v1 は直交（similarity ≈ 0）なのでほぼ同スコア
    expect(withInhibition[0]!.relevance).toBeCloseTo(withoutInhibition[0]!.relevance, 3);
  });

  it("importance が高いほど relevance が高い", () => {
    const low = classifyRecallHits(
      [{ turnId: "c", body: "C", distance: 0.4, importance: 2 }],
      DEFAULT_RECALL_DISTANCE_THRESHOLDS,
    );
    const high = classifyRecallHits(
      [{ turnId: "d", body: "D", distance: 0.4, importance: 9 }],
      DEFAULT_RECALL_DISTANCE_THRESHOLDS,
    );
    expect(high[0]!.relevance).toBeGreaterThan(low[0]!.relevance);
  });

  it("vector なし hits は inhibition の影響なし（エラーにならない）", () => {
    expect(() =>
      classifyRecallHits(
        [{ turnId: "e", body: "E", distance: 0.4 }],
        DEFAULT_RECALL_DISTANCE_THRESHOLDS,
        { inhibitionBuffer: [v1] },
      ),
    ).not.toThrow();
  });
});

describe("speaker match boost", () => {
  const hit = (turnId: string, participants?: string[]) => ({
    turnId,
    body: turnId,
    distance: 0.4,
    participants,
  });

  it("currentSpeaker が participants に含まれると relevance が上がる", () => {
    const base = classifyRecallHits(
      [hit("a", ["claude_kuro"])],
      DEFAULT_RECALL_DISTANCE_THRESHOLDS,
      {},
    );
    const boosted = classifyRecallHits(
      [hit("a", ["claude_kuro"])],
      DEFAULT_RECALL_DISTANCE_THRESHOLDS,
      { currentSpeaker: "claude_kuro" },
    );
    expect(boosted[0]!.relevance).toBeGreaterThan(base[0]!.relevance);
  });

  it("currentSpeaker が participants にいないと不変", () => {
    const base = classifyRecallHits(
      [hit("b", ["HAL"])],
      DEFAULT_RECALL_DISTANCE_THRESHOLDS,
      {},
    );
    const same = classifyRecallHits(
      [hit("b", ["HAL"])],
      DEFAULT_RECALL_DISTANCE_THRESHOLDS,
      { currentSpeaker: "claude_kuro" },
    );
    expect(same[0]!.relevance).toBeCloseTo(base[0]!.relevance, 6);
  });

  it("participants 無しのヒットは currentSpeaker があっても不変・エラーにならない", () => {
    const base = classifyRecallHits(
      [hit("c")],
      DEFAULT_RECALL_DISTANCE_THRESHOLDS,
      {},
    );
    const same = classifyRecallHits(
      [hit("c")],
      DEFAULT_RECALL_DISTANCE_THRESHOLDS,
      { currentSpeaker: "claude_kuro" },
    );
    expect(same[0]!.relevance).toBeCloseTo(base[0]!.relevance, 6);
  });

  it("話者一致ヒットは同距離の不一致ヒットより上位に並ぶ", () => {
    const result = classifyRecallHits(
      [hit("other", ["HAL"]), hit("mine", ["claude_kuro"])],
      DEFAULT_RECALL_DISTANCE_THRESHOLDS,
      { currentSpeaker: "claude_kuro" },
    );
    expect(result[0]!.id).toBe(1); // "mine"
  });

  it("omit 判定（距離ゲーティング）は currentSpeaker で変わらない", () => {
    // vagueMax 超過は currentSpeaker でも復活しない
    const result = classifyRecallHits(
      [{ turnId: "far", body: "遠い", distance: 0.95, participants: ["claude_kuro"] }],
      DEFAULT_RECALL_DISTANCE_THRESHOLDS,
      { currentSpeaker: "claude_kuro" },
    );
    expect(result).toHaveLength(0);
  });
});
