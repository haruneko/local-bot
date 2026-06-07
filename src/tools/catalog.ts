import type { McpToolDescriptor, McpToolProvider } from "../mcp/types.js";
import type { ToolDefinition } from "./registry.js";

export type ToolCategory = "memory" | "research" | "express";

export type CatalogTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  category: ToolCategory;
  source: "in-process" | "mcp";
  server?: string;
};

export const MEMORY_TOOL_KINDS = [
  "remember",
  "recall",
  "forget",
  "memo_write",
  "memo_read",
  "distill",
] as const;

export type MemoryToolKind = (typeof MEMORY_TOOL_KINDS)[number];

const MEMORY_TOOL_DESCRIPTIONS: Record<MemoryToolKind, string> = {
  remember: "会話の事実・好み・約束を LanceDB 記憶に残す",
  recall: "体験・感情の内省記憶を LanceDB で検索する。data/notes のファイル読取には使わない。引数: {query: 検索クエリ（省略時は intent を使う）}",
  forget: "LanceDB 記憶から特定の事実を忘れる（ソフト削除）",
  memo_write: "data/notes のメモファイルに書き残す。ディレクトリを含むパスも指定できる",
  memo_read: "data/notes のメモファイルを見つけて全文を読む。ファイル名が曖昧でも意図から候補を絞れる",
  distill: "エピソード記憶を意味記憶へ蒸留する（将来実装・スタブ）",
};

export function memoryCatalogTools(): CatalogTool[] {
  return MEMORY_TOOL_KINDS.map((name) => ({
    name,
    description: MEMORY_TOOL_DESCRIPTIONS[name],
    parameters: { type: "object", properties: {} },
    category: "memory" as const,
    source: "in-process" as const,
  }));
}

export function mcpToolsToCatalog(tools: McpToolDescriptor[]): CatalogTool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    category: t.category,
    source: "mcp" as const,
    server: t.server,
  }));
}

export async function buildToolCatalog(
  mcp: McpToolProvider,
): Promise<CatalogTool[]> {
  const mcpTools = await mcp.listTools();
  return [...memoryCatalogTools(), ...mcpToolsToCatalog(mcpTools)];
}

export function catalogForCategory(
  catalog: readonly CatalogTool[],
  category: ToolCategory,
): CatalogTool[] {
  return catalog.filter((t) => t.category === category);
}

export function formatCatalogForPrompt(tools: readonly CatalogTool[]): string {
  if (tools.length === 0) return "（利用可能なツールはない）";
  return tools
    .map((t) => `- ${t.name}: ${t.description}`)
    .join("\n");
}

export function toToolDefinition(tool: CatalogTool): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
}
