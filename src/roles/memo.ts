import { ACTION_ERROR_CODES, errorFromLlmAttempts } from "../action/error.js";
import {
  tryParseJsonWithSchema,
  type ParseJsonFailure,
} from "../action/parse-json.js";
import { actionFailed, actionSucceeded } from "../action/outcome.js";
import {
  lastUserMessageFromContext,
  type RunActionInput,
} from "../action/context.js";
import type { ActionOutcome } from "../types.js";
import { MEMO_OP_SYSTEM } from "../prompts/roles.js";
import { memoOpJsonSchema, memoOpSchema } from "../prompts/schemas.js";
import type { LlmClient } from "../llm/types.js";
import { applyMemoOp, type MemoOp } from "../memo/ops.js";
import { descendToTarget, recallRecognizeTarget } from "../memo/descent.js";
import { regenerateIndexChain, splitIfOversized } from "../memo/tree.js";
import {
  defaultNoteFilename,
  ensureMdExtension,
  readNoteContent,
  safeFilename,
  safePath,
  slugifyFilename,
  truncateNotePreview,
  writeNoteContent,
} from "../tools/notes.js";

function resolveFilename(raw?: string): string | null {
  if (!raw || !raw.trim()) return null;
  const withMd = ensureMdExtension(raw.trim());
  return safePath(withMd) ?? safeFilename(withMd) ?? slugifyFilename(withMd);
}

/** 本文に1始まりの行番号を付ける（op 段の提示用。replace_line/delete_line がこの番号で狙う） */
function numberLines(text: string): string {
  if (text === "") return "（空ファイル）";
  return text
    .split("\n")
    .map((line, i) => `${i + 1}\t${line}`)
    .join("\n");
}

/**
 * メモ読み書き統合 actor の本体。read を write に内包する（write は必ず read を伴う）。
 *  フェーズ1: 対象メモを locate（主=recall認識・フォールバック=連想ディセント）して全文ロード（read-before-edit）
 *  フェーズ2: 現在の全文＋意図を見て op を1つ出す → 純関数 applier で決定的に適用
 *  書き込み後: 親〜ルートの `_index.md`（MOC）を機械再生成し memo_index を upsert
 * 詳細は docs/MEMO-TREE.md。
 */
export async function runMemo(
  llm: LlmClient,
  input: RunActionInput,
): Promise<ActionOutcome> {
  const action = input.action;
  const intent = action.intent;
  const { currentDateTime } = input.ctx;
  const lastUserMessage = lastUserMessageFromContext(input.ctx);

  // --- フェーズ1: 対象メモを locate（無ければ null = 新規） ---
  // 主経路: recall 認識（memo_index の top-k 一覧を見て「意図の対象」を認識し、明確一致は必ず再利用）。
  //   台帳のように同じノートへ繰り返し戻る用途で頑健＝断片化を防ぐ。
  // フォールバック: recall で認識できなければ連想ディセント（木を降りる・browsing 的）。
  let target = input.memoIndex
    ? await recallRecognizeTarget(llm, input.memoIndex, intent)
    : null;
  if (!target) target = await descendToTarget(llm, intent);
  const current = target ? await readNoteContent(target) : null;

  // --- フェーズ2: op を1つ出す ---
  const opFormat = memoOpJsonSchema as Record<string, unknown>;
  const opAttempts: string[] = [];
  let lastParseFailure: ParseJsonFailure | undefined;
  let op: MemoOp | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await llm.chat(
      [
        { role: "system", content: MEMO_OP_SYSTEM },
        {
          role: "user",
          content: [
            `基準日時: ${currentDateTime}`,
            `意図: ${intent}`,
            lastUserMessage ? `相手があなたに言ったこと: ${lastUserMessage}` : "",
            "",
            target
              ? `候補メモ: ${target}（下が現在の全文。意図と別主題なら無視して create で新規にしてよい）`
              : "候補メモ: なし（新規に書くなら create で filename を付ける）",
            target
              ? "----- 候補の現在の全文（行番号付き。replace_line/delete_line はこの番号で狙う） -----"
              : "",
            target ? numberLines(current ?? "") : "",
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
      { format: opFormat, temperature: 0 },
    );
    opAttempts.push(raw);
    const parsed = tryParseJsonWithSchema(raw, memoOpSchema);
    if (parsed.ok) {
      op = parsed.value as MemoOp;
      break;
    }
    lastParseFailure = parsed.failure;
  }

  if (!op) {
    return actionFailed(
      action,
      "メモ操作を決められなかった",
      errorFromLlmAttempts(
        opAttempts,
        lastParseFailure?.reason,
        lastParseFailure?.zodMessage,
      ),
      "memo_write",
    );
  }

  // view: 参照のみ（書き込まない）
  if (op.op === "view") {
    if (!target || current === null) {
      return actionSucceeded(action, "読むべきメモが見つからなかった", "memo_read");
    }
    return actionSucceeded(action, {
      kind: "memo_read",
      filename: target,
      body: current,
    });
  }
  if (op.op === "noop") {
    return actionSucceeded(action, "メモは変更しなかった");
  }

  // 書き込み先と基準本文を op の意味で解決する。
  // create は descent 候補を無視して新規パスへ（衝突不能）。
  // ただし新規パスに既存があれば上書きせず append に倒す（データ保全）。
  let filename: string;
  let baseContent: string | null;
  let effectiveOp = op;
  if (op.op === "create") {
    filename = resolveFilename(op.filename) ?? target ?? defaultNoteFilename();
    baseContent = await readNoteContent(filename);
    if (baseContent !== null) effectiveOp = { ...op, op: "append" }; // 既存→追記に倒す
  } else {
    // append / replace / section_replace は descent 候補（全文ロード済み）を対象にする
    filename = target ?? resolveFilename(op.filename) ?? defaultNoteFilename();
    baseContent = target ? current : null;
  }

  // 境界: goals/ は plan の派生ビュー（plan 所有・renderPlan で機械再生成される）。
  // memo で書くと次の plan 更新で上書き消失し取り合いになる。書かずに plan の領分へ譲る。
  if (filename.startsWith("goals/")) {
    return actionSucceeded(
      action,
      "計画ノート（goals/）は plan の領分なので memo では書かなかった",
    );
  }

  const result = applyMemoOp(baseContent, effectiveOp);
  if (!result.ok) {
    return actionFailed(action, "メモ操作を適用できなかった", {
      code: ACTION_ERROR_CODES.INVALID_ARGS,
      message: result.reason,
    }, "memo_write");
  }
  if (result.nextContent === null) {
    return actionSucceeded(action, "メモは変更しなかった");
  }

  const written = await writeNoteContent(filename, result.nextContent);
  if (!written) {
    return actionFailed(action, "メモファイルへの書き込みに失敗した", {
      code: ACTION_ERROR_CODES.TOOL_FAILED,
      message: `writeNoteContent が失敗（filename: ${filename}）`,
    }, "memo_write");
  }

  // サイズ自動分割（予算超過なら見出し境界でフォルダ化）→ MOC 目次を機械再生成 → 所在 upsert
  const split = await splitIfOversized(written);
  const now = new Date().toISOString();
  if (split) {
    await regenerateIndexChain(split.children[0]);
    for (const child of split.children) {
      const body = (await readNoteContent(child)) ?? "";
      await input.memoIndex?.upsert({
        path: child,
        preview: truncateNotePreview(body, 200),
        createdAt: now,
        updatedAt: now,
      });
    }
  } else {
    await regenerateIndexChain(written);
    await input.memoIndex?.upsert({
      path: written,
      preview: truncateNotePreview(result.nextContent, 200),
      createdAt: now,
      updatedAt: now,
    });
  }

  return actionSucceeded(action, {
    kind: "memo_write",
    filename: written,
    body: result.nextContent,
  });
}
