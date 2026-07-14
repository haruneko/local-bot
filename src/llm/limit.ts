import pLimit, { type LimitFunction } from "p-limit";

// 全 LLM 呼び出し（chat / embed）は同じ Ollama サーバを叩くので、プロセス全体で
// 1 つの同時実行リミッタを共有する。毎ターン頭の活性化バーストでサーバを溢れさせ、
// undici のヘッダタイムアウト（送信時点から計測）を踏むのを防ぐ＝待ち行列を
// サーバ内でなく bot 内に持つ。クラウド client に差し替えても同じ runLimited を通せばよい。
// サーバ側の OLLAMA_NUM_PARALLEL と同じ値に揃えると、溢れさせずパイプを満杯にできる。

// 既定は保守的に 2（サーバの OLLAMA_NUM_PARALLEL 未設定でも溢れにくい）。
// サーバ側を上げたら settings.ollamaMaxConcurrency で揃えて引き上げる。
const DEFAULT_CONCURRENCY = 2;
let limit: LimitFunction = pLimit(DEFAULT_CONCURRENCY);

/** 起動時に同時実行上限を設定する（OLLAMA_NUM_PARALLEL と揃える） */
export function configureLlmConcurrency(n: number): void {
  limit = pLimit(Math.max(1, Math.floor(n)));
}

/** LLM 呼び出しを同時実行リミッタ越しに実行する */
export function runLimited<T>(fn: () => Promise<T>): Promise<T> {
  return limit(fn);
}

/**
 * ストリーミング LLM 呼び出しを同時実行リミッタ越しに実行する。
 * chat() と違い返るのが AsyncIterable なので、スロットは**反復が終わる**まで保持する
 * （正常終了・throw・早期 break のいずれでも finally で解放）。
 * p-limit は fn の Promise が settle するとスロットを返すので、
 * fn を「反復完了まで解決しない gate」にしてスロットを掴み続ける。
 */
export async function* runLimitedStream<T>(
  fn: () => AsyncIterable<T>,
): AsyncGenerator<T> {
  // fn は反復完了で解決する gate を返す＝その間 p-limit のスロットを占有し続ける
  let releaseSlot!: () => void;
  const slotHeld = new Promise<void>((resolve) => {
    releaseSlot = resolve;
  });
  // runLimited に「スロットを取れたら知らせる」ハンドシェイクを載せる
  let acquired!: () => void;
  const slotAcquired = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const limited = runLimited(() => {
    acquired();
    return slotHeld;
  });
  // runLimited の rejection（通常起きないが握りつぶさない）を伝播できるよう握っておく
  limited.catch(() => {});
  try {
    await slotAcquired;
    yield* fn();
  } finally {
    releaseSlot();
    await limited;
  }
}

// **速く失敗する**一過性エラー＝リトライして良い（接続瞬断・レート制限・5xx）。
// ヘッダ/ボディタイムアウト（数分かけて失敗）は除外する：リトライしても倍待つだけで、
// これは同時実行リミッタで「予防」する種類のもの。
const RETRIABLE =
  /fetch failed|ECONNREFUSED|ECONNRESET|EAI_AGAIN|socket hang up|\b(?:429|500|502|503|504)\b|overloaded|rate.?limit/i;
const SLOW_TIMEOUT = /HEADERS_TIMEOUT|BODY_TIMEOUT/i;

export function isRetriableLlmError(err: unknown): boolean {
  if (!err) return false;
  const e = err as { message?: string; code?: string; cause?: { code?: string; message?: string } };
  const text = [e.message, e.code, e.cause?.code, e.cause?.message, String(err)]
    .filter(Boolean)
    .join(" ");
  if (SLOW_TIMEOUT.test(text)) return false; // 5分タイムアウトはリトライしない
  return RETRIABLE.test(text);
}

/** 速く失敗する一過性エラーのみ短い間隔で再試行する素朴なリトライ（attempts=総試行回数） */
export async function withLlmRetry<T>(
  fn: () => Promise<T>,
  attempts = 2,
  delayMs = 800,
): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i < attempts - 1 && isRetriableLlmError(e)) {
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      throw e;
    }
  }
  throw last;
}
