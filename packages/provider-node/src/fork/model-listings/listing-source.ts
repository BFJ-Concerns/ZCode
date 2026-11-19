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
const LISTED_API_TYPES: ReadonlySet<string> = new Set([
  "openai-chat-completions",
  "openai-responses",
]);

/**
 * Asks a CLIProxyAPI gateway for its client catalogue, the one listing it serves with
 * each model's limits. Other OpenAI-compatible providers ignore the parameter.
 */
const CLIPROXYAPI_CATALOGUE_QUERY = "client_version=cpa";

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
    const results = await Promise.all(
      listingRequests(configured).map(
        async (request): Promise<ModelListingResult> => ({
          providerId: request.providerId,
          ...(await this.#readListing(request)),
        }),
      ),
    );
    return joinListings(configured, results);
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
  try {
    const response = await request(url, {
      headers: { accept: "application/json", ...headers },
      signal: AbortSignal.timeout(LISTING_TIMEOUT_MS),
    });
    if (!response.ok) return { status: "failed", reason: `HTTP ${response.status}` };
    return { status: "read", models: parseModelListing(await response.json()) };
  } catch (error) {
    return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}

/** One listing request for each enabled provider the owner configured with an API key. */
function listingRequests(snapshot: ProviderConfigSnapshot): readonly ListingRequest[] {
  return snapshot.personalProviders.rules().flatMap((rule): ListingRequest[] => {
    if (rule.enabled === false) return [];
    const config = effectiveProviderConfig(snapshot, rule);
    const baseUrl = config.api?.baseUrl?.trim();
    if (!baseUrl || !config.api?.type || !LISTED_API_TYPES.has(config.api.type)) return [];
    if (!isApiKeyAccess(config.access) || !config.access.apiKey) return [];
    return [
      {
        providerId: rule.providerId,
        url: `${baseUrl.replace(/\/+$/, "")}/models?${CLIPROXYAPI_CATALOGUE_QUERY}`,
        headers: {
          ...config.api.headers,
          authorization: `Bearer ${config.access.apiKey}`,
        },
      },
    ];
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
  const listingRules = [...listed].flatMap(([providerId, models]) =>
    models.flatMap((model) => listingRule(providerId, model)),
  );
  return Object.freeze({
    ...snapshot,
    [MODEL_LISTING_REPORT]: Object.freeze([...results]),
    revision: JSON.stringify([snapshot.revision, results]),
    personalProviders,
    zcodeBuiltinModelRules: new ModelConfigRules([
      ...snapshot.zcodeBuiltinModelRules.rules(),
      ...listingRules,
    ]),
  });
}

function listingRule(providerId: string, model: ListedModel): ModelConfigRule[] {
  const { contextWindow, maxOutputTokens, reasoningLevels } = model;
  if (contextWindow === undefined && maxOutputTokens === undefined && !reasoningLevels) return [];
  const config = new ModelConfig({
    ...(contextWindow === undefined
      ? {}
      : { properties: new ModelPropertiesConfig({ contextWindow }) }),
    optionSpecs: new ModelOptionSpecsConfig({
      ...(reasoningLevels ? { reasoningLevel: { values: [...reasoningLevels] } } : {}),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens: { max: maxOutputTokens } }),
    }),
  });
  return [{ type: "provider-model", providerId, modelId: model.modelId, config }];
}
