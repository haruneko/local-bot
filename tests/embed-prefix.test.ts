import { describe, expect, it } from "vitest";
import { embedPrefixFor } from "../src/llm/embed-prefix.js";
import { OllamaEmbedClient } from "../src/llm/ollama.js";

describe("embedPrefixFor", () => {
  it("ruri は非対称の日本語接頭辞", () => {
    expect(embedPrefixFor("hf.co/Targoyle/ruri-v3-310m-GGUF")).toEqual({
      query: "検索クエリ: ",
      doc: "検索文書: ",
    });
  });
  it("nomic は search_query/document", () => {
    expect(embedPrefixFor("nomic-embed-text:latest")).toEqual({
      query: "search_query: ",
      doc: "search_document: ",
    });
  });
  it("bge-m3 は接頭辞なし", () => {
    expect(embedPrefixFor("bge-m3:latest")).toEqual({ query: "", doc: "" });
  });
});

describe("OllamaEmbedClient embedQuery/embedDocument", () => {
  class SpyEmbed extends OllamaEmbedClient {
    seen: string[] = [];
    override async embed(text: string): Promise<number[]> {
      this.seen.push(text);
      return [0];
    }
  }

  it("embedQuery は query 接頭辞・embedDocument は doc 接頭辞を前置きする", async () => {
    const c = new SpyEmbed("http://localhost:1", "ruri", {
      query: "検索クエリ: ",
      doc: "検索文書: ",
    });
    await c.embedQuery("あいまいさ");
    await c.embedDocument("本文");
    expect(c.seen).toEqual(["検索クエリ: あいまいさ", "検索文書: 本文"]);
  });

  it("接頭辞なし設定では素のテキスト", async () => {
    const c = new SpyEmbed("http://localhost:1", "bge-m3");
    await c.embedQuery("q");
    await c.embedDocument("d");
    expect(c.seen).toEqual(["q", "d"]);
  });
});
