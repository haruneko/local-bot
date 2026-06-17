import type { ActionErrorInfo } from "./action/error.js";
import type { ActionFacts } from "./action/facts.js";
import type { AbstractAction } from "./action/types.js";

export type { ActionErrorInfo };

export type AgentState = string;

export type ActionOutcome =
  | { attempted: false }
  | {
      attempted: true;
      kind: AbstractAction["kind"];
      intent: string;
      status: "succeeded" | "failed";
      /** 細かい op（recall/forget/memo_read/… ＝ facts.kind と同じ語彙）。
       *  成功は facts.kind 由来、失敗時も明示して載せる＝失敗の文言を op 別に出せる。 */
      op?: ActionFacts["kind"];
      /** 成功時の構造化事実（言語野・内省はこちらを参照） */
      facts?: ActionFacts;
      /** verbose/ログ用（成功時は facts から生成、失敗時は原因コード・詳細含む） */
      summary: string;
      /** status === "failed" のとき構造化エラー */
      error?: ActionErrorInfo;
    };

export type ConversationTurn = {
  role: "user" | "assistant";
  speakerId?: string;
  content: string;
  /** 省略時は dialogue（ユーザー向け）。heartbeat 独り言は monologue */
  channel?: "dialogue" | "monologue";
  /** append 時に自動付与される ISO 8601 タイムスタンプ */
  createdAt?: string;
};

export type EpisodeSource = "remember" | "introspection";

export type EpisodeMetadata = {
  timestamp: string;
  participants: string[];
  tags: string[];
  state: AgentState;
  action: string;
  source: EpisodeSource;
  reply: boolean;
  turnId: string;
  /** 重要度スコア 1-10。内省 LLM が採点。未設定時は 5（中立）扱い */
  importance?: number;
  /** 裏打ちのある事実記録（コードが行動結果＋相手発話から機械生成・埋め込まない）。
   *  夢の蒸留が turnId 経由で引いて、作話を含みうる本文でなくこれから蒸留する＝符号化ロンダリング対策
   *  （DECISIONS §②符号化側のロンダリング対策）。本文(body)の想起は無傷のまま。 */
  groundedFacts?: string;
};
