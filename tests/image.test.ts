import { describe, expect, it } from "vitest";
import { Jimp } from "jimp";
import { normalizeImage } from "../src/sensor/image.js";

async function pngBase64(w: number, h: number): Promise<string> {
  const img = new Jimp({ width: w, height: h, color: 0xffffffff });
  const buf = await img.getBuffer("image/png");
  return buf.toString("base64");
}

describe("normalizeImage — 取り込み画像の縮小", () => {
  it("長辺が上限を超える画像は縮小される", async () => {
    const big = await pngBase64(2000, 1500);
    const out = await normalizeImage(big, 1024);
    const img = await Jimp.read(Buffer.from(out, "base64"));
    expect(Math.max(img.width, img.height)).toBeLessThanOrEqual(1024);
    // アスペクト比は保つ（2000:1500 = 4:3 → 1024:768）
    expect(img.width).toBe(1024);
    expect(img.height).toBe(768);
  });

  it("上限以下の画像はそのまま（再エンコードしない）", async () => {
    const small = await pngBase64(640, 480);
    expect(await normalizeImage(small, 1024)).toBe(small);
  });

  it("画像でないデータは原本を返す（壊さない）", async () => {
    const notImage = Buffer.from([1, 2, 3, 4]).toString("base64");
    expect(await normalizeImage(notImage, 1024)).toBe(notImage);
  });

  it("空文字はそのまま", async () => {
    expect(await normalizeImage("", 1024)).toBe("");
  });
});
