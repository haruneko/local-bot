import { describe, expect, it } from "vitest";
import { researchSummaryForUser } from "../src/roles/subagent.js";

describe("researchSummaryForUser — ユーザーには要約だけ・出典 dump は出さない", () => {
  it("web_search 本文（要約: ...\\n\\n[出典]）から要約部分だけ取り出す", () => {
    const content =
      "要約: 2026年6月時点で Ariana Grande がトップ。\n\n[1] 出典タイトル\nhttps://example.com\n長い本文…";
    const s = researchSummaryForUser(content, "web_search を実行した");
    expect(s).toBe("要約: 2026年6月時点で Ariana Grande がトップ。");
    expect(s).not.toContain("[1]"); // 出典 dump は含めない
    expect(s).not.toContain("https://");
  });

  it("要約 prefix が無い本文（browse 等）は冒頭を短く返す（500字以内）", () => {
    const content = "あ".repeat(2000);
    const s = researchSummaryForUser(content, "browse_url を実行した");
    expect(s.length).toBeLessThanOrEqual(500);
    expect(s).not.toBe("browse_url を実行した"); // 汎用ラベルは使わない
  });

  it("本文が空なら fallback（MCPラベル）に落ちる", () => {
    expect(researchSummaryForUser("", "x を実行した")).toBe("x を実行した");
  });
});
