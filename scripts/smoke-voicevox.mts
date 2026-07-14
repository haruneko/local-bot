/**
 * VOICEVOX 疎通確認スクリプト。
 * 設定を読み、サンプルテキストを synthesize → play して結果を表示する。
 * 失敗時は原因（接続不可/再生手段なし）を分かりやすく出す。
 *
 * 使い方: npm run smoke:voice
 */

import { loadSettings, resolveVoiceSettings } from "../src/config/settings.js";
import { synthesizeVoice } from "../src/voice/voicevox.js";
import { playWav } from "../src/voice/play.js";

const TEST_TEXT = "こんにちは、わたしはエバです。声の調子はどうかな？";

const settings = await loadSettings();
const voiceCfg = resolveVoiceSettings(settings);

console.log(`VOICEVOX smoke`);
console.log(`  host   : ${voiceCfg.host}`);
console.log(`  speaker: ${voiceCfg.speaker}`);
console.log(`  text   : ${TEST_TEXT}`);
console.log();

// 1. synthesize
let wav: Buffer;
try {
  process.stdout.write("synthesize ... ");
  wav = await synthesizeVoice(TEST_TEXT, { host: voiceCfg.host, speaker: voiceCfg.speaker });
  console.log(`OK (${wav.byteLength} bytes)`);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.log("FAILED");
  console.error();
  if (msg.includes("ECONNREFUSED") || msg.includes("fetch") || msg.includes("timed out")) {
    console.error(`[接続エラー] VOICEVOX ENGINE に接続できませんでした。`);
    console.error(`  確認: VOICEVOX が ${voiceCfg.host} で起動しているか？`);
    console.error(`  Windows ホスト側で VOICEVOX を起動してから再実行してください。`);
  } else {
    console.error(`[synthesize エラー] ${msg}`);
  }
  process.exit(1);
}

// 2. play
try {
  process.stdout.write("play     ... ");
  await playWav(wav);
  console.log("OK");
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.log("FAILED");
  console.error();
  if (msg.includes("再生手段が見つかりません")) {
    console.error(`[再生エラー] 音声の再生手段がありません。`);
    console.error(`  paplay（PulseAudio）も powershell.exe（WSL2 interop）も利用不可です。`);
    console.error(`  WSL2 の場合: sudo apt install pulseaudio-utils などで paplay を導入してください。`);
  } else {
    console.error(`[play エラー] ${msg}`);
  }
  process.exit(1);
}

console.log();
console.log("smoke:voice OK");
