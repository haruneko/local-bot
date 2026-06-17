import { describe, expect, it } from "vitest";
import { formatWorkingMemoryDialogue } from "../src/context/dialogue.js";
import {
  createTurnContext,
  renderLanguageUserContent,
  withAction,
} from "../src/context/turn-context.js";
import { fallbackRecalledEpisodes } from "../src/recall/distance.js";
const dialogue = {
  resolveUserDisplayName: (id: string) =>
    id === "user_001" ? "HAL" : id,
};

describe("dialogue format", () => {
  it("uses display name and 自分 instead of assistant/user id", () => {
    const text = formatWorkingMemoryDialogue(
      [
        { role: "user", speakerId: "user_001", content: "こんにちは" },
        { role: "assistant", content: "やあ" },
      ],
      dialogue,
    );
    expect(text).toContain("HAL: こんにちは");
    expect(text).toContain("自分: やあ");
    expect(text).not.toContain("[assistant]");
    expect(text).not.toContain("user_001");
  });

  it("labels heartbeat monologue separately from user-facing speech", () => {
    const text = formatWorkingMemoryDialogue(
      [
        { role: "user", speakerId: "user_001", content: "メモ見て" },
        { role: "assistant", content: "どれを読む？" },
        {
          role: "assistant",
          channel: "monologue",
          content: "全部ざっと読もう",
        },
      ],
      dialogue,
    );
    expect(text).toContain("自分: どれを読む？");
    expect(text).toContain("自分（独り言）: 全部ざっと読もう");
  });

  it("renderLanguageUserContent uses heartbeat monologue layout", () => {
    const body = renderLanguageUserContent(
      createTurnContext({
        turnId: "t-hb",
        state: "対話",
        trigger: { type: "heartbeat" },
        dialogue,
        recentTurns: [
          {
            role: "user",
            speakerId: "user_001",
            content: "メモの中身を見て",
          },
          {
            role: "assistant",
            channel: "monologue",
            content: "一覧を返しただけだ",
          },
        ],
        recalledEpisodes: [],
      }),
    );
    expect(body).toContain("未完了の依頼");
    expect(body).toContain("HAL: メモの中身を見て");
    expect(body).toContain("直近の会話と独り言");
    expect(body).not.toContain("相手の発話（このターン）");
  });

  it("renderLanguageUserContent uses shared TurnContext layout", () => {
    const body = renderLanguageUserContent(
      createTurnContext({
        turnId: "t1",
        state: "対話",
        trigger: {
          type: "user_message",
          content: "今何時？",
          speakerId: "user_001",
        },
        dialogue,
        recentTurns: [
          { role: "user", speakerId: "user_001", content: "今何時？" },
        ],
        recalledEpisodes: fallbackRecalledEpisodes(["過去の内省"]),
      }),
    );
    expect(body).toContain("HALの発話（このターン）");
    expect(body).toContain("HAL: 今何時？");
    expect(body).toContain("このターンで起きたこと");
    expect(body).toContain("なんとなく思い出したこと");
    expect(body).not.toContain("## 誰が誰か");
  });

  it("includes action block for memo_write", () => {
    const body = renderLanguageUserContent(
      withAction(
        createTurnContext({
          turnId: "t2",
          state: "対話",
          trigger: {
            type: "user_message",
            content: "メモして",
            speakerId: "user_001",
          },
          dialogue,
          recentTurns: [
            { role: "user", speakerId: "user_001", content: "メモして" },
          ],
          recalledEpisodes: [],
        }),
        {
          attempted: true,
          kind: "memory",
          intent: "状況を書く",
          status: "succeeded",
          facts: { kind: "memo_write", filename: "状況.md", body: "眠くなった" },
          summary: "data/notes/状況.md に書き込んだ:\n眠くなった",
        },
      ),
    );
    expect(body).toContain("状況.md のメモに書き込んだ");
    expect(body).toContain("眠くなった");
  });
});
