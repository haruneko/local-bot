import { describe, expect, it } from "vitest";
import {
  DEFAULT_RECALL_DISTANCE_THRESHOLDS,
  distanceToRelevance,
  filterRecallByDistance,
  VAGUE_PRESENTED,
} from "../src/recall/distance.js";

describe("recall distance filter", () => {
  it("maps L2 distance to presentation levels", () => {
    const result = filterRecallByDistance(
      [
        { body: "原文A", distance: 0.4 },
        { body: "原文B", distance: 0.65 },
        { body: "原文C", distance: 0.8 },
        { body: "原文D", distance: 1.0 },
      ],
      DEFAULT_RECALL_DISTANCE_THRESHOLDS,
    );

    expect(result).toHaveLength(3);
    expect(result[0].presented).toBe("原文A");
    expect(result[0].presentation).toBe("full");
    expect(result.find((e) => e.presentation === "summarize")?.presented).toMatch(
      /^原文B/,
    );
    expect(result.find((e) => e.presentation === "vague")?.presented).toBe(
      VAGUE_PRESENTED,
    );
  });

  it("omits hits above vagueMax (strict)", () => {
    const result = filterRecallByDistance([
      { body: "遠い記憶", distance: 0.86 },
      { body: "近い記憶", distance: 0.5 },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].presented).toBe("近い記憶");
  });

  it("returns empty for no hits", () => {
    expect(filterRecallByDistance([])).toEqual([]);
  });

  it("sorts by relevance descending", () => {
    const result = filterRecallByDistance([
      { body: "b", distance: 0.7 },
      { body: "a", distance: 0.4 },
    ]);
    expect(result[0].presented).toMatch(/^a$/);
    expect(result[0].relevance).toBeGreaterThan(result[1].relevance);
  });

  it("distanceToRelevance returns 0 above vagueMax", () => {
    expect(distanceToRelevance(0.9, 0.85)).toBe(0);
    expect(distanceToRelevance(0.425, 0.85)).toBeCloseTo(0.5, 5);
  });
});
