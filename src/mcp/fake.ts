import type { McpCallResult, McpToolDescriptor, McpToolProvider } from "./types.js";

const FAKE_RESEARCH_TOOLS: McpToolDescriptor[] = [
  {
    name: "web_search",
    description: "Web検索を行いスニペットを返す",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    server: "fake-research",
    category: "research",
  },
  {
    name: "browse_url",
    description: "URLの本文を取得する",
    parameters: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
    server: "fake-research",
    category: "research",
  },
  {
    name: "calendar_read",
    description: "予定を照会する",
    parameters: {
      type: "object",
      properties: { date: { type: "string" } },
    },
    server: "fake-research",
    category: "research",
  },
];

const FAKE_EXPRESS_TOOLS: McpToolDescriptor[] = [
  {
    name: "post_tweet",
    description: "Twitter/X に投稿する",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    server: "fake-express",
    category: "express",
  },
  {
    name: "calendar_write",
    description: "予定を登録する",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        date: { type: "string" },
      },
      required: ["title"],
    },
    server: "fake-express",
    category: "express",
  },
];

export class FakeMcpToolProvider implements McpToolProvider {
  readonly calls: Array<{
    server: string;
    name: string;
    args: Record<string, unknown>;
  }> = [];

  async listTools(): Promise<McpToolDescriptor[]> {
    return [...FAKE_RESEARCH_TOOLS, ...FAKE_EXPRESS_TOOLS];
  }

  async callTool(
    server: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpCallResult> {
    this.calls.push({ server, name, args });

    switch (name) {
      case "web_search":
        return {
          ok: true,
          summary: `検索: ${String(args.query ?? "")}`,
          content: `検索結果（fake）: ${String(args.query ?? "")}`,
        };
      case "browse_url":
        return {
          ok: true,
          summary: `閲覧: ${String(args.url ?? "")}`,
          content: `ページ本文（fake）: ${String(args.url ?? "")}`,
        };
      case "calendar_read":
        return {
          ok: true,
          summary: `予定照会: ${String(args.date ?? "今日")}`,
          content: "予定なし（fake）",
        };
      case "post_tweet":
        return {
          ok: true,
          summary: `投稿: ${String(args.text ?? "").slice(0, 80)}`,
          content: String(args.text ?? ""),
        };
      case "calendar_write":
        return {
          ok: true,
          summary: `予定登録: ${String(args.title ?? "")}`,
          content: `${String(args.title ?? "")} @ ${String(args.date ?? "")}`,
        };
      default:
        return { ok: false, summary: `未知のツール: ${name}` };
    }
  }
}
