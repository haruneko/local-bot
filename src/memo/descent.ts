import type { LlmClient } from "../llm/types.js";
import { listChildren } from "./tree.js";
import { MEMO_DESCEND_SYSTEM, MEMO_RECALL_PICK_SYSTEM } from "../prompts/roles.js";
import {
  memoReadPickJsonSchema,
  memoReadPickOutputSchema,
} from "../prompts/schemas.js";
import { tryParseJsonWithSchema } from "../action/parse-json.js";
import type { MemoIndexStore } from "../memory/memo-index.js";
import { readNoteContent } from "../tools/notes.js";
import { lexicalRank } from "../recall/lexical.js";
import { reciprocalRankFusion } from "../recall/fuse.js";

/** 無限ループ防止。木がこれより深くなることは当面ない */
const MAX_DEPTH = 6;

/**
 * 連想ディセント: ルートからフォルダを選んで降り、葉メモに到達するまで辿る。
 * 各ホップで LLM が「ここにあるもの」から1つ選ぶ（連想）。到達した葉の相対パスを返す。
 * どこにも合わなければ null（＝新規作成すべき / ここには無い）。
 * 詳細は docs/MEMO-TREE.md（recall 加速・サイズ分割は後段で合成）。
 */
export async function descendToTarget(
  llm: LlmClient,
  intent: string,
): Promise<string | null> {
  let dir = "";
  const format = memoReadPickJsonSchema as Record<string, unknown>;

  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const { dirs, leaves } = await listChildren(dir);
    if (dirs.length === 0 && leaves.length === 0) return null;

    const options = [
      ...dirs.map((d) => `${d.path}/    （フォルダ：選ぶと中へ降りる）`),
      ...leaves.map(
        (l) =>
          `${l.path}${l.headings.length ? ` — ${l.headings.join(" / ")}` : ""}`,
      ),
    ].join("\n");

    let pick: string | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = await llm.chat(
        [
          { role: "system", content: MEMO_DESCEND_SYSTEM },
          {
            role: "user",
            content: [
              `意図: ${intent}`,
              `現在地: ${dir || "（ルート）"}`,
              "",
              "ここにあるもの:",
              options,
            ].join("\n"),
          },
        ],
        { format, temperature: 0 },
      );
      const parsed = tryParseJsonWithSchema(raw, memoReadPickOutputSchema);
      if (!parsed.ok) continue;
      pick = parsed.value.filename;
      break;
    }

    if (!pick) return null;
    if (leaves.some((l) => l.path === pick)) return pick; // 葉に到達
    const sub = dirs.find((d) => d.path === pick);
    if (sub) {
      dir = sub.path; // フォルダへ降りる
      continue;
    }
    return null; // 一覧に無いものを選んだ → 諦め（新規扱い）
  }
  return null;
}

/**
 * recall 認識（locate の**主経路**・docs/MEMO-TREE.md §3 / 台帳ユースケース）。
 * memo_index のベクトル想起で候補を top-k 出し、その**一覧を LLM に見せて「意図の対象」を認識**させる
 * （想起＝recall ではなく、見て選ぶ＝recognition）。木を盲目で降りる descent より、台帳のように
 * 同じノートへ繰り返し戻る用途で頑健（断片化を防ぐ）。明確に一致する候補があれば**必ず再利用**し、
 * 重複を作らない。明確な一致が無ければ null（→ descent フォールバック / 新規作成へ）。
 */
/** 字句チャンネルを混ぜるゲート。クエリとファイル名のバイグラム Dice がこれ超えで初めて融合する。
 *  低くすると topical/oblique クエリにノイズが混ざって vector を汚す（eval で実測・0.4 が安全点）。 */
const LEXICAL_MIN_DICE = 0.4;

export async function recallRecognizeTarget(
  llm: LlmClient,
  memoIndex: MemoIndexStore,
  intent: string,
  topK = 8,
): Promise<string | null> {
  // goals/ は plan 所有の派生ビュー＝memo の対象にしない（plan の領分・取り合い防止）。
  const notPlan = (p: string) => !p.startsWith("goals/");
  const vhits = (await memoIndex.recall(intent, topK)).filter((h) => notPlan(h.path));
  // hybrid: 「名前そのまま」クエリは意味ベクトルが弱いので字句一致（ファイル名）を RRF 融合する。
  // ただしゲート（強い字句一致のときだけ）で話題クエリへのノイズ注入を防ぐ（eval:retrieval で検証）。
  const all = (await memoIndex.list()).filter((e) => notPlan(e.path));
  const lexPaths = lexicalRank(
    intent,
    all.map((e) => ({ key: e.path, text: e.path })),
    LEXICAL_MIN_DICE,
  );
  let hits = vhits;
  if (lexPaths.length > 0) {
    const previewByPath = new Map(all.map((e) => [e.path, e.preview]));
    for (const h of vhits) previewByPath.set(h.path, h.preview);
    hits = reciprocalRankFusion([vhits.map((h) => h.path), lexPaths])
      .slice(0, topK)
      .map((f) => ({ path: f.turnId, preview: previewByPath.get(f.turnId) ?? "", distance: 0 }));
  }
  if (hits.length === 0) return null; // 候補ゼロ → LLM を呼ばない
  const list = hits.map((h) => `${h.path} — ${h.preview}`).join("\n");
  const format = memoReadPickJsonSchema as Record<string, unknown>;

  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await llm.chat(
      [
        { role: "system", content: MEMO_RECALL_PICK_SYSTEM },
        {
          role: "user",
          content: [
            `意図: ${intent}`,
            "",
            "既存メモ（ファイル名 — 冒頭抜粋）:",
            list,
          ].join("\n"),
        },
      ],
      { format, temperature: 0 },
    );
    const parsed = tryParseJsonWithSchema(raw, memoReadPickOutputSchema);
    if (!parsed.ok) continue;
    const f = parsed.value.filename;
    if (f && hits.some((h) => h.path === f)) {
      const content = await readNoteContent(f);
      if (content !== null) return f; // 実在確認（index は残るがファイルが消えた場合を弾く）
    }
    return null; // 明確な一致なし → descent / 新規へ
  }
  return null;
}
