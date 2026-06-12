import { describe, expect, it } from "vitest";
import {
  createTurnContext,
  withAction,
  withSpeech,
} from "../src/context/turn-context.js";
import { runIntrospection } from "../src/roles/introspection.js";
import { FakeLlmClient } from "../src/llm/fake.js";
import type { ChatMessage } from "../src/llm/types.js";

const dialogue = {
  resolveUserDisplayName: (id: string) => id,
};

/** runIntrospection を実行し、LLM へ渡された実メッセージ列を返す（実経路を検証） */
async function introMessages(
  speech: string | null,
  action: Parameters<typeof withAction>[1],
  options?: {
    trigger?: { type: "user_message"; content: string; speakerId: string };
    recentTurns?: Parameters<typeof createTurnContext>[0]["recentTurns"];
  },
): Promise<ChatMessage[]> {
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
  ctx = withAction(ctx, action);
  if (speech !== null) ctx = withSpeech(ctx, speech);

  const llm = new FakeLlmClient(['{"text":"内省本文","importance":5}']);
  await runIntrospection(llm, ctx);
  return llm.calls[0]!.messages;
}

const joinByRole = (msgs: ChatMessage[], role: ChatMessage["role"]) =>
  msgs.filter((m) => m.role === role).map((m) => m.content).join("\n");

describe("runIntrospection の入力（role 構造で自他を分離）", () => {
  it("相手=user / 自分=assistant に分離して渡す", async () => {
    const msgs = await introMessages("うん、5月だよね", { attempted: false }, {
      trigger: { type: "user_message", content: "覚えてくれた？", speakerId: "u1" },
      recentTurns: [
        { role: "user", speakerId: "u1", content: "誕生日は5月だよ" },
        { role: "assistant", content: "覚えておくね" },
      ],
    });
    const userText = joinByRole(msgs, "user");
    const asstText = joinByRole(msgs, "assistant");
    expect(userText).toContain("覚えてくれた？");
    expect(userText).toContain("誕生日は5月だよ");
    expect(asstText).toContain("うん、5月だよね");
    expect(asstText).toContain("覚えておくね");
    // 相手の発話が自分(assistant)側に混ざらない
    expect(asstText).not.toContain("覚えてくれた？");
  });

  it("speech 空 → 自分(assistant)側に「返答はしなかった」", async () => {
    const msgs = await introMessages(null, { attempted: false });
    expect(joinByRole(msgs, "assistant")).toContain("（返答はしなかった）");
  });

  it("行動なし → 行動ブロックを載せない", async () => {
    const msgs = await introMessages("こんにちは", { attempted: false });
    const all = msgs.map((m) => m.content).join("\n");
    expect(all).not.toContain("（行動）");
  });

  it("成功アクション → 「できた」と事実が自分側に載る", async () => {
    const msgs = await introMessages(null, {
      attempted: true,
      kind: "memory",
      intent: "今日の予定をメモに",
      status: "succeeded",
      facts: { kind: "memo_write", filename: "予定.md", body: "買い物と会議" },
      summary: "data/notes/予定.md に書き込んだ:\n買い物と会議",
    });
    const asst = joinByRole(msgs, "assistant");
    expect(asst).toContain("結果: できた");
    expect(asst).toContain("買い物と会議");
  });

  it("失敗アクション → 「できなかった」と原因コードが載る", async () => {
    const msgs = await introMessages("ごめんね", {
      attempted: true,
      kind: "memory",
      intent: "誕生日を覚える",
      status: "failed",
      summary: "覚える内容を生成できなかった",
      error: { code: "llm_parse_failed", message: "JSON解釈失敗" },
    });
    const asst = joinByRole(msgs, "assistant");
    expect(asst).toContain("結果: できなかった");
    expect(asst).toContain("原因コード: llm_parse_failed");
  });

  it("独り言の発話は REPLY=false でも自分側に載る", async () => {
    const msgs = await introMessages("CONCEPT.md を読んだ。次は続きを", {
      attempted: true,
      kind: "memory",
      intent: "読む",
      status: "succeeded",
      facts: { kind: "memo_read", filename: "CONCEPT.md", body: "設計書" },
      summary: "data/notes/CONCEPT.md を読んだ:\n設計書",
    });
    const asst = joinByRole(msgs, "assistant");
    expect(asst).toContain("CONCEPT.md を読んだ。次は続きを");
    expect(asst).not.toContain("（返答はしなかった）");
  });
});
