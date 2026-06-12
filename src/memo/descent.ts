import type { LlmClient } from "../llm/types.js";
import { listChildren } from "./tree.js";
import { MEMO_DESCEND_SYSTEM } from "../prompts/roles.js";
import {
  memoReadPickJsonSchema,
  memoReadPickOutputSchema,
} from "../prompts/schemas.js";
import { tryParseJsonWithSchema } from "../action/parse-json.js";
import type { MemoIndexStore } from "../memory/memo-index.js";
import { readNoteContent } from "../tools/notes.js";

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
 * recall 加速の「フォールバック」合成（docs/MEMO-TREE.md §3）。
 * descent が行き止まった（どの枝も合わない）とき、memo_index のベクトル想起で葉へテレポートする。
 * 「迷子」（誤配置で永遠に辿り着けない）を救う安全網。
 * 誤テレポート（本来は新規作成すべきなのに無関係な葉に飛ぶ）を避けるため厳しい距離閾値で絞り、
 * 実在するファイルだけを返す。
 */
export async function recallFallbackTarget(
  memoIndex: MemoIndexStore,
  intent: string,
  maxDistance: number,
): Promise<string | null> {
  const hits = await memoIndex.recall(intent, 1);
  const top = hits[0];
  if (!top || top.distance > maxDistance) return null;
  const content = await readNoteContent(top.path);
  if (content === null) return null; // index は残っているがファイルが無い
  return top.path;
}
