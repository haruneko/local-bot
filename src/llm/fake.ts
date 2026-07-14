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

  /** 次の queue 応答を ~8 文字ずつのチャンクに割って yield。calls は chat() と同形式で記録。 */
  async *chatStream(
    messages: ChatMessage[],
    options?: ChatOptions,
  ): AsyncIterable<string> {
    this.calls.push({ messages, options });
    const next = this.responses.shift();
    if (next === undefined) {
      throw new Error("FakeLlmClient: no more queued responses");
    }
    const size = 8;
    for (let i = 0; i < next.length; i += size) {
      yield next.slice(i, i + size);
    }
  }
}
