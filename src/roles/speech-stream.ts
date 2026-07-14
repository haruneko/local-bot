/**
 * 発話ストリーミングの純関数2つ。
 *
 * 言語野は grammar 強制の `{"speech":"..."}` JSON を吐く。ストリーミングでは
 *  (a) extractSpeechStream: LLM の生差分から speech フィールドのデコード済みテキストだけを抽出し、
 *  (b) splitSentences: それを文単位に切って、口（音声・表示）へ流す。
 *
 * ここが担うのは**提示専用**。正本は完了後の parseLanguageOutput(全文)（language-faculty.ts）。
 * この抽出はゆるくてよい（作業記憶・内省が読むのは確定した全文であって、この差分ではない）。
 */

/** 文境界となる記号。この直後で文を切る。 */
const SENTENCE_TERMINATORS = new Set(["。", "！", "？", "!", "?", "\n"]);
/** 文境界の直後にあれば前の文へ含める閉じ記号（かっこ・引用符）。 */
const TRAILING_CLOSERS = new Set(["」", "』", "）", ")", '"', "”"]);
/** これ未満の文字数の断片は次と結合する（TTS の細切れ防止）。 */
const MIN_SENTENCE_LEN = 6;

/**
 * LLM の生テキスト差分から、`{"speech":"..."}` の speech 値をデコードしながら incremental に yield する。
 *
 * - 先頭の空白・```json フェンスは読み飛ばす。
 * - `"speech"`（前後空白許容）→ `:` → 開始 `"` を探し、見つかったら中身を（エスケープを解いて）yield。
 * - 閉じ `"` に達したら以降（`}` 等）は無視。
 * - エスケープ列（`\"` `\\` `\/` `\n` `\t` `\r` `\uXXXX`）はチャンク境界で割れても内部バッファで持ち越して正しく解く。
 * - speech キーが最後まで現れなくてもエラーにしない（何も yield しない）。
 */
export async function* extractSpeechStream(
  deltas: AsyncIterable<string>,
): AsyncIterable<string> {
  // フェーズ: キー探し → 値の中身読み → 終了
  type Phase = "seekKey" | "inValue" | "done";
  let phase: Phase = "seekKey";
  // seekKey フェーズで走査しきれなかった残り（`"spee` のようにキーがチャンクで割れる）
  let keyBuf = "";
  // inValue フェーズで、エスケープ列が途中で割れたときの持ち越し（`\` や `\u12` 等）
  let escBuf = "";

  for await (const delta of deltas) {
    if (phase === "done") continue;

    if (phase === "seekKey") {
      keyBuf += delta;
      // "speech" <ws> : <ws> " を探す。開始 " の直後の位置を捉える。
      const m = keyBuf.match(/"speech"\s*:\s*"/);
      if (!m) {
        // まだ開始 " まで来ていない。次チャンクに持ち越すが、無限成長を防ぐため末尾のみ残す
        // （開始トークン `"speech":"` は高々十数文字。安全に末尾 32 文字を保持すれば割れを跨げる）。
        if (keyBuf.length > 64) keyBuf = keyBuf.slice(-32);
        continue;
      }
      phase = "inValue";
      // 開始 " の直後から値の中身が始まる
      const rest = keyBuf.slice(m.index! + m[0].length);
      keyBuf = "";
      const out = consumeValue(rest);
      if (out.text) yield out.text;
      escBuf = out.escBuf;
      if (out.closed) phase = "done";
      continue;
    }

    // phase === "inValue"
    const out = consumeValue(escBuf + delta);
    if (out.text) yield out.text;
    escBuf = out.escBuf;
    if (out.closed) phase = "done";
  }
}

/**
 * 値バッファ（JSON 文字列の中身。先頭は開始 " の直後）を走査し、
 * デコード済みテキスト・末尾で割れたエスケープ列の持ち越し・閉じ " に達したかを返す。
 */
function consumeValue(buf: string): {
  text: string;
  escBuf: string;
  closed: boolean;
} {
  let text = "";
  let i = 0;
  while (i < buf.length) {
    const ch = buf[i]!;
    if (ch === '"') {
      // 非エスケープの " ＝値の終わり
      return { text, escBuf: "", closed: true };
    }
    if (ch === "\\") {
      // エスケープ列。完結するだけの文字がまだ来ていなければ持ち越す。
      const next = buf[i + 1];
      if (next === undefined) {
        return { text, escBuf: buf.slice(i), closed: false };
      }
      if (next === "u") {
        // \uXXXX には計 6 文字必要
        if (i + 6 > buf.length) {
          return { text, escBuf: buf.slice(i), closed: false };
        }
        const hex = buf.slice(i + 2, i + 6);
        const code = Number.parseInt(hex, 16);
        text += Number.isNaN(code) ? "" : String.fromCharCode(code);
        i += 6;
        continue;
      }
      text += decodeSimpleEscape(next);
      i += 2;
      continue;
    }
    text += ch;
    i += 1;
  }
  return { text, escBuf: "", closed: false };
}

function decodeSimpleEscape(c: string): string {
  switch (c) {
    case "n":
      return "\n";
    case "t":
      return "\t";
    case "r":
      return "\r";
    case '"':
      return '"';
    case "\\":
      return "\\";
    case "/":
      return "/";
    case "b":
      return "\b";
    case "f":
      return "\f";
    default:
      // 未知のエスケープは文字そのままを残す（壊さない）
      return c;
  }
}

/**
 * テキスト差分を文単位に切って yield する。
 *
 * - 文境界: 。！？!?\n。境界直後の閉じ記号（」』））"）は前の文に含める。
 * - 短すぎる断片（MIN_SENTENCE_LEN 未満）は次と結合する（TTS の細切れ防止）。
 * - 連続空白・空文は捨てる。
 * - 入力終了時に残りを flush（末尾に句点が無くても出す）。
 */
export async function* splitSentences(
  chunks: AsyncIterable<string>,
): AsyncIterable<string> {
  let buf = "";
  // 直前に emit しきれず持ち越した（短すぎる）断片
  let carry = "";

  const emit = function* (raw: string): Generator<string> {
    const trimmed = raw.trim();
    // 空文は捨てる: 空白のみ／中身が境界・閉じ記号だけ（例: 先頭の「。。。」）＝実体ゼロ。
    const hasContent = [...trimmed].some(
      (c) => !SENTENCE_TERMINATORS.has(c) && !TRAILING_CLOSERS.has(c) && c.trim() !== "",
    );
    if (!hasContent) return;
    const combined = carry ? `${carry}${trimmed}` : trimmed;
    if (combined.length < MIN_SENTENCE_LEN) {
      // まだ短い → 次と結合するため持ち越す
      carry = combined;
      return;
    }
    carry = "";
    yield combined;
  };

  for await (const chunk of chunks) {
    buf += chunk;
    let start = 0;
    for (let i = 0; i < buf.length; i++) {
      if (!SENTENCE_TERMINATORS.has(buf[i]!)) continue;
      // 境界。直後の閉じ記号を巻き込む。
      let end = i + 1;
      while (end < buf.length && TRAILING_CLOSERS.has(buf[end]!)) end++;
      yield* emit(buf.slice(start, end));
      start = end;
      i = end - 1;
    }
    buf = buf.slice(start);
  }

  // flush: 残りバッファ＋持ち越し
  const tail = (carry + buf).trim();
  if (tail) yield tail;
}
