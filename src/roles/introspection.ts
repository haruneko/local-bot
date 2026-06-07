import {
  renderIntrospectionPrompt,
  type TurnContext,
} from "../context/turn-context.js";
import { INTROSPECTION_SYSTEM } from "../prompts/roles.js";
import type { LlmClient } from "../llm/types.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

export async function runIntrospection(
  llm: LlmClient,
  ctx: TurnContext,
): Promise<string> {
  const prompt = renderIntrospectionPrompt(ctx);
  return llm.chat(
    [
      { role: "system", content: INTROSPECTION_SYSTEM },
      { role: "user", content: prompt },
    ],
    { temperature: 0.6 },
  );
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
