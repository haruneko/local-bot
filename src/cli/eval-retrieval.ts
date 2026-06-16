import { readFile } from "node:fs/promises";
import path from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { loadSettings } from "../config/settings.js";
import { lancedbDir } from "../config/paths.js";
import { OllamaEmbedClient } from "../llm/ollama.js";
import { embedPrefixFor } from "../llm/embed-prefix.js";
import { ImageBindClient } from "../embedding/xmodal.js";
import { cosineSimilarity } from "../recall/distance.js";
import { reciprocalRankFusion } from "../recall/fuse.js";
import { lexicalRank } from "../recall/lexical.js";
import {
  listNoteFilenames,
  readNoteContent,
  truncateNotePreview,
} from "../tools/notes.js";
import { INDEX_FILENAME } from "../memo/tree.js";

/**
 * 想起評価ハーネス（永続）。候補 embedding モデルを memo locate の gold set で横並び採点する。
 * 当て推量で embed を差し替えるのを避け、Recall@k / MRR で実証比較するための体温計。
 *
 *   npm run eval:retrieval                         # 既定モデル（settings.embedModel）で採点
 *   npm run eval:retrieval -- --model nomic-embed-text:latest --model bge-m3
 *   npm run eval:retrieval -- --model imagebind    # ImageBind のテキスト側（port 8800）
 *   オプション: --gold <path> / --topk 8 / --embed-target path+preview|content / --worst
 *
 * embed-target=path+preview（既定）は本番 memo_index と同じ「パス＋冒頭200字」を埋め込む＝本番再現。
 * content はパスを混ぜず本文だけ＝「パス語への依存（レキシカル退化）」を切り分ける ablation。
 */

type Embed = (text: string) => Promise<number[] | null>;
type GoldCase = { query: string; expect?: string[]; anchorId?: string; kind?: string; holdout?: boolean };
type Gold = { cases: GoldCase[] };
type Doc = { path: string; embedText: string };

/**
 * モデル別のタスク接頭辞（query/document）。本番（bootstrap）と同じ embedPrefixFor を使う＝
 * 単一情報源。付け忘れると nomic/ruri/e5 は本来の性能が出ない。`--no-prefix` で無効化できる。
 */
function prefixFor(model: string, noPrefix: boolean): { q: string; d: string } {
  if (noPrefix) return { q: "", d: "" };
  const p = embedPrefixFor(model);
  return { q: p.query, d: p.doc };
}

function makeEmbedder(model: string, host: string): Embed {
  if (model === "imagebind" || model === "xmodal") {
    const c = new ImageBindClient({
      host: process.env.IMAGEBIND_HOST ?? "http://localhost:8800",
    });
    return (t) => c.embed({ kind: "text", text: t });
  }
  const c = new OllamaEmbedClient(host, model);
  return async (t) => {
    try {
      return await c.embed(t);
    } catch {
      return null;
    }
  };
}

async function buildCorpus(embedTarget: string): Promise<Doc[]> {
  const files = await listNoteFilenames();
  const docs: Doc[] = [];
  for (const f of files) {
    if (f.endsWith(INDEX_FILENAME)) continue;
    const content = await readNoteContent(f);
    if (content === null || !content.trim()) continue;
    const preview = truncateNotePreview(content, 200);
    const embedText =
      embedTarget === "content" ? content : `${f} ${preview}`;
    docs.push({ path: f, embedText });
  }
  return docs;
}

/** episode コーパス: LanceDB episodes の本文を全件。doc 識別子＝turnId。ファイル名は無い＝純粋な意味検索。 */
async function buildEpisodeCorpus(): Promise<Doc[]> {
  const conn = await lancedb.connect(lancedbDir());
  const rows = (await (await conn.openTable("episodes")).query().toArray()) as Record<string, unknown>[];
  const docs: Doc[] = [];
  for (const r of rows) {
    const id = String(r.turnId ?? r.turn_id ?? r.id ?? "");
    const body = String(r.body ?? r.text ?? "");
    if (id && body.trim()) docs.push({ path: id, embedText: body });
  }
  return docs;
}

/** expect のどれかが最初に現れる順位（0始まり）。見つからなければ null */
function bestRank(ranked: string[], expect: string[]): number | null {
  const want = new Set(expect);
  for (let i = 0; i < ranked.length; i++) {
    if (want.has(ranked[i]!)) return i;
  }
  return null;
}

type ModelScore = {
  model: string;
  byKind: Map<string, { n: number; r1: number; r3: number; r8: number; mrr: number }>;
  worst: { query: string; kind: string; rank: number | null; top: string }[];
};

async function scoreModel(
  model: string,
  host: string,
  docs: Doc[],
  gold: Gold,
  topk: number,
  prefix: { q: string; d: string },
  hybrid: boolean,
): Promise<ModelScore | null> {
  const embed = makeEmbedder(model, host);
  // corpus を埋め込む（失敗＝このモデルは計測不能）
  const docVecs: { path: string; vec: number[] }[] = [];
  for (const d of docs) {
    const v = await embed(prefix.d + d.embedText);
    if (!v) {
      console.error(`  ! ${model}: corpus embed 失敗（${d.path}）→ skip model`);
      return null;
    }
    docVecs.push({ path: d.path, vec: v });
  }

  const byKind = new Map<string, { n: number; r1: number; r3: number; r8: number; mrr: number }>();
  const bump = (k: string) =>
    byKind.get(k) ?? byKind.set(k, { n: 0, r1: 0, r3: 0, r8: 0, mrr: 0 }).get(k)!;
  const worst: ModelScore["worst"] = [];

  for (const c of gold.cases) {
    const qv = await embed(prefix.q + c.query);
    const kind = c.kind ?? "?";
    if (!qv) continue;
    const ranked = docVecs
      .map((d) => ({ path: d.path, sim: cosineSimilarity(qv, d.vec) }))
      .sort((a, b) => b.sim - a.sim);
    // hybrid: 意味(ベクトル)順位＋字句(ファイル名)順位を RRF 融合
    const order = hybrid
      ? reciprocalRankFusion([
          ranked.map((r) => r.path),
          lexicalRank(c.query, docs.map((d) => ({ key: d.path, text: d.path })), 0.4),
        ]).map((f) => f.turnId)
      : ranked.map((r) => r.path);
    const rank = bestRank(order, c.expect ?? []);
    const buckets = [bump(kind), bump("ALL")];
    if (c.holdout) buckets.push(bump("holdout"));
    for (const acc of buckets) {
      acc.n++;
      if (rank !== null) {
        if (rank < 1) acc.r1++;
        if (rank < 3) acc.r3++;
        if (rank < topk) acc.r8++;
        acc.mrr += 1 / (rank + 1);
      }
    }
    if (rank === null || rank >= 3) {
      worst.push({ query: c.query, kind, rank, top: ranked[0]?.path ?? "—" });
    }
  }
  return { model, byKind, worst };
}

function pct(x: number, n: number): string {
  return n === 0 ? "  -  " : `${Math.round((100 * x) / n)}%`.padStart(5);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const get = (flag: string, def?: string) => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? args[i + 1]! : def;
  };
  const models: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--model" && args[i + 1]) models.push(args[++i]!);
  }
  const settings = await loadSettings();
  const host = process.env.OLLAMA_HOST ?? settings.ollamaHost;
  if (models.length === 0) models.push(settings.embedModel);
  const corpus = get("--corpus", "memo")!;
  const goldPath = get("--gold", corpus === "episode" ? "eval/episode-recall.gold.draft.json" : "eval/memo-locate.gold.json")!;
  const topk = Number(get("--topk", "8"));
  const embedTarget = get("--embed-target", "path+preview")!;
  const showWorst = args.includes("--worst");
  const noPrefix = args.includes("--no-prefix");
  const hybrid = args.includes("--hybrid");

  const gold = JSON.parse(
    await readFile(path.join(process.cwd(), goldPath), "utf8"),
  ) as Gold;
  // anchorId しか持たない episode gold は expect=[anchorId] に正規化（アンカー想起 Recall を測る）。
  for (const c of gold.cases) {
    if (!c.expect && c.anchorId) c.expect = [c.anchorId];
  }
  const docs = corpus === "episode" ? await buildEpisodeCorpus() : await buildCorpus(embedTarget);
  console.error(
    `eval:retrieval — corpus=${corpus} ${docs.length}件 / gold ${gold.cases.length}件 / embed-target=${embedTarget} / topk=${topk}`,
  );

  const scores: ModelScore[] = [];
  for (const m of models) {
    const prefix = prefixFor(m, noPrefix);
    const pfxLabel = prefix.q || prefix.d ? `prefix: q="${prefix.q}" d="${prefix.d}"` : "prefix: なし";
    console.error(`\n■ ${m} を採点中…（${pfxLabel}）`);
    const s = await scoreModel(m, host, docs, gold, topk, prefix, hybrid);
    if (s) scores.push(s);
  }

  // サマリ表（kind 別）
  const kinds = ["ALL", "name", "topical", "disambig", "oblique", "holdout"];
  console.error(`\n=== 結果（Recall@1 / @3 / @${topk} / MRR）===`);
  for (const k of kinds) {
    console.error(`\n[${k}]`);
    console.error(`  ${"model".padEnd(36)}  R@1   R@3   R@${topk}  MRR`);
    for (const s of scores) {
      const a = s.byKind.get(k);
      if (!a) continue;
      console.error(
        `  ${s.model.padEnd(36)}  ${pct(a.r1, a.n)} ${pct(a.r3, a.n)} ${pct(a.r8, a.n)}  ${(a.mrr / a.n).toFixed(2)}`,
      );
    }
  }

  if (showWorst) {
    for (const s of scores) {
      console.error(`\n=== ${s.model} の取りこぼし（rank≥3 / 圏外）===`);
      for (const w of s.worst) {
        console.error(
          `  [${w.kind}] rank=${w.rank === null ? "圏外" : w.rank + 1}  「${w.query}」→ top: ${w.top}`,
        );
      }
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
