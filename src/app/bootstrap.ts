import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  loadSettings,
  resolveDreamMinEpisodes,
  resolveOllamaThink,
  resolveRecallDistanceThresholds,
  resolveRecencyExclusionTurns,
  resolveSemanticRecallMaxDistance,
  resolveSemanticRecallTopK,
  type AppSettings,
} from "../config/settings.js";
import { loadMcpConfig, resolveExpressDryRun } from "../config/mcp.js";
import { createUserResolver, loadUsers } from "../config/users.js";
import { TurnOrchestrator } from "../orchestrator/turn.js";
import { WorkingMemory } from "../memory/working.js";
import { LanceEpisodeStore } from "../memory/lancedb.js";
import { InMemoryEpisodeStore } from "../memory/episode.js";
import { InMemorySemanticStore } from "../memory/semantic.js";
import { LanceSemanticStore } from "../memory/semantic-lancedb.js";
import type { SemanticStore } from "../memory/semantic.js";
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
import { McpToolClient } from "../mcp/client.js";
import { FakeMcpToolProvider } from "../mcp/fake.js";
import type { McpToolProvider } from "../mcp/types.js";
import { buildToolCatalog, type CatalogTool } from "../tools/catalog.js";
import type { RunActionInput } from "../action/context.js";

export type AppContext = {
  settings: AppSettings;
  orchestrator: TurnOrchestrator;
  speakerId: string;
  verbose: VerboseLogger;
  llm: LlmClient;
  episodes: EpisodeStore;
  semantic: SemanticStore;
};

export type BootstrapOptions = {
  speakerId?: string;
  memory?: "lance" | "memory";
  verbose?: boolean;
  /** 省略時 data/state.json。false で永続化しない */
  statePath?: string | false;
  mcp?: McpToolProvider;
};

function resolveOllamaHost(settings: AppSettings): string {
  return process.env.OLLAMA_HOST ?? settings.ollamaHost;
}

async function resolveMcpProvider(
  override?: McpToolProvider,
): Promise<McpToolProvider> {
  if (override) return override;
  const config = await loadMcpConfig();
  const client = await McpToolClient.connect(config);
  const tools = await client.listTools();
  if (tools.length > 0) return client;
  await client.close();
  return new FakeMcpToolProvider();
}

export async function createApp(
  options: BootstrapOptions = {},
): Promise<AppContext> {
  const settings = await loadSettings();
  const mcpConfig = await loadMcpConfig();
  const expressDryRun = resolveExpressDryRun(mcpConfig);
  const mcp = await resolveMcpProvider(options.mcp);
  const toolCatalog: CatalogTool[] = await buildToolCatalog(mcp);

  const host = resolveOllamaHost(settings);
  const verboseLogger = options.verbose ? createVerboseLogger() : null;
  const think = resolveOllamaThink(settings);
  let llm: LlmClient = new OllamaLlmClient({
    host,
    model: settings.chatModel,
    think,
    numCtx: settings.ollamaNumCtx,
  });
  if (verboseLogger) {
    llm = withVerboseLlm(llm, verboseLogger);
  }

  let episodes: EpisodeStore;
  let semantic: SemanticStore;
  if (options.memory === "memory") {
    episodes = new InMemoryEpisodeStore();
    semantic = new InMemorySemanticStore();
  } else {
    const embedder = new OllamaEmbedClient(host, settings.embedModel);
    const dbPath = path.join(process.cwd(), "data", "lancedb");
    episodes = await LanceEpisodeStore.open(dbPath, embedder);
    semantic = await LanceSemanticStore.open(dbPath, embedder);
  }

  const personaPath = path.join(process.cwd(), "persona", "character.md");
  const personaText = await readFile(personaPath, "utf8");
  const users = await loadUsers();
  const resolveUserDisplayName = createUserResolver(users);
  const statePath =
    options.statePath === false ? null : (options.statePath ?? defaultStatePath());
  const session = statePath
    ? await loadSession(statePath)
    : {
        state: "対話" as AgentState,
        workingMemory: [] as const,
        innerState: "",
      };
  const wm = new WorkingMemory(
    settings.workingMemoryTurns,
    session.workingMemory,
  );
  const persistSession = statePath
    ? async (next: {
        state: AgentState;
        workingMemory: readonly ConversationTurn[];
        innerState: string;
      }) => saveSession(statePath, next)
    : undefined;

  const actionDeps = {
    mcp,
    toolCatalog,
    expressDryRun,
  };

  const orchestrator = new TurnOrchestrator(session.state, {
    llm,
    episodes,
    semantic,
    workingMemory: wm,
    episodeRecallTopK: settings.episodeRecallTopK,
    semanticRecallTopK: resolveSemanticRecallTopK(settings),
    semanticRecallMaxDistance: resolveSemanticRecallMaxDistance(settings),
    recencyExclusionTurns: resolveRecencyExclusionTurns(settings),
    recallDistanceThresholds: resolveRecallDistanceThresholds(settings),
    initialInnerState: session.innerState,
    contextTokenBudget: settings.contextTokenBudget,
    languageNumPredict: settings.languageNumPredict ?? 400,
    timeZone: settings.timeZone ?? "Asia/Tokyo",
    getPersona: async () => personaText,
    dialogue: { resolveUserDisplayName },
    runAction: (input: RunActionInput) =>
      runAction(llm, {
        ...input,
        mcp: input.mcp ?? mcp,
        toolCatalog: input.toolCatalog ?? toolCatalog,
        expressDryRun: input.expressDryRun ?? expressDryRun,
      }),
    actionDeps,
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
    semanticRecallTopK: resolveSemanticRecallTopK(settings),
    dreamMinEpisodes: resolveDreamMinEpisodes(settings),
    statePath: statePath ?? "(in-memory)",
    initialState: session.state,
    workingMemoryTurnsLoaded: session.workingMemory.length,
    initialInnerState: session.innerState || "(empty)",
    recencyExclusionTurns: resolveRecencyExclusionTurns(settings),
    expressDryRun,
    toolCatalogSize: toolCatalog.length,
  });

  return {
    settings,
    orchestrator,
    speakerId: options.speakerId ?? "user_001",
    verbose: verboseLogger ?? { enabled: false },
    llm,
    episodes,
    semantic,
  };
}
