import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runMemo } from "../src/roles/memo.js";
import { FakeLlmClient } from "../src/llm/fake.js";
import { InMemoryEpisodeStore } from "../src/memory/episode.js";
import { InMemoryMemoIndexStore } from "../src/memory/memo-index.js";
import { createTurnContext } from "../src/context/turn-context.js";
import { readNoteContent, writeNoteContent } from "../src/tools/notes.js";

const dialogue = { resolveUserDisplayName: () => "HAL" };

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "memo-"));
  process.env.MEMO_NOTES_DIR = dir;
});
afterEach(async () => {
  delete process.env.MEMO_NOTES_DIR;
  await rm(dir, { recursive: true, force: true });
});

function makeInput(intent: string, memoIndex?: InMemoryMemoIndexStore) {
  const ctx = createTurnContext({
    turnId: "turn-memo",
    state: "対話",
    trigger: { type: "user_message", content: "メモして", speakerId: "u1" },
    dialogue,
    recentTurns: [],
    recalledEpisodes: [],
  });
  return {
    ctx,
    action: { kind: "memory" as const, intent },
    episodes: new InMemoryEpisodeStore(),
    episodeRecallTopK: 3,
    memoIndex,
  };
}

describe("runMemo（統合 actor・recall認識＋descent）", () => {
  it("空ツリーでは descent をスキップし create で新規作成、_index と memoIndex を更新", async () => {
    const memoIndex = new InMemoryMemoIndexStore();
    // ツリーが空 → descent は LLM を呼ばない → op の1応答のみ
    const llm = new FakeLlmClient([
      JSON.stringify({ op: "create", filename: "買い物.md", content: "卵、牛乳" }),
    ]);
    const outcome = await runMemo(llm, makeInput("買い物リスト", memoIndex));
    expect(outcome.attempted && outcome.status).toBe("succeeded");
    expect(await readNoteContent("買い物.md")).toContain("卵");
    // 目次が機械生成される
    expect(await readNoteContent("_index.md")).toContain("[[買い物]]");
    // 所在インデックス
    expect((await memoIndex.list())[0].path).toBe("買い物.md");
  });

  it("ルート直下の葉を descent で選び view（書き込まない）", async () => {
    await writeNoteContent("note.md", "原文の中身");
    const llm = new FakeLlmClient([
      JSON.stringify({ filename: "note.md" }), // descent: 葉を選ぶ
      JSON.stringify({ op: "view" }),
    ]);
    const outcome = await runMemo(llm, makeInput("あのメモ読んで"));
    if (outcome.attempted && outcome.status === "succeeded") {
      expect(outcome.facts).toMatchObject({ kind: "memo_read", filename: "note.md", body: "原文の中身" });
    } else {
      throw new Error("expected success");
    }
  });

  it("フォルダ→葉と2段降りて replace、残りは保全", async () => {
    await writeNoteContent("lyrics/01-新曲.md", "Aメロは仮。サビは未定。");
    const llm = new FakeLlmClient([
      JSON.stringify({ filename: "lyrics" }), // descent: フォルダへ降りる
      JSON.stringify({ filename: "lyrics/01-新曲.md" }), // descent: 葉
      JSON.stringify({ op: "replace", old: "サビは未定。", content: "サビが決まった。" }),
    ]);
    const outcome = await runMemo(llm, makeInput("サビを書く"));
    expect(outcome.attempted && outcome.status).toBe("succeeded");
    const content = await readNoteContent("lyrics/01-新曲.md");
    expect(content).toContain("サビが決まった。");
    expect(content).toContain("Aメロは仮。"); // 保全
  });

  it("replace の old が一致しなければ失敗（盲目改変しない）", async () => {
    await writeNoteContent("note.md", "本文");
    const llm = new FakeLlmClient([
      JSON.stringify({ filename: "note.md" }),
      JSON.stringify({ op: "replace", old: "存在しない", content: "x" }),
    ]);
    const outcome = await runMemo(llm, makeInput("直して"));
    expect(outcome.attempted && outcome.status).toBe("failed");
    expect(await readNoteContent("note.md")).toBe("本文");
  });

  it("recall認識で既存の台帳ノートを再利用する（断片化させない）", async () => {
    await writeNoteContent("買い物リスト.md", "卵\n牛乳");
    // memo_index が既存ノートを候補に返す → recall認識が一覧から既存を認識
    const memoIndex = {
      upsert: async () => {},
      list: async () => [],
      recall: async () => [{ path: "買い物リスト.md", preview: "卵 牛乳", distance: 0.1 }],
    };
    const llm = new FakeLlmClient([
      JSON.stringify({ filename: "買い物リスト.md" }), // recall認識: 既存を再利用
      JSON.stringify({ op: "view" }),
    ]);
    const outcome = await runMemo(llm, { ...makeInput("買い物リストに何ある？"), memoIndex });
    if (outcome.attempted && outcome.status === "succeeded") {
      expect(outcome.facts).toMatchObject({ kind: "memo_read", filename: "買い物リスト.md" });
    } else {
      throw new Error("expected reuse of existing note");
    }
  });

  it("recall認識で明確一致が無ければ null→descent/新規へ（誤再利用しない）", async () => {
    // memo_index は無関係な候補を返す → recall認識は null → 木は空なので descent スキップ → create
    const memoIndex = {
      upsert: async () => {},
      list: async () => [],
      recall: async () => [{ path: "unrelated.md", preview: "別の話題", distance: 0.5 }],
    };
    const llm = new FakeLlmClient([
      JSON.stringify({ filename: null }), // recall認識: 明確一致なし
      JSON.stringify({ op: "create", filename: "新規.md", content: "新しい話題" }),
    ]);
    const outcome = await runMemo(llm, { ...makeInput("全く新しい話題"), memoIndex });
    expect(outcome.attempted && outcome.status).toBe("succeeded");
    expect(await readNoteContent("新規.md")).toContain("新しい話題");
  });

  it("大きな create は書き込み後に自動分割され、子が memoIndex に載る", async () => {
    process.env.MEMO_MAX_LEAF_BYTES = "200"; // 小さい予算で分割を誘発
    const memoIndex = new InMemoryMemoIndexStore();
    const body = ["## サビ", "さび".repeat(40), "## Aメロ", "えーめろ".repeat(40)].join("\n");
    const llm = new FakeLlmClient([
      JSON.stringify({ op: "create", filename: "歌.md", content: body }),
    ]);
    try {
      const outcome = await runMemo(llm, makeInput("新曲", memoIndex));
      expect(outcome.attempted && outcome.status).toBe("succeeded");
      // 元ファイルはフォルダ化（消えている）、子が複数
      expect(await readNoteContent("歌.md")).toBeNull();
      const paths = (await memoIndex.list()).map((e) => e.path);
      expect(paths.length).toBeGreaterThan(1);
      expect(paths.every((p) => p.startsWith("歌/"))).toBe(true);
    } finally {
      delete process.env.MEMO_MAX_LEAF_BYTES;
    }
  });

  it("descent が無関係な既存葉に当たっても、op=create は候補を無視して新規作成（衝突回避）", async () => {
    await writeNoteContent("既存の別メモ.md", "全然ちがう話題");
    const llm = new FakeLlmClient([
      JSON.stringify({ filename: "既存の別メモ.md" }), // descent が誤って既存を選ぶ
      // op は候補を見て別主題と判断し create で新規パスへ
      JSON.stringify({ op: "create", filename: "新曲メモ.md", content: "新しい曲のアイデア" }),
    ]);
    const outcome = await runMemo(llm, makeInput("新曲のメモを作る"));
    expect(outcome.attempted && outcome.status).toBe("succeeded"); // 衝突で落ちない
    expect(await readNoteContent("新曲メモ.md")).toContain("新しい曲のアイデア");
    expect(await readNoteContent("既存の別メモ.md")).toBe("全然ちがう話題"); // 既存は無傷
  });

  it("create 先に同名既存があれば上書きせず append に倒す（データ保全）", async () => {
    await writeNoteContent("ノート.md", "元の本文");
    const llm = new FakeLlmClient([
      JSON.stringify({ filename: null }), // descent null（新規のつもり）
      JSON.stringify({ op: "create", filename: "ノート.md", content: "追加分" }),
    ]);
    const outcome = await runMemo(llm, makeInput("ノートに何か"));
    expect(outcome.attempted && outcome.status).toBe("succeeded");
    const content = await readNoteContent("ノート.md");
    expect(content).toContain("元の本文"); // 上書きされない
    expect(content).toContain("追加分"); // 追記される
  });

  it("op のパース失敗時は失敗で返す", async () => {
    const llm = new FakeLlmClient(["not json", "not json"]);
    const outcome = await runMemo(llm, makeInput("何か"));
    expect(outcome.attempted && outcome.status).toBe("failed");
  });
});
