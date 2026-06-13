/** 文脈との関連度に応じた提示レベル */
export type RecallPresentation = "vague" | "summarize" | "full";

export type RecalledEpisode = {
  /** コンテキストに載せる本文（フィルター後） */
  presented: string;
  /** 文脈との関連度 0〜1 */
  relevance: number;
  presentation: RecallPresentation;
  /** エピソードの発生時刻（ISO 8601）。提示時に「N分前/N日前」に変換し、
   *  記憶内の相対時刻語（「明日」「さっき」）が"いつ基準か"を分かるようにする */
  occurredAt?: string;
};
