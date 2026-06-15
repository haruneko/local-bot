export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
  /** マルチモーダル: 生の画像（base64・文字起こししない）。vision モデルがそのまま見る */
  images?: string[];
};

export type ChatOptions = {
  format?: Record<string, unknown> | "json";
  temperature?: number;
  /** Ollama num_predict: 生成トークン上限。-1 = 無制限 */
  numPredict?: number;
};

export interface LlmClient {
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
}
