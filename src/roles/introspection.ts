import {
  buildReflectionMessages,
  type TurnContext,
} from "../context/turn-context.js";
import { INTROSPECTION_SYSTEM } from "../prompts/roles.js";
import type { ChatMessage, LlmClient } from "../llm/types.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { tryParseJsonWithSchema } from "../action/parse-json.js";

export type IntrospectionOutput = {
  text: string;
  importance: number;
};

const introspectionSchema = z.object({
  text: z.string(),
  importance: z.number().int().min(1).max(10),
});

const introspectionJsonSchema = zodToJsonSchema(introspectionSchema, {
  name: "IntrospectionOutput",
  $refStrategy: "none",
}) as Record<string, unknown>;

export async function runIntrospection(
  llm: LlmClient,
  ctx: TurnContext,
): Promise<IntrospectionOutput> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: `${INTROSPECTION_SYSTEM}\n\n（状況: ${ctx.state} / ${ctx.currentDateTime}）`,
    },
    ...buildReflectionMessages(ctx),
    {
      role: "user",
      content:
        "上のやり取り（あなた自身=assistant の発言・行動と、相手=user の発言）を振り返り、一人称の内省を書いてください。",
    },
  ];
  const raw = await llm.chat(messages, {
    format: introspectionJsonSchema,
    temperature: 0.6,
  });
  const parsed = tryParseJsonWithSchema(raw, introspectionSchema);
  if (parsed.ok) return parsed.value;
  // フォールバック: テキストがそのまま返ってきた場合
  return { text: raw.trim(), importance: 5 };
}

const tagsSchema = z.object({ tags: z.array(z.string()).max(4) });
const tagsJsonSchema = zodToJsonSchema(tagsSchema, {
  name: "EpisodeTags",
  $refStrategy: "none",
}) as Record<string, unknown>;

const TAG_EXTRACT_SYSTEM =
  `内省テキストを読み、話題・出来事を表す日本語の名詞タグを 2〜4 個抽出してください。` +
  `固有名詞・行動・感情は使わず、トピックを示す短い名詞のみ。JSON で返す。`;

export async function extractEpisodeTags(
  llm: LlmClient,
  introspection: string,
): Promise<string[]> {
  if (!introspection.trim()) return [];
  try {
    const raw = await llm.chat(
      [
        { role: "system", content: TAG_EXTRACT_SYSTEM },
        { role: "user", content: introspection },
      ],
      { format: tagsJsonSchema, temperature: 0 },
    );
    const parsed = tagsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.tags : [];
  } catch {
    return [];
  }
}
