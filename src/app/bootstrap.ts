import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  loadSettings,
  resolveOllamaThink,
  resolveRecallDistanceThresholds,
  type AppSettings,
} from "../config/settings.js";
import { createUserResolver, loadUsers } from "../config/users.js";
import { TurnOrchestrator } from "../orchestrator/turn.js";
import { WorkingMemory } from "../memory/working.js";
import { LanceEpisodeStore } from "../memory/lancedb.js";
import { InMemoryEpisodeStore } from "../memory/episode.js";
import { OllamaEmbedClient, OllamaLlmClient } from "../llm/ollama.js";
import { withVerboseLlm } from "../llm/logging.js";
import { runAction } from "../roles/action.js";
import type { EpisodeStore } from "../memory/episode.js";
import type { LlmClient } from "../llm/types.js";
import { createVerboseLogger } from "../util/verbose.js";
import type { VerboseLogger } from "../util/verbose.js";
import {
  defaultStatePath,
  loadSession,
  saveSession,
} from "../state/persist.js";
import type { AgentState, ConversationTurn } from "../types.js";

export type AppContext = {
  settings: AppSettings;
  orchestrator: TurnOrchestrator;
  speakerId: string;
  verbose: VerboseLogger;
};

export type BootstrapOptions = {
  speakerId?: string;
  memory?: "lance" | "memory";
  verbose?: boolean;
  /** 省略時 data/state.json。false で永続化しない */
  statePath?: string | false;
};

function resolveOllamaHost(settings: AppSettings): string {
  return process.env.OLLAMA_HOST ?? settings.ollamaHost;
}

export async function createApp(
  options: BootstrapOptions = {},
): Promise<AppContext> {
  const settings = await loadSettings();
  const host = resolveOllamaHost(settings);
  const verboseLogger = options.verbose ? createVerboseLogger() : null;
  const think = resolveOllamaThink(settings);
  let llm: LlmClient = new OllamaLlmClient({
    host,
    model: settings.chatModel,
    think,
  });
  if (verboseLogger) {
    llm = withVerboseLlm(llm, verboseLogger);
  }

  let episodes: EpisodeStore;
  if (options.memory === "memory") {
    episodes = new InMemoryEpisodeStore();
  } else {
    const embedder = new OllamaEmbedClient(host, settings.embedModel);
    const dbPath = path.join(process.cwd(), "data", "lancedb");
    episodes = await LanceEpisodeStore.open(dbPath, embedder);
  }

  const personaPath = path.join(process.cwd(), "persona", "character.md");
  const personaText = await readFile(personaPath, "utf8");
  const users = await loadUsers();
  const resolveUserDisplayName = createUserResolver(users);
  const statePath =
    options.statePath === false ? null : (options.statePath ?? defaultStatePath());
  const session = statePath
    ? await loadSession(statePath)
    : { state: "対話" as AgentState, workingMemory: [] as const };
  const wm = new WorkingMemory(
    settings.workingMemoryTurns,
    session.workingMemory,
  );
  const persistSession = statePath
    ? async (next: {
        state: AgentState;
        workingMemory: readonly ConversationTurn[];
      }) => saveSession(statePath, next)
    : undefined;

  const orchestrator = new TurnOrchestrator(session.state, {
    llm,
    episodes,
    workingMemory: wm,
    episodeRecallTopK: settings.episodeRecallTopK,
    recallDistanceThresholds: resolveRecallDistanceThresholds(settings),
    contextTokenBudget: settings.contextTokenBudget,
    timeZone: settings.timeZone ?? "Asia/Tokyo",
    getPersona: async () => personaText,
    dialogue: { resolveUserDisplayName },
    runAction: (input) => runAction(llm, input),
    onSessionPersist: persistSession,
    verbose: verboseLogger ?? undefined,
  });

  verboseLogger?.startup({
    ollamaHost: host,
    chatModel: settings.chatModel,
    ollamaThink: think,
    embedModel: settings.embedModel,
    memory: options.memory ?? "lance",
    workingMemoryTurns: settings.workingMemoryTurns,
    contextTokenBudget: settings.contextTokenBudget,
    episodeRecallTopK: settings.episodeRecallTopK,
    statePath: statePath ?? "(in-memory)",
    initialState: session.state,
    workingMemoryTurnsLoaded: session.workingMemory.length,
  });

  return {
    settings,
    orchestrator,
    speakerId: options.speakerId ?? "user_001",
    verbose: verboseLogger ?? { enabled: false },
  };
}
