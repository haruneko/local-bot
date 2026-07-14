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
  /** ストリーミング生成。yield は content の差分。全差分の連結 = chat() が返す文字列と同等。
   *  未実装のクライアントでは undefined（呼び出し側が chat() にフォールバックする）。 */
  chatStream?(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<string>;
}
