import type { ToolCategory } from "../tools/catalog.js";

export type McpToolDescriptor = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  server: string;
  category: ToolCategory;
};

export type McpCallResult = {
  ok: boolean;
  summary: string;
  content?: string;
};

export interface McpToolProvider {
  listTools(): Promise<McpToolDescriptor[]>;
  callTool(
    server: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpCallResult>;
}
