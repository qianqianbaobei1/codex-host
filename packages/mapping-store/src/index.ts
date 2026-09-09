import { WORKSPACE_CONTRACT_VERSION } from "@codexhost/shared-contracts";

export { MappingStore, MappingStoreError } from "./mapping-store.js";
export type { MappingStoreErrorCode, MappingStoreOptions } from "./mapping-store.js";
export {
  delegationStatusSchema,
  storedDelegationRecordV1Schema,
  externalGoalStatusSchema,
  externalGoalStopReasonSchema,
  storedExternalGoalV1Schema,
  storedThreadRecordV1Schema,
  storedTurnMappingV1Schema,
} from "./records.js";
export type {
  CommitReadyThreadInput,
  CreateDelegationInput,
  CreateProvisionalThreadInput,
  DelegationStatus,
  ExternalGoalStatus,
  ExternalGoalStopReason,
  FindRecentDelegationInput,
  HandoverHarnessInput,
  ReplaceReadySessionAfterLastTurnInput,
  ReplaceReadySessionInput,
  StoredDelegationRecordV1,
  StoredExternalGoalV1,
  StoredThreadRecordV1,
  StoredTurnMappingV1,
} from "./records.js";

export const packageMetadata = {
  name: "@codexhost/mapping-store",
  contractVersion: WORKSPACE_CONTRACT_VERSION,
} as const;
