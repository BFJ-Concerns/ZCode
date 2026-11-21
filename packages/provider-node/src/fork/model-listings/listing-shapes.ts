import type { ModelInputFormatConfigInput } from "@zcode/provider";

/**
 * Reads the CLIProxyAPI catalogue and OpenAI-compatible model listings, including
 * OpenRouter's architecture metadata and NanoGPT's detailed catalogue. Missing
 * metadata leaves the corresponding built-in values in place.
 */

/** One model as its provider lists it. */
export interface ListedModel {
  readonly modelId: string;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly reasoningLevels?: readonly string[];
  readonly inputFormat?: ModelInputFormatConfigInput;
  /** The listing advertises reasoning without naming any levels. */
  readonly reasoningSupported?: true;
}

/** The only level a model holds when its listing says it does not reason. */
const NO_REASONING_LEVELS = Object.freeze(["disabled"]);

// The registry uses the first value as the lowest effort for auxiliary calls.
const OPENROUTER_EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const OPENROUTER_EFFORT_RANK = new Map(OPENROUTER_EFFORT_ORDER.map((level, rank) => [level, rank]));

function openRouterEffortRank(level: string): number {
  return OPENROUTER_EFFORT_RANK.get(level) ?? OPENROUTER_EFFORT_ORDER.length;
}

export function parseModelListing(body: unknown): readonly ListedModel[] | undefined {
  if (!isRecord(body)) return undefined;
  const catalogue = Array.isArray(body.models) ? body.models : undefined;
  const openAi = Array.isArray(body.data) ? body.data : undefined;
  if (!catalogue && !openAi) return undefined;

  const listed = new Map<string, ListedModel>();
  for (const entry of catalogue ?? []) {
    const model = readCatalogueEntry(entry);
    if (model && !listed.has(model.modelId)) listed.set(model.modelId, model);
  }
  for (const entry of openAi ?? []) {
    const model = readOpenAiEntry(entry);
    if (model && !listed.has(model.modelId)) listed.set(model.modelId, model);
  }
  return Object.freeze([...listed.values()]);
}

function readCatalogueEntry(entry: unknown): ListedModel | undefined {
  if (!isRecord(entry) || entry.visibility === "hide") return undefined;
  const modelId = nonEmptyString(entry.slug) ?? nonEmptyString(entry.id);
  if (!modelId) return undefined;
  const levels = Array.isArray(entry.supported_reasoning_levels)
    ? uniqueLevels(
        entry.supported_reasoning_levels.map((level) =>
          isRecord(level) ? nonEmptyString(level.effort) : nonEmptyString(level),
        ),
      )
    : undefined;
  return listedModel(modelId, {
    contextWindow:
      positiveInteger(entry.context_window) ?? positiveInteger(entry.max_context_window),
    maxOutputTokens: positiveInteger(entry.max_tokens),
    reasoningLevels: levels,
    inputFormat: readInputFormat(entry.input_modalities),
  });
}

function readOpenAiEntry(entry: unknown): ListedModel | undefined {
  if (!isRecord(entry) || entry.available === false) return undefined;
  const modelId = nonEmptyString(entry.id);
  if (!modelId) return undefined;
  const topProvider = isRecord(entry.top_provider) ? entry.top_provider : {};
  const architecture = isRecord(entry.architecture) ? entry.architecture : {};
  const capabilities = isRecord(entry.capabilities) ? entry.capabilities : {};
  return listedModel(modelId, {
    contextWindow:
      positiveInteger(topProvider.context_length) ?? positiveInteger(entry.context_length),
    maxOutputTokens:
      positiveInteger(topProvider.max_completion_tokens) ??
      positiveInteger(entry.max_completion_tokens) ??
      positiveInteger(entry.max_output_tokens),
    inputFormat: readInputFormat(
      architecture.input_modalities ?? entry.input_modalities,
      capabilities,
    ),
    ...openAiReasoning(entry, capabilities.reasoning),
  });
}

/** Explicit levels take precedence over a capability flag. */
function openAiReasoning(
  entry: Record<string, unknown>,
  reasoningCapability: unknown,
): Pick<ListedModel, "reasoningLevels" | "reasoningSupported"> {
  if (isRecord(entry.reasoning) && Array.isArray(entry.reasoning.supported_efforts)) {
    const levels = uniqueLevels(entry.reasoning.supported_efforts.map(nonEmptyString));
    if (levels) {
      return {
        reasoningLevels: Object.freeze(
          levels.toSorted((a, b) => openRouterEffortRank(a) - openRouterEffortRank(b)),
        ),
      };
    }
  }
  if (Array.isArray(entry.reasoning_efforts)) {
    const levels = uniqueLevels(entry.reasoning_efforts.map(nonEmptyString));
    if (levels) return { reasoningLevels: levels };
  }
  if (isRecord(entry.thinking) && Array.isArray(entry.thinking.levels)) {
    const levels = uniqueLevels(entry.thinking.levels.map(nonEmptyString));
    if (levels) return { reasoningLevels: levels };
  }
  if (typeof reasoningCapability === "boolean") {
    return reasoningCapability
      ? { reasoningSupported: true }
      : { reasoningLevels: NO_REASONING_LEVELS };
  }
  if (!Array.isArray(entry.supported_parameters)) return {};
  const reasons = entry.supported_parameters.some(
    (parameter) => parameter === "reasoning" || parameter === "reasoning_effort",
  );
  return reasons ? { reasoningSupported: true } : { reasoningLevels: NO_REASONING_LEVELS };
}

function readInputFormat(
  advertised: unknown,
  capabilities: Record<string, unknown> = {},
): ModelInputFormatConfigInput | undefined {
  const modalities =
    Array.isArray(advertised) && advertised.every((kind) => nonEmptyString(kind) !== undefined)
      ? new Set(advertised.map(nonEmptyString))
      : undefined;
  const supportsText = modalities?.has("text");
  const supportsImage = booleanValue(capabilities.vision) ?? modalities?.has("image");
  // NanoGPT reports PDF support separately from architecture.input_modalities.
  const supportsPdf =
    booleanValue(capabilities.pdf_upload) ??
    (modalities && (modalities.has("pdf") || modalities.has("file")));
  const supportsVideo = booleanValue(capabilities.video_input) ?? modalities?.has("video");
  const supportsAudio = booleanValue(capabilities.audio_input) ?? modalities?.has("audio");
  const inputFormat = {
    ...(supportsText === undefined ? {} : { supportsText }),
    ...(supportsImage === undefined ? {} : { supportsImage }),
    ...(supportsPdf === undefined ? {} : { supportsPdf }),
    ...(supportsVideo === undefined ? {} : { supportsVideo }),
    ...(supportsAudio === undefined ? {} : { supportsAudio }),
  };
  return Object.keys(inputFormat).length > 0 ? Object.freeze(inputFormat) : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function listedModel(modelId: string, metadata: Omit<ListedModel, "modelId">): ListedModel {
  return Object.freeze({
    modelId,
    ...(metadata.contextWindow === undefined ? {} : { contextWindow: metadata.contextWindow }),
    ...(metadata.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: metadata.maxOutputTokens }),
    ...(metadata.reasoningLevels === undefined
      ? {}
      : { reasoningLevels: metadata.reasoningLevels }),
    ...(metadata.reasoningSupported ? { reasoningSupported: true } : {}),
    ...(metadata.inputFormat === undefined ? {} : { inputFormat: metadata.inputFormat }),
  });
}

/** An empty list of levels is no statement about the model, so the built-in rules decide. */
function uniqueLevels(levels: readonly (string | undefined)[]): readonly string[] | undefined {
  const unique = [...new Set(levels.filter((level): level is string => level !== undefined))];
  return unique.length === 0 ? undefined : Object.freeze(unique);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}
