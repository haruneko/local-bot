/**
 * MCP stdio server: web_search (SearXNG JSON API) + browse_url
 * Node 20+ fetch のみ使用。SearXNG: docker compose up -d
 * SEARXNG_URL 環境変数で接続先を変更可能（デフォルト: http://localhost:8080）
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "mcp-research", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

// ---- ツール定義 ----

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "web_search",
      description: "ウェブ検索を実施し、タイトル・URL・スニペットを返す",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "検索クエリ" },
          limit: { type: "number", description: "件数（省略時 5）", default: 5 },
        },
        required: ["query"],
      },
    },
    {
      name: "browse_url",
      description: "URL のページ本文テキストを返す",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "取得する URL" },
          maxChars: {
            type: "number",
            description: "最大文字数（省略時 3000）",
            default: 3000,
          },
        },
        required: ["url"],
      },
    },
  ],
}));

// ---- ツール実行 ----

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  if (name === "web_search") {
    let queryArg = args.query ?? "";
    // LLM sometimes wraps the query in a nested object like {"query": "..."}
    if (typeof queryArg === "object" && queryArg !== null) {
      queryArg = queryArg.query ?? queryArg.q ?? Object.values(queryArg)[0] ?? "";
    }
    const text = await webSearch(String(queryArg), Number(args.limit ?? 5));
    return { content: [{ type: "text", text }] };
  }

  if (name === "browse_url") {
    const text = await browseUrl(String(args.url ?? ""), Number(args.maxChars ?? 3000));
    return { content: [{ type: "text", text }] };
  }

  return {
    isError: true,
    content: [{ type: "text", text: `未知のツール: ${name}` }],
  };
});

// ---- 実装 ----

const SEARXNG_URL = process.env.SEARXNG_URL ?? "http://localhost:8080";

async function webSearch(query, limit) {
  const url = new URL("/search", SEARXNG_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("language", "ja-JP");

  let res;
  try {
    res = await fetch(url.toString(), {
      headers: { "Accept": "application/json" },
    });
  } catch (err) {
    throw new Error(`SearXNG に接続できません（${SEARXNG_URL}）: ${err.message}`);
  }
  if (!res.ok) throw new Error(`SearXNG エラー: ${res.status}`);

  const data = await res.json();
  const items = (data.results ?? []).slice(0, limit);

  if (items.length === 0) {
    return `「${query}」の検索結果が見つかりませんでした。`;
  }

  return items
    .map((r, i) => `[${i + 1}] ${r.title ?? ""}\n${r.url ?? ""}\n${r.content ?? ""}`)
    .join("\n\n");
}

async function browseUrl(url, maxChars) {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; local-bot/0.1; +https://github.com/local-bot)",
      "Accept-Language": "ja,en;q=0.9",
    },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`fetch failed: ${res.status} ${url}`);
  const html = await res.text();
  const noScript = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  const noStyle = noScript.replace(/<style[\s\S]*?<\/style>/gi, "");
  const text = stripTags(noStyle).replace(/\s+/g, " ").trim();
  return text.slice(0, maxChars);
}

function stripTags(html) {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

// ---- 起動 ----

const transport = new StdioServerTransport();
await server.connect(transport);
