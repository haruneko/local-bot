/**
 * MCP stdio server: web_search (Tavily API) + browse_url
 * Node 20+ fetch のみ使用。Docker 不要。
 * TAVILY_API_KEY をプロジェクト直下の .env（または親 env）から読む。
 */
import { readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// MCP 子プロセスは親 env を全部は継がないので、プロジェクト直下の .env を自前で読む
try {
  const envText = readFileSync(new URL("../.env", import.meta.url), "utf8");
  for (const line of envText.split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
} catch {
  /* .env が無ければ親 env のみ */
}

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

const TAVILY_API_KEY = process.env.TAVILY_API_KEY ?? "";

/** 応答しない外部 I/O でターンが固まらないよう、必ず時間で打ち切る fetch */
async function fetchWithTimeout(url, options = {}, ms = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } catch (err) {
    if (ctrl.signal.aborted) throw new Error(`timeout（${ms}ms 応答なし）: ${url}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function webSearch(query, limit) {
  if (!TAVILY_API_KEY) {
    throw new Error("TAVILY_API_KEY が未設定です（.env に TAVILY_API_KEY=... を追加してください）");
  }

  let res;
  try {
    res = await fetchWithTimeout("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: TAVILY_API_KEY,
        query,
        max_results: limit,
        search_depth: "basic",
        include_answer: true,
      }),
    }, 15000);
  } catch (err) {
    throw new Error(`Tavily に接続できません: ${err.message}`);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Tavily エラー: ${res.status} ${detail.slice(0, 200)}`);
  }

  const data = await res.json();
  const items = (data.results ?? []).slice(0, limit);
  if (items.length === 0) {
    return `「${query}」の検索結果が見つかりませんでした。`;
  }

  const head = data.answer ? `要約: ${data.answer}\n\n` : "";
  return (
    head +
    items
      .map((r, i) => `[${i + 1}] ${r.title ?? ""}\n${r.url ?? ""}\n${r.content ?? ""}`)
      .join("\n\n")
  );
}

async function browseUrl(url, maxChars) {
  const res = await fetchWithTimeout(url, {
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
