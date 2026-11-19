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
  { listing, script, modelIds = ["configured-model"], modelRules, defaultModelId, reasoningLevel },
) {
  const provider = await startModelProvider({ listing, script });
  t.after(() => provider.close());
  const providerConfig = providerConfiguration({
    baseUrl: provider.baseUrl,
    modelIds,
    defaultModelId: defaultModelId ?? modelIds[0],
  });
  if (modelRules) providerConfig.config.modelConfigRules.providerModelRules.push(...modelRules);
  // A default without a reasoning level is passed over for the first model listed.
  if (reasoningLevel) providerConfig.config.defaultModelSelection.options = { reasoningLevel };
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

  const listingRequest = provider.requests.find(({ path }) => path.startsWith("/v1/models"));
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

for (const [condition, listing] of [
  ["answers with an error", undefined],
  ["never answers", hang()],
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
    assert.equal(printed.listings[0].status, "failed");
    assert.ok(limitsOf(printed, "configured-model"), "the configured model is still offered");
  });
}
