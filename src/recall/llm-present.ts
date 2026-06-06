import { tryParseJsonWithSchema } from "../action/parse-json.js";
import type { LlmClient } from "../llm/types.js";
import {
  RECALL_ACTION_SYSTEM,
  RECALL_PRESENT_SUMMARIZE_SYSTEM,
} from "../prompts/roles.js";
import {
  recallActionJsonSchema,
  recallActionOutputSchema,
  recallPresentSummarizeJsonSchema,
  recallPresentSummarizeOutputSchema,
} from "../prompts/schemas.js";
import type { EpisodeRecallHit } from "../memory/episode.js";
import {
  classifyRecallHits,
  resolvePresentedMechanical,
  type ClassifiedRecallHit,
  type RecallDistanceThresholds,
} from "./distance.js";
import type { RecalledEpisode } from "./types.js";

export type RecallSituation = {
  state: string;
  currentDateTime: string;
  /** いまのきっかけ（相手発話 or ハートビート） */
  triggerLabel: string;
  recallQuery: string;
};

function buildSituationBlock(situation: RecallSituation): string {
  return [
    `状態: ${situation.state}`,
    `日時: ${situation.currentDateTime}`,
    `いまのきっかけ: ${situation.triggerLabel}`,
    `想起クエリ: ${situation.recallQuery}`,
  ].join("\n");
}

function buildSummarizeUserContent(
  situation: RecallSituation,
  hits: readonly ClassifiedRecallHit[],
): string {
  const items = hits
    .filter((h) => h.presentation === "summarize")
    .map((h) => `--- id: ${h.id}\n原文:\n${h.body.trim()}`)
    .join("\n\n");

  return [
    "## いまの作業状況",
    buildSituationBlock(situation),
    "",
    "## 記憶の断片（summarize）",
    items,
  ].join("\n");
}

async function llmPresentSummarizeHits(
  llm: LlmClient,
  hits: readonly ClassifiedRecallHit[],
  situation: RecallSituation,
): Promise<Map<number, string>> {
  const toSummarize = hits.filter((h) => h.presentation === "summarize");
  if (toSummarize.length === 0) return new Map();

  const format = recallPresentSummarizeJsonSchema as Record<string, unknown>;
  const raw = await llm.chat(
    [
      { role: "system", content: RECALL_PRESENT_SUMMARIZE_SYSTEM },
      { role: "user", content: buildSummarizeUserContent(situation, hits) },
    ],
    { format, temperature: 0 },
  );

  const parsed = tryParseJsonWithSchema(raw, recallPresentSummarizeOutputSchema);
  if (!parsed.ok) return new Map();

  const map = new Map<number, string>();
  for (const item of parsed.value.items) {
    map.set(item.id, item.presented);
  }
  return map;
}

function assembleRecalledEpisodes(
  classified: readonly ClassifiedRecallHit[],
  llmSummarized: Map<number, string>,
): RecalledEpisode[] {
  const result: RecalledEpisode[] = [];

  for (const hit of classified) {
    let presented: string | null;

    if (hit.presentation === "full") {
      presented = hit.body.trim() || null;
    } else if (hit.presentation === "vague") {
      presented = resolvePresentedMechanical("vague", hit.body);
    } else {
      const fromLlm = llmSummarized.get(hit.id);
      if (fromLlm !== undefined) {
        presented = fromLlm.trim() || null;
      } else {
        presented = resolvePresentedMechanical("summarize", hit.body);
      }
    }

    if (!presented) continue;

    result.push({
      presented,
      relevance: hit.relevance,
      presentation: hit.presentation,
    });
  }

  return result.sort((a, b) => b.relevance - a.relevance);
}

/** 距離分類 → summarize は LLM、vague は機械固定 → RecalledEpisode */
export async function presentRecallEpisodes(
  llm: LlmClient,
  hits: readonly EpisodeRecallHit[],
  situation: RecallSituation,
  thresholds: RecallDistanceThresholds,
): Promise<RecalledEpisode[]> {
  const classified = classifyRecallHits(hits, thresholds);
  const llmSummarized = await llmPresentSummarizeHits(llm, classified, situation);
  return assembleRecalledEpisodes(classified, llmSummarized);
}

export async function summarizeRecallActionHits(
  llm: LlmClient,
  intent: string,
  hits: readonly EpisodeRecallHit[],
): Promise<string[]> {
  if (hits.length === 0) return [];

  const blocks = hits
    .map((hit, i) => `--- ${i + 1}\n${hit.body.trim()}`)
    .join("\n\n");

  const format = recallActionJsonSchema as Record<string, unknown>;
  const raw = await llm.chat(
    [
      { role: "system", content: RECALL_ACTION_SYSTEM },
      {
        role: "user",
        content: [`意図: ${intent}`, "", "## 検索ヒット", blocks].join("\n"),
      },
    ],
    { format, temperature: 0 },
  );

  const parsed = tryParseJsonWithSchema(raw, recallActionOutputSchema);
  if (!parsed.ok) {
    return hits.map((hit) => resolvePresentedMechanical("summarize", hit.body) ?? hit.body.trim());
  }

  return parsed.value.bullets.map((b) => b.trim()).filter(Boolean);
}
