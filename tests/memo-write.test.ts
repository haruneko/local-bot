import { describe, expect, it } from "vitest";
import { runMemoWrite } from "../src/roles/memo-write.js";
import { FakeLlmClient } from "../src/llm/fake.js";
import { InMemoryEpisodeStore } from "../src/memory/episode.js";
import { InMemoryMemoIndexStore } from "../src/memory/memo-index.js";
import {
  createTurnContext,
  withJudge,
} from "../src/context/turn-context.js";

const dialogue = { resolveUserDisplayName: () => "HAL" };

function makeInput(memoIndex?: InMemoryMemoIndexStore) {
  const ctx = withJudge(
    createTurnContext({
      turnId: "turn-mw",
      state: "対話",
      trigger: { type: "user_message", content: "買い物リストを作って", speakerId: "u1" },
      dialogue,
      recentTurns: [],
      recalledEpisodes: [],
    }),
    { ACTION: { kind: "memo_write", intent: "買い物リスト" } as never, REPLY: true, NEXT_STATE: "対話" },
  );
  return {
    ctx,
    episodes: new InMemoryEpisodeStore(),
    episodeRecallTopK: 3,
    memoIndex,
  };
}

describe("runMemoWrite", () => {
  it("成功時に memoIndex へ upsert される", async () => {
    const choiceJson = JSON.stringify({
      content: "卵、牛乳、パン",
      filename: "買い物リスト.md",
    });
    const llm = new FakeLlmClient([choiceJson]);
    const memoIndex = new InMemoryMemoIndexStore();
    const outcome = await runMemoWrite(llm, makeInput(memoIndex));

    expect(outcome.attempted).toBe(true);
    if (outcome.attempted) {
      expect(outcome.status).toBe("succeeded");
    }

    const list = await memoIndex.list();
    expect(list).toHaveLength(1);
    expect(list[0].path).toBe("買い物リスト.md");
    expect(list[0].preview).toContain("卵");
  });

  it("LLM パース失敗時は memoIndex に追加されない", async () => {
    const llm = new FakeLlmClient(["invalid json", "invalid json"]);
    const memoIndex = new InMemoryMemoIndexStore();
    const outcome = await runMemoWrite(llm, makeInput(memoIndex));

    expect(outcome.attempted).toBe(true);
    if (outcome.attempted) {
      expect(outcome.status).toBe("failed");
    }

    const list = await memoIndex.list();
    expect(list).toHaveLength(0);
  });

  it("memoIndex が undefined でもクラッシュしない", async () => {
    const choiceJson = JSON.stringify({
      content: "テストメモ",
      filename: "test.md",
    });
    const llm = new FakeLlmClient([choiceJson]);
    await expect(runMemoWrite(llm, makeInput(undefined))).resolves.toBeDefined();
  });
});
