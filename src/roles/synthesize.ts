import { ACTION_ERROR_CODES } from "../action/error.js";
import { actionFailed, actionSucceeded } from "../action/outcome.js";
import {
  lastUserMessageFromContext,
  type RunActionInput,
} from "../action/context.js";
import { memorySnapshot } from "../context/turn-context.js";
import type { ActionOutcome } from "../types.js";
import { SYNTHESIZE_SYSTEM } from "../prompts/roles.js";
import type { LlmClient } from "../llm/types.js";
import { applyMemoOp } from "../memo/ops.js";
import { regenerateIndexChain } from "../memo/tree.js";
import {
  readNoteContent,
  slugifyFilename,
  truncateNotePreview,
  writeNoteContent,
} from "../tools/notes.js";

/** 一片あたりの生成上限（成果物は複数ターンで継ぎ足すので、一度に書き切らせない） */
const SYNTHESIZE_NUM_PREDICT = 800;

/** 成果物ノートのパスを決める。取り組み中の計画があればその id に紐づけ、
 *  なければ意図からスラグを作る（いずれも works/ 配下に決定的に置く＝断片化を防ぐ） */
function resolveArtifactFilename(planId: string, intent: string): string {
  if (planId.trim()) return `works/${planId}.md`;
  return `works/${slugifyFilename(intent)}`;
}

/**
 * synthesize actor 本体。想起＋外部情報＋感性を統合して成果物に外化する「行動としての思考」。
 * memo（決まったことの転記・強制ギプス）と違い、ここは**生成が役割**の唯一のレーン。
 *  - 素材（想起エピソード・関連メモ所在・意味記憶・内心/関心事・計画）を全部のせて次の一片を生成
 *  - 成果物ノート（works/<id|slug>.md）へ append（無ければ create）。既存本文は破壊しない
 *  - 書き込み後に MOC を再生成し memo_index を upsert（成果物も recall できるように）
 * 詳細は docs/ACTION-DESIGN.md。
 */
export async function runSynthesize(
  llm: LlmClient,
  input: RunActionInput,
): Promise<ActionOutcome> {
  const action = input.action;
  const intent = action.intent;
  const { currentDateTime, planId } = input.ctx;
  const lastUserMessage = lastUserMessageFromContext(input.ctx);
  const snap = memorySnapshot(input.ctx);

  // 継ぎ足し先の現在の成果物（あれば末尾につながるよう生成させる）
  const filename = resolveArtifactFilename(planId, intent);
  const existing = await readNoteContent(filename);

  const materials = [
    `基準日時: ${currentDateTime}`,
    `意図（何を作る/まとめるか）: ${intent}`,
    lastUserMessage ? `相手があなたに言ったこと: ${lastUserMessage}` : "",
    snap.concern ? `\nいまの関心事: ${snap.concern}` : "",
    snap.affect ? `いまの内心: ${snap.affect}` : "",
    snap.plan ? `\n取り組み中の計画:\n${snap.plan}` : "",
    snap.recalledEpisodes.length
      ? `\n想起した記憶:\n${snap.recalledEpisodes.map((e) => `- ${e}`).join("\n")}`
      : "",
    snap.semanticFacts.length
      ? `\n知っていること:\n${snap.semanticFacts.map((f) => `- ${f}`).join("\n")}`
      : "",
    snap.recalledNotes.length
      ? `\n関連するメモ:\n${snap.recalledNotes.map((n) => `- ${n}`).join("\n")}`
      : "",
    existing
      ? `\n----- 現在の成果物（この続きを書く・繰り返さない） -----\n${existing}`
      : "\n（成果物はまだ無い。書き出しから作る）",
  ]
    .filter(Boolean)
    .join("\n");

  const generated = await llm.chat(
    [
      { role: "system", content: SYNTHESIZE_SYSTEM },
      { role: "user", content: materials },
    ],
    { temperature: 0.7, numPredict: SYNTHESIZE_NUM_PREDICT },
  );

  const chunk = generated.trim();
  if (!chunk) {
    return actionFailed(action, "成果物の一片を生成できなかった", {
      code: ACTION_ERROR_CODES.TOOL_FAILED,
      message: "synthesize の生成結果が空だった",
    });
  }

  // 既存があれば append、無ければ create（applyMemoOp で間隔整形・盲目上書き防止を共有）
  const result = applyMemoOp(
    existing,
    existing === null
      ? { op: "create", filename, content: chunk }
      : { op: "append", content: chunk },
  );
  if (!result.ok || result.nextContent === null) {
    return actionFailed(action, "成果物の書き込みを適用できなかった", {
      code: ACTION_ERROR_CODES.INVALID_ARGS,
      message: result.ok ? "nextContent が空" : result.reason,
    });
  }

  const written = await writeNoteContent(filename, result.nextContent);
  if (!written) {
    return actionFailed(action, "成果物ファイルへの書き込みに失敗した", {
      code: ACTION_ERROR_CODES.TOOL_FAILED,
      message: `writeNoteContent が失敗（filename: ${filename}）`,
    });
  }

  const now = new Date().toISOString();
  await regenerateIndexChain(written);
  await input.memoIndex?.upsert({
    path: written,
    preview: truncateNotePreview(result.nextContent, 200),
    createdAt: now,
    updatedAt: now,
  });

  // 言語野/内省にはこのターンで作った一片を見せる（全文ではなく、いま外化したもの）
  return actionSucceeded(action, {
    kind: "synthesize",
    filename: written,
    body: chunk,
  });
}
