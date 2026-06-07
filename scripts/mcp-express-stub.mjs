/**
 * MCP stdio server: express stubs (post_tweet, calendar_write)
 * expressDryRun=true のときオーケストレータが手前で止めるため実際の呼び出しは来ない想定。
 * dry-run=false 時用の最小スタブ。ツール定義を返すことでサブエージェントがカタログを参照できる。
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "mcp-express-stub", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "post_tweet",
      description: "X（Twitter）にツイートを投稿する",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "投稿本文（280文字以内）" },
        },
        required: ["text"],
      },
    },
    {
      name: "calendar_write",
      description: "Google カレンダーに予定を登録する（複数人招待の承認フロー未実装・ペンド）",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "予定のタイトル" },
          start: { type: "string", description: "開始日時（ISO8601）" },
          end: { type: "string", description: "終了日時（ISO8601）" },
          description: { type: "string", description: "予定の詳細（省略可）" },
        },
        required: ["title", "start", "end"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  if (name === "post_tweet") {
    const text = String(args?.text ?? "(本文なし)");
    return { content: [{ type: "text", text: `[stub] ツイート投稿: ${text}` }] };
  }
  if (name === "calendar_write") {
    const title = String(args?.title ?? "(タイトルなし)");
    const start = String(args?.start ?? "?");
    return { content: [{ type: "text", text: `[stub] 予定登録: ${title} (${start})` }] };
  }
  return {
    content: [{ type: "text", text: `未知のツール: ${name}` }],
    isError: true,
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
