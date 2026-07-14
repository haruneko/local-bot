/**
 * STT 疎通確認スクリプト。
 *
 * VOICEVOX で「明日の天気は晴れらしいよ。散歩に行かない？」を
 * outputSamplingRate=16000, outputStereo=false で合成し、
 * transcribe に通して原文と一致するか（句読点の差は許容）を表示する。
 *
 * 使い方: npm run smoke:stt
 */

import { loadSettings, resolveVoiceSettings, resolveSttSettings } from "../src/config/settings.js";
import { transcribe } from "../src/voice/stt.js";

const ORIGINAL = "明日の天気は晴れらしいよ。散歩に行かない？";

const settings = await loadSettings();
const voiceCfg = resolveVoiceSettings(settings);
const sttCfg = resolveSttSettings(settings);

console.log("STT smoke");
console.log(`  voicevox host : ${voiceCfg.host}`);
console.log(`  stt host      : ${sttCfg.host}`);
console.log(`  stt model     : ${sttCfg.model}`);
console.log(`  original      : ${ORIGINAL}`);
console.log();

// 1. VOICEVOX で 16kHz mono wav を合成
let wav: Buffer;
try {
  process.stdout.write("synthesize (16kHz mono) ... ");
  wav = await synthesize16kMono(ORIGINAL, voiceCfg.host, voiceCfg.speaker);
  console.log(`OK (${wav.byteLength} bytes)`);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.log("FAILED");
  console.error();
  if (msg.includes("ECONNREFUSED") || msg.includes("fetch") || msg.includes("timed out")) {
    console.error("[接続エラー] VOICEVOX ENGINE に接続できませんでした。");
    console.error(`  確認: VOICEVOX が ${voiceCfg.host} で起動しているか？`);
    console.error("  /voice で起動してから再実行してください。");
  } else {
    console.error(`[synthesize エラー] ${msg}`);
  }
  process.exit(1);
}

// 2. STT に通す
let transcribed: string;
try {
  process.stdout.write("transcribe     ... ");
  transcribed = await transcribe(wav, sttCfg);
  console.log(`OK`);
  console.log(`  transcribed   : ${transcribed}`);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.log("FAILED");
  console.error(`[transcribe エラー] ${msg}`);
  process.exit(1);
}

// 3. 原文との一致確認（句読点・記号差を許容）
const normalize = (s: string) =>
  s
    .replace(/[。、！？!?.,，．　\s]/g, "")
    .trim();

const origNorm = normalize(ORIGINAL);
const transNorm = normalize(transcribed);
const match = origNorm === transNorm;

console.log();
console.log(`原文（正規化）     : ${origNorm}`);
console.log(`文字起こし（正規化）: ${transNorm}`);
console.log();
if (match) {
  console.log("smoke:stt OK — 一致");
} else {
  console.log("smoke:stt NG — 不一致（内容を目視確認してください）");
}

// ------------------------------------------------------------------
// VOICEVOX audio_query に outputSamplingRate=16000, outputStereo=false を指定する
// ------------------------------------------------------------------

async function synthesize16kMono(
  text: string,
  host: string,
  speaker: number,
): Promise<Buffer> {
  const TIMEOUT_MS = 10_000;

  function withTimeout(): AbortSignal {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error("VOICEVOX fetch timed out")), TIMEOUT_MS);
    ac.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
    return ac.signal;
  }

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
  const audioQuery = await queryRes.json() as Record<string, unknown>;

  // 16kHz mono に変更
  audioQuery.outputSamplingRate = 16000;
  audioQuery.outputStereo = false;

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
