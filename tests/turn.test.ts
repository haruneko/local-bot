import { describe, expect, it } from "vitest";
import { TurnOrchestrator } from "../src/orchestrator/turn.js";
import { InMemoryEpisodeStore } from "../src/memory/episode.js";
import {
  InMemorySemanticStore,
  pseudoVector,
} from "../src/memory/semantic.js";
import { WorkingMemory } from "../src/memory/working.js";
import { FakeLlmClient } from "../src/llm/fake.js";
import { DEFAULT_RECALL_DISTANCE_THRESHOLDS } from "../src/recall/distance.js";
import type { TurnDeps } from "../src/orchestrator/turn.js";

/** 新アーキテクチャのターンごとの LLM 呼び出し順:
 *  0: memory-agent activation  → {"activate":false}
 *  1: research-agent activation → {"activate":false}
 *  2: language                  → {"speech":"...","nextState":"..."}
 *  3: introspection             → plain text
 *  4: tag extraction            → {"tags":[...]}
 *  5: inner-state update        → plain text
 *
 *  idle heartbeat (speech=""):  calls 0–2 のみ（内省スキップ）
 */

const MEM_OFF = JSON.stringify({ activate: false });
const RES_OFF = JSON.stringify({ activate: false });

function lang(speech: string, nextState = "対話") {
  return JSON.stringify({ speech, nextState });
}

function baseTurnDeps(
  overrides: Partial<TurnDeps> & Pick<TurnDeps, "llm" | "workingMemory">,
): TurnDeps {
  return {
    episodes: new InMemoryEpisodeStore(),
    semantic: new InMemorySemanticStore(),
    episodeRecallTopK: 3,
    semanticRecallTopK: 5,
    semanticRecallMaxDistance: 0.75,
    recencyExclusionTurns: 4,
    recallDistanceThresholds: DEFAULT_RECALL_DISTANCE_THRESHOLDS,
    contextTokenBudget: 6000,
    getPersona: async () => "",
    dialogue: { resolveUserDisplayName: () => "太郎" },
    ...overrides,
  };
}

describe("TurnOrchestrator", () => {
  it("T-T01: clears turn context after turn", async () => {
    const llm = new FakeLlmClient([
      MEM_OFF,
      RES_OFF,
      lang("ボットの返答です"),
      "内省テキストです",
      '{"tags":["会話"]}',
      "少し嬉しい気分",
    ]);
    const episodes = new InMemoryEpisodeStore();
    const orch = new TurnOrchestrator(
      "対話",
      baseTurnDeps({
        llm,
        episodes,
        workingMemory: new WorkingMemory(20),
        getPersona: async () => "test persona",
      }),
    );

    await orch.run({
      type: "user_message",
      content: "やあ",
      speakerId: "user_001",
    });

    expect(orch.getTurnContext()).toBeNull();
    expect(episodes.getAll()).toHaveLength(1);
    expect(episodes.getAll()[0].metadata.source).toBe("introspection");
  });

  it("empty speech still runs introspection for user_message and skips assistant memory", async () => {
    const llm = new FakeLlmClient([
      MEM_OFF,
      RES_OFF,
      lang("", "静穏"),
      "内省のみ",
      '{"tags":["会話"]}',
      "静かな気持ち",
    ]);
    const wm = new WorkingMemory(20);
    const orch = new TurnOrchestrator(
      "対話",
      baseTurnDeps({ llm, workingMemory: wm }),
    );

    const result = await orch.run({
      type: "user_message",
      content: "……",
      speakerId: "user_001",
    });

    expect(result.speech).toBeNull();
    expect(llm.calls).toHaveLength(6);
    const introCall = llm.calls[3]; // introspection is 4th call (index 3)
    expect(introCall.messages[1].content).toContain("（返答はしなかった）");
    expect(wm.getRecent().some((t) => t.role === "assistant")).toBe(false);
  });

  it("idle heartbeat skips introspection LLM and episode append", async () => {
    const llm = new FakeLlmClient([
      MEM_OFF,
      RES_OFF,
      lang("", "静穏"),
    ]);
    const episodes = new InMemoryEpisodeStore();
    const orch = new TurnOrchestrator(
      "静穏",
      baseTurnDeps({ llm, episodes, workingMemory: new WorkingMemory(20) }),
    );

    const result = await orch.run({ type: "heartbeat" });

    expect(result.episodeSaved).toBe(false);
    expect(result.introspection).toBe("");
    expect(llm.calls).toHaveLength(3);
    expect(episodes.getAll()).toHaveLength(0);
  });

  it("heartbeat REPLY appends monologue to working memory", async () => {
    const llm = new FakeLlmClient([
      MEM_OFF,
      RES_OFF,
      lang("独り言セリフ"),
      "内省",
      '{"tags":["日常"]}',
      "穏やかな気分",
    ]);
    const wm = new WorkingMemory(20, [
      { role: "user", speakerId: "user_001", content: "前の質問" },
    ]);
    const orch = new TurnOrchestrator(
      "対話",
      baseTurnDeps({ llm, workingMemory: wm }),
    );

    await orch.run({ type: "heartbeat" });

    expect(wm.getRecent()).toEqual([
      expect.objectContaining({ role: "user", speakerId: "user_001", content: "前の質問" }),
      expect.objectContaining({ role: "assistant", channel: "monologue", content: "独り言セリフ" }),
    ]);
  });

  it("heartbeat with language speech appends monologue and saves episode", async () => {
    const llm = new FakeLlmClient([
      MEM_OFF,
      RES_OFF,
      lang("CONCEPT.md は設計書だった。次は別メモも見よう"),
      "内省テキスト",
      '{"tags":["メモ"]}',
      "少し満足した気分",
    ]);
    const wm = new WorkingMemory(20, [
      { role: "user", speakerId: "user_001", content: "メモ見て" },
    ]);
    const episodes = new InMemoryEpisodeStore();
    const orch = new TurnOrchestrator(
      "対話",
      baseTurnDeps({ llm, episodes, workingMemory: wm }),
    );

    const result = await orch.run({ type: "heartbeat" });

    expect(result.speech).toBe("CONCEPT.md は設計書だった。次は別メモも見よう");
    expect(llm.calls).toHaveLength(6);
    expect(wm.getRecent()[1]).toEqual(
      expect.objectContaining({
        role: "assistant",
        channel: "monologue",
        content: "CONCEPT.md は設計書だった。次は別メモも見よう",
      }),
    );
    expect(result.episodeSaved).toBe(true);
  });

  it("loads semantic facts into turn context from semantic store", async () => {
    const semantic = new InMemorySemanticStore();
    await semantic.upsert({
      body: "ユーザーは夏目漱石を好む",
      vector: pseudoVector("読書の話"),
    });

    const llm = new FakeLlmClient([
      MEM_OFF,
      RES_OFF,
      lang("夏目漱石の話ですね"),
      "内省",
      '{"tags":["読書"]}',
      "読書の話で少し嬉しい",
    ]);

    const orch = new TurnOrchestrator(
      "対話",
      baseTurnDeps({
        llm,
        semantic,
        workingMemory: new WorkingMemory(20),
      }),
    );

    await orch.run({
      type: "user_message",
      content: "読書の話",
      speakerId: "user_001",
    });

    // 意味記憶は language agent の system message (calls[2].messages[0]) に含まれる
    const languageSystem = llm.calls[2]!.messages[0]!.content;
    expect(languageSystem).toContain("夏目漱石");
    expect(languageSystem).toContain("意味記憶");
  });

  it("updates inner state after introspection and persists to session", async () => {
    const llm = new FakeLlmClient([
      MEM_OFF,
      RES_OFF,
      lang("返答"),
      "内省本文",
      '{"tags":["会話"]}',
      "さっき二度言っちゃった、ちょっと恥ずかしい",
    ]);
    let savedInner = "";
    const orch = new TurnOrchestrator(
      "対話",
      baseTurnDeps({
        llm,
        workingMemory: new WorkingMemory(20),
        initialInnerState: "",
        onSessionPersist: async (s) => {
          savedInner = s.innerState;
        },
      }),
    );

    await orch.run({
      type: "user_message",
      content: "こんにちは",
      speakerId: "user_001",
    });

    expect(orch.getInnerState()).toBe(
      "さっき二度言っちゃった、ちょっと恥ずかしい",
    );
    expect(savedInner).toBe("さっき二度言っちゃった、ちょっと恥ずかしい");
    // inner-state は 6 番目の呼び出し (index 5)
    expect(llm.calls[5]!.messages[0].content).toContain("前の内心");
  });

  it("excludes recent episode turnIds from recall", async () => {
    const episodes = new InMemoryEpisodeStore();
    await episodes.append({
      body: "古い内省",
      metadata: {
        timestamp: "2026-01-01T00:00:00.000Z",
        participants: [],
        tags: [],
        state: "対話",
        action: "",
        source: "introspection",
        reply: true,
        turnId: "old-turn",
      },
    });

    // ターン1: 6 calls, ターン2: 6 calls = 合計 12 calls
    const llm = new FakeLlmClient([
      MEM_OFF, RES_OFF, lang("返答1"), "直近の内省", '{"tags":["会話"]}', "内心1",
      MEM_OFF, RES_OFF, lang("返答2"), "内省2", '{"tags":["会話"]}', "内心2",
    ]);
    const orch = new TurnOrchestrator(
      "対話",
      baseTurnDeps({
        llm,
        episodes,
        workingMemory: new WorkingMemory(20),
        recencyExclusionTurns: 4,
      }),
    );

    await orch.run({
      type: "user_message",
      content: "最初",
      speakerId: "user_001",
    });
    await orch.run({
      type: "user_message",
      content: "二回目",
      speakerId: "user_001",
    });

    // ターン2の language system (calls[8]) に古い内省のみ含まれ、直近の内省は除外される
    const turn2LangSystem = llm.calls[8]!.messages[0].content;
    expect(turn2LangSystem).toContain("古い内省");
    expect(turn2LangSystem).not.toContain("直近の内省");
  });
});
