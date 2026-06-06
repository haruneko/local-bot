import type { ChatMessage, ChatOptions, LlmClient } from "./types.js";

export class FakeLlmClient implements LlmClient {
  private readonly responses: string[] = [];
  public calls: { messages: ChatMessage[]; options?: ChatOptions }[] = [];

  constructor(responses: string[]) {
    this.responses = [...responses];
  }

  async chat(
    messages: ChatMessage[],
    options?: ChatOptions,
  ): Promise<string> {
    this.calls.push({ messages, options });
    const next = this.responses.shift();
    if (next === undefined) {
      throw new Error("FakeLlmClient: no more queued responses");
    }
    return next;
  }
}
