import { OllamaEmbedClient, OllamaLlmClient } from "../src/llm/ollama.js";
import { createTurnContext } from "../src/context/turn-context.js";
import { runJudge } from "../src/roles/judge.js";

const host = process.env.OLLAMA_HOST ?? "http://192.168.16.1:11434";

const llm = new OllamaLlmClient({ host, model: "gemma4:e4b" });
const ctx = createTurnContext({
  turnId: "smoke",
  state: "対話",
  trigger: {
    type: "user_message",
    content: "こんにちは",
    speakerId: "user_001",
  },
  dialogue: {
    resolveUserDisplayName: () => "ユーザー",
  },
  recentTurns: [
    { role: "user", speakerId: "user_001", content: "こんにちは" },
  ],
  recalledEpisodes: [],
  now: new Date(),
});

const judge = await runJudge(llm, ctx);
console.log("judge:", judge);

const emb = new OllamaEmbedClient(host, "nomic-embed-text:latest");
const v = await emb.embed("test");
console.log("embed dim:", v.length);
