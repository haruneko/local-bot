// 字句一致チャンネル（hybrid 検索の lexical 側）。
// ベクトル想起(意味)は「名前そのまま」クエリに弱い＝クエリにファイル名/パスの語が
// 含まれる場合は字句で拾う方が確実。文字バイグラムの Dice 係数で言語非依存に近づける
// （日本語は空白分かち書きが無いので単語トークンより文字 n-gram が頑健）。
// ベクトル側とは reciprocalRankFusion（src/recall/fuse.ts）で順位融合する。

/** 文字バイグラム集合（長さ1の語は単体も足す）。 */
function bigrams(s: string): Set<string> {
  const t = s.toLowerCase().replace(/\s+/g, "");
  const out = new Set<string>();
  if (t.length === 1) out.add(t);
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

/** Dice 係数 = 2|A∩B| / (|A|+|B|)。0〜1。 */
export function bigramDice(a: string, b: string): number {
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size);
}

export type LexicalItem = { key: string; text: string };

/**
 * query と各 item.text（ファイルパス/名前など）の字句近さで降順ランキング。
 * スコア 0（全く重ならない）は落とす。返すのは key の配列（fuse に渡す用）。
 */
export function lexicalRank(
  query: string,
  items: readonly LexicalItem[],
  minScore = 0,
): string[] {
  return items
    .map((it) => ({ key: it.key, score: bigramDice(query, it.text) }))
    .filter((r) => r.score > minScore)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.key);
}
