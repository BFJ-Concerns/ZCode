import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { launch } from "../../harness/launcher.mjs";
import { callTool, say, startModelProvider } from "../../harness/model-provider.mjs";
import { createOwnerHome, providerConfiguration } from "../../harness/owner-home.mjs";
import { startSearxng } from "../../harness/searxng.mjs";

const WEB_QUERY = "birds & habitats";
const MODEL_OUTPUT_LIMIT = 10_000;
const IMAGE_QUERY = "kingfisher + river";
const WEB_RESULT = {
  title: "Kingfisher field guide",
  url: "https://guide.example/birds/kingfisher",
  content: "Look for a flash of blue.",
};
const UNTITLED_RESULT = {
  url: "https://guide.example/birds/song",
  content: "Listen for a high whistle.",
};
const IMAGE_RESULT = {
  title: "Kingfisher at the river",
  url: "https://photos.example/kingfisher",
  img_src: "https://media.example/kingfisher.jpg",
};

async function ownerWithSearch(t, { configured, nativeSearch, script, webResults }) {
  const modelId = nativeSearch ? "stand-in-native-search" : "stand-in-client-search";
  const provider = await startModelProvider({ script });
  t.after(() => provider.close());
  const search = await startSearxng({
    results: ({ params }) =>
      params.categories === "images"
        ? [IMAGE_RESULT]
        : (webResults ?? [
            WEB_RESULT,
            UNTITLED_RESULT,
            { url: "https://ignore.example/", title: "Excluded result" },
          ]),
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
    const imageTool = request.body.tools.find((tool) => tool.function?.name === "ImageSearch");
    assert.deepEqual(imageTool.function.parameters, {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { query: { type: "string", minLength: 2 } },
      required: ["query"],
      additionalProperties: false,
    });
  }
  assert.deepEqual(search.queries, [
    { q: WEB_QUERY, params: { q: WEB_QUERY, format: "json", categories: "general" }, traceId },
    { q: IMAGE_QUERY, params: { q: IMAGE_QUERY, format: "json", categories: "images" }, traceId },
  ]);
  const webReply = toolMessages(requests[1]);
  assert.match(webReply, /^Web search results for query:/);
  assert.ok(webReply.includes(`\nSummary:\n${WEB_RESULT.title}: ${WEB_RESULT.content}\n`));
  assert.deepEqual(markdownLinks(webReply), [WEB_RESULT.url, UNTITLED_RESULT.url]);
  assert.equal(webReply.split(WEB_RESULT.url).length, 2);
  assert.equal(webReply.split(UNTITLED_RESULT.url).length, 2);
  assert.ok(!webReply.includes("ignore.example"));
  const imageReply = toolMessages(requests[2]);
  assert.ok(imageReply.includes(IMAGE_RESULT.url));
  assert.ok(imageReply.includes(IMAGE_RESULT.img_src));
}

function toolMessages(request) {
  return request.body.messages
    .filter((message) => message.role === "tool")
    .map((message) => message.content)
    .join("\n");
}

function markdownLinks(text) {
  return [...text.matchAll(/^- \[[^\]]+\]\(([^)]+)\)$/gm)].map((match) => match[1]);
}

test("case-sensitive destinations each appear once", async (t) => {
  const webResults = [
    { ...WEB_RESULT, url: "https://guide.example/Guide?edition=A" },
    { ...WEB_RESULT, url: "https://guide.example/guide?edition=A" },
    { ...WEB_RESULT, url: "https://guide.example/Guide?edition=a" },
  ];
  const { home, provider } = await ownerWithSearch(t, {
    configured: true,
    nativeSearch: false,
    script: [callTool("WebSearch", { query: WEB_QUERY }), say("Done.")],
    webResults: [...webResults, webResults[0]],
  });
  await run(t, home, "Search the web.");
  const reply = toolMessages(provider.modelRequests()[1]);
  assert.deepEqual(
    markdownLinks(reply),
    webResults.map(({ url }) => url),
  );
});

test("a full page keeps complete links and a summary within the model's UTF-8 limit", async (t) => {
  const webResults = Array.from({ length: 20 }, (_, index) => ({
    title: `Guide ${index + 1}`,
    url: `https://guide.example/articles/${index + 1}/${"a".repeat(200)}`,
    content: `Snippet ${index + 1}: ${"鳥".repeat(480)}`,
  }));
  const { home, provider } = await ownerWithSearch(t, {
    configured: true,
    nativeSearch: false,
    script: [callTool("WebSearch", { query: WEB_QUERY }), say("Done.")],
    webResults: [...webResults, webResults[0]],
  });
  await run(t, home, "Search the web.");

  const reply = toolMessages(provider.modelRequests()[1]);
  assert.ok(Buffer.byteLength(reply, "utf8") <= MODEL_OUTPUT_LIMIT);
  assert.match(reply, /\nSummary:\nGuide 1: Snippet 1: 鳥/);
  assert.match(reply, /\nLinks:\n/);
  assert.doesNotMatch(reply, /truncated by resultBudget/);
  assert.deepEqual(
    markdownLinks(reply),
    webResults.map(({ url }) => url),
  );
  for (const { url } of webResults) assert.equal(reply.split(url).length, 2);
});

test("long destinations use the available space in ranked order and stay whole", async (t) => {
  const webResults = Array.from({ length: 4 }, (_, index) => ({
    url: `https://guide.example/${index}/${"a".repeat(3500)}`,
    content: WEB_RESULT.content,
  }));
  const { home, provider } = await ownerWithSearch(t, {
    configured: true,
    nativeSearch: false,
    script: [callTool("WebSearch", { query: WEB_QUERY }), say("Done.")],
    webResults,
  });
  await run(t, home, "Search the web.");

  const reply = toolMessages(provider.modelRequests()[1]);
  assert.ok(Buffer.byteLength(reply, "utf8") <= MODEL_OUTPUT_LIMIT);
  assert.ok(reply.includes(`\nSummary:\n${WEB_RESULT.content}\n`));
  assert.doesNotMatch(reply, /truncated by resultBudget/);
  assert.deepEqual(
    markdownLinks(reply),
    webResults.slice(0, 2).map(({ url }) => url),
  );
});

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
