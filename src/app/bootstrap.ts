import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  loadSettings,
  resolveDreamMinEpisodes,
  resolveOllamaThink,
  resolveRecallDistanceThresholds,
  resolveRecencyExclusionTurns,
  resolveActionModel,
  resolveActorChannels,
  resolveActorModel,
  resolveEnabledActors,
  resolveRoleModel,
  resolveRoleThink,
  resolveSemanticRecallMaxDistance,
  resolveSemanticRecallTopK,
  type ActorName,
  type AppSettings,
  type RoleName,
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
import { InMemoryMemoIndexStore, type MemoIndexStore } from "../memory/memo-index.js";
import { LanceMemoIndexStore } from "../memory/memo-index-lancedb.js";
import { OllamaEmbedClient, OllamaLlmClient } from "../llm/ollama.js";
import { withVerboseLlm } from "../llm/logging.js";
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

export type AppContext = {
  settings: AppSettings;
  orchestrator: TurnOrchestrator;
  speakerId: string;
  verbose: VerboseLogger;
  llm: LlmClient;
  episodes: EpisodeStore;
  semantic: SemanticStore;
  memoIndex: MemoIndexStore;
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

const ROLE_NAMES: RoleName[] = ["language", "introspection", "innerState"];

function buildRoleLlm(
  settings: AppSettings,
  host: string,
  verboseLogger: ReturnType<typeof createVerboseLogger> | null,
): Partial<Record<RoleName, LlmClient>> {
  const result: Partial<Record<RoleName, LlmClient>> = {};
  for (const role of ROLE_NAMES) {
    const model = resolveRoleModel(settings, role);
    const think = resolveRoleThink(settings, role);
    let client: LlmClient = new OllamaLlmClient({
      host,
      model,
      think,
      numCtx: settings.ollamaNumCtx,
    });
    if (verboseLogger) client = withVerboseLlm(client, verboseLogger);
    result[role] = client;
  }
  return result;
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

  // actionModel クライアント（activator + 全実行 actors）
  const actionModelName = resolveActionModel(settings);
  let actionLlm: LlmClient = new OllamaLlmClient({
    host,
    model: actionModelName,
    think: false,
    numCtx: settings.ollamaNumCtx,
  });
  if (verboseLogger) {
    actionLlm = withVerboseLlm(actionLlm, verboseLogger);
  }

  let episodes: EpisodeStore;
  let semantic: SemanticStore;
  let memoIndex: MemoIndexStore;
  if (options.memory === "memory") {
    episodes = new InMemoryEpisodeStore();
    semantic = new InMemorySemanticStore();
    memoIndex = new InMemoryMemoIndexStore();
  } else {
    const embedder = new OllamaEmbedClient(host, settings.embedModel);
    const dbPath = path.join(process.cwd(), "data", "lancedb");
    episodes = await LanceEpisodeStore.open(dbPath, embedder);
    semantic = await LanceSemanticStore.open(dbPath, embedder);
    memoIndex = await LanceMemoIndexStore.open(dbPath, embedder);
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

  const roleLlm = buildRoleLlm(settings, host, verboseLogger);

  // State ごとの有効 actor リスト（初期 State で解決。実行時は stateConfig で上書き）
  const enabledActors = resolveEnabledActors(settings, session.state);

  // actor ごとの知覚チャンネルと LLM
  const ALL_ACTOR_NAMES: ActorName[] = [
    "recall", "remember", "forget", "memoWrite", "memoRead",
    "webSearch", "urlBrowse", "webcam",
  ];
  const actorChannels = Object.fromEntries(
    ALL_ACTOR_NAMES.map((name) => [name, resolveActorChannels(settings, name)]),
  ) as Record<ActorName, ReturnType<typeof resolveActorChannels>>;

  const actorLlm = Object.fromEntries(
    ALL_ACTOR_NAMES.map((name) => {
      const model = resolveActorModel(settings, name);
      // actionModel と同じならクライアントを共用
      if (model === actionModelName) return [name, actionLlm];
      let client: LlmClient = new OllamaLlmClient({
        host,
        model,
        think: false,
        numCtx: settings.ollamaNumCtx,
      });
      if (verboseLogger) client = withVerboseLlm(client, verboseLogger);
      return [name, client];
    }),
  ) as Record<ActorName, LlmClient>;

  const orchestrator = new TurnOrchestrator(session.state, {
    llm,
    actionLlm,
    episodes,
    semantic,
    memoIndex,
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
    actionDeps,
    stateConfig: settings.stateConfig,
    enabledActors,
    actorChannels,
    actorLlm,
    roleLlm,
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
    memoIndex,
  };
}
