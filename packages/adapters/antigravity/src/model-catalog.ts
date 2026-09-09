import {
  harnessModelCatalogSchema,
  harnessModelRefSchema,
  harnessThinkingOptionIdSchema,
  harnessThinkingOptionSchema,
  type HarnessModelCatalog,
  type HarnessModelRef,
  type HarnessThinkingOption,
  type HarnessThinkingOptionId,
} from "@codexhost/shared-contracts";

export interface AntigravityNativeModel {
  slug: string;
  label: string;
  supportedThinkingOptionIds?: HarnessThinkingOptionId[];
}

const ANTIGRAVITY_MODEL_REF_PREFIX = "antigravity-model-v1.";
const EFFORT_SLUG_PATTERN = /^(.+)-(low|medium|high)$/i;
const EFFORT_LABEL_PATTERN = /\s*\((Low|Medium|High)\)\s*$/i;

export const ANTIGRAVITY_THINKING_OPTION_IDS: readonly HarnessThinkingOptionId[] = [
  harnessThinkingOptionIdSchema.parse("low"),
  harnessThinkingOptionIdSchema.parse("medium"),
  harnessThinkingOptionIdSchema.parse("high"),
];

export const ANTIGRAVITY_THINKING_LABELS: Readonly<Record<string, string>> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

export const DEFAULT_ANTIGRAVITY_THINKING_OPTION_ID: HarnessThinkingOptionId =
  harnessThinkingOptionIdSchema.parse("medium");

function assertModelPart(value: string, name: string): void {
  if (value.trim().length === 0) throw new Error(`Antigravity ${name} must not be empty`);
}

export function encodeAntigravityModelRef(model: AntigravityNativeModel | string): HarnessModelRef {
  const slug = typeof model === "string" ? model : model.slug;
  assertModelPart(slug, "Model slug");
  const encoded = Buffer.from(slug, "utf8").toString("base64url");
  return harnessModelRefSchema.parse({ id: `${ANTIGRAVITY_MODEL_REF_PREFIX}${encoded}` });
}

export function decodeAntigravityModelRef(ref: HarnessModelRef): string {
  const parsed = harnessModelRefSchema.parse(ref);
  if (!parsed.id.startsWith(ANTIGRAVITY_MODEL_REF_PREFIX)) {
    throw new Error("Model Ref does not belong to AntigravityAdapter");
  }
  const encoded = parsed.id.slice(ANTIGRAVITY_MODEL_REF_PREFIX.length);
  let decoded: string;
  try {
    decoded = Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    throw new Error("Antigravity Model Ref is malformed");
  }
  assertModelPart(decoded, "Model slug");
  if (encodeAntigravityModelRef(decoded).id !== parsed.id) {
    throw new Error("Antigravity Model Ref is not canonical");
  }
  return decoded;
}

interface MutableGroup {
  slug: string;
  label: string;
  efforts: Set<HarnessThinkingOptionId>;
}

export function parseAntigravityModelsOutput(output: string): AntigravityNativeModel[] {
  const groups = new Map<string, MutableGroup>();
  for (const rawLine of output.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.toLowerCase().startsWith("fetching") || line.toLowerCase().startsWith("available")) {
      continue;
    }
    const [rawSlug, ...labelParts] = line.split("\t");
    if (!rawSlug) continue;
    const rawLabel = labelParts.join("\t").trim() || rawSlug;

    const effortMatch = rawSlug.match(EFFORT_SLUG_PATTERN);
    let baseSlug = rawSlug;
    let effort: HarnessThinkingOptionId | undefined;
    let baseLabel = rawLabel;

    if (effortMatch && effortMatch[1] && effortMatch[2]) {
      baseSlug = effortMatch[1];
      effort = harnessThinkingOptionIdSchema.parse(effortMatch[2].toLowerCase());
      baseLabel = rawLabel.replace(EFFORT_LABEL_PATTERN, "").trim() || baseSlug;
    } else {
      baseLabel = rawLabel.replace(/\s*\(Thinking\)\s*$/i, "").trim() || baseSlug;
    }

    let existing = groups.get(baseSlug);
    if (!existing) {
      existing = { slug: baseSlug, label: baseLabel, efforts: new Set() };
      groups.set(baseSlug, existing);
    }
    if (effort) {
      existing.efforts.add(effort);
    }
  }

  const result: AntigravityNativeModel[] = [];
  for (const group of groups.values()) {
    const supported = ANTIGRAVITY_THINKING_OPTION_IDS.filter((id) => group.efforts.has(id));
    result.push({
      slug: group.slug,
      label: group.label,
      ...(supported.length > 0 ? { supportedThinkingOptionIds: supported } : {}),
    });
  }
  return result;
}

export function normalizeAntigravityModelCatalog(
  nativeModels: readonly AntigravityNativeModel[],
  effectiveModel?: string,
  effectiveThinkingOptionId?: HarnessThinkingOptionId,
): HarnessModelCatalog {
  const models = nativeModels.map((model) => ({
    ref: encodeAntigravityModelRef(model),
    label: model.label,
    resolvedModelLabel: model.slug,
    ...(model.supportedThinkingOptionIds && model.supportedThinkingOptionIds.length > 0
      ? { supportedThinkingOptionIds: model.supportedThinkingOptionIds }
      : {}),
  }));
  if (models.length === 0) throw new Error("Antigravity did not report any available models");

  const normalizedEffectiveSlug = effectiveModel?.replace(EFFORT_SLUG_PATTERN, "$1");
  const defaultModelObj =
    (normalizedEffectiveSlug
      ? models.find((m) => decodeAntigravityModelRef(m.ref) === normalizedEffectiveSlug)
      : undefined) ??
    (effectiveModel
      ? models.find((m) => decodeAntigravityModelRef(m.ref) === effectiveModel)
      : undefined) ??
    models[0];
  if (!defaultModelObj) throw new Error("Antigravity did not report a default Model");

  const defaultModel = defaultModelObj.ref;

  const matchedNative = nativeModels.find(
    (m) => m.slug === decodeAntigravityModelRef(defaultModel),
  );
  const supportedOptions = matchedNative?.supportedThinkingOptionIds;
  // agy requires an explicit --effort for Models that have effort variants and
  // its own default is the strongest variant, so the catalog default leads with
  // the strongest listed option (upstream-aligned) unless one was requested.
  const catalogDefaultThinking =
    supportedOptions && supportedOptions.length > 0
      ? supportedOptions[supportedOptions.length - 1]
      : undefined;
  const defaultThinking =
    effectiveThinkingOptionId &&
    supportedOptions &&
    supportedOptions.includes(effectiveThinkingOptionId)
      ? effectiveThinkingOptionId
      : catalogDefaultThinking;

  const thinkingOptions = ANTIGRAVITY_THINKING_OPTION_IDS.map((id) =>
    harnessThinkingOptionSchema.parse({
      id,
      label: ANTIGRAVITY_THINKING_LABELS[id] ?? id,
    }),
  );

  return harnessModelCatalogSchema.parse({
    models,
    defaultModel,
    thinkingOptions,
    ...(defaultThinking ? { defaultThinkingOptionId: defaultThinking } : {}),
  });
}

export function modelBySlug(
  models: readonly AntigravityNativeModel[],
  slug: string,
): AntigravityNativeModel | undefined {
  const exact = models.find((model) => model.slug === slug);
  if (exact) return exact;
  const baseSlug = slug.replace(EFFORT_SLUG_PATTERN, "$1");
  return models.find((model) => model.slug === baseSlug);
}

/**
 * The Thinking options the given Model actually accepts (upstream-aligned).
 * Models without effort variants expose none.
 */
export function antigravityAvailableThinkingOptions(
  model: AntigravityNativeModel | undefined,
): readonly HarnessThinkingOption[] {
  const supported = model?.supportedThinkingOptionIds;
  if (!supported || supported.length === 0) {
    return [];
  }
  return ANTIGRAVITY_THINKING_OPTION_IDS.filter((id) => supported.includes(id)).map((id) =>
    harnessThinkingOptionSchema.parse({
      id,
      label: ANTIGRAVITY_THINKING_LABELS[id] ?? id,
    }),
  );
}

/** Whether the Model accepts the given effort; false when it has no effort variants. */
export function modelAcceptsThinking(
  model: AntigravityNativeModel | undefined,
  thinkingOptionId: HarnessThinkingOptionId | undefined,
): boolean {
  if (!thinkingOptionId) return true;
  if (!model?.supportedThinkingOptionIds || model.supportedThinkingOptionIds.length === 0) {
    return false;
  }
  return model.supportedThinkingOptionIds.includes(thinkingOptionId);
}
