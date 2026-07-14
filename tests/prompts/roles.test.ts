import { describe, expect, it } from "vitest";
import {
  LANGUAGE_HEARTBEAT_SYSTEM_PREFIX,
  LANGUAGE_SYSTEM_PREFIX,
  MEMO_OP_SYSTEM,
  STEPS_SYSTEM,
} from "../../src/prompts/roles.js";
import { memoActor } from "../../src/actors/memo.js";
import { formatActionForLanguage } from "../../src/action/present.js";

describe("role prompts", () => {
  it("LANGUAGE_SYSTEM_PREFIX does not leak module identity phrasing", () => {
    expect(LANGUAGE_SYSTEM_PREFIX).not.toContain("言語化するモジュール");
    expect(LANGUAGE_SYSTEM_PREFIX).not.toContain("あなたは言語化");
    expect(LANGUAGE_SYSTEM_PREFIX).not.toMatch(/あなたは.*担当/);
  });

  it("LANGUAGE_HEARTBEAT_SYSTEM_PREFIX shows a positive example without prohibition framing", () => {
    expect(LANGUAGE_HEARTBEAT_SYSTEM_PREFIX).toContain("例:");
    expect(LANGUAGE_HEARTBEAT_SYSTEM_PREFIX).not.toContain("悪い例");
    expect(LANGUAGE_HEARTBEAT_SYSTEM_PREFIX).not.toContain("質問で返さない");
  });

  it("STEPS_SYSTEM は段取り一覧の id を (m1) 形式と誤って例示しない（stepsId=タイトル・m1 はマイルストーン専用）", () => {
    // 段取り一覧の実レンダリング（renderBacklog）は (タイトル) 形式。
    // (m1) を一覧の例として教えると steps actor が stepsId:"m1" を幻覚する（2026-07-14 ラリーで実測）。
    expect(STEPS_SYSTEM).not.toContain("「いまの段取り一覧」（(m1)");
    expect(STEPS_SYSTEM).toContain("stepsId＝タイトルがそのまま id");
    expect(STEPS_SYSTEM).toContain("マイルストーン専用");
  });

  it("MEMO_OP_SYSTEM は転記の境界を示す（文脈に無いことを一般知識で補って書かない）", () => {
    expect(MEMO_OP_SYSTEM).toContain("一般知識で補って書かない");
  });

  it("memo criteria は転記の境界（自分の知識で書かない・調べる依頼だけでは起動しない）を示す", () => {
    expect(memoActor.criteria).toContain("自分の知識では書かない");
    expect(memoActor.criteria).toContain("調べる依頼だけ（記録まで頼まれていない）では起動しない");
  });
});

describe("formatActionForLanguage regression", () => {
  it("does not include first-person pronouns in action facts", () => {
    const text = formatActionForLanguage({
      attempted: true,
      kind: "remember",
      intent: "好み",
      status: "succeeded",
      facts: { kind: "remember", body: "コーヒーが好き" },
      summary: "LanceDB（source: remember）に記録した: コーヒーが好き",
    });
    expect(text).toContain("コーヒーが好き");
    expect(text).not.toMatch(/わたし|私は/);
  });
});
