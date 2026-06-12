import { describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import path from "node:path";
import { runMemoWrite } from "../src/roles/memo-write.js";
import { FakeLlmClient } from "../src/llm/fake.js";
import { InMemoryEpisodeStore } from "../src/memory/episode.js";
import { InMemoryMemoIndexStore } from "../src/memory/memo-index.js";
import { createTurnContext } from "../src/context/turn-context.js";
import { NOTES_DIR, readNoteContent } from "../src/tools/notes.js";

const dialogue = { resolveUserDisplayName: () => "HAL" };

function makeInput(memoIndex?: InMemoryMemoIndexStore) {
  const ctx = createTurnContext({
    turnId: "turn-mw",
    state: "対話",
    trigger: { type: "user_message", content: "買い物リストを作って", speakerId: "u1" },
    dialogue,
    recentTurns: [],
    recalledEpisodes: [],
  });
  return {
    ctx,
    action: { kind: "memory" as const, intent: "買い物リスト" },
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

  it("既存ファイルは上書きせず追記する（既存本文を失わない）", async () => {
    const fname = "__test-append__.md";
    const fpath = path.join(NOTES_DIR, fname);
    await rm(fpath, { force: true });
    try {
      // 1回目: 新規作成
      const llm1 = new FakeLlmClient([
        JSON.stringify({ content: "1行目の大事な原文", filename: fname }),
      ]);
      await runMemoWrite(llm1, makeInput());

      // 2回目: 同名へ。LLM が append:false と言っても、既存があるので上書きしない
      const llm2 = new FakeLlmClient([
        JSON.stringify({ content: "2行目の追記", filename: fname, append: false }),
      ]);
      await runMemoWrite(llm2, makeInput());

      const content = await readNoteContent(fname);
      expect(content).toContain("1行目の大事な原文"); // 既存が消えていない
      expect(content).toContain("2行目の追記"); // 追記もされている
    } finally {
      await rm(fpath, { force: true });
    }
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
