/**
 * Reads a provider's model listing into the limits the fork takes from it. Two shapes
 * are understood, and a body may carry either:
 *
 * - CLIProxyAPI's client catalogue (`GET /models?client_version=cpa`):
 *   `{ models: [{ slug, context_window, max_tokens, supported_reasoning_levels: [{ effort }],
 *   visibility }] }`. Entries hidden from clients (image and video models) are skipped.
 * - The OpenAI-compatible listing OpenRouter serves (`GET /models`):
 *   `{ data: [{ id, context_length, top_provider: { context_length, max_completion_tokens },
 *   supported_parameters }] }`. A plain OpenAI listing is the same shape with only `id`.
 *
 * A value the listing does not give is left out, so the built-in rules supply it.
 */

/** One model as its provider lists it. */
export interface ListedModel {
  readonly modelId: string;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly reasoningLevels?: readonly string[];
}

/**
 * The levels OpenRouter accepts for `reasoning.effort` on every model whose listing
 * names the `reasoning` parameter, lowest first. OpenRouter's listing says only whether
 * a model reasons, not which levels it takes.
 */
const OPENROUTER_REASONING_LEVELS = Object.freeze(["low", "medium", "high"]);

/** The only level a model holds when its listing says it does not reason. */
const NO_REASONING_LEVELS = Object.freeze(["disabled"]);

export function parseModelListing(body: unknown): readonly ListedModel[] {
  if (!isRecord(body)) throw new Error("the model listing is not a JSON object");
  const catalogue = Array.isArray(body.models) ? body.models : undefined;
  const openAi = Array.isArray(body.data) ? body.data : undefined;
  if (!catalogue && !openAi) throw new Error("the model listing has neither `models` nor `data`");

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
  });
}

function readOpenAiEntry(entry: unknown): ListedModel | undefined {
  if (!isRecord(entry)) return undefined;
  const modelId = nonEmptyString(entry.id);
  if (!modelId) return undefined;
  const topProvider = isRecord(entry.top_provider) ? entry.top_provider : {};
  return listedModel(modelId, {
    contextWindow:
      positiveInteger(topProvider.context_length) ?? positiveInteger(entry.context_length),
    maxOutputTokens:
      positiveInteger(topProvider.max_completion_tokens) ??
      positiveInteger(entry.max_completion_tokens),
    reasoningLevels: openAiReasoningLevels(entry),
  });
}

/** CLIProxyAPI's own registry entries carry `thinking.levels`; OpenRouter's carry `supported_parameters`. */
function openAiReasoningLevels(entry: Record<string, unknown>): readonly string[] | undefined {
  if (isRecord(entry.thinking) && Array.isArray(entry.thinking.levels)) {
    return uniqueLevels(entry.thinking.levels.map(nonEmptyString));
  }
  if (!Array.isArray(entry.supported_parameters)) return undefined;
  const reasons = entry.supported_parameters.some(
    (parameter) => parameter === "reasoning" || parameter === "reasoning_effort",
  );
  return reasons ? OPENROUTER_REASONING_LEVELS : NO_REASONING_LEVELS;
}

function listedModel(modelId: string, limits: Omit<ListedModel, "modelId">): ListedModel {
  return Object.freeze({
    modelId,
    ...(limits.contextWindow === undefined ? {} : { contextWindow: limits.contextWindow }),
    ...(limits.maxOutputTokens === undefined ? {} : { maxOutputTokens: limits.maxOutputTokens }),
    ...(limits.reasoningLevels === undefined ? {} : { reasoningLevels: limits.reasoningLevels }),
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
