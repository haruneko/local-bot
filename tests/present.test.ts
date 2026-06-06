import { describe, expect, it } from "vitest";
import {
  formatActionFactContent,
  formatActionForIntrospection,
  formatActionForLanguage,
  formatActionSummary,
} from "../src/action/present.js";

describe("formatActionForLanguage", () => {
  it("memo_read uses neutral factual template", () => {
    const text = formatActionForLanguage({
      attempted: true,
      kind: "memory",
      intent: "確認",
      status: "succeeded",
      facts: { kind: "memo_read", filename: "状況.md", body: "眠くなった" },
      summary: "data/notes/状況.md を読んだ:\n眠くなった",
    });
    expect(text).toContain("メモ（状況.md）を読んだ");
    expect(text).toContain("眠くなった");
    expect(text).not.toMatch(/わたし|私は/);
  });

  it("memo_write uses neutral factual template", () => {
    const text = formatActionForLanguage({
      attempted: true,
      kind: "memory",
      intent: "状況",
      status: "succeeded",
      facts: { kind: "memo_write", filename: "状況.md", body: "本文です" },
      summary: "data/notes/状況.md に書き込んだ:\n本文です",
    });
    expect(text).toContain("メモ（状況.md）に書き込んだ");
    expect(text).toContain("本文です");
    expect(text).not.toMatch(/わたし|私は/);
  });
});

describe("formatActionForIntrospection", () => {
  it("success memo_write includes body under 内容", () => {
    const block = formatActionForIntrospection({
      attempted: true,
      kind: "memory",
      intent: "状況",
      status: "succeeded",
      facts: { kind: "memo_write", filename: "状況.md", body: "眠い" },
      summary: "data/notes/状況.md に書き込んだ:\n眠い",
    });
    expect(block).toContain("結果: できた");
    expect(block).toContain("内容:");
    expect(block).toContain("メモ（状況.md）に書き込んだ");
    expect(block).toContain("眠い");
  });

  it("failure includes code and message only, not LLM detail", () => {
    const block = formatActionForIntrospection({
      attempted: true,
      kind: "memory",
      intent: "x",
      status: "failed",
      summary:
        "失敗\n原因コード: llm_parse_failed\n詳細: --- LLM応答 1 ---\n{\"bad\":json}",
      error: {
        code: "llm_parse_failed",
        message: "JSONとして解釈できなかった",
        detail: '--- LLM応答 1 ---\n{"bad":json}',
      },
    });
    expect(block).toContain("結果: できなかった");
    expect(block).toContain("原因コード: llm_parse_failed");
    expect(block).toContain("原因: JSONとして解釈できなかった");
    expect(block).not.toContain("詳細:");
    expect(block).not.toContain("LLM応答");
  });

  it("formatActionFactContent for memo_read", () => {
    const facts = formatActionFactContent({
      attempted: true,
      kind: "memory",
      intent: "確認",
      status: "succeeded",
      facts: { kind: "memo_read", filename: "a.md", body: "本文" },
      summary: "data/notes/a.md を読んだ:\n本文",
    });
    expect(facts).toContain("メモ（a.md）を読んだ");
    expect(facts).toContain("本文");
  });
});

describe("formatActionSummary", () => {
  it("memo write includes path and body", () => {
    const s = formatActionSummary({
      kind: "memo_write",
      filename: "状況.md",
      body: "眠い\n状況メモ",
    });
    expect(s).toContain("data/notes/状況.md に書き込んだ:");
    expect(s).not.toContain("/home/");
    expect(s).toContain("眠い");
    expect(s).toContain("状況メモ");
  });

  it("memo read includes path and body", () => {
    const s = formatActionSummary({
      kind: "memo_read",
      filename: "a.md",
      body: "本文テスト",
    });
    expect(s).toContain("data/notes/a.md を読んだ:");
    expect(s).toContain("本文テスト");
  });

  it("research facts format for language", () => {
    const text = formatActionForLanguage({
      attempted: true,
      kind: "research",
      intent: "天気",
      status: "succeeded",
      facts: {
        kind: "research",
        tool: "web_search",
        title: "天気",
        body: "晴れ",
      },
      summary: "web_search: 晴れ",
    });
    expect(text).toContain("web_search");
    expect(text).toContain("晴れ");
  });
});
