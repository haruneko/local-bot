import { describe, expect, it } from "vitest";
import {
  createTurnContext,
  renderIntrospectionPrompt,
  withAction,
  withJudge,
  withSpeech,
} from "../src/context/turn-context.js";

const dialogue = {
  resolveUserDisplayName: (id: string) => id,
};

function introCtx(
  reply: boolean,
  speech: string | null,
  action: Parameters<typeof withAction>[1],
  options?: {
    trigger?: { type: "user_message"; content: string; speakerId: string };
    recentTurns?: Parameters<typeof createTurnContext>[0]["recentTurns"];
  },
) {
  let ctx = createTurnContext({
    turnId: "t-intro",
    state: "対話",
    now: new Date("2026-06-06T06:00:00.000Z"),
    trigger: options?.trigger ?? {
      type: "user_message",
      content: ".",
      speakerId: "u1",
    },
    dialogue,
    recentTurns: options?.recentTurns ?? [],
    recalledEpisodes: [],
  });
  ctx = withJudge(ctx, {
    ACTION: { kind: "none", intent: "" },
    REPLY: reply,
    NEXT_STATE: "対話",
  });
  ctx = withAction(ctx, action);
  if (speech !== null) {
    ctx = withSpeech(ctx, speech);
  }
  return renderIntrospectionPrompt(ctx);
}

describe("renderIntrospectionPrompt", () => {
  it("T-I01: REPLY=false uses silence line", () => {
    const prompt = introCtx(false, null, { attempted: false });
    expect(prompt).toMatch(/（状況: 対話 \/ .+）/);
    expect(prompt).toContain("【直近の会話】");
    expect(prompt).toContain("（返答はしなかった）");
    expect(prompt).not.toContain("【行動】");
  });

  it("T-I02: ACTION none omits action block", () => {
    const prompt = introCtx(true, "こんにちは", { attempted: false });
    expect(prompt).toContain("【直近の会話】");
    expect(prompt).toContain("【いま自分が言ったこと】");
    expect(prompt).toContain("こんにちは");
    expect(prompt).not.toContain("【行動】");
  });

  it("includes conversation history and separates partner utterance from own speech", () => {
    const prompt = introCtx(
      true,
      "今どんな感じ？一緒に話してみない？",
      { attempted: false },
      {
        trigger: {
          type: "user_message",
          content: "元気？",
          speakerId: "u1",
        },
        recentTurns: [
          { role: "user", speakerId: "u1", content: "こんにちは" },
          { role: "assistant", content: "こんにちは！" },
        ],
      },
    );
    expect(prompt).toContain("u1: 元気？");
    expect(prompt).toContain("自分: こんにちは！");
    expect(prompt).toContain("【いま自分が言ったこと】");
    expect(prompt).toContain("今どんな感じ？一緒に話してみない？");
    expect(prompt.indexOf("【直近の会話】")).toBeLessThan(
      prompt.indexOf("【いま自分が言ったこと】"),
    );
  });

  it("T-I03: succeeded action shows factual summary", () => {
    const prompt = introCtx(false, null, {
      attempted: true,
      kind: "memo_write",
      intent: "今日の予定をメモに",
      status: "succeeded",
      facts: { kind: "memo_write", filename: "予定.md", body: "買い物と会議" },
      summary: "data/notes/予定.md に書き込んだ:\n買い物と会議",
    });
    expect(prompt).toContain("【行動】");
    expect(prompt).toContain("（返答はしなかった）");
    expect(prompt).toContain("メモを書く");
    expect(prompt).toContain("今日の予定をメモに");
    expect(prompt).toContain("結果: できた");
    expect(prompt).toContain("内容:");
    expect(prompt).toContain("メモ（予定.md）に書き込んだ");
    expect(prompt).toContain("買い物と会議");
  });

  it("uses monologue speech even when REPLY is false", () => {
    const prompt = introCtx(false, "CONCEPT.md を読んだ。次は続きを", {
      attempted: true,
      kind: "memo_read",
      intent: "読む",
      status: "succeeded",
      facts: { kind: "memo_read", filename: "CONCEPT.md", body: "設計書" },
      summary: "data/notes/CONCEPT.md を読んだ:\n設計書",
    });
    expect(prompt).toContain("CONCEPT.md を読んだ。次は続きを");
    expect(prompt).not.toContain("（返答はしなかった）");
  });

  it("T-I04: failed action shows error detail", () => {
    const prompt = introCtx(true, "ごめんね", {
      attempted: true,
      kind: "remember",
      intent: "誕生日を覚える",
      status: "failed",
      summary:
        "覚える内容を生成できなかった\n原因コード: llm_parse_failed\n原因: JSON解釈失敗",
      error: {
        code: "llm_parse_failed",
        message: "JSON解釈失敗",
      },
    });
    expect(prompt).toContain("原因コード: llm_parse_failed");
    expect(prompt).toContain("結果: できなかった");
  });
});
