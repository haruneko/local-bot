import { describe, expect, it } from "vitest";
import {
  extractSpeechStream,
  splitSentences,
} from "../src/roles/speech-stream.js";

/** 文字列を1文字ずつ yield する（チャンク境界で割れるケースの再現に使う）。 */
async function* charByChar(s: string): AsyncIterable<string> {
  for (const ch of s) yield ch;
}

/** 与えたチャンク列をそのまま順に yield する。 */
async function* fromChunks(chunks: string[]): AsyncIterable<string> {
  for (const c of chunks) yield c;
}

async function collect(it: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe("extractSpeechStream", () => {
  it("正常: speech 値をデコードして流す（連結すると全文）", async () => {
    const raw = JSON.stringify({ speech: "こんにちは。元気？", nextState: "対話" });
    const parts = await collect(extractSpeechStream(fromChunks([raw])));
    expect(parts.join("")).toBe("こんにちは。元気？");
  });

  it("1文字ずつ流しても正しく抽出する", async () => {
    const raw = JSON.stringify({ speech: "やあ、いい天気だね！", nextState: "対話" });
    const parts = await collect(extractSpeechStream(charByChar(raw)));
    expect(parts.join("")).toBe("やあ、いい天気だね！");
  });

  it("```json フェンス・先頭空白を許容する", async () => {
    const raw = '\n  ```json\n{"speech": "フェンス越し"}\n```';
    const parts = await collect(extractSpeechStream(charByChar(raw)));
    expect(parts.join("")).toBe("フェンス越し");
  });

  it("キー前後の空白を許容する", async () => {
    const raw = '{ "speech" :  "空白あり" }';
    const parts = await collect(extractSpeechStream(charByChar(raw)));
    expect(parts.join("")).toBe("空白あり");
  });

  it("エスケープ（\\n \\\" \\\\ \\/）をデコードする", async () => {
    const raw = '{"speech":"1行目\\n2\\"引用\\"\\\\末尾\\/"}';
    const parts = await collect(extractSpeechStream(charByChar(raw)));
    expect(parts.join("")).toBe('1行目\n2"引用"\\末尾/');
  });

  it("\\uXXXX をデコードする（1文字ずつでも割れずに解ける）", async () => {
    // あ = あ
    const raw = '{"speech":"\\u3042い"}';
    const parts = await collect(extractSpeechStream(charByChar(raw)));
    expect(parts.join("")).toBe("あい");
  });

  it("エスケープ列がチャンク境界で割れても正しく扱う", async () => {
    // "改行\n" を `...\` と `n...` の間で割る
    const chunks = ['{"speech":"改行', "\\", 'n次"}'];
    const parts = await collect(extractSpeechStream(fromChunks(chunks)));
    expect(parts.join("")).toBe("改行\n次");
  });

  it("\\uXXXX がチャンク境界で割れても正しく扱う", async () => {
    // あ を複数のチャンクに割る
    const chunks = ['{"speech":"', "\\u30", "42", '"}'];
    const parts = await collect(extractSpeechStream(fromChunks(chunks)));
    expect(parts.join("")).toBe("あ");
  });

  it("閉じ \" 以降（nextState 等）は無視する", async () => {
    const raw = '{"speech":"本文だけ","nextState":"対話"}';
    const parts = await collect(extractSpeechStream(charByChar(raw)));
    expect(parts.join("")).toBe("本文だけ");
  });

  it("speech キーが無ければ何も yield しない（エラーにしない）", async () => {
    const raw = '{"nextState":"対話","other":"値"}';
    const parts = await collect(extractSpeechStream(charByChar(raw)));
    expect(parts).toEqual([]);
  });

  it("キーが途中で終わっても（不完全出力）壊れない", async () => {
    const parts = await collect(extractSpeechStream(fromChunks(['{"spe'])));
    expect(parts).toEqual([]);
  });
});

describe("splitSentences", () => {
  it("句点・感嘆・疑問・改行で文を切る（各文は結合閾値以上の長さ）", async () => {
    const src = fromChunks(["これは一文目です。これは二文目だよ！これは三文目かな？\nこれは四文目です"]);
    const out = await collect(splitSentences(src));
    expect(out).toEqual([
      "これは一文目です。",
      "これは二文目だよ！",
      "これは三文目かな？",
      "これは四文目です",
    ]);
  });

  it("短い文は次と結合する（TTS 細切れ防止・仕様どおり）", async () => {
    const src = fromChunks(["三つ目？四つ目の文だよ。"]);
    const out = await collect(splitSentences(src));
    // 「三つ目？」は4文字＝閾値未満 → 次と結合
    expect(out).toEqual(["三つ目？四つ目の文だよ。"]);
  });

  it("境界直後の閉じ記号（」』）\")は前の文に含める", async () => {
    const src = fromChunks(["「もう限界だ。」と言った。"]);
    const out = await collect(splitSentences(src));
    expect(out).toEqual(["「もう限界だ。」", "と言った。"]);
  });

  it("短すぎる断片（6文字未満）は次と結合する", async () => {
    // 「はい。」は3文字＝短い → 次と結合
    const src = fromChunks(["はい。今日はとても良い一日だった。"]);
    const out = await collect(splitSentences(src));
    expect(out).toEqual(["はい。今日はとても良い一日だった。"]);
  });

  it("末尾に句点が無くても flush する", async () => {
    const src = fromChunks(["ちゃんとした長さの尻切れ文"]);
    const out = await collect(splitSentences(src));
    expect(out).toEqual(["ちゃんとした長さの尻切れ文"]);
  });

  it("連続空白・空文は捨てる", async () => {
    const src = fromChunks(["。。。本当に長い意味のある文だよ。"]);
    const out = await collect(splitSentences(src));
    // 先頭の空の「。」群は捨てられ、意味のある一文だけ出る
    expect(out).toEqual(["本当に長い意味のある文だよ。"]);
  });

  it("1文字ずつ流しても文境界で正しく切れる", async () => {
    const out = await collect(splitSentences(charByChar("最初の文です。次の長い文だよ。")));
    expect(out).toEqual(["最初の文です。", "次の長い文だよ。"]);
  });

  it("抽出器→分割器を繋いでエンドツーエンドで文が出る（1文字ずつ）", async () => {
    const raw = JSON.stringify({
      speech: "やっほー、元気だった？わたしは元気だよ。",
      nextState: "対話",
    });
    const out = await collect(splitSentences(extractSpeechStream(charByChar(raw))));
    expect(out.join("")).toBe("やっほー、元気だった？わたしは元気だよ。");
    // 疑問符で切れる（先頭断片が十分長い）
    expect(out.length).toBeGreaterThanOrEqual(2);
  });
});
