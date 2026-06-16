// 2 チャンネル（nomic テキスト空間 / ImageBind 横断空間）の想起を融合する。
// nomic 距離と ImageBind 距離は物差しが違う＝生スコアを足すのは脆い。順位だけ使う
// Reciprocal Rank Fusion（異種 retriever 融合の定石）で逃げる。
// 設計: docs/ARCH-NEXT.md「横断 embedding の設計」④ recall の2空間マージ。

export type FusedTurn = { turnId: string; score: number };

/**
 * Reciprocal Rank Fusion。各チャンネルは「近い順に並んだ turnId 配列」。
 * turnId のスコア = Σ 1/(k + rank)（rank は 0 始まり）。同じ turnId が複数チャンネルに
 * 出れば加算され上位に来る。スコア降順で返す（同点は最初に出た順で安定）。
 *
 * @param channels 近い順の turnId 配列の配列（空配列・空チャンネルは無視）
 * @param k ランク定数（既定 60・標準値）。大きいほど上位順位の優位が緩む。
 */
export function reciprocalRankFusion(
  channels: ReadonlyArray<ReadonlyArray<string>>,
  k = 60,
): FusedTurn[] {
  const scores = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  let order = 0;
  for (const channel of channels) {
    for (let rank = 0; rank < channel.length; rank++) {
      const turnId = channel[rank];
      if (!turnId) continue;
      scores.set(turnId, (scores.get(turnId) ?? 0) + 1 / (k + rank));
      if (!firstSeen.has(turnId)) firstSeen.set(turnId, order++);
    }
  }
  return [...scores.entries()]
    .map(([turnId, score]) => ({ turnId, score }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (firstSeen.get(a.turnId) ?? 0) - (firstSeen.get(b.turnId) ?? 0);
    });
}
