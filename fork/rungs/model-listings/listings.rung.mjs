/**
 * Model listings: the fork reads each configured provider's model listing, in
 * CLIProxyAPI's shape and in OpenRouter's, and holds each model to the context window,
 * maximum output and reasoning levels it gives. The owner's configuration overrides
 * the listing, the listing overrides the built-in rules, and a listing that cannot be
 * read never stops a run. Observed through `zcode models` and at the stand-in provider.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { launch } from "../../harness/launcher.mjs";
import { hang, say, startModelProvider } from "../../harness/model-provider.mjs";
import { createOwnerHome, providerConfiguration } from "../../harness/owner-home.mjs";
import { cliProxyApiCatalogue, openRouterListing } from "./listings.mjs";

/** A stand-in serving `listing`, and a home whose configuration names only `modelIds`. */
async function ownerWithListing(
  t,
  {
    listing,
    script,
    modelIds = ["configured-model"],
    modelRules,
    defaultModelId,
    reasoningLevel,
    apiType,
    versionedBase = true,
    templateId,
  },
) {
  const provider = await startModelProvider({ listing, script });
  t.after(() => provider.close());
  const providerConfig = providerConfiguration({
    baseUrl: versionedBase ? provider.baseUrl : new URL(provider.baseUrl).origin,
    modelIds,
    defaultModelId: defaultModelId ?? modelIds[0],
    defaultReasoningLevel: reasoningLevel,
  });
  const [providerRule] = providerConfig.config.providerConfigRules.providerRules;
  if (apiType) providerRule.config.api.type = apiType;
  if (templateId) providerRule.templateId = templateId;
  if (modelRules) providerConfig.config.modelConfigRules.providerModelRules.push(...modelRules);
  const home = await createOwnerHome({ providerConfig });
  t.after(() => home.remove());
  return { provider, home };
}

/** Runs `zcode models` in `home` and returns what it printed. */
async function printedModels(t, home) {
  const run = launch({ home, command: ["models"] });
  t.after(() => run.dispose());
  const outcome = await run.outcome;
  assert.equal(outcome.exitCode, 0, outcome.stderr);
  return JSON.parse(outcome.stdout);
}

const limitsOf = (printed, model) => {
  const entry = printed.models.find((candidate) => candidate.model === model);
  assert.ok(entry, `${model} is among the usable models: ${JSON.stringify(printed.models)}`);
  const { contextWindow, maxOutputTokens, reasoningLevels } = entry;
  return { contextWindow, maxOutputTokens, reasoningLevels };
};

test("served CLIProxyAPI's catalogue, the command prints the window, output and levels it gave", async (t) => {
  const { provider, home } = await ownerWithListing(t, { listing: cliProxyApiCatalogue });

  const printed = await printedModels(t, home);

  assert.deepEqual(limitsOf(printed, "gateway-coder"), {
    contextWindow: 272_000,
    maxOutputTokens: 64_000,
    reasoningLevels: ["low", "medium", "high", "xhigh"],
  });
  assert.deepEqual(limitsOf(printed, "gateway-chat"), {
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    reasoningLevels: ["none", "low"],
  });
  assert.equal(
    printed.models.some(({ model }) => model === "gateway-image"),
    false,
    "a model the catalogue hides from clients is not offered",
  );
  assert.deepEqual(printed.listings, [{ provider: "stand-in", status: "read", models: 2 }]);

  const [listingRequest] = provider.requests;
  assert.equal(listingRequest.method, "GET");
  assert.equal(listingRequest.path, "/v1/models?client_version=cpa");
  assert.equal(
    listingRequest.headers.authorization,
    "Bearer stand-in-key",
    "the listing is read with the owner's key",
  );
});

test("served OpenRouter's listing, the command prints the window, output and levels it gave", async (t) => {
  const { home } = await ownerWithListing(t, { listing: openRouterListing });

  const printed = await printedModels(t, home);

  assert.deepEqual(limitsOf(printed, "vendor/reasoner"), {
    contextWindow: 400_000,
    maxOutputTokens: 100_000,
    reasoningLevels: ["low", "medium", "high"],
  });
  assert.deepEqual(limitsOf(printed, "vendor/plain"), {
    contextWindow: 32_768,
    maxOutputTokens: 8_192,
    reasoningLevels: ["disabled"],
  });
});

test("CLIProxyAPI registry levels take precedence over supported parameters, which supply the fallback", async (t) => {
  const { home } = await ownerWithListing(t, {
    listing: {
      data: [
        {
          id: "gateway-explicit-levels",
          thinking: { levels: ["low", "xhigh"] },
          supported_parameters: ["max_tokens", "reasoning_effort"],
        },
        {
          id: "gateway-empty-levels",
          thinking: { levels: [] },
          supported_parameters: ["reasoning_effort"],
        },
        {
          id: "gateway-no-levels",
          supported_parameters: ["max_tokens"],
        },
      ],
    },
  });

  const printed = await printedModels(t, home);

  assert.deepEqual(limitsOf(printed, "gateway-explicit-levels").reasoningLevels, ["low", "xhigh"]);
  assert.deepEqual(limitsOf(printed, "gateway-empty-levels").reasoningLevels, [
    "low",
    "medium",
    "high",
  ]);
  assert.deepEqual(limitsOf(printed, "gateway-no-levels").reasoningLevels, ["disabled"]);
});

test("a capability-only listing preserves built-in reasoning levels and their request mapping", async (t) => {
  const { home, provider } = await ownerWithListing(t, {
    listing: openRouterListing,
    defaultModelId: "openai/gpt-6-astra",
    reasoningLevel: "max",
    script: [say("Used the saved level."), say("Used the named level.")],
  });

  const printed = await printedModels(t, home);
  assert.deepEqual(limitsOf(printed, "openai/gpt-6-astra").reasoningLevels, [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  assert.deepEqual(limitsOf(printed, "openai/gpt-5.4").reasoningLevels, [
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
  ]);

  const saved = launch({ home, prompt: "Use the saved level." });
  t.after(() => saved.dispose());
  const savedOutcome = await saved.outcome;
  assert.equal(savedOutcome.exitCode, 0, savedOutcome.stderr);
  assert.equal(savedOutcome.result.response, "Used the saved level.");
  const [savedRequest] = provider.modelRequests();
  assert.equal(savedRequest.body.model, "openai/gpt-6-astra");
  assert.equal(savedRequest.body.reasoning_effort, "max");

  const named = launch({
    home,
    prompt: "Use the named level.",
    args: ["--provider", "stand-in", "--model", "openai/gpt-5.4", "--reasoning-level", "xhigh"],
  });
  t.after(() => named.dispose());
  const namedOutcome = await named.outcome;
  assert.equal(namedOutcome.exitCode, 0, namedOutcome.stderr);
  assert.equal(namedOutcome.result.response, "Used the named level.");
  assert.equal(provider.modelRequests().length, 2);
  const [, namedRequest] = provider.modelRequests();
  assert.equal(namedRequest.body.model, "openai/gpt-5.4");
  assert.equal(namedRequest.body.reasoning_effort, "xhigh");
  assert.equal(
    namedRequest.body.thinking,
    undefined,
    "the built-in model mapping sends effort only",
  );
});

test("a value the owner writes for a model replaces the listing's, and the listing's replaces the built-in rule's", async (t) => {
  const builtin = limitsOf(
    await printedModels(t, (await ownerWithListing(t, { modelIds: ["gateway-coder"] })).home),
    "gateway-coder",
  );
  const { home } = await ownerWithListing(t, {
    listing: cliProxyApiCatalogue,
    modelRules: [
      {
        providerId: "stand-in",
        modelId: "gateway-coder",
        config: { properties: { contextWindow: 50_000 } },
      },
    ],
  });

  const listed = limitsOf(await printedModels(t, home), "gateway-coder");

  assert.equal(listed.contextWindow, 50_000, "the owner's value");
  assert.equal(listed.maxOutputTokens, 64_000, "the listing's value");
  assert.notEqual(builtin.maxOutputTokens, 64_000, "the built-in rule says otherwise");
});

test("a value the listing does not give comes from the built-in rules", async (t) => {
  const builtin = limitsOf(
    await printedModels(t, (await ownerWithListing(t, { modelIds: ["sparse-model"] })).home),
    "sparse-model",
  );
  const { home } = await ownerWithListing(t, {
    listing: { models: [{ slug: "sparse-model", context_window: 64_000 }] },
  });

  const listed = limitsOf(await printedModels(t, home), "sparse-model");

  assert.deepEqual(listed, { ...builtin, contextWindow: 64_000 });
});

test("a model only the listing names runs, held to the listing's output limit and levels", async (t) => {
  const { provider, home } = await ownerWithListing(t, {
    listing: cliProxyApiCatalogue,
    modelIds: [],
    defaultModelId: "gateway-chat",
    reasoningLevel: "low",
    script: [say("Listed and answering.")],
  });

  const run = launch({ home, prompt: "Say something." });
  t.after(() => run.dispose());
  const outcome = await run.outcome;

  assert.equal(outcome.exitCode, 0, outcome.stderr);
  assert.equal(outcome.result.response, "Listed and answering.");
  const [request] = provider.modelRequests();
  assert.equal(request.body.model, "gateway-chat");
  assert.equal(request.body.max_tokens ?? request.body.max_completion_tokens, 16_384);
  assert.equal(request.body.reasoning_effort, "low", "a reasoning level only the listing gives");
});

for (const [condition, listing, reason] of [
  ["answers with an HTTP error", undefined, "HTTP 404"],
  ["never answers", hang(), "Model listing timed out"],
  [
    "answers without a model array",
    { error: "unrecognised response" },
    "Model listing has no models or data array",
  ],
]) {
  test(`a run starts and completes when the listing ${condition}`, async (t) => {
    const { provider, home } = await ownerWithListing(t, {
      listing,
      script: [say("Answered without a listing.")],
    });

    const run = launch({ home, prompt: "Say something." });
    t.after(() => run.dispose());
    const outcome = await run.outcome;

    assert.equal(outcome.exitCode, 0, outcome.stderr);
    assert.equal(outcome.result.response, "Answered without a listing.");
    assert.equal(provider.modelRequests().length, 1);

    const printed = await printedModels(t, home);
    assert.deepEqual(printed.listings, [{ provider: "stand-in", status: "failed", reason }]);
    assert.ok(limitsOf(printed, "configured-model"), "the configured model is still offered");
  });
}

for (const [condition, failure, reason] of [
  ["transport", "throw new Error(requestDetails);", "Model listing request failed"],
  [
    "JSON decoding",
    "return new Response(options.headers['x-fixture-secret']);",
    "Model listing response is not readable JSON",
  ],
]) {
  test(`a listing ${condition} failure reports a reason without copying request details`, async (t) => {
    const baseUrl = "http://fixture-user:fixture-password@127.0.0.1:1/v1";
    const providerConfig = providerConfiguration({ baseUrl });
    const [rule] = providerConfig.config.providerConfigRules.providerRules;
    rule.config.api.headers = { "x-fixture-secret": "fixture-header-value" };
    const home = await createOwnerHome({ providerConfig });
    t.after(() => home.remove());

    // The transport error quotes the request, and the malformed body quotes a header.
    const preload = `
      const fetch = globalThis.fetch;
      globalThis.fetch = (url, options) => {
        if (!String(url).includes("/v1/models?")) return fetch(url, options);
        const requestDetails = JSON.stringify({ url, headers: options.headers });
        ${failure}
      };
    `;
    home.env.NODE_OPTIONS = `--import=data:text/javascript,${encodeURIComponent(preload)}`;

    const printed = await printedModels(t, home);
    assert.deepEqual(printed.listings, [{ provider: "stand-in", status: "failed", reason }]);
    assert.ok(limitsOf(printed, "stand-in-model"), "the configured model is still offered");
  });
}

for (const versionedBase of [true, false]) {
  test(`an Anthropic-compatible ${versionedBase ? "versioned" : "unversioned"} base reads /v1/models with both credentials`, async (t) => {
    const { provider, home } = await ownerWithListing(t, {
      listing: openRouterListing,
      apiType: "anthropic-messages",
      versionedBase,
    });

    const printed = await printedModels(t, home);

    assert.deepEqual(limitsOf(printed, "vendor/reasoner"), {
      contextWindow: 400_000,
      maxOutputTokens: 100_000,
      reasoningLevels: ["low", "medium", "high"],
    });
    const [listingRequest] = provider.requests;
    assert.equal(listingRequest.method, "GET");
    assert.equal(listingRequest.path, "/v1/models?client_version=cpa");
    assert.equal(listingRequest.headers.authorization, "Bearer stand-in-key");
    assert.equal(listingRequest.headers["x-api-key"], "stand-in-key");
  });
}

test("a listed model is offered even where a built-in rule switches it off", async (t) => {
  // The built-in rules switch kimi-k2.6 off for providers made from this template.
  const unlisted = await printedModels(
    t,
    (await ownerWithListing(t, { modelIds: ["kimi-k2.6"], templateId: "opencode-go-chat" })).home,
  );
  assert.equal(
    unlisted.models.some(({ model }) => model === "kimi-k2.6"),
    false,
    "the built-in rule switches the model off when nothing lists it",
  );
  const { home } = await ownerWithListing(t, {
    listing: { models: [{ slug: "kimi-k2.6", context_window: 256_000, max_tokens: 32_000 }] },
    templateId: "opencode-go-chat",
  });

  const printed = await printedModels(t, home);

  assert.equal(limitsOf(printed, "kimi-k2.6").contextWindow, 256_000);
});

test("a listed reasoning level reaches the model as that level, whatever a built-in mapping expects", async (t) => {
  // kimi-k2.6's built-in mapping knows only "enabled" and "disabled", and sends any other level as disabled.
  const { provider, home } = await ownerWithListing(t, {
    listing: {
      models: [
        {
          slug: "kimi-k2.6",
          supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
        },
      ],
    },
    modelIds: [],
    defaultModelId: "kimi-k2.6",
    reasoningLevel: "high",
    script: [say("Reasoned.")],
  });

  const run = launch({ home, prompt: "Think hard." });
  t.after(() => run.dispose());
  const outcome = await run.outcome;

  assert.equal(outcome.exitCode, 0, outcome.stderr);
  const [request] = provider.modelRequests();
  assert.equal(request.body.model, "kimi-k2.6");
  assert.equal(request.body.reasoning_effort, "high");
  assert.notEqual(request.body.thinking?.type, "disabled");
});
