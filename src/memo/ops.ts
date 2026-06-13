/**
 * メモ本文に対する「小さな操作」。plan の op と同じく構造はコードが握り、LLM は op を1つ出すだけ。
 * Ollama structured output 向けに discriminated union でなく平坦にする（意味は applier が解釈）。
 *
 * 不変条件（DECISIONS / docs/MEMO-TREE.md）:
 * - 要約はしない。op は要約ではなく差分。
 * - replace / section_replace は **対象を読み込み厳密一致を確認してから**適用する（read-before-edit）。
 *   一致しなければ失敗（盲目改変しない）。
 */
export type MemoOp = {
  op:
    | "view"
    | "create"
    | "append"
    | "replace"
    | "section_replace"
    | "replace_line"
    | "delete_line"
    | "noop";
  /** create のとき新規パス。他の op では caller が pick 済みの対象を使う */
  filename?: string;
  /** create=初期本文 / append=追記分 / replace=置換後 / section_replace=見出し下の新本文 / replace_line=その行の新しい内容 */
  content?: string;
  /** replace: 置き換える既存の厳密な部分文字列 */
  old?: string;
  /** section_replace: 対象セクションの見出し行（例 "## サビ"） */
  heading?: string;
  /** replace_line / delete_line: 対象の行番号（1始まり。提示された番号付き本文の番号） */
  line?: number;
};

export type MemoApplyResult =
  | {
      ok: true;
      opKind: MemoOp["op"];
      /** 書き込む新本文。null = 書き込みなし（view / noop） */
      nextContent: string | null;
    }
  | { ok: false; reason: string };

/** 行が markdown 見出しなら見出しレベル（# の数）を返す。見出しでなければ 0 */
function headingLevel(line: string): number {
  const m = /^(#{1,6})\s/.exec(line);
  return m ? m[1].length : 0;
}

/**
 * 見出し行に一致するセクションの範囲 [start, end)（行インデックス）を返す。
 * セクションは「その見出し行の次の行」から「同じか浅いレベルの次の見出し or EOF」まで。
 * 見出し行が見つからなければ null。
 */
function findSection(
  lines: string[],
  heading: string,
): { headingLine: number; bodyStart: number; bodyEnd: number } | null {
  const target = heading.trim();
  const level = headingLevel(target);
  if (level === 0) return null;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== target) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      const lv = headingLevel(lines[j]);
      if (lv > 0 && lv <= level) {
        end = j;
        break;
      }
    }
    return { headingLine: i, bodyStart: i + 1, bodyEnd: end };
  }
  return null;
}

/** 厳密一致の出現回数を数える（重複適用を避けるため） */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/**
 * op を現在の本文に決定的に適用する純関数。LLM は一切呼ばない。
 * current: 既存本文（新規なら null）。
 * 戻り値の nextContent が null のときは「書き込みなし」（view / noop）。
 */
export function applyMemoOp(
  current: string | null,
  op: MemoOp,
): MemoApplyResult {
  switch (op.op) {
    case "noop":
      return { ok: true, opKind: "noop", nextContent: null };

    case "view":
      // 参照のみ。書き込まない（本文の提示は caller が行う）
      return { ok: true, opKind: "view", nextContent: null };

    case "create": {
      const content = (op.content ?? "").trim();
      if (!content) return { ok: false, reason: "create の本文が空" };
      if (current !== null) {
        // 既存を盲目上書きしない。既存があるなら append/replace を使うべき
        return { ok: false, reason: "create 対象に既存本文がある（上書き禁止）" };
      }
      return { ok: true, opKind: "create", nextContent: `${content}\n` };
    }

    case "append": {
      const content = (op.content ?? "").trim();
      if (!content) return { ok: false, reason: "append の本文が空" };
      if (current === null) {
        // 対象が無いなら create と同義に倒す（情報は失わない）
        return { ok: true, opKind: "create", nextContent: `${content}\n` };
      }
      const base = current.replace(/\s*$/, "");
      // リスト項目（- / * / + / 1.）の追記は1行間隔、散文は段落（空行）間隔。
      // 判定するのは LLM が今出した content の形だけ（既存 markdown はパースしない）。
      const isListItem = /^\s*([-*+]|\d+[.)])\s/.test(content);
      const sep = isListItem ? "\n" : "\n\n";
      return { ok: true, opKind: "append", nextContent: `${base}${sep}${content}\n` };
    }

    case "replace": {
      if (current === null) return { ok: false, reason: "replace 対象の本文が無い" };
      const old = op.old ?? "";
      if (!old) return { ok: false, reason: "replace の old が空" };
      const n = countOccurrences(current, old);
      if (n === 0) return { ok: false, reason: "replace の old が本文に一致しない" };
      if (n > 1) return { ok: false, reason: `replace の old が${n}箇所に一致（曖昧）` };
      const next = current.replace(old, op.content ?? "");
      return { ok: true, opKind: "replace", nextContent: next };
    }

    case "section_replace": {
      if (current === null) return { ok: false, reason: "section_replace 対象の本文が無い" };
      const heading = (op.heading ?? "").trim();
      if (!heading) return { ok: false, reason: "section_replace の heading が空" };
      const lines = current.split("\n");
      const sec = findSection(lines, heading);
      if (!sec) return { ok: false, reason: `見出し「${heading}」が本文に無い` };
      const body = (op.content ?? "").replace(/\s*$/, "");
      const newLines = [
        ...lines.slice(0, sec.bodyStart),
        ...(body ? [body, ""] : [""]),
        ...lines.slice(sec.bodyEnd),
      ];
      return {
        ok: true,
        opKind: "section_replace",
        nextContent: newLines.join("\n"),
      };
    }

    case "replace_line": {
      // 行番号で1行を差し替え（厳密 old 文字列を作らせない＝弱モデルでも堅い。提示は番号付き本文）
      if (current === null) return { ok: false, reason: "replace_line 対象の本文が無い" };
      const lines = current.split("\n");
      const idx = (op.line ?? 0) - 1; // 1始まり
      if (idx < 0 || idx >= lines.length) {
        return { ok: false, reason: `replace_line の行番号 ${op.line} が範囲外（1〜${lines.length}）` };
      }
      lines[idx] = op.content ?? "";
      return { ok: true, opKind: "replace_line", nextContent: lines.join("\n") };
    }

    case "delete_line": {
      // 行番号で1行を削除（項目1個の削除＝厳密一致 replace の脆さを回避）
      if (current === null) return { ok: false, reason: "delete_line 対象の本文が無い" };
      const lines = current.split("\n");
      const idx = (op.line ?? 0) - 1;
      if (idx < 0 || idx >= lines.length) {
        return { ok: false, reason: `delete_line の行番号 ${op.line} が範囲外（1〜${lines.length}）` };
      }
      lines.splice(idx, 1);
      return { ok: true, opKind: "delete_line", nextContent: lines.join("\n") };
    }
  }
}
