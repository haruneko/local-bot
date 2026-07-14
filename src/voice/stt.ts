/**
 * STT（Speech-to-Text）: Ollama の OpenAI 互換エンドポイントで wav を文字起こしする。
 *
 * - POST {host}/v1/chat/completions に input_audio メッセージを投げる。
 * - 音声フォーマットは 16kHz mono s16le wav（認識必須条件）。
 * - タイムアウト 60 秒（AbortController）。失敗は throw（呼び出し側が degrade）。
 * - 返り値は choices[0].message.content の trim。空なら空文字。
 *
 * DI: fetch を外から注入できる（テスト用）。
 */

const TIMEOUT_MS = 60_000;

export type TranscribeFetch = typeof fetch;

/**
 * wav バッファを文字起こしして文字列を返す。
 * @param wav    16kHz mono s16le wav のバッファ
 * @param cfg    Ollama ホスト URL とモデル名
 * @param _fetch テスト用 fetch 差し替え（省略時はグローバル fetch）
 */
export async function transcribe(
  wav: Buffer,
  cfg: { host: string; model: string },
  _fetch: TranscribeFetch = fetch,
): Promise<string> {
  const { host, model } = cfg;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("STT fetch timed out")), TIMEOUT_MS);
  ac.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });

  const b64 = wav.toString("base64");

  const body = {
    model,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "この音声を一字一句正確に文字起こしして。文字起こし結果だけを出力して。",
          },
          {
            type: "input_audio",
            input_audio: {
              data: b64,
              format: "wav",
            },
          },
        ],
      },
    ],
  };

  let res: Response;
  try {
    res = await _fetch(`${host}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } catch (err) {
    throw new Error(
      `STT リクエスト失敗: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`STT エンドポイントエラー: ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`);
  }

  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== "string") return "";
  return content.trim();
}
