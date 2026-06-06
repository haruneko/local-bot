import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpConfig, McpServerConfig } from "../config/mcp.js";
import type { ToolCategory } from "../tools/catalog.js";
import type { McpCallResult, McpToolDescriptor, McpToolProvider } from "./types.js";

type ConnectedServer = {
  config: McpServerConfig;
  client: Client;
  transport: StdioClientTransport;
};

function toolCategoryForServer(
  server: McpServerConfig,
): ToolCategory | undefined {
  if (server.categories.length === 1) return server.categories[0];
  return undefined;
}

function extractTextContent(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return JSON.stringify(result);
  return content
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const typed = item as { type?: string; text?: string };
      if (typed.type === "text" && typed.text) return typed.text;
      return JSON.stringify(item);
    })
    .filter(Boolean)
    .join("\n");
}

export class McpToolClient implements McpToolProvider {
  private servers: ConnectedServer[] = [];
  private tools: McpToolDescriptor[] = [];

  static async connect(config: McpConfig): Promise<McpToolClient> {
    const client = new McpToolClient();
    for (const server of config.servers) {
      if (server.enabled === false) continue;
      try {
        await client.connectServer(server);
      } catch (err) {
        console.warn(
          `[mcp] server "${server.name}" connect failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    return client;
  }

  private async connectServer(config: McpServerConfig): Promise<void> {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: config.env,
      cwd: config.cwd,
    });
    const client = new Client(
      { name: "local-bot", version: "0.1.0" },
      { capabilities: {} },
    );
    await client.connect(transport);
    const listed = await client.listTools();
    const defaultCategory = toolCategoryForServer(config);
    for (const tool of listed.tools) {
      const category =
        defaultCategory ??
        config.categories[0] ??
        ("research" as ToolCategory);
      this.tools.push({
        name: tool.name,
        description: tool.description ?? tool.name,
        parameters: (tool.inputSchema as Record<string, unknown>) ?? {
          type: "object",
          properties: {},
        },
        server: config.name,
        category,
      });
    }
    this.servers.push({ config, client, transport });
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    return [...this.tools];
  }

  async callTool(
    server: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpCallResult> {
    const connected = this.servers.find((s) => s.config.name === server);
    if (!connected) {
      return { ok: false, summary: `MCPサーバが見つからない: ${server}` };
    }
    try {
      const result = await connected.client.callTool({ name, arguments: args });
      const text = extractTextContent(result);
      const isError = Boolean(
        result && typeof result === "object" && (result as { isError?: boolean }).isError,
      );
      if (isError) {
        return {
          ok: false,
          summary: text || `ツール ${name} がエラーを返した`,
          content: text,
        };
      }
      return {
        ok: true,
        summary: `${name} を実行した`,
        content: text || JSON.stringify(result),
      };
    } catch (err) {
      return {
        ok: false,
        summary: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async close(): Promise<void> {
    for (const s of this.servers) {
      try {
        await s.client.close();
      } catch {
        /* ignore */
      }
    }
    this.servers = [];
    this.tools = [];
  }
}

export class EmptyMcpToolProvider implements McpToolProvider {
  async listTools(): Promise<McpToolDescriptor[]> {
    return [];
  }

  async callTool(): Promise<McpCallResult> {
    return { ok: false, summary: "MCPツールが設定されていない" };
  }
}
