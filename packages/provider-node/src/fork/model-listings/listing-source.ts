/**
 * The provider configuration as the registry reads it, with each configured provider's
 * model listing joined in. A listed model becomes one of the provider's models, and
 * what the listing says about it becomes a rule that sits after every built-in rule and
 * before the owner's own, so the owner's configuration overrides the listing and the
 * listing overrides the built-in rules. A value the listing leaves out still comes from
 * the built-in rules.
 *
 * A listing that cannot be read leaves its provider as configured: the run starts with
 * the built-in rules, and the failure is kept for `readModelListingReport`.
 */

import {
  isApiKeyAccess,
  ModelConfig,
  ModelConfigRules,
  ModelOptionSpecsConfig,
  ModelPropertiesConfig,
  type ModelConfigRule,
  type ProviderConfig,
  type ProviderConfigRule,
  type ProviderConfigSnapshot,
  type ProviderSource,
} from "@zcode/provider";
import { parseModelListing, type ListedModel } from "./listing-shapes.js";

/** How long a listing may take before the run goes on without it. */
const LISTING_TIMEOUT_MS = 5_000;

/** API types whose providers serve an OpenAI-compatible `GET /models`. */
const OPENAI_API_TYPES: ReadonlySet<string> = new Set([
  "openai-chat-completions",
  "openai-responses",
]);

/**
 * Anthropic-compatible providers (OpenRouter's template among them) are listed at
 * `/v1/models` under the base URL, where their requests go to `/v1/messages`.
 */
const ANTHROPIC_API_TYPE = "anthropic-messages";

/** A built-in rule that holds for every model, as opposed to one written for particular models. */
const EVERY_MODEL = ".*";

/** Fallback for a reasoning-capable model whose built-in rules give it no specific levels. */
const CAPABILITY_REASONING_LEVELS = ["low", "medium", "high"] as const;

/**
 * Asks a CLIProxyAPI gateway for its client catalogue, the one listing it serves with
 * each model's limits. Other OpenAI-compatible providers ignore the parameter.
 */
const CLIPROXYAPI_CATALOGUE_QUERY = "client_version=cpa";
const NANOGPT_CATALOGUE_QUERY = "detailed=true";
const NANOGPT_HOSTS = new Set(["nano-gpt.com", "api.nano-gpt.com"]);

export type ModelListingResult =
  | {
      readonly providerId: string;
      readonly status: "read";
      readonly models: readonly ListedModel[];
    }
  | {
      readonly providerId: string;
      readonly status: "failed";
      readonly reason: string;
    };

type ListingRead =
  | { readonly status: "read"; readonly models: readonly ListedModel[] }
  | { readonly status: "failed"; readonly reason: string };

interface ListingRequest {
  readonly providerId: string;
  readonly templateId?: string;
  readonly apiType: string;
  readonly baseUrl: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * Where a snapshot carries what reading each listing came to. A symbol-keyed property,
 * because the registry keeps a shallow copy of the snapshot it was given.
 */
const MODEL_LISTING_REPORT = Symbol("model-listings.report");

type ReportedSnapshot = ProviderConfigSnapshot & {
  readonly [MODEL_LISTING_REPORT]?: readonly ModelListingResult[];
};

/** What reading each provider's listing came to, for a snapshot this source produced. */
export function readModelListingReport(
  snapshot: ProviderConfigSnapshot,
): readonly ModelListingResult[] {
  return (snapshot as ReportedSnapshot)[MODEL_LISTING_REPORT] ?? [];
}

export interface ModelListingSourceOptions {
  readonly fetch?: typeof globalThis.fetch;
}

export function withModelListings(
  configSource: ProviderSource<ProviderConfigSnapshot>,
  options: ModelListingSourceOptions = {},
): ProviderSource<ProviderConfigSnapshot> {
  return new ModelListingConfigSource(configSource, options.fetch ?? globalThis.fetch);
}

class ModelListingConfigSource implements ProviderSource<ProviderConfigSnapshot> {
  readonly #inner: ProviderSource<ProviderConfigSnapshot>;
  readonly #fetch: typeof globalThis.fetch;
  /** One read per distinct request for the life of the process; a failed read is retried. */
  readonly #reads = new Map<string, Promise<ListingRead>>();

  constructor(inner: ProviderSource<ProviderConfigSnapshot>, request: typeof globalThis.fetch) {
    this.#inner = inner;
    this.#fetch = request;
  }

  async read(): Promise<ProviderConfigSnapshot> {
    const configured = await this.#inner.read();
    const requests = listingRequests(configured);
    const results = await Promise.all(
      requests.map(
        async (request): Promise<ModelListingResult> => ({
          providerId: request.providerId,
          ...(await this.#readListing(request)),
        }),
      ),
    );
    return joinListings(configured, requests, results);
  }

  onDidChange(listener: (reason: string) => void): () => void {
    return this.#inner.onDidChange(listener);
  }

  #readListing(request: ListingRequest): Promise<ListingRead> {
    const key = JSON.stringify([request.url, request.headers]);
    const cached = this.#reads.get(key);
    if (cached) return cached;
    const read = fetchListing(this.#fetch, request);
    this.#reads.set(key, read);
    void read.then((result) => {
      if (result.status === "failed" && this.#reads.get(key) === read) this.#reads.delete(key);
    });
    return read;
  }
}

async function fetchListing(
  request: typeof globalThis.fetch,
  { url, headers }: ListingRequest,
): Promise<ListingRead> {
  const signal = AbortSignal.timeout(LISTING_TIMEOUT_MS);
  let response: Response;
  try {
    response = await request(url, {
      headers: { accept: "application/json", ...headers },
      signal,
    });
  } catch {
    // Request errors can include credentials from the URL and headers.
    return {
      status: "failed",
      reason: signal.aborted ? "Model listing timed out" : "Model listing request failed",
    };
  }
  if (!response.ok) return { status: "failed", reason: `HTTP ${response.status}` };

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      status: "failed",
      reason: signal.aborted
        ? "Model listing timed out"
        : "Model listing response is not readable JSON",
    };
  }
  const models = parseModelListing(body);
  return models
    ? { status: "read", models }
    : { status: "failed", reason: "Model listing has no models or data array" };
}

/** One listing request for each enabled provider the owner configured with an API key. */
function listingRequests(snapshot: ProviderConfigSnapshot): readonly ListingRequest[] {
  return snapshot.personalProviders.rules().flatMap((rule): ListingRequest[] => {
    if (rule.enabled === false) return [];
    const config = effectiveProviderConfig(snapshot, rule);
    const baseUrl = config.api?.baseUrl?.trim().replace(/\/+$/, "");
    const apiType = config.api?.type;
    if (!baseUrl || !apiType) return [];
    if (!isApiKeyAccess(config.access) || !config.access.apiKey) return [];
    const apiKey = config.access.apiKey;
    const host = URL.parse(baseUrl)?.hostname;
    const listingQuery =
      host && NANOGPT_HOSTS.has(host) ? NANOGPT_CATALOGUE_QUERY : CLIPROXYAPI_CATALOGUE_QUERY;
    const templateId =
      rule.templateId ?? snapshot.zcodeBuiltinProviders.getRule(rule.providerId)?.templateId;
    const identity = {
      providerId: rule.providerId,
      ...(templateId ? { templateId } : {}),
      apiType,
      baseUrl,
    };
    if (OPENAI_API_TYPES.has(apiType)) {
      return [
        {
          ...identity,
          url: `${baseUrl}/models?${listingQuery}`,
          headers: { ...config.api?.headers, authorization: `Bearer ${apiKey}` },
        },
      ];
    }
    if (apiType === ANTHROPIC_API_TYPE) {
      const versioned = /\/v1$/i.test(baseUrl) ? baseUrl : `${baseUrl}/v1`;
      return [
        {
          ...identity,
          url: `${versioned}/models?${listingQuery}`,
          // The same two credentials the Anthropic-compatible requests carry.
          headers: {
            ...config.api?.headers,
            authorization: `Bearer ${apiKey}`,
            "x-api-key": apiKey,
          },
        },
      ];
    }
    return [];
  });
}

/** The provider's template, then its built-in configuration, then the owner's, as the resolver layers them. */
function effectiveProviderConfig(
  snapshot: ProviderConfigSnapshot,
  rule: ProviderConfigRule,
): ProviderConfig {
  const builtinRule = snapshot.zcodeBuiltinProviders.getRule(rule.providerId);
  const templateId = rule.templateId ?? builtinRule?.templateId;
  const template = templateId
    ? snapshot.zcodeBuiltinProviderTemplates.get(templateId)?.config
    : undefined;
  const layers = [template, builtinRule?.config].filter(
    (layer): layer is ProviderConfig => layer !== undefined,
  );
  return layers.reduceRight((config, below) => below.overlay(config), rule.config);
}

function joinListings(
  snapshot: ProviderConfigSnapshot,
  requests: readonly ListingRequest[],
  results: readonly ModelListingResult[],
): ProviderConfigSnapshot {
  const listed = new Map(
    results.flatMap((result) =>
      result.status === "read" ? [[result.providerId, result.models] as const] : [],
    ),
  );
  const personalProviders = snapshot.personalProviders.mapConfigs((config, providerId) => {
    const models = listed.get(providerId);
    if (!models) return config;
    const named = new Set([
      ...(snapshot.zcodeBuiltinProviders.get(providerId)?.builtinModelIds ?? []),
      ...(config.personalModelIds ?? []),
    ]);
    const added = models.map(({ modelId }) => modelId).filter((modelId) => !named.has(modelId));
    return added.length === 0
      ? config
      : config.withPersonalModelIds([...(config.personalModelIds ?? []), ...added]);
  });
  const builtinRules = snapshot.zcodeBuiltinModelRules.rules();
  const everyModelRules = new ModelConfigRules(
    builtinRules.filter((rule) => "modelMatch" in rule && rule.modelMatch === EVERY_MODEL),
  );
  // The global enabled/disabled default says nothing about a particular model's levels.
  const modelRules = new ModelConfigRules(
    builtinRules.filter((rule) => rule.type !== "model" || rule.modelMatch !== EVERY_MODEL),
  );
  const listingRules = requests.flatMap((request) =>
    (listed.get(request.providerId) ?? []).map((model) =>
      listingRule(request, model, everyModelRules, modelRules),
    ),
  );
  return Object.freeze({
    ...snapshot,
    [MODEL_LISTING_REPORT]: Object.freeze([...results]),
    revision: JSON.stringify([snapshot.revision, results]),
    personalProviders,
    zcodeBuiltinModelRules: new ModelConfigRules([...builtinRules, ...listingRules]),
  });
}

/**
 * A listed model is offered whatever the built-in rules say of it. Listed reasoning
 * levels are sent the way the provider's API sends any level: a built-in mapping written
 * for one model's own level names could turn a listed level into no reasoning at all.
 */
function listingRule(
  request: ListingRequest,
  model: ListedModel,
  everyModelRules: ModelConfigRules,
  modelRules: ModelConfigRules,
): ModelConfigRule {
  const { contextWindow, maxOutputTokens, inputFormat } = model;
  const identity = { ...request, modelId: model.modelId };
  const usesCapabilityFallback =
    model.reasoningSupported &&
    !modelRules.resolve(identity).optionSpecs?.reasoningLevel?.values?.length;
  const reasoningLevels =
    model.reasoningLevels ?? (usesCapabilityFallback ? CAPABILITY_REASONING_LEVELS : undefined);
  const reasoningMap = reasoningLevels
    ? everyModelRules.resolve(identity).optionSpecs?.reasoningLevel?.map
    : undefined;
  const config = new ModelConfig({
    enabled: true,
    properties: new ModelPropertiesConfig({
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(inputFormat === undefined ? {} : { inputFormat }),
    }),
    optionSpecs: new ModelOptionSpecsConfig({
      ...(reasoningLevels
        ? {
            reasoningLevel: {
              values: [...reasoningLevels],
              ...(reasoningMap === undefined ? {} : { map: reasoningMap }),
            },
          }
        : {}),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens: { max: maxOutputTokens } }),
    }),
  });
  return { type: "provider-model", providerId: request.providerId, modelId: model.modelId, config };
}
