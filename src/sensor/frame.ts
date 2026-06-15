import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { normalizeImage } from "./image.js";

/**
 * 視覚センサー: いま視界に入っているフレーム（画像）を base64 で返す。
 * 文字起こしせず生のまま image_feed チャンネルに乗せる（docs/ARCH-NEXT.md）。
 *
 * source は当面ファイルベース（カメラが無いため）:
 * - ファイルパス  → その1枚
 * - ディレクトリ  → 中の最新更新ファイル1枚
 * 後で webcam グラブコマンドや Wi-Fi カメラ URL に差し替える。
 * 読めなければ [] を返す（普段は画像なし）。
 */
const IMAGE_EXT = /\.(png|jpe?g|webp|bmp|gif)$/i;

export async function readFrames(
  source?: string,
  maxLongSide?: number,
): Promise<string[]> {
  const path = source?.trim();
  if (!path) return [];
  try {
    const target = statSync(path).isDirectory() ? latestImageIn(path) : path;
    if (!target) return [];
    const raw = readFileSync(target).toString("base64");
    return [await normalizeImage(raw, maxLongSide)];
  } catch {
    return [];
  }
}

function latestImageIn(dir: string): string | null {
  const files = readdirSync(dir)
    .filter((f) => IMAGE_EXT.test(f))
    .map((f) => join(dir, f));
  let newest: string | null = null;
  let newestMtime = -Infinity;
  for (const f of files) {
    try {
      const m = statSync(f).mtimeMs;
      if (m > newestMtime) {
        newestMtime = m;
        newest = f;
      }
    } catch {
      // skip unreadable
    }
  }
  return newest;
}
