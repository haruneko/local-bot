import { describe, expect, it } from "vitest";
import {
  buildActorContext,
  createTurnContext,
  memorySnapshot,
  renderLanguageUserContent,
  withAction,
} from "../src/context/turn-context.js";
import { fallbackRecalledEpisodes } from "../src/recall/distance.js";

const dialogue = {
  resolveUserDisplayName: () => "HAL",
};

describe("TurnContext", () => {
  it("puts partner utterance first and omits duplicate from prior dialogue", () => {
    const ctx = createTurnContext({
      turnId: "t1",
      state: "対話",
      trigger: {
        type: "user_message",
        content: "印象ある？",
        speakerId: "user_001",
      },
      dialogue,
      recentTurns: [
        { role: "assistant", content: "前の返答" },
        { role: "user", speakerId: "user_001", content: "印象ある？" },
      ],
      recalledEpisodes: fallbackRecalledEpisodes(["内省A", "内省B"]),
    });

    expect(ctx.partnerUtteranceLine).toBe("HAL: 印象ある？");
    const rendered = renderLanguageUserContent(ctx);
    expect(rendered.indexOf("HALの発話")).toBeLessThan(
      rendered.indexOf("直近の会話"),
    );
    expect(rendered).toContain("自分: 前の返答");
    expect(rendered).not.toMatch(/印象ある？\s*\n\nわたし: 前の返答/);
  });

  it("omits background recall after successful recall action", () => {
    const ctx = withAction(
      createTurnContext({
        turnId: "t2",
        state: "対話",
        trigger: {
          type: "user_message",
          content: "印象ある？",
          speakerId: "user_001",
        },
        dialogue,
        recentTurns: [
          { role: "user", speakerId: "user_001", content: "印象ある？" },
        ],
        recalledEpisodes: fallbackRecalledEpisodes(["内省のみ"]),
      }),
      {
        attempted: true,
        kind: "memory",
        intent: "印象",
        status: "succeeded",
        facts: { kind: "recall", bullets: ["髪を切りたい"] },
        summary: "- 髪を切りたい",
      },
    );

    expect(ctx.recallDelivery).toBe("omit");
    const rendered = renderLanguageUserContent(ctx);
    expect(rendered).not.toContain("背景の記憶");
    expect(rendered).toContain("髪を切りたい");
  });

  it("背景の記憶に発生時刻を [N日前] として前置きし、時刻基準の注記を出す", () => {
    const now = new Date("2026-06-13T12:00:00+09:00");
    const threeDaysAgo = new Date(now.getTime() - 3 * 86_400_000).toISOString();
    const ctx = createTurnContext({
      turnId: "t-when",
      state: "対話",
      trigger: { type: "user_message", content: "天気は？", speakerId: "user_001" },
      dialogue,
      recentTurns: [
        { role: "user", speakerId: "user_001", content: "天気は？" },
      ],
      recalledEpisodes: [
        {
          presented: "川口の明日は雨だが午後に晴れる",
          relevance: 0.9,
          presentation: "summarize",
          occurredAt: threeDaysAgo,
        },
      ],
      now,
    });

    const rendered = renderLanguageUserContent(ctx);
    expect(rendered).toContain("[3日前]");
    expect(rendered).toContain("いまの話とは限らない"); // 古い記憶を今の事実にしない注記
    // 前置きが本文の前に来る
    expect(rendered.indexOf("[3日前]")).toBeLessThan(
      rendered.indexOf("川口の明日は雨"),
    );
  });

  it("renders inner state in language input when non-empty", () => {
    const ctx = createTurnContext({
      turnId: "t-inner",
      state: "対話",
      trigger: {
        type: "user_message",
        content: "元気？",
        speakerId: "user_001",
      },
      dialogue,
      recentTurns: [
        { role: "user", speakerId: "user_001", content: "元気？" },
      ],
      recalledEpisodes: [],
      affect: "さっき少し恥ずかしかった",
    });

    const rendered = renderLanguageUserContent(ctx);
    expect(rendered).toContain("## いまの内心");
    expect(rendered).toContain("さっき少し恥ずかしかった");
    expect(rendered).toContain("温度の素");
  });

  it("omits inner state section when empty", () => {
    const ctx = createTurnContext({
      turnId: "t-empty-inner",
      state: "対話",
      trigger: {
        type: "user_message",
        content: "おはよう",
        speakerId: "user_001",
      },
      dialogue,
      recentTurns: [
        { role: "user", speakerId: "user_001", content: "おはよう" },
      ],
      recalledEpisodes: [],
      affect: "",
    });

    expect(renderLanguageUserContent(ctx)).not.toContain("## いまの内心");
  });

  it("includes affect in memory snapshot", () => {
    const ctx = createTurnContext({
      turnId: "t-snap-inner",
      state: "対話",
      trigger: {
        type: "user_message",
        content: "こんにちは",
        speakerId: "user_001",
      },
      dialogue,
      recentTurns: [
        { role: "user", speakerId: "user_001", content: "こんにちは" },
      ],
      recalledEpisodes: [],
      affect: "穏やか",
    });

    const snap = memorySnapshot(ctx);
    expect(snap.affect).toBe("穏やか");
  });

  it("memory snapshot and language share the same recalled episodes before action", () => {
    const ctx = createTurnContext({
      turnId: "t3",
      state: "対話",
      trigger: {
        type: "user_message",
        content: "こんにちは",
        speakerId: "user_001",
      },
      dialogue,
      recentTurns: [
        { role: "user", speakerId: "user_001", content: "こんにちは" },
      ],
      recalledEpisodes: fallbackRecalledEpisodes(["過去の内省全文"]),
    });

    const snap = memorySnapshot(ctx);
    const langBody = renderLanguageUserContent(ctx);

    expect(snap.recalledEpisodes).toEqual(["過去の内省全文"]);
    expect(langBody).toContain("1. 過去の内省全文");
    expect(langBody).not.toMatch(/過去の内省全文.{0,20}…/);
  });

  it("tags summarize; full has no tag in language render", () => {
    const ctx = createTurnContext({
      turnId: "t4",
      state: "対話",
      trigger: {
        type: "user_message",
        content: "ねえ",
        speakerId: "user_001",
      },
      dialogue,
      recentTurns: [
        { role: "user", speakerId: "user_001", content: "ねえ" },
      ],
      recalledEpisodes: [
        { presented: "なんとなく寂しい", relevance: 0.3, presentation: "full" },
        { presented: "昨日話した", relevance: 0.5, presentation: "summarize" },
      ],
    });

    const body = renderLanguageUserContent(ctx);
    expect(body).toContain("なんとなく寂しい");
    expect(body).not.toContain("（おぼろげ）");
    expect(body).toContain("（要約）昨日話した");
  });

  it("memory snapshot contains priorDialogue matching language render", () => {
    const ctx = createTurnContext({
      turnId: "t5",
      state: "対話",
      trigger: {
        type: "user_message",
        content: "ねえ",
        speakerId: "user_001",
      },
      dialogue,
      recentTurns: [
        { role: "assistant", content: "前の返答" },
        { role: "user", speakerId: "user_001", content: "ねえ" },
      ],
      recalledEpisodes: [],
    });

    const snap = memorySnapshot(ctx);
    const langBody = renderLanguageUserContent(ctx);

    expect(snap.priorDialogue).toContain("自分: 前の返答");
    expect(langBody).toContain(snap.priorDialogue);
  });

  it("recallDelivery omit clears recall in snapshot and language", () => {
    const ctx = withAction(
      createTurnContext({
        turnId: "t6",
        state: "対話",
        trigger: {
          type: "user_message",
          content: "思い出して",
          speakerId: "user_001",
        },
        dialogue,
        recentTurns: [
          { role: "user", speakerId: "user_001", content: "思い出して" },
        ],
        recalledEpisodes: fallbackRecalledEpisodes(["背景の内省"]),
      }),
      {
        attempted: true,
        kind: "memory",
        intent: "印象",
        status: "succeeded",
        facts: { kind: "recall", bullets: ["髪を切りたい"] },
        summary: "- 髪を切りたい",
      },
    );

    const snap = memorySnapshot(ctx);
    const langBody = renderLanguageUserContent(ctx);

    expect(ctx.recallDelivery).toBe("omit");
    expect(snap.recalledEpisodes).toEqual([]);
    expect(langBody).not.toContain("背景の記憶");
  });

  it("renders semantic facts in snapshot and language channels", () => {
    const ctx = createTurnContext({
      turnId: "t7",
      state: "対話",
      trigger: {
        type: "user_message",
        content: "好きな作家は？",
        speakerId: "user_001",
      },
      dialogue,
      recentTurns: [
        { role: "user", speakerId: "user_001", content: "好きな作家は？" },
      ],
      recalledEpisodes: [],
      semanticFacts: [
        { body: "ユーザーは夏目漱石を好む", relevance: 0.9 },
      ],
    });

    const snap = memorySnapshot(ctx);
    const langBody = renderLanguageUserContent(ctx);

    expect(snap.semanticFacts).toEqual(["ユーザーは夏目漱石を好む"]);
    expect(langBody).toContain("## 知っていること（意味記憶）");
    expect(langBody).toContain("1. ユーザーは夏目漱石を好む");
  });

  it("T-IS05: inner_state channel includes concern when non-empty", () => {
    const ctx = createTurnContext({
      turnId: "t-is05",
      state: "静穏",
      trigger: { type: "heartbeat" },
      dialogue,
      recentTurns: [],
      recalledEpisodes: [],
      affect: "少し落ち着いた気分",
      concern: "記憶アーキテクチャの実装方法",
    });

    const actorCtx = buildActorContext(ctx, ["inner_state"]);
    expect(actorCtx).toContain("記憶アーキテクチャの実装方法");
  });

  it("T-IS05: inner_state channel includes affect when non-empty", () => {
    const ctx = createTurnContext({
      turnId: "t-is05b",
      state: "静穏",
      trigger: { type: "heartbeat" },
      dialogue,
      recentTurns: [],
      recalledEpisodes: [],
      affect: "穏やかな気持ち",
      concern: "",
    });

    const actorCtx = buildActorContext(ctx, ["inner_state"]);
    expect(actorCtx).toContain("穏やかな気持ち");
  });
});
