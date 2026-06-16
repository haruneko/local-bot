import { describe, expect, it } from "vitest";
import { bigramDice, lexicalRank } from "../src/recall/lexical.js";

describe("bigramDice", () => {
  it("同一文字列は1", () => {
    expect(bigramDice("ambiguity", "ambiguity")).toBe(1);
  });
  it("無関係は低い", () => {
    expect(bigramDice("曖昧さ", "買い物リスト")).toBeLessThan(0.2);
  });
  it("部分一致は中間", () => {
    const s = bigramDice("Fコードのマスター", "goals/fコードのマスター.md");
    expect(s).toBeGreaterThan(0.5);
  });
});

describe("lexicalRank", () => {
  const items = [
    { key: "DesignPrinciples/ambiguity.md", text: "DesignPrinciples/ambiguity.md" },
    { key: "買い物リスト.md", text: "買い物リスト.md" },
    { key: "goals/fコードのマスター.md", text: "goals/fコードのマスター.md" },
  ];

  it("名前そのままクエリは該当ファイルを上位に", () => {
    const r = lexicalRank("ambiguity", items);
    expect(r[0]).toBe("DesignPrinciples/ambiguity.md");
  });

  it("ゲート(minScore)で弱い一致を落とす＝話題クエリは空に近づく", () => {
    // 「曖昧さについて書いたメモ」はどのファイル名とも字句的に弱い → ゲートで除外
    const gated = lexicalRank("曖昧さについて書いたメモ", items, 0.4);
    expect(gated).toHaveLength(0);
    // ゲート無しなら何かしら拾う可能性がある（=ノイズになりうる）
    const ungated = lexicalRank("曖昧さについて書いたメモ", items, 0);
    expect(ungated.length).toBeGreaterThanOrEqual(gated.length);
  });
});
