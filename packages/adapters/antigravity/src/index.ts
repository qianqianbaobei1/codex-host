export { AntigravityAdapter } from "./antigravity-adapter.js";
export { ANTIGRAVITY_COMMAND_ENV, resolveAntigravityExecutable } from "./command.js";
export {
  ANTIGRAVITY_ACCOUNT_ID_ENV,
  ANTIGRAVITY_ACCOUNTS_DIR,
  ANTIGRAVITY_THREAD_ID_ENV,
  AntigravityAccountStore,
  antigravityAccountsFile,
  antigravityAccountsRoot,
  antigravityRealHome,
  antigravityShadowHome,
  applyAntigravityAccountEnvironment,
  createEmptyAccountsFile,
  ensureAntigravityShadowHome,
  loadAntigravityAccountsSync,
  resolveAntigravityHostAnchors,
} from "./accounts.js";
export type {
  AntigravityAccount,
  AntigravityAccountHealth,
  AntigravityAccountsFileV1,
  AntigravityAccountsLoad,
  AntigravityHostAnchors,
  AntigravityThreadBinding,
  ShadowHomeReport,
} from "./accounts.js";
export {
  decodeAntigravityModelRef,
  encodeAntigravityModelRef,
  normalizeAntigravityModelCatalog,
  parseAntigravityModelsOutput,
  antigravityAvailableThinkingOptions,
  modelAcceptsThinking,
  ANTIGRAVITY_THINKING_OPTION_IDS,
  ANTIGRAVITY_THINKING_LABELS,
  DEFAULT_ANTIGRAVITY_THINKING_OPTION_ID,
} from "./model-catalog.js";
export {
  parseAntigravityContextUsage,
  pollAntigravityContextUsage,
  antigravityHttpsPort,
} from "./context-usage.js";
export { projectAntigravityFileChange } from "./file-change.js";
export { loadAntigravitySnapshot, mapAntigravitySnapshot } from "./history.js";
export {
  readAntigravityTranscript,
  resolveAntigravityTranscriptPath,
  parseTranscriptTurns,
} from "./transcript.js";
export { AntigravityCliTransport, AntigravityTransportError } from "./transport.js";
export {
  DEFAULT_ANTIGRAVITY_STATUSLINE_RAW_PATH,
  DEFAULT_ANTIGRAVITY_QUOTA_SNAPSHOT_PATH,
  projectAntigravityRawQuota,
  projectAntigravitySnapshotQuota,
  parseAntigravityQuotaPayload,
  readAntigravityCreditsSync,
  readAntigravityCredits,
  refreshAntigravityCredits,
} from "./credits.js";
export { fetchAntigravityQuota, parseAntigravityUsageCommand } from "./quota.js";
export {
  composePluginBridgePrompt,
  enabledPluginIdsFromConfig,
  pluginBridgeRootsExist,
  readCodexRules,
  readSelectedPluginSkillPrompt,
} from "./plugin-bridge.js";
export type { PluginBridgeSkill } from "./plugin-bridge.js";
export type {
  AntigravityCommandRunner,
  AntigravityQuotaBucket,
  AntigravityQuotaSnapshot,
} from "./quota.js";
export {
  ANTIGRAVITY_DEFAULT_PERMISSION_MODE_ID,
  ANTIGRAVITY_PERMISSION_MODE_CATALOG,
  decodeAntigravityPermissionModeId,
} from "./permission-modes.js";
export type { AntigravityPermissionMode } from "./permission-modes.js";
export {
  antigravityToolErrorMessage,
  isAntigravityPermissionDenial,
  parseAntigravityStreamLine,
} from "./stream-events.js";
export type { AntigravityCreditsProductUsage, AntigravityCreditsPathOptions } from "./credits.js";
export type {
  AntigravityAdapterDependencies,
  AntigravityAdapterOptions,
  AntigravityCliTransportLike,
  AntigravityModelsResult,
} from "./antigravity-adapter.js";
export type {
  AntigravityInitEvent,
  AntigravityResultEvent,
  AntigravityStepUpdate,
  AntigravityTransportOptions,
} from "./transport.js";

export const packageMetadata = {
  name: "@codexhost/adapter-antigravity",
} as const;
