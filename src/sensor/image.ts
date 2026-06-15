import { Jimp } from "jimp";

/** 視覚の既定の縮小上限（長辺・px）。携帯/カメラの高解像度はタイルが増えてトークン爆発するので
 *  取り込み口で縮小する。1024 は「顔のざっくり・シーンの細部・物の判別」が保てる手頃な所。
 *  重ければ settings.imageMaxLongSide で下げる（コード変更なしで観察→調整）。 */
export const DEFAULT_IMAGE_MAX_LONG_SIDE = 1024;

/**
 * 取り込んだ画像（base64）を、長辺が maxLongSide を超えるときだけ縮小し JPEG 再エンコードして返す。
 * - 上限以下ならそのまま返す（再エンコードしない＝劣化させない）。
 * - 画像として読めなければ原本をそのまま返す（壊さない）。
 */
export async function normalizeImage(
  base64: string,
  maxLongSide = DEFAULT_IMAGE_MAX_LONG_SIDE,
): Promise<string> {
  if (!base64) return base64;
  try {
    const img = await Jimp.read(Buffer.from(base64, "base64"));
    if (Math.max(img.width, img.height) <= maxLongSide) return base64;
    img.scaleToFit({ w: maxLongSide, h: maxLongSide });
    const out = await img.getBuffer("image/jpeg", { quality: 85 });
    return out.toString("base64");
  } catch {
    return base64;
  }
}
