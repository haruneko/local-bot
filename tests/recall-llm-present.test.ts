import { describe, expect, it } from "vitest";
import { FakeLlmClient } from "../src/llm/fake.js";
import { DEFAULT_RECALL_DISTANCE_THRESHOLDS } from "../src/recall/distance.js";
import {
  presentRecallEpisodes,
  summarizeRecallActionHits,
} from "../src/recall/llm-present.js";

describe("presentRecallEpisodes", () => {
  it("uses LLM for summarize only; full as-is; 旧 vague 帯は omit", async () => {
    const llm = new FakeLlmClient([
      JSON.stringify({
        items: [{ id: 1, presented: "要点だけ残したB" }],
      }),
    ]);

    const recalled = await presentRecallEpisodes(
      llm,
      [
        { body: "原文A", distance: 0.4 }, // full
        { body: "原文Bは長い記憶の本文です", distance: 0.65 }, // summarize（LLM）
        { body: "原文Cの遠い記憶", distance: 0.8 }, // 旧 vague → omit
        { body: "原文D", distance: 1.0 }, // omit
      ],
      {
        state: "対話",
        currentDateTime: "2026年6月6日 15:00（JST）",
        triggerLabel: "こんばんは",
        recallQuery: "こんばんは",
      },
      DEFAULT_RECALL_DISTANCE_THRESHOLDS,
    );

    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0].options?.format).toBeDefined();
    expect(llm.calls[0].messages[0].content).toContain("summarize");
    expect(recalled).toHaveLength(2);
    expect(recalled.find((e) => e.presentation === "full")?.presented).toBe(
      "原文A",
    );
    expect(
      recalled.find((e) => e.presentation === "summarize")?.presented,
    ).toBe("要点だけ残したB");
    expect(recalled.some((e) => (e.presentation as string) === "vague")).toBe(false);
  });

  it("旧 vague 帯のみのヒットは LLM 無しで omit（空）", async () => {
    const llm = new FakeLlmClient([]);

    const recalled = await presentRecallEpisodes(
      llm,
      [{ body: "無関係な昔話", distance: 0.8 }],
      {
        state: "静穏",
        currentDateTime: "2026年6月6日 3:00（JST）",
        triggerLabel: "（ハートビート・静穏）",
        recallQuery: "heartbeat 静穏",
      },
      DEFAULT_RECALL_DISTANCE_THRESHOLDS,
    );

    expect(llm.calls).toHaveLength(0);
    expect(recalled).toEqual([]);
  });

  it("omits summarize hit when LLM returns empty presented", async () => {
    const llm = new FakeLlmClient([
      JSON.stringify({
        items: [{ id: 0, presented: "" }],
      }),
    ]);

    const recalled = await presentRecallEpisodes(
      llm,
      [{ body: "無関係な記憶", distance: 0.65 }],
      {
        state: "静穏",
        currentDateTime: "2026年6月6日 3:00（JST）",
        triggerLabel: "（ハートビート・静穏）",
        recallQuery: "heartbeat 静穏",
      },
      DEFAULT_RECALL_DISTANCE_THRESHOLDS,
    );

    expect(recalled).toHaveLength(0);
  });

  it("skips LLM call when there are no summarize hits（full のみ・遠いのは omit）", async () => {
    const llm = new FakeLlmClient([]);
    const recalled = await presentRecallEpisodes(
      llm,
      [
        { body: "近い記憶", distance: 0.3 }, // full
        { body: "遠い記憶", distance: 0.8 }, // 旧 vague → omit
      ],
      {
        state: "対話",
        currentDateTime: "2026年6月6日 12:00（JST）",
        triggerLabel: "test",
        recallQuery: "test",
      },
      DEFAULT_RECALL_DISTANCE_THRESHOLDS,
    );

    expect(llm.calls).toHaveLength(0);
    expect(recalled).toHaveLength(1);
    expect(recalled.find((e) => e.presentation === "full")?.presented).toBe(
      "近い記憶",
    );
  });
});

describe("summarizeRecallActionHits", () => {
  it("returns LLM bullets for recall action", async () => {
    const llm = new FakeLlmClient([
      JSON.stringify({
        bullets: ["コーヒーが好きだった", "前に話した約束"],
      }),
    ]);

    const bullets = await summarizeRecallActionHits(llm, "コーヒーの話", [
      { body: "太郎はコーヒーが好きと言っていた。エスプレッソ派。", distance: 0.2 },
      { body: "来週また会おうと約束した。", distance: 0.4 },
    ]);

    expect(bullets).toEqual(["コーヒーが好きだった", "前に話した約束"]);
    expect(llm.calls[0].messages[0].content).toContain("記憶（LanceDB）");
    expect(llm.calls[0].options?.format).toBeDefined();
  });
});
