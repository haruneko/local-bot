import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TurnOrchestrator } from "../src/orchestrator/turn.js";
import { loadSteps, saveSteps, type StepsState } from "../src/steps/state.js";
import { readNoteContent } from "../src/tools/notes.js";
import { InMemoryEpisodeStore } from "../src/memory/episode.js";
import {
  InMemorySemanticStore,
  pseudoVector,
} from "../src/memory/semantic.js";
import { WorkingMemory } from "../src/memory/working.js";
import { FakeLlmClient } from "../src/llm/fake.js";
import { FakeMcpToolProvider } from "../src/mcp/fake.js";
import { buildToolCatalog } from "../src/tools/catalog.js";
import { DEFAULT_RECALL_DISTANCE_THRESHOLDS } from "../src/recall/distance.js";
import type { TurnDeps } from "../src/orchestrator/turn.js";

/** ターンごとの LLM 呼び出し順（enabledActors=[] のとき activator は呼ばれない）:
 *  0: language         → {"speech":"...","nextState":"..."}
 *  1: introspection    → plain text
 *  2: tag extraction   → {"tags":[...]}
 *  3: inner-state      → plain text
 *
 *  idle heartbeat (speech=""):  call 0 のみ（内省スキップ）
 */

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
    // enabledActors=[] なので activator LLM は呼ばれない
    resolveForState: () => ({ enabledActors: [], episodeRecallTopK: 3 }),
    ...overrides,
  };
}

describe("TurnOrchestrator", () => {
  it("T-T01: clears turn context after turn", async () => {
    const llm = new FakeLlmClient([
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
    expect(llm.calls).toHaveLength(4);
    const introCall = llm.calls[1]; // introspection is 2nd call (index 1)
    // 無言は自分(assistant)メッセージに入る（role 構造化後）
    expect(introCall.messages.map((m) => m.content).join("\n")).toContain(
      "（返答はしなかった）",
    );
    expect(wm.getRecent().some((t) => t.role === "assistant")).toBe(false);
  });

  it("idle heartbeat skips introspection LLM and episode append", async () => {
    const llm = new FakeLlmClient([
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
    expect(llm.calls).toHaveLength(1);
    expect(episodes.getAll()).toHaveLength(0);
  });

  it("heartbeat REPLY appends monologue to working memory", async () => {
    const llm = new FakeLlmClient([
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
    expect(llm.calls).toHaveLength(4);
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

    // 意味記憶は language agent の system message (calls[0].messages[0]) に含まれる
    const languageSystem = llm.calls[0]!.messages[0]!.content;
    expect(languageSystem).toContain("夏目漱石");
    expect(languageSystem).toContain("覚えている事実");
  });

  it("updates inner state after introspection and persists to session", async () => {
    const llm = new FakeLlmClient([
      lang("返答"),
      "内省本文",
      '{"tags":["会話"]}',
      "さっき二度言っちゃった、ちょっと恥ずかしい",
    ]);
    let savedAffect = "";
    const orch = new TurnOrchestrator(
      "対話",
      baseTurnDeps({
        llm,
        workingMemory: new WorkingMemory(20),
        initialAffect: "",
        onSessionPersist: async (s) => {
          savedAffect = s.affect;
        },
      }),
    );

    await orch.run({
      type: "user_message",
      content: "こんにちは",
      speakerId: "user_001",
    });

    expect(orch.getAffect()).toBe(
      "さっき二度言っちゃった、ちょっと恥ずかしい",
    );
    expect(savedAffect).toBe("さっき二度言っちゃった、ちょっと恥ずかしい");
    // affect は 4 番目の呼び出し (index 3)
    expect(llm.calls[3]!.messages[0].content).toContain("前の内心");
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

    // ターン1: 4 calls, ターン2: 4 calls = 合計 8 calls
    const llm = new FakeLlmClient([
      lang("返答1"), "直近の内省", '{"tags":["会話"]}', "内心1",
      lang("返答2"), "内省2", '{"tags":["会話"]}', "内心2",
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

    // ターン2の language system (calls[4]) に古い内省のみ含まれ、直近の内省は除外される
    const turn2LangSystem = llm.calls[4]!.messages[0].content;
    expect(turn2LangSystem).toContain("古い内省");
    expect(turn2LangSystem).not.toContain("直近の内省");
  });

  it("user_message のトリガー画像が image_feed として言語野に届く（周辺視野の注釈付き）", async () => {
    const llm = new FakeLlmClient([
      lang("いい写真だね"),
      "内省",
      '{"tags":["会話"]}',
      "嬉しい気分",
    ]);
    const orch = new TurnOrchestrator(
      "対話",
      baseTurnDeps({ llm, workingMemory: new WorkingMemory(20) }),
    );

    await orch.run({
      type: "user_message",
      content: "見て",
      speakerId: "user_001",
      images: ["BASE64FRAME"],
    });

    const langMsgs = llm.calls[0]!.messages;
    const lastUser = langMsgs[langMsgs.length - 1]!;
    expect(lastUser.role).toBe("user");
    expect(lastUser.images).toEqual(["BASE64FRAME"]);
    expect(lastUser.content).toContain("周辺視野");
  });

  it("トリガー画像はファイルセンサー(readFrames)より優先される", async () => {
    const llm = new FakeLlmClient([
      lang("返答"),
      "内省",
      '{"tags":[]}',
      "気分",
    ]);
    const orch = new TurnOrchestrator(
      "対話",
      baseTurnDeps({
        llm,
        workingMemory: new WorkingMemory(20),
        readFrames: () => ["SENSOR"],
      }),
    );

    await orch.run({
      type: "user_message",
      content: "x",
      speakerId: "user_001",
      images: ["TRIGGER"],
    });

    const msgs = llm.calls[0]!.messages;
    const last = msgs[msgs.length - 1]!;
    expect(last.images).toEqual(["TRIGGER"]);
  });

  it("自発 distill: 静穏 idle ハートビートで runDistill を呼ぶ", async () => {
    const llm = new FakeLlmClient([lang("", "静穏")]); // idle heartbeat = 1 call
    let distillCalls = 0;
    const orch = new TurnOrchestrator(
      "静穏",
      baseTurnDeps({
        llm,
        workingMemory: new WorkingMemory(20),
        runDistill: async () => {
          distillCalls++;
          return { ran: false, factsUpserted: 0, skippedReason: "test" };
        },
      }),
    );

    await orch.run({ type: "heartbeat" });

    expect(distillCalls).toBe(1);
  });

  it("自発 distill: user_message では呼ばない", async () => {
    const llm = new FakeLlmClient([lang("返答"), "内省", '{"tags":[]}', "気分"]);
    let distillCalls = 0;
    const orch = new TurnOrchestrator(
      "静穏",
      baseTurnDeps({
        llm,
        workingMemory: new WorkingMemory(20),
        runDistill: async () => {
          distillCalls++;
          return { ran: false, factsUpserted: 0 };
        },
      }),
    );

    await orch.run({ type: "user_message", content: "やあ", speakerId: "u1" });

    expect(distillCalls).toBe(0);
  });

  it("自発 distill: 集中ハートビート（focusSteps あり）では呼ばない", async () => {
    // 新設計では state は観測導出: heartbeat で focusSteps があれば集中（＝静穏でない）。
    const llm = new FakeLlmClient([lang("")]);
    let distillCalls = 0;
    const orch = new TurnOrchestrator(
      "集中",
      baseTurnDeps({
        llm,
        workingMemory: new WorkingMemory(20),
        initialFocusSteps: "dummy-steps",
        runDistill: async () => {
          distillCalls++;
          return { ran: false, factsUpserted: 0 };
        },
      }),
    );

    await orch.run({ type: "heartbeat" });

    expect(distillCalls).toBe(0);
  });

  // --- 集中 State の機械導出・focusStreak・強制ギプス（MAX_FOCUS_STREAK） ---
  // State は言語野の宣言でなく観測事実から導出（turn.ts §State 遷移）。

  it("T-FS01: user_message は focusSteps があっても 対話 に割り込む（集中の中断）", async () => {
    const llm = new FakeLlmClient([lang("はーい"), "内省", '{"tags":[]}', "気分"]);
    let persisted: { state: string; focusSteps: string } | null = null;
    const orch = new TurnOrchestrator(
      "集中",
      baseTurnDeps({
        llm,
        workingMemory: new WorkingMemory(20),
        initialFocusSteps: "dummy-steps",
        initialFocusStreak: 3,
        onSessionPersist: async (s) => {
          persisted = { state: s.state, focusSteps: s.focusSteps };
        },
      }),
    );

    const result = await orch.run({ type: "user_message", content: "やあ", speakerId: "u1" });

    expect(result.nextState).toBe("対話");
    // 中断であって放棄ではない＝focusSteps は保持（次の heartbeat で集中へ戻れる sticky）
    expect(persisted!.focusSteps).toBe("dummy-steps");
  });

  it("T-FS02: heartbeat + focusSteps あり → 集中、focusStreak が加算される", async () => {
    const llm = new FakeLlmClient([lang("")]); // idle heartbeat = 1 call
    let persistedStreak = -1;
    const orch = new TurnOrchestrator(
      "集中",
      baseTurnDeps({
        llm,
        workingMemory: new WorkingMemory(20),
        initialFocusSteps: "dummy-steps",
        initialFocusStreak: 0,
        onSessionPersist: async (s) => {
          persistedStreak = s.focusStreak;
        },
      }),
    );

    const result = await orch.run({ type: "heartbeat" });

    expect(result.nextState).toBe("集中");
    expect(persistedStreak).toBe(1);
  });

  it("T-FS03: heartbeat + focusSteps なし → 静穏、focusStreak は 0 に戻る", async () => {
    const llm = new FakeLlmClient([lang("")]);
    let persistedStreak = -1;
    const orch = new TurnOrchestrator(
      "集中",
      baseTurnDeps({
        llm,
        workingMemory: new WorkingMemory(20),
        initialFocusSteps: "",
        initialFocusStreak: 5,
        onSessionPersist: async (s) => {
          persistedStreak = s.focusStreak;
        },
      }),
    );

    const result = await orch.run({ type: "heartbeat" });

    expect(result.nextState).toBe("静穏");
    expect(persistedStreak).toBe(0);
  });

  it("T-FS04: focusStreak が MAX_FOCUS_STREAK(=10) に達したら強制ギプスで focusSteps を手放し 静穏へ", async () => {
    const llm = new FakeLlmClient([lang("")]);
    let persisted: { state: string; focusSteps: string } | null = null;
    const orch = new TurnOrchestrator(
      "集中",
      baseTurnDeps({
        llm,
        workingMemory: new WorkingMemory(20),
        initialFocusSteps: "dummy-steps",
        initialFocusStreak: 10, // MAX 到達
        onSessionPersist: async (s) => {
          persisted = { state: s.state, focusSteps: s.focusSteps };
        },
      }),
    );

    const result = await orch.run({ type: "heartbeat" });

    expect(persisted!.focusSteps).toBe(""); // ギプスで手放す
    expect(result.nextState).toBe("静穏"); // focusSteps が無くなったので静穏へ
  });

  // --- 口の効果器（OutputChannel）= 発話を即 push・反省より前 ---

  it("T-OC01: outputChannel に発話を即 push し、内省/affect より前に呼ばれる", async () => {
    const llm = new FakeLlmClient([lang("返答です"), "内省", '{"tags":[]}', "新しい気分"]);
    let sayArgs: { speech: string | null; artifacts: string[] } | null = null;
    let affectAtSay = "?";
    const orch = new TurnOrchestrator(
      "対話",
      baseTurnDeps({
        llm,
        workingMemory: new WorkingMemory(20),
        initialAffect: "古い気分",
        outputChannel: {
          say: async (speech, artifacts) => {
            sayArgs = { speech, artifacts };
            affectAtSay = orch.getAffect(); // say 時点の affect
          },
        },
      }),
    );

    await orch.run({ type: "user_message", content: "やあ", speakerId: "u1" });

    expect(sayArgs).toEqual({ speech: "返答です", artifacts: [] });
    expect(affectAtSay).toBe("古い気分"); // say 時点で affect 未更新＝反省より前に push された
    expect(orch.getAffect()).toBe("新しい気分"); // 反省は say の後に走り affect を更新
  });

  it("T-OC02: idle heartbeat（発話も成果物も無い）では say を呼ばない", async () => {
    const llm = new FakeLlmClient([lang("", "静穏")]);
    let called = false;
    const orch = new TurnOrchestrator(
      "静穏",
      baseTurnDeps({
        llm,
        workingMemory: new WorkingMemory(20),
        outputChannel: { say: async () => { called = true; } },
      }),
    );

    await orch.run({ type: "heartbeat" });

    expect(called).toBe(false);
  });

  it("符号化ロンダリング対策: 裏打ち事実(groundedFacts)に相手発話を機械記録し、本文は内省のまま", async () => {
    const llm = new FakeLlmClient([lang("返答"), "内省テキスト", '{"tags":[]}', "気分"]);
    const episodes = new InMemoryEpisodeStore();
    const orch = new TurnOrchestrator(
      "対話",
      baseTurnDeps({ llm, episodes, workingMemory: new WorkingMemory(20) }),
    );

    await orch.run({ type: "user_message", content: "やっほー", speakerId: "user_001" });

    const ep = episodes.getAll()[0]!;
    // 事実記録には相手発話が入る（埋め込まないメタ）
    expect(ep.metadata.groundedFacts).toContain("やっほー");
    // 本文(body)は内省のまま＝想起は無傷
    expect(ep.body).toBe("内省テキスト");
  });
});

// focusSteps 遷移の集約（resolveFocusAfterActions ＋ setFocusSteps）を orchestrator 経由で確認する。
// dispatcher none / 完了畳み は実 steps ファイルが要るので STEPS_DIR を temp に隔離する。
describe("TurnOrchestrator — focusSteps 遷移（STEPS_DIR 隔離）", () => {
  let tmpRoot: string;
  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), "turn-focus-"));
    process.env.STEPS_DIR = path.join(tmpRoot, "steps");
    process.env.MEMO_NOTES_DIR = path.join(tmpRoot, "notes");
  });
  afterEach(async () => {
    delete process.env.STEPS_DIR;
    delete process.env.MEMO_NOTES_DIR;
    await rm(tmpRoot, { recursive: true, force: true });
  });

  function stepsFixture(over: Partial<StepsState> = {}): StepsState {
    return {
      id: "p",
      title: "t",
      goal: "g",
      milestones: [{ id: "m1", text: "やること", done: false }],
      current: "m1",
      log: [],
      createdAt: "2026-06-19",
      updatedAt: "2026-06-19",
      ...over,
    };
  }

  it("実行順序: memo は webSearch の後に走り、op プロンプトに検索の実結果が載る（転記元のグラウンディング）", async () => {
    const llm = new FakeLlmClient([
      // multi-label activator: memo と webSearch が同時起動（「調べてメモして」）
      JSON.stringify({
        memo: { active: true, intent: "調べた結果を控える" },
        webSearch: { active: true, intent: "Stack-chan を調べる" },
      }),
      // webSearch（wave1）: pick1=web_search 実行 → pick2=done で締める（executor は2段・done は必須）
      JSON.stringify({ done: false, tool: "web_search", arguments: { query: "Stack-chan" } }),
      JSON.stringify({ done: true, reason: "十分な結果が得られた" }),
      // memo（wave2）: 検索の実結果を見た上で op を出す
      JSON.stringify({ op: "noop" }),
      lang("調べて控えたよ"),
      "内省",
      '{"tags":[]}',
      '{"affect":"","concern":"","importance":5}',
    ]);
    const mcp = new FakeMcpToolProvider();
    const orch = new TurnOrchestrator(
      "対話",
      baseTurnDeps({
        llm,
        workingMemory: new WorkingMemory(20),
        resolveForState: () => ({
          enabledActors: ["memo", "webSearch"],
          episodeRecallTopK: 3,
        }),
        actionDeps: { mcp, toolCatalog: await buildToolCatalog(mcp) },
      }),
    );

    await orch.run({
      type: "user_message",
      content: "Stack-chan がどんなものか調べてメモしといて",
      speakerId: "u1",
    });

    // 4番目の LLM 呼び出し＝memo の op 段。webSearch（pick×2）が先に済んでいるので実結果が載る
    const memoOpPrompt = llm.calls[3]!.messages[1]!.content;
    expect(memoOpPrompt).toContain("実際にやったこと");
    expect(memoOpPrompt).toContain("検索結果（fake）: Stack-chan");
  });

  it("完了畳み: 全✓済みの段取りに焦点が残っていたら手放す（停滞カウントも 0 に新規化）", async () => {
    // current=null＝dispatcher を起こさない（LLM は language のみ）。全 milestone done で alreadyDone 畳み。
    await saveSteps(
      stepsFixture({ milestones: [{ id: "m1", text: "やること", done: true }], current: null }),
    );
    const llm = new FakeLlmClient([lang("")]); // idle heartbeat
    let persisted: { state: string; focusSteps: string; focusStall: number } | null = null;
    const orch = new TurnOrchestrator(
      "集中",
      baseTurnDeps({
        llm,
        workingMemory: new WorkingMemory(20),
        initialFocusSteps: "p",
        initialFocusStall: 4,
        onSessionPersist: async (s) => {
          persisted = { state: s.state, focusSteps: s.focusSteps, focusStall: s.focusStall };
        },
      }),
    );

    const result = await orch.run({ type: "heartbeat" });

    expect(persisted!.focusSteps).toBe(""); // 畳んで手放す
    expect(persisted!.focusStall).toBe(0); // setFocusSteps が停滞カウントを新規化
    expect(result.nextState).toBe("静穏");
    expect(llm.calls).toHaveLength(1); // dispatcher も processor も呼ばれない
  });

  it("dispatcher none: current をどの手でもできないと段取りを集中から外す（入口で塞ぐ・停滞 0）", async () => {
    await saveSteps(stepsFixture()); // current=m1（未完）→ dispatcher を起こす
    const llm = new FakeLlmClient([
      JSON.stringify({ hand: "none", intent: "" }), // dispatcher → none
      lang(""), // language（idle）
    ]);
    let persisted: { state: string; focusSteps: string; focusStall: number } | null = null;
    const orch = new TurnOrchestrator(
      "集中",
      baseTurnDeps({
        llm,
        workingMemory: new WorkingMemory(20),
        initialFocusSteps: "p",
        initialFocusStall: 2,
        resolveForState: () => ({ enabledActors: ["synthesize"], episodeRecallTopK: 3 }),
        onSessionPersist: async (s) => {
          persisted = { state: s.state, focusSteps: s.focusSteps, focusStall: s.focusStall };
        },
      }),
    );

    const result = await orch.run({ type: "heartbeat" });

    expect(persisted!.focusSteps).toBe(""); // none → shelve（手放す）
    expect(persisted!.focusStall).toBe(0);
    expect(result.nextState).toBe("静穏");
    expect(llm.calls).toHaveLength(2); // dispatcher + language（doer は走らない）
  });

  it("full-cycle: dispatcher→synthesize→受け入れ判定→前進→全✓で完了畳み（2ターン通し）", async () => {
    await saveSteps(
      stepsFixture({
        goal: "短い文章を仕上げる",
        milestones: [
          { id: "m1", text: "書き出しを書く", done: false },
          { id: "m2", text: "締めを書く", done: false },
        ],
        current: "m1",
      }),
    );
    // ターン1: dispatcher が synthesize を選ぶ → 一片生成 → 判定 m1=済/m2=未 → current 前進
    const llm = new FakeLlmClient([
      JSON.stringify({ hand: "synthesize", intent: "書き出しを書く" }), // dispatcher
      "はじめの一片。", // synthesize 生成
      JSON.stringify({ satisfied: true }), // 受け入れ判定 m1
      JSON.stringify({ satisfied: false }), // 受け入れ判定 m2（まだ）
      lang(""), // language（独り作業・無言）
      "内省1", // 行動が成功したので内省は永続化される
      '{"tags":[]}',
      '{"affect":"","concern":"","importance":5}',
      // ターン2: 締めを書く → m2 も済 → 全✓ → 完了畳み
      JSON.stringify({ hand: "synthesize", intent: "締めを書く" }),
      "締めの一片。",
      JSON.stringify({ satisfied: true }), // m2 → allDone
      lang(""),
      "内省2",
      '{"tags":[]}',
      '{"affect":"","concern":"","importance":5}',
    ]);
    const persisted: { state: string; focusSteps: string }[] = [];
    const orch = new TurnOrchestrator(
      "集中",
      baseTurnDeps({
        llm,
        workingMemory: new WorkingMemory(20),
        initialFocusSteps: "p",
        resolveForState: () => ({ enabledActors: ["synthesize"], episodeRecallTopK: 3 }),
        onSessionPersist: async (s) => {
          persisted.push({ state: s.state, focusSteps: s.focusSteps });
        },
      }),
    );

    const r1 = await orch.run({ type: "heartbeat" });
    expect(r1.nextState).toBe("集中"); // m2 が残っている＝焦点保持
    const afterTurn1 = await loadSteps("p");
    expect(afterTurn1?.milestones.find((m) => m.id === "m1")?.done).toBe(true);
    expect(afterTurn1?.milestones.find((m) => m.id === "m2")?.done).toBe(false);
    expect(afterTurn1?.current).toBe("m2"); // 受け入れ判定が current を前進させた
    expect(await readNoteContent("works/p.md")).toContain("はじめの一片。");

    const r2 = await orch.run({ type: "heartbeat" });
    expect(r2.nextState).toBe("静穏"); // 全✓ → 完了畳みで焦点を手放す
    expect(persisted.at(-1)!.focusSteps).toBe("");
    const afterTurn2 = await loadSteps("p");
    expect(afterTurn2?.milestones.every((m) => m.done)).toBe(true);
    expect(afterTurn2?.log.some((l) => l.text.includes("達成"))).toBe(true); // 達成ログ
    expect(await readNoteContent("works/p.md")).toContain("締めの一片。");
  });

  it("degrade: 集中の doer がクラッシュしてもターンは死なず、current は前進しない（正直）", async () => {
    await saveSteps(stepsFixture()); // m1 未完・current=m1
    const llm = new FakeLlmClient([
      JSON.stringify({ hand: "synthesize", intent: "書く" }), // dispatcher
      JSON.stringify({ satisfied: false }), // 受け入れ判定（失敗した手を見て進めない）
      lang(""), // language（失敗のみ・無言 → 内省は永続化されない）
    ]);
    let persisted: { focusSteps: string } | null = null;
    const orch = new TurnOrchestrator(
      "集中",
      baseTurnDeps({
        llm,
        workingMemory: new WorkingMemory(20),
        initialFocusSteps: "p",
        resolveForState: () => ({ enabledActors: ["synthesize"], episodeRecallTopK: 3 }),
        // doer の LLM を空キューにして throw させる（Ollama 落ちの代役）
        actorLlm: { synthesize: new FakeLlmClient([]) },
        onSessionPersist: async (s) => {
          persisted = { focusSteps: s.focusSteps };
        },
      }),
    );

    const result = await orch.run({ type: "heartbeat" });

    expect(result.nextState).toBe("集中"); // ターンは生きて焦点も保持
    expect(persisted!.focusSteps).toBe("p");
    const after = await loadSteps("p");
    expect(after?.milestones[0]?.done).toBe(false); // 偽の前進を作らない
  });
});
