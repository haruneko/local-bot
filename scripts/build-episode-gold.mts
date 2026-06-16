// episode gold のドラフト生成（使い捨てビルダー。出力 json は永続）。
//  1. episodes(733) を重複除去＋時系列で層化サンプル ~30
//  2. 各アンカーについて qwen が「後日この記憶が思い出されるべき状況/問いかけ」を生成
//     （語漏洩ルール: 記憶内の固有名詞・珍しい語をそのまま使わない＝意味検索を測るため）
//  3. eval/episode-recall.gold.draft.json に {query, anchorId, anchorBody} を書く
// 次工程: nomic/bge-m3/ruri-v3 でプール→人が関連判定（graded）→nDCG。
import { writeFile } from "node:fs/promises";
import path from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { lancedbDir } from "../src/config/paths.js";
import { loadSettings } from "../src/config/settings.js";

const N = 30;
const settings = await loadSettings();
const host = process.env.OLLAMA_HOST ?? settings.ollamaHost;
const chatModel = (settings as any).chatModel ?? (settings as any).model ?? "qwen3.6:35b-a3b";

const conn = await lancedb.connect(lancedbDir());
const table = await conn.openTable("episodes");
const rows = (await table.query().toArray()) as any[];
console.error(`episodes 全 ${rows.length} 件`);

// 重複除去（本文先頭28字の正規化キー）＋時系列ソート
const norm = (s: string) => s.replace(/\s+/g, "").slice(0, 28);
const seen = new Set<string>();
const uniq = rows
  .map((r) => ({
    id: r.turnId ?? r.turn_id ?? r.id ?? "",
    body: String(r.body ?? r.text ?? ""),
    ts: String(r.timestamp ?? r.created_at ?? ""),
    importance: r.importance,
  }))
  .filter((r) => r.body.trim().length > 10 && r.id)
  .filter((r) => {
    const k = norm(r.body);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  })
  .sort((a, b) => a.ts.localeCompare(b.ts));
console.error(`重複除去後 ${uniq.length} 件 → ${N} 件を層化サンプル`);

const stride = Math.max(1, Math.floor(uniq.length / N));
const anchors = uniq.filter((_, i) => i % stride === 0).slice(0, N);

async function genQuery(body: string): Promise<string | null> {
  const res = await fetch(`${host}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: chatModel,
      stream: false,
      options: { temperature: 0.3 },
      messages: [
        {
          role: "system",
          content:
            "あなたは検索評価データを作る助手です。出力はクエリ本文のみ、1文の日本語。",
        },
        {
          role: "user",
          content:
            "次は対話エージェント『エバ』の記憶（一人称の内省文）です。\n" +
            "後日、別の会話の中でこの記憶が自然に思い出されるべき『状況・問いかけ』を1つだけ、短い日本語で作ってください。\n" +
            "制約: 記憶内の固有名詞・珍しい語をそのまま使わず、話題や意図で言い換えること。1文。クエリ本文のみ出力。\n\n" +
            "記憶:\n" + body,
        },
      ],
    }),
  });
  if (!res.ok) return null;
  const j = (await res.json()) as any;
  const text = String(j?.message?.content ?? "").trim();
  // think タグや余計な前置きを除去、最初の非空行を採用
  const line = text
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)[0];
  return line ?? null;
}

const out: { query: string; anchorId: string; anchorBody: string }[] = [];
for (let i = 0; i < anchors.length; i++) {
  const a = anchors[i]!;
  const q = await genQuery(a.body);
  if (q) {
    out.push({ query: q, anchorId: a.id, anchorBody: a.body });
    console.error(`  [${i + 1}/${anchors.length}] ${q}`);
  } else {
    console.error(`  [${i + 1}/${anchors.length}] 生成失敗 skip`);
  }
}

const dest = path.join(process.cwd(), "eval", "episode-recall.gold.draft.json");
await writeFile(dest, JSON.stringify({ corpus: "episode", cases: out }, null, 2) + "\n", "utf8");
console.error(`\n書き出し: ${dest}（${out.length} 件）`);
