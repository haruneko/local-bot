/** 文脈との関連度に応じた提示レベル */
export type RecallPresentation = "vague" | "summarize" | "full";

export type RecalledEpisode = {
  /** コンテキストに載せる本文（フィルター後） */
  presented: string;
  /** 文脈との関連度 0〜1 */
  relevance: number;
  presentation: RecallPresentation;
};
