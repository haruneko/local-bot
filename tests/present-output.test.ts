import { describe, expect, it } from "vitest";
import { actionSucceeded } from "../src/action/outcome.js";
import {
  collectUserArtifacts,
  formatActionForLanguage,
  formatActionForIntrospection,
} from "../src/action/present.js";
import type { ActionFacts } from "../src/action/facts.js";

const act = { kind: "memory" as const, intent: "x" };
const long = "あ".repeat(300);

function outcome(facts: ActionFacts) {
  return actionSucceeded(act, facts);
}

describe("出力の3宛先非対称（ユーザー全文 / 言語野・内省は冒頭120字）", () => {
  it("ユーザー出力: synthesize/memo_read は全文・research は要約だけ（全文 dump は出さない）", () => {
    const arts = collectUserArtifacts([
      outcome({ kind: "synthesize", filename: "works/a.md", body: long }),
      // research は要約だけ返す。多ソースの生 dump（body）は流さない
      outcome({
        kind: "research",
        tool: "web",
        title: "件名",
        summary: "要約: 結論はこれ",
        body: "要約: 結論はこれ\n\n[1] 長い出典 " + long,
      }),
      outcome({ kind: "memo_read", filename: "n.md", body: "メモ全文" }),
      // 以下は出さない（プリプロセスまでで既知 or 短い）
      outcome({ kind: "memo_write", filename: "n.md", body: long }),
      outcome({ kind: "recall", bullets: ["x"] }),
    ]);
    expect(arts).toHaveLength(3);
    expect(arts[0]).toBe(long); // synthesize は全文
    expect(arts[1]).toContain("結論はこれ"); // research は要約
    expect(arts[1]).not.toContain("[1] 長い出典"); // 全文 dump は出さない
    expect(arts[2]).toBe("メモ全文"); // memo_read は全文
  });

  it("言語野: 長い成果物は冒頭に縮め『書き写すな』注記が付く", () => {
    const text = formatActionForLanguage(
      outcome({ kind: "synthesize", filename: "works/a.md", body: long }),
    );
    expect(text).toContain("…"); // 冒頭で切れている
    expect(text.length).toBeLessThan(long.length); // 全文より短い
    expect(text).toContain("書き写さず"); // 二重生成を抑える注記
  });

  it("内省: 長い成果物は冒頭＋分量メタ（全文は入れない）", () => {
    const text = formatActionForIntrospection(
      outcome({ kind: "synthesize", filename: "works/a.md", body: long }),
    );
    expect(text).toContain("…");
    expect(text).toContain("全300字"); // 量感メタ
    expect(text).not.toContain(long); // 全文は焼かない
  });

  it("短い facts（recall）は縮めずそのまま", () => {
    const text = formatActionForLanguage(
      outcome({ kind: "recall", bullets: ["思い出した一行"] }),
    );
    expect(text).toContain("思い出した一行");
    expect(text).not.toContain("書き写さず");
  });
});
