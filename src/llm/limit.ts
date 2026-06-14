import pLimit, { type LimitFunction } from "p-limit";

// 全 LLM 呼び出し（chat / embed）は同じ Ollama サーバを叩くので、プロセス全体で
// 1 つの同時実行リミッタを共有する。毎ターン頭の活性化バーストでサーバを溢れさせ、
// undici のヘッダタイムアウト（送信時点から計測）を踏むのを防ぐ＝待ち行列を
// サーバ内でなく bot 内に持つ。クラウド client に差し替えても同じ runLimited を通せばよい。
// サーバ側の OLLAMA_NUM_PARALLEL と同じ値に揃えると、溢れさせずパイプを満杯にできる。

const DEFAULT_CONCURRENCY = 4;
let limit: LimitFunction = pLimit(DEFAULT_CONCURRENCY);

/** 起動時に同時実行上限を設定する（OLLAMA_NUM_PARALLEL と揃える） */
export function configureLlmConcurrency(n: number): void {
  limit = pLimit(Math.max(1, Math.floor(n)));
}

/** LLM 呼び出しを同時実行リミッタ越しに実行する */
export function runLimited<T>(fn: () => Promise<T>): Promise<T> {
  return limit(fn);
}

// 一過性（接続瞬断・サーバ過負荷・タイムアウト・レート制限）と判断できるエラー。
// これらは待てば直ることが多いので 1 回だけ再試行する（盛りすぎない）。
const TRANSIENT =
  /fetch failed|HEADERS_TIMEOUT|BODY_TIMEOUT|UND_ERR|ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up|EAI_AGAIN|\b(?:429|500|502|503|504)\b|overloaded|rate.?limit/i;

export function isTransientLlmError(err: unknown): boolean {
  if (!err) return false;
  const e = err as { message?: string; code?: string; cause?: { code?: string; message?: string } };
  const parts = [e.message, e.code, e.cause?.code, e.cause?.message, String(err)];
  return TRANSIENT.test(parts.filter(Boolean).join(" "));
}

/** 一過性エラーのみ短い間隔で再試行する素朴なリトライ（attempts=総試行回数） */
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
      if (i < attempts - 1 && isTransientLlmError(e)) {
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      throw e;
    }
  }
  throw last;
}
