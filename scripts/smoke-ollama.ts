import { OllamaEmbedClient, OllamaLlmClient } from "../src/llm/ollama.js";
import { loadSettings } from "../src/config/settings.js";

// Ollama の疎通確認。設定（config/settings.json）の chatModel / embedModel /
// ollamaHost をそのまま使い、chat と embed が実際に返るかだけ見る軽いスモーク。
// judge は廃止されたので、特定ロールに依存せず生の chat 1往復 + embed で確認する。
const settings = await loadSettings();
const host = process.env.OLLAMA_HOST ?? settings.ollamaHost;

const llm = new OllamaLlmClient({ host, model: settings.chatModel });
const reply = await llm.chat(
  [
    { role: "system", content: "あなたは疎通確認の応答器。短く一言だけ返す。" },
    { role: "user", content: "「ok」とだけ返して。" },
  ],
  { temperature: 0 },
);
console.log(`chat  [${settings.chatModel}] @ ${host}: ${reply.trim().slice(0, 80)}`);

const emb = new OllamaEmbedClient(host, settings.embedModel);
const v = await emb.embed("test");
console.log(`embed [${settings.embedModel}]: dim=${v.length}`);

console.log("smoke OK");
