import type { ActionErrorInfo } from "./action/error.js";
import type { ActionFacts } from "./action/facts.js";
import type { AbstractAction } from "./action/types.js";

export type { ActionErrorInfo };

export type AgentState = string;

export type JudgeOutput = {
  ACTION: AbstractAction;
  REPLY: boolean;
  NEXT_STATE: string;
};

export type ActionOutcome =
  | { attempted: false }
  | {
      attempted: true;
      kind: AbstractAction["kind"];
      intent: string;
      status: "succeeded" | "failed";
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
};
