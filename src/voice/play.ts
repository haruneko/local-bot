/**
 * wav バッファの再生。逐次再生前提（呼び出し側でキューに入れる）。
 *
 * 優先順:
 *   1. paplay が PATH にあれば stdin に wav を流す
 *   2. 無ければ Windows interop:
 *      - wav を os.tmpdir() の一時ファイルに書き
 *      - wslpath -w で Windows パスに変換
 *      - powershell.exe Media.SoundPlayer でブロック再生
 *
 * 手段の探索は初回のみ（プロセス内キャッシュ）。
 * 再生手段が無ければ throw する（呼び出し側が degrade）。
 */

import { spawn } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

type PlayMethod = "paplay" | "powershell" | "none";

let cachedMethod: PlayMethod | null = null;

async function detectMethod(): Promise<PlayMethod> {
  if (cachedMethod !== null) return cachedMethod;

  // paplay が PATH にあるか確認
  const hasPaplay = await new Promise<boolean>((resolve) => {
    const child = spawn("which", ["paplay"], { stdio: "ignore" });
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
  if (hasPaplay) {
    cachedMethod = "paplay";
    return cachedMethod;
  }

  // wslpath + powershell.exe が使えるか確認（WSL2 interop）
  const hasPowershell = await new Promise<boolean>((resolve) => {
    const child = spawn("which", ["powershell.exe"], { stdio: "ignore" });
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
  if (hasPowershell) {
    cachedMethod = "powershell";
    return cachedMethod;
  }

  cachedMethod = "none";
  return cachedMethod;
}

async function playWithPowershell(wav: Buffer): Promise<void> {
  const tmpPath = join(tmpdir(), `voicevox-${randomUUID()}.wav`);
  try {
    await writeFile(tmpPath, wav);

    // WSL パスを Windows パスに変換
    const winPath = await new Promise<string>((resolve, reject) => {
      const child = spawn("wslpath", ["-w", tmpPath], { stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve(out.trim());
        else reject(new Error(`wslpath failed with code ${code}`));
      });
    });

    // PowerShell で同期再生
    const psScript = `(New-Object Media.SoundPlayer '${winPath}').PlaySync()`;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "powershell.exe",
        ["-NoProfile", "-Command", psScript],
        { stdio: "ignore" },
      );
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`powershell.exe exited with code ${code}`));
      });
    });
  } finally {
    // 一時ファイルを削除（失敗しても無視）
    unlink(tmpPath).catch(() => undefined);
  }
}

/** paplay の raw stdin 渡しが WAV ヘッダで失敗する場合の fallback: wav ファイルを使う */
async function playWithPaplayFile(wav: Buffer): Promise<void> {
  const tmpPath = join(tmpdir(), `voicevox-${randomUUID()}.wav`);
  try {
    await writeFile(tmpPath, wav);
    await new Promise<void>((resolve, reject) => {
      const child = spawn("paplay", [tmpPath], { stdio: "ignore" });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`paplay exited with code ${code}`));
      });
    });
  } finally {
    unlink(tmpPath).catch(() => undefined);
  }
}

export async function playWav(wav: Buffer): Promise<void> {
  const method = await detectMethod();
  if (method === "paplay") {
    // wav ファイルとして渡す（VOICEVOX は標準 wav を出力するので paplay がそのまま扱える）
    return playWithPaplayFile(wav);
  }
  if (method === "powershell") {
    return playWithPowershell(wav);
  }
  throw new Error("再生手段が見つかりません（paplay も powershell.exe も利用不可）");
}

/** テスト用: キャッシュをリセットする */
export function _resetMethodCache(): void {
  cachedMethod = null;
}
