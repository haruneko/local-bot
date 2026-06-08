import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  tryParseJsonWithSchema,
  type ParseJsonFailure,
} from "../action/parse-json.js";
import { ACTION_ERROR_CODES } from "../action/error.js";
import { errorFromLlmAttempts } from "../action/error.js";
import { actionFailed, actionSucceeded } from "../action/outcome.js";
import type { RunActionInput } from "../action/context.js";
import type { ActionOutcome } from "../types.js";
import type { CatalogTool, ToolCategory } from "../tools/catalog.js";
import { formatCatalogForPrompt } from "../tools/catalog.js";
import type { TurnContext } from "../context/turn-context.js";
import type { LlmClient } from "../llm/types.js";
import type { McpToolProvider } from "../mcp/types.js";
import { SUBAGENT_STEP_SYSTEM } from "../prompts/roles.js";
import { runMemorySubagent } from "./agents/memory.js";
import { generateExpressText } from "./language-faculty.js";

export const MAX_SUBAGENT_STEPS = 5;

export const subagentStepSchema = z.object({
  done: z.boolean(),
  tool: z.string().optional(),
  arguments: z.record(z.unknown()).optional(),
  reason: z.string().optional(),
});

export const subagentStepJsonSchema = zodToJsonSchema(subagentStepSchema, {
  name: "SubagentStep",
  $refStrategy: "none",
});

export type SubagentPickInput = {
  category: ToolCategory;
  intent: string;
  catalog: readonly CatalogTool[];
  ctx: TurnContext;
  priorSteps?: string[];
};

export type SubagentPickResult = {
  done: boolean;
  tool?: string;
  arguments?: Record<string, unknown>;
  reason?: string;
};

export async function runSubagentToolPick(
  llm: LlmClient,
  input: SubagentPickInput,
): Promise<SubagentPickResult> {
  const format = subagentStepJsonSchema as Record<string, unknown>;
  const attempts: string[] = [];
  let lastFailure: ParseJsonFailure | undefined;

  for (let attempt = 0; attempt < 2; attempt++) {
    const contextLines: string[] = [];
    const recentTurns = input.ctx.priorTurns.slice(-3);
    if (recentTurns.length > 0) {
      contextLines.push("直近の会話:");
      for (const t of recentTurns) {
        const speaker = t.role === "user" ? (t.speakerId ?? "相手") : "自分";
        contextLines.push(`${speaker}: ${t.content}`);
      }
    }
    if (input.ctx.partnerUtteranceLine) {
      contextLines.push(`現在のターン: ${input.ctx.partnerUtteranceLine}`);
    }

    const raw = await llm.chat(
      [
        { role: "system", content: SUBAGENT_STEP_SYSTEM },
        {
          role: "user",
          content: [
            `カテゴリ: ${input.category}`,
            `意図: ${input.intent}`,
            contextLines.length ? ["", ...contextLines].join("\n") : "",
            "",
            "利用可能なツール:",
            formatCatalogForPrompt(input.catalog),
            input.priorSteps?.length
              ? ["", "これまでのステップ:", ...input.priorSteps].join("\n")
              : "",
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
      { format, temperature: 0 },
    );
    attempts.push(raw);
    const parsed = tryParseJsonWithSchema(raw, subagentStepSchema);
    if (!parsed.ok) {
      lastFailure = parsed.failure;
      continue;
    }
    return parsed.value;
  }

  return {
    done: true,
    reason: errorFromLlmAttempts(
      attempts,
      lastFailure?.reason,
      lastFailure?.zodMessage,
    ).message,
  };
}

async function executeMcpStep(
  mcp: McpToolProvider,
  tool: CatalogTool,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; summary: string; content: string }> {
  if (tool.source !== "mcp" || !tool.server) {
    return { ok: false, summary: "MCPツールではない", content: "" };
  }
  const result = await mcp.callTool(tool.server, tool.name, args);
  return {
    ok: result.ok,
    summary: result.summary,
    content: result.content ?? result.summary,
  };
}

function isNetworkError(summary: string): boolean {
  return /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|に接続できません|-32603/i.test(summary);
}

function findCatalogTool(
  catalog: readonly CatalogTool[],
  name: string,
): CatalogTool | undefined {
  return catalog.find((t) => t.name === name);
}

export async function runResearchSubagent(
  llm: LlmClient,
  input: RunActionInput,
): Promise<ActionOutcome> {
  const action = input.action;
  const catalog = input.toolCatalog ?? [];
  const tools = catalog.filter((t) => t.category === "research");
  if (tools.length === 0) {
    return actionFailed(action, "探索ツールが設定されていない", {
      code: ACTION_ERROR_CODES.ACTION_DISCONNECTED,
      message: "research カテゴリの MCP ツールがない",
    });
  }

  const priorSteps: string[] = [];
  let lastContent = "";
  let lastTool = "";
  let lastSummary = "";
  let lastFailure: { summary: string; content: string } | undefined;

  for (let step = 0; step < MAX_SUBAGENT_STEPS; step++) {
    const pick = await runSubagentToolPick(llm, {
      category: "research",
      intent: action.intent,
      catalog: tools,
      ctx: input.ctx,
      priorSteps,
    });

    if (pick.done || !pick.tool) {
      if (lastContent) break;
      if (lastFailure) {
        return actionFailed(action, "探索ツールの実行に失敗した", {
          code: ACTION_ERROR_CODES.TOOL_FAILED,
          message: lastFailure.summary,
          detail: lastFailure.content,
        });
      }
      return actionSucceeded(
        action,
        pick.reason ?? "探索を完了したが結果がない",
      );
    }

    const tool = findCatalogTool(tools, pick.tool);
    if (!tool) {
      return actionFailed(action, "探索ツールが見つからない", {
        code: ACTION_ERROR_CODES.PICK_FAILED,
        message: `未知のツール: ${pick.tool}`,
      });
    }

    const result = await executeMcpStep(
      input.mcp!,
      tool,
      pick.arguments ?? {},
    );
    priorSteps.push(
      `${pick.tool}: ${result.ok ? "成功" : "失敗"} — ${result.summary}`,
    );

    if (!result.ok) {
      // ネットワーク障害（接続不可・タイムアウト等）はクエリ変更で解決しないので即失敗
      if (isNetworkError(result.summary)) {
        return actionFailed(action, "探索ツールに接続できない", {
          code: ACTION_ERROR_CODES.TOOL_FAILED,
          message: result.summary,
          detail: result.content,
        });
      }
      lastFailure = { summary: result.summary, content: result.content };
      continue;
    }

    lastContent = result.content;
    lastTool = pick.tool;
    lastSummary = result.summary;

    if (pick.done) break;
  }

  if (!lastContent) {
    return actionFailed(action, "探索ツールの実行に失敗した", {
      code: ACTION_ERROR_CODES.TOOL_FAILED,
      message: lastFailure?.summary ?? "探索結果が得られなかった",
      detail: lastFailure?.content,
    });
  }

  return actionSucceeded(action, {
    kind: "research",
    tool: lastTool || "research",
    title: action.intent,
    body: lastContent || lastSummary,
  });
}

export async function runExpressSubagent(
  llm: LlmClient,
  input: RunActionInput,
): Promise<ActionOutcome> {
  const action = input.action;
  const catalog = input.toolCatalog ?? [];
  const tools = catalog.filter((t) => t.category === "express");
  if (tools.length === 0) {
    return actionFailed(action, "発信ツールが設定されていない", {
      code: ACTION_ERROR_CODES.ACTION_DISCONNECTED,
      message: "express カテゴリの MCP ツールがない",
    });
  }

  const pick = await runSubagentToolPick(llm, {
    category: "express",
    intent: action.intent,
    catalog: tools,
    ctx: input.ctx,
  });

  if (pick.done || !pick.tool) {
    return actionFailed(action, "発信ツールを選べなかった", {
      code: ACTION_ERROR_CODES.PICK_FAILED,
      message: pick.reason ?? "ツール未選択",
    });
  }

  const tool = findCatalogTool(tools, pick.tool);
  if (!tool) {
    return actionFailed(action, "発信ツールが見つからない", {
      code: ACTION_ERROR_CODES.PICK_FAILED,
      message: `未知のツール: ${pick.tool}`,
    });
  }

  const args = { ...(pick.arguments ?? {}) };
  if (!args.text && !args.content && !args.message) {
    const composed = await generateExpressText(llm, input.ctx, action.intent);
    if (tool.name === "post_tweet" || tool.name.includes("tweet")) {
      args.text = composed;
    } else {
      args.content = composed;
    }
  }

  if (input.expressDryRun) {
    const preview = String(args.text ?? args.content ?? args.message ?? "");
    return actionSucceeded(action, {
      kind: "express",
      tool: tool.name,
      title: `[dry-run] ${action.intent}`,
      body: preview,
    });
  }

  const result = await executeMcpStep(input.mcp!, tool, args);
  if (!result.ok) {
    return actionFailed(action, "発信ツールの実行に失敗した", {
      code: ACTION_ERROR_CODES.TOOL_FAILED,
      message: result.summary,
      detail: result.content,
    });
  }

  return actionSucceeded(action, {
    kind: "express",
    tool: tool.name,
    title: action.intent,
    body: result.content,
  });
}

export async function runCategorySubagent(
  llm: LlmClient,
  input: RunActionInput,
): Promise<ActionOutcome> {
  const kind = input.action.kind;
  switch (kind) {
    case "memory":
      return runMemorySubagent(llm, input);
    case "research":
      return runResearchSubagent(llm, input);
    case "express":
      return runExpressSubagent(llm, input);
    default:
      return actionFailed(input.action, "未対応のカテゴリ", {
        code: ACTION_ERROR_CODES.ACTION_DISCONNECTED,
        message: `kind: ${kind}`,
      });
  }
}
