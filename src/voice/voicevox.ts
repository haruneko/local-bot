/**
 * VOICEVOX ENGINE との通信。
 * POST /audio_query → POST /synthesis の2ステップで wav バイナリを得る。
 * fetch タイムアウト 5 秒（AbortController）。失敗は throw（呼び出し側が degrade）。
 */

const TIMEOUT_MS = 5000;

function withTimeout(): AbortSignal {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("VOICEVOX fetch timed out")), TIMEOUT_MS);
  // Node の AbortSignal にはリスナー追加が不要なので timer は leak させず abort 後に clear する
  ac.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  return ac.signal;
}

export async function synthesizeVoice(
  text: string,
  cfg: { host: string; speaker: number },
): Promise<Buffer> {
  const { host, speaker } = cfg;

  // ステップ1: audio_query
  const queryRes = await fetch(
    `${host}/audio_query?text=${encodeURIComponent(text)}&speaker=${speaker}`,
    { method: "POST", signal: withTimeout() },
  );
  if (!queryRes.ok) {
    throw new Error(
      `VOICEVOX audio_query failed: ${queryRes.status} ${queryRes.statusText}`,
    );
  }
  const audioQuery = await queryRes.json();

  // ステップ2: synthesis
  const synthRes = await fetch(
    `${host}/synthesis?speaker=${speaker}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(audioQuery),
      signal: withTimeout(),
    },
  );
  if (!synthRes.ok) {
    throw new Error(
      `VOICEVOX synthesis failed: ${synthRes.status} ${synthRes.statusText}`,
    );
  }
  const arrayBuffer = await synthRes.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
