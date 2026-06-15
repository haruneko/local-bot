import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFrames } from "../src/sensor/frame.js";

describe("readFrames — 視覚センサー（文字起こししない・生の base64）", () => {
  it("source 未設定/空白なら空（視覚オフ）", async () => {
    expect(await readFrames()).toEqual([]);
    expect(await readFrames("")).toEqual([]);
    expect(await readFrames("   ")).toEqual([]);
  });

  it("存在しないパスなら空（壊さず黙る）", async () => {
    expect(await readFrames("/no/such/file.png")).toEqual([]);
  });

  it("ファイルパスなら中身を base64 で1枚返す（画像でなければ原本のまま）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "frame-"));
    const f = join(dir, "a.png");
    const bytes = Buffer.from([1, 2, 3, 4]); // 画像でない＝縮小は素通り（原本）
    writeFileSync(f, bytes);
    try {
      expect(await readFrames(f)).toEqual([bytes.toString("base64")]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ディレクトリなら最新更新の画像1枚（非画像は無視）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "frame-"));
    const older = join(dir, "old.png");
    const newer = join(dir, "new.jpg");
    const newerBytes = Buffer.from([7, 7]);
    writeFileSync(older, Buffer.from([9]));
    writeFileSync(newer, newerBytes);
    writeFileSync(join(dir, "notes.txt"), "画像じゃないので無視される");
    // old を過去に倒して new を最新にする
    const past = new Date(Date.now() - 60_000);
    utimesSync(older, past, past);
    try {
      expect(await readFrames(dir)).toEqual([newerBytes.toString("base64")]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
