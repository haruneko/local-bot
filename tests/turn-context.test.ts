import { describe, expect, it } from "vitest";
import {
  createTurnContext,
  memorySnapshot,
  renderJudgeUserPayload,
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
      innerState: "さっき少し恥ずかしかった",
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
      innerState: "",
    });

    expect(renderLanguageUserContent(ctx)).not.toContain("## いまの内心");
  });

  it("includes innerState in judge memory snapshot", () => {
    const ctx = createTurnContext({
      turnId: "t-judge-inner",
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
      innerState: "穏やか",
    });

    const payload = renderJudgeUserPayload(ctx);
    expect(payload).toContain("innerState");
    expect(payload).toContain("穏やか");
  });

  it("judge and language share the same recalled episodes before action", () => {
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

    const judgePayload = JSON.parse(renderJudgeUserPayload(ctx));
    const langBody = renderLanguageUserContent(ctx);
    const snap = memorySnapshot(ctx);

    expect(judgePayload.context.recalledEpisodes).toEqual([
      "過去の内省全文",
    ]);
    expect(snap.recalledEpisodes).toEqual(["過去の内省全文"]);
    expect(langBody).toContain("1. 過去の内省全文");
    expect(langBody).not.toMatch(/過去の内省全文.{0,20}…/);
  });

  it("tags vague and summarize in language render", () => {
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
        { presented: "なんとなく寂しい", relevance: 0.3, presentation: "vague" },
        { presented: "昨日話した", relevance: 0.5, presentation: "summarize" },
      ],
    });

    const body = renderLanguageUserContent(ctx);
    expect(body).toContain("（おぼろげ）なんとなく寂しい");
    expect(body).toContain("（要約）昨日話した");
  });

  it("judge and language share priorDialogue from memorySnapshot", () => {
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

    const judgePayload = JSON.parse(renderJudgeUserPayload(ctx));
    const langBody = renderLanguageUserContent(ctx);

    expect(judgePayload.context.priorDialogue).toBe(
      langBody.split("## 直近の会話\n")[1]?.split("\n##")[0]?.trim(),
    );
    expect(judgePayload.context.priorDialogue).toContain("自分: 前の返答");
  });

  it("recallDelivery omit clears recall in judge and language", () => {
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

    const judgePayload = JSON.parse(renderJudgeUserPayload(ctx));
    const langBody = renderLanguageUserContent(ctx);

    expect(ctx.recallDelivery).toBe("omit");
    expect(judgePayload.context.recalledEpisodes).toEqual([]);
    expect(langBody).not.toContain("背景の記憶");
  });

  it("renders semantic facts in judge and language channels", () => {
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

    const judgePayload = JSON.parse(renderJudgeUserPayload(ctx));
    const langBody = renderLanguageUserContent(ctx);
    const snap = memorySnapshot(ctx);

    expect(judgePayload.context.semanticFacts).toEqual([
      "ユーザーは夏目漱石を好む",
    ]);
    expect(snap.semanticFacts).toEqual(["ユーザーは夏目漱石を好む"]);
    expect(langBody).toContain("## 知っていること（意味記憶）");
    expect(langBody).toContain("1. ユーザーは夏目漱石を好む");
  });
});
