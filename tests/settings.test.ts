import { describe, expect, it } from "vitest";
import {
  loadSettings,
  resolveActivatorModel,
  resolveEnabledActors,
  resolveOllamaThink,
} from "../src/config/settings.js";

describe("集中 State の actor 解決", () => {
  it("対話・静穏は steps actor を含む（管理＝立てる/開始/報告/再開）", async () => {
    const s = await loadSettings();
    expect(resolveEnabledActors(s, "対話")).toContain("steps");
    expect(resolveEnabledActors(s, "静穏")).toContain("steps");
  });
  it("集中は steps actor を含まない（執行フェーズ＝doer が動き、前進は受け入れ判定が担う）", async () => {
    const s = await loadSettings();
    expect(resolveEnabledActors(s, "集中")).not.toContain("steps");
    // 集中の doer（少なくとも作る人）は居る
    expect(resolveEnabledActors(s, "集中")).toContain("synthesize");
  });
});

describe("resolveActivatorModel", () => {
  it("uses activatorModel when set", () => {
    expect(
      resolveActivatorModel({ activatorModel: "tiny", actionModel: "8b", chatModel: "35b" } as never),
    ).toBe("tiny");
  });

  it("falls back to actionModel, then chatModel", () => {
    expect(resolveActivatorModel({ actionModel: "8b", chatModel: "35b" } as never)).toBe("8b");
    expect(resolveActivatorModel({ chatModel: "35b" } as never)).toBe("35b");
  });
});

describe("resolveOllamaThink", () => {
  it("defaults to false when unset", () => {
    expect(resolveOllamaThink({} as never)).toBe(false);
  });

  it("uses settings value", () => {
    expect(resolveOllamaThink({ ollamaThink: "low" } as never)).toBe("low");
  });

  it("env OLLAMA_THINK overrides settings", () => {
    const prev = process.env.OLLAMA_THINK;
    process.env.OLLAMA_THINK = "false";
    try {
      expect(resolveOllamaThink({ ollamaThink: true } as never)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.OLLAMA_THINK;
      else process.env.OLLAMA_THINK = prev;
    }
  });
});
