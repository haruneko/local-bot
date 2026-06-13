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
  return mcpToolsToCatalog(mcpTools);
}

export function catalogForCategory(
  catalog: readonly CatalogTool[],
  category: ToolCategory,
): CatalogTool[] {
  return catalog.filter((t) => t.category === category);
}

function formatParamSignature(parameters: Record<string, unknown>): string {
  const props = parameters.properties as Record<string, { type?: string }> | undefined;
  if (!props || Object.keys(props).length === 0) return "";
  const required = new Set((parameters.required as string[] | undefined) ?? []);
  const parts = Object.entries(props).map(
    ([k, v]) => `${k}${required.has(k) ? "" : "?"}:${v.type ?? "any"}`,
  );
  return `(${parts.join(", ")})`;
}

export function formatCatalogForPrompt(tools: readonly CatalogTool[]): string {
  if (tools.length === 0) return "（利用可能なツールはない）";
  return tools
    .map((t) => {
      const sig = formatParamSignature(t.parameters);
      return `- ${t.name}${sig}: ${t.description}`;
    })
    .join("\n");
}

export function toToolDefinition(tool: CatalogTool): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
}
