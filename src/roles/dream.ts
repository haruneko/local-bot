import { tryParseJsonWithSchema } from "../action/parse-json.js";
import type { EpisodeRecord, EpisodeStore } from "../memory/episode.js";
import type { SemanticSeedEntry } from "../memory/semantic-seed.js";
import type { SemanticStore } from "../memory/semantic.js";
import type { LlmClient } from "../llm/types.js";
import { DREAM_DISTILL_SYSTEM } from "../prompts/roles.js";
import {
  dreamDistillJsonSchema,
  dreamDistillOutputSchema,
} from "../prompts/schemas.js";
import {
  defaultDreamStatePath,
  loadDreamState,
  saveDreamState,
} from "../state/dream-state.js";
import type { MemoIndexStore } from "../memory/memo-index.js";
import {
  listNoteFilenames,
  readNoteContent,
  truncateNotePreview,
} from "../tools/notes.js";

export type RunDreamInput = {
  llm: LlmClient;
  episodes: EpisodeStore;
  semantic: SemanticStore;
  /** あれば distill 実行時に data/notes/ をスキャンし、memo_index 未登録の本文を upsert
   *  （外部から置かれたメモの取り込み）。LLM 不要（preview は機械的に切るだけ） */
  memoIndex?: MemoIndexStore;
  dreamStatePath?: string;
  minEpisodes?: number;
  /** 夢のタネ（内省風断片）。applySeed=true のとき蒸留入力に含める */
  seed?: readonly SemanticSeedEntry[];
  applySeed?: boolean;
  /** seedAppliedAt があってもタネを再蒸留する */
  forceSeed?: boolean;
  now?: Date;
};

export type DreamResult = {
  ran: boolean;
  skippedReason?: string;
  episodesProcessed: number;
  seedProcessed: number;
  factsUpserted: number;
  lastDreamAt: string | null;
  seedAppliedAt: string | null;
  /** memo_index に新規取り込みしたメモ数（distill 実行時のみ・memoIndex 未指定なら 0） */
  memoIndexSynced?: number;
};

/** data/notes/ をスキャンし、memo_index 未登録の本文を upsert（LLM 不要・preview は機械切り）。
 *  外部から data/notes/ に置かれたメモを所在記憶に取り込む。戻り値 = 新規取り込み数。 */
async function syncMemoIndex(memoIndex: MemoIndexStore): Promise<number> {
  const files = await listNoteFilenames();
  const indexed = new Set((await memoIndex.list()).map((e) => e.path));
  const now = new Date().toISOString();
  let added = 0;
  for (const path of files) {
    if (indexed.has(path)) continue;
    const body = (await readNoteContent(path)) ?? "";
    if (!body.trim()) continue;
    await memoIndex.upsert({
      path,
      preview: truncateNotePreview(body, 200),
      createdAt: now,
      updatedAt: now,
    });
    added += 1;
  }
  return added;
}

function buildDreamUserContent(
  episodes: readonly EpisodeRecord[],
  seed: readonly SemanticSeedEntry[],
): string {
  const parts: string[] = [];

  if (seed.length > 0) {
    const seedBlocks = seed
      .map((entry, i) => {
        const tagLine =
          entry.tags && entry.tags.length > 0
            ? ` (tags: ${entry.tags.join(", ")})`
            : "";
        return `--- seed ${i + 1}${tagLine}\n${entry.body.trim()}`;
      })
      .join("\n\n");
    parts.push("## 夢のタネ（初期素材）", seedBlocks, "");
  }

  if (episodes.length > 0) {
    const episodeBlocks = episodes
      // 作話を含みうる本文(body)でなく、裏打ちのある事実記録(groundedFacts)から蒸留する。
      // 無い場合（旧エピソード等）は body にフォールバック（符号化ロンダリング対策・DECISIONS §②）。
      .map((ep, i) => {
        const material = ep.metadata.groundedFacts?.trim() || ep.body.trim();
        return `--- ${i + 1} (turnId: ${ep.metadata.turnId}, at: ${ep.metadata.timestamp})\n${material}`;
      })
      .join("\n\n");
    parts.push("## 蒸留対象のエピソード", episodeBlocks);
  }

  return parts.join("\n");
}

export async function runDream(input: RunDreamInput): Promise<DreamResult> {
  const dreamStatePath = input.dreamStatePath ?? defaultDreamStatePath();
  const minEpisodes = input.minEpisodes ?? 3;
  const now = input.now ?? new Date();
  const dreamState = await loadDreamState(dreamStatePath);
  const seed = input.seed ?? [];

  const includeSeed =
    input.applySeed === true &&
    seed.length > 0 &&
    (input.forceSeed === true || dreamState.seedAppliedAt === null);

  const episodes = await input.episodes.listSince(
    dreamState.lastDreamAt ?? undefined,
  );

  const canRun = episodes.length >= minEpisodes || includeSeed;
  if (!canRun) {
    return {
      ran: false,
      skippedReason: `episodes ${episodes.length} < min ${minEpisodes}（タネ未指定または適用済み）`,
      episodesProcessed: episodes.length,
      seedProcessed: 0,
      factsUpserted: 0,
      lastDreamAt: dreamState.lastDreamAt,
      seedAppliedAt: dreamState.seedAppliedAt,
    };
  }

  const format = dreamDistillJsonSchema as Record<string, unknown>;
  const userContent = buildDreamUserContent(
    episodes,
    includeSeed ? seed : [],
  );

  let parsed = tryParseJsonWithSchema("", dreamDistillOutputSchema);
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await input.llm.chat(
      [
        { role: "system", content: DREAM_DISTILL_SYSTEM },
        {
          role: "user",
          content:
            attempt === 0
              ? userContent
              : `${userContent}\n\n（注意: 前回の JSON が不正でした。tags は ["a","b"] 形式。,= や余分な記号を入れないこと。）`,
        },
      ],
      { format, temperature: 0 },
    );
    parsed = tryParseJsonWithSchema(raw, dreamDistillOutputSchema);
    if (parsed.ok) break;
    if (attempt === 1) {
      const detail = parsed.failure.zodMessage ?? parsed.failure.reason;
      console.warn("[dream] distill parse failed", detail, parsed.failure.rawPreview);
      return {
        ran: false,
        skippedReason: `LLM distill parse failed (${detail})`,
        episodesProcessed: episodes.length,
        seedProcessed: includeSeed ? seed.length : 0,
        factsUpserted: 0,
        lastDreamAt: dreamState.lastDreamAt,
        seedAppliedAt: dreamState.seedAppliedAt,
      };
    }
  }

  if (!parsed.ok) {
    return {
      ran: false,
      skippedReason: "LLM distill parse failed",
      episodesProcessed: episodes.length,
      seedProcessed: includeSeed ? seed.length : 0,
      factsUpserted: 0,
      lastDreamAt: dreamState.lastDreamAt,
      seedAppliedAt: dreamState.seedAppliedAt,
    };
  }

  let factsUpserted = 0;
  const sourceIds = [
    ...episodes.map((ep) => ep.metadata.turnId),
    ...(includeSeed ? seed.map((_, i) => `seed:${i + 1}`) : []),
  ];
  for (const fact of parsed.value.facts) {
    const body = fact.body.trim();
    if (!body) continue;
    await input.semantic.upsert({
      body,
      tags: fact.tags ?? [],
      sourceEpisodeIds: sourceIds,
    });
    factsUpserted += 1;
  }

  const lastDreamAt =
    episodes.length > 0 ? now.toISOString() : dreamState.lastDreamAt;
  const seedAppliedAt = includeSeed
    ? now.toISOString()
    : dreamState.seedAppliedAt;
  const allFacts = await input.semantic.list();
  await saveDreamState(dreamStatePath, {
    lastDreamAt,
    seedAppliedAt,
    factCount: allFacts.length,
  });

  // distill 実行時に memo_index を同期（外部から置かれたメモの取り込み）。あれば。
  const memoIndexSynced = input.memoIndex
    ? await syncMemoIndex(input.memoIndex)
    : 0;

  return {
    ran: true,
    episodesProcessed: episodes.length,
    seedProcessed: includeSeed ? seed.length : 0,
    factsUpserted,
    lastDreamAt,
    seedAppliedAt,
    memoIndexSynced,
  };
}
