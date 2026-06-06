export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ChatOptions = {
  format?: Record<string, unknown> | "json";
  temperature?: number;
};

export interface LlmClient {
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
}
