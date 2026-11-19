import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { launch } from "../../harness/launcher.mjs";
import { callTool, say, startModelProvider } from "../../harness/model-provider.mjs";
import { createOwnerHome, providerConfiguration } from "../../harness/owner-home.mjs";
import { startSearxng } from "../../harness/searxng.mjs";

const WEB_QUERY = "birds & habitats";
const IMAGE_QUERY = "kingfisher + river";
const WEB_RESULT = {
  title: "Kingfisher field guide",
  url: "https://guide.example/birds/kingfisher",
  content: "Look for a flash of blue.",
};
const IMAGE_RESULT = {
  title: "Kingfisher at the river",
  url: "https://photos.example/kingfisher",
  img_src: "https://media.example/kingfisher.jpg",
};

async function ownerWithSearch(t, { configured, nativeSearch, script }) {
  const modelId = nativeSearch ? "stand-in-native-search" : "stand-in-client-search";
  const provider = await startModelProvider({ script });
  t.after(() => provider.close());
  const search = await startSearxng({
    results: ({ params }) =>
      params.categories === "images"
        ? [IMAGE_RESULT]
        : [WEB_RESULT, { url: "https://ignore.example/", title: "Excluded result" }],
  });
  t.after(() => search.close());
  const home = await createOwnerHome({
    providerConfig: providerConfiguration({ baseUrl: provider.baseUrl, modelIds: [modelId] }),
    cliConfig: configured ? { searxngUrl: search.url } : {},
  });
  t.after(() => home.remove());

  // Supply a built-in rule for the loopback provider. Shipped native-search rules
  // match specific HTTPS endpoints that the OpenAI-compatible stand-in does not serve.
  const builtinPath = join(home.dir, "builtin.json");
  const builtin = JSON.parse(
    await readFile(new URL("../../../config/provider/zcode-builtin.json", import.meta.url), "utf8"),
  );
  builtin.config.modelConfigRules.builtinProviderModelRules.push({
    providerId: "stand-in",
    modelId,
    config: { properties: { supportsNativeWebSearch: nativeSearch } },
  });
  await writeFile(builtinPath, JSON.stringify(builtin));
  home.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = builtinPath;
  home.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = join(
    home.dir,
    ".zcode",
    "v2",
    "provider_config.json",
  );
  return { home, provider, search, modelId };
}

async function run(t, home, prompt) {
  const process = launch({ home, prompt });
  t.after(() => process.dispose());
  const outcome = await process.outcome;
  assert.equal(outcome.exitCode, 0, outcome.stderr);
  assert.equal(outcome.result?.response, "Done.");
  return outcome.result;
}

function offeredSearches(request) {
  return (request.body.tools ?? [])
    .map((tool) => tool.function?.name ?? tool.name ?? tool.type)
    .filter((name) => /web_?search|image_?search/i.test(name))
    .sort();
}

test("models without native search are offered both tools and receive both SearXNG results", async (t) => {
  await checkConfiguredSearch(t, false);
});

test("models with native search are offered both tools and still receive the SearXNG results", async (t) => {
  await checkConfiguredSearch(t, true);
});

async function checkConfiguredSearch(t, nativeSearch) {
  const { home, provider, search, modelId } = await ownerWithSearch(t, {
    configured: true,
    nativeSearch,
    script: [
      callTool("WebSearch", { query: WEB_QUERY, allowed_domains: ["guide.example"] }),
      callTool("ImageSearch", { query: IMAGE_QUERY }),
      say("Done."),
    ],
  });
  const { traceId } = await run(t, home, "Search the web and find an image.");
  assert.ok(traceId, "the run reports its trace ID");

  const requests = provider.modelRequests();
  assert.equal(requests.length, 3);
  for (const request of requests) {
    assert.equal(request.body.model, modelId);
    assert.deepEqual(offeredSearches(request), ["ImageSearch", "WebSearch"]);
  }
  assert.deepEqual(search.queries, [
    { q: WEB_QUERY, params: { q: WEB_QUERY, format: "json", categories: "general" }, traceId },
    { q: IMAGE_QUERY, params: { q: IMAGE_QUERY, format: "json", categories: "images" }, traceId },
  ]);
  const webReply = toolMessages(requests[1]);
  assert.ok(webReply.includes(WEB_RESULT.url));
  assert.ok(webReply.includes(WEB_RESULT.content));
  assert.ok(!webReply.includes("ignore.example"));
  const imageReply = toolMessages(requests[2]);
  assert.ok(imageReply.includes(IMAGE_RESULT.url));
  assert.ok(imageReply.includes(IMAGE_RESULT.img_src));
}

function toolMessages(request) {
  return JSON.stringify(request.body.messages.filter((message) => message.role === "tool"));
}

test("neither search is offered without an owner instance, even for a native-search model", async (t) => {
  const { home, provider, search } = await ownerWithSearch(t, {
    configured: false,
    nativeSearch: true,
    script: [say("Done.")],
  });
  await writeFile(join(home.workspace, "zcode.json"), JSON.stringify({ searxngUrl: search.url }));
  await run(t, home, "Which tools are available?");

  const requests = provider.modelRequests();
  assert.equal(requests.length, 1);
  assert.deepEqual(offeredSearches(requests[0]), []);
  assert.deepEqual(search.queries, []);
});
