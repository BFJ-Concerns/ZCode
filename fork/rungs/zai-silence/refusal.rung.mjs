/**
 * The runtime refusal: a Z.ai host name planted where the fork's own process will
 * request it (here, an MCP server in the owner's configuration) is refused and the
 * attempt reported, unless the owner has configured that host as a model provider, in
 * which case the request is made. The name is pointed at the stand-in, so a request the
 * fork makes arrives there and one it refuses does not. Through the owner's HTTP proxy the
 * same holds: the proxy is never asked for a Z.ai host.
 */

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import { startHttpProxy } from "../../harness/http-proxy.mjs";
import { launch } from "../../harness/launcher.mjs";
import { say, startModelProvider } from "../../harness/model-provider.mjs";
import { attempts, forgetAttempts, pointNameAtStandIn } from "../../harness/network-sandbox.mjs";
import { createOwnerHome, providerConfiguration } from "../../harness/owner-home.mjs";

const ZAI_HOST = "api.z.ai";
const MCP_PATH = "/planted-mcp";

beforeEach(forgetAttempts);

/** The owner's CLI configuration with one remote MCP server, which `zcode` connects to at start-up. */
const plantedMcpServer = (url) => ({
  features: { mcp: true },
  mcp: { servers: { planted: { type: "http", url, enabled: true } } },
});

const isPlantedRequest = (request) => request.path.startsWith(MCP_PATH);

/** The refusals the fork reported in this home, one record per line. */
async function reportedRefusals(home) {
  const text = await readFile(
    join(home.dir, ".zcode", "cli", "refused-zai-connections.jsonl"),
    "utf8",
  ).catch((error) => (error.code === "ENOENT" ? "" : Promise.reject(error)));
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

async function runWith(t, { providerBaseUrl, provider }) {
  const home = await createOwnerHome({
    providerConfig: providerConfiguration({ baseUrl: providerBaseUrl }),
    cliConfig: plantedMcpServer(`http://${ZAI_HOST}:${provider.port}${MCP_PATH}`),
  });
  t.after(() => home.remove());
  const run = launch({ home, prompt: "Say anything." });
  t.after(() => run.dispose());
  return { home, outcome: await run.outcome };
}

test("a request to a Z.ai host that is not a configured provider is refused and reported", async (t) => {
  const provider = await startModelProvider({ script: () => say("Answered.") });
  t.after(() => provider.close());
  await pointNameAtStandIn(ZAI_HOST);

  const { home, outcome } = await runWith(t, { providerBaseUrl: provider.baseUrl, provider });

  assert.equal(outcome.exitCode, 0, outcome.stderr);
  assert.equal(outcome.result.response, "Answered.", "the run goes on without the refused server");
  assert.deepEqual(provider.requests.filter(isPlantedRequest), [], "the request was not made");
  assert.deepEqual(
    (await reportedRefusals(home)).map(({ host, port, command }) => ({ host, port, command })),
    [{ host: ZAI_HOST, port: provider.port, command: "prompt" }],
    "the attempt is reported where the owner can read it",
  );
  assert.match(
    outcome.stderr,
    new RegExp(`refused a connection to ${ZAI_HOST.replace(".", "\\.")}`, "u"),
  );
  assert.deepEqual(
    await attempts(),
    { names: [], connections: [] },
    "refused before it was looked up",
  );
});

test("the refusal record identifies malformed provider JSON without quoting it", async (t) => {
  const provider = await startModelProvider();
  t.after(() => provider.close());
  await pointNameAtStandIn(ZAI_HOST);
  const home = await createOwnerHome({
    providerConfig: providerConfiguration({ baseUrl: provider.baseUrl }),
  });
  t.after(() => home.remove());
  const configPath = join(home.dir, ".zcode", "v2", "provider_config.json");
  const secret = "KEYFRAG";
  await writeFile(configPath, `{"apiKey": ${secret}}`);

  const run = launch({
    home,
    command: [
      "plugins",
      "marketplace",
      "add",
      `http://${ZAI_HOST}:${provider.port}${MCP_PATH}.json`,
    ],
  });
  t.after(() => run.dispose());
  const outcome = await run.outcome;
  assert.notEqual(outcome.exitCode, 0);
  assert.match(outcome.stderr, /refused a connection to api\.z\.ai/u);

  const records = await reportedRefusals(home);
  assert.equal(records.length, 1);
  assert.equal(records[0].host, ZAI_HOST);
  assert.ok(!JSON.stringify(records).includes(secret), "the report contains no provider key");
  assert.match(records[0].providerConfiguration, /provider_config\.json: invalid JSON$/u);
  assert.deepEqual(provider.requests.filter(isPlantedRequest), [], "the request was refused");
});

test("the same request is made when the owner has configured that host as a model provider", async (t) => {
  const provider = await startModelProvider({ script: () => say("Answered.") });
  t.after(() => provider.close());
  await pointNameAtStandIn(ZAI_HOST);

  const { home, outcome } = await runWith(t, {
    providerBaseUrl: `http://${ZAI_HOST}:${provider.port}/v1`,
    provider,
  });

  assert.equal(outcome.exitCode, 0, outcome.stderr);
  assert.equal(outcome.result.response, "Answered.", "the model requests reached the provider");
  assert.notDeepEqual(
    provider.requests.filter(isPlantedRequest),
    [],
    "the planted request was made",
  );
  assert.deepEqual(await reportedRefusals(home), [], "nothing was refused");
});

test("a host the owner configured through a built-in provider template is reached", async (t) => {
  const provider = await startModelProvider({ script: () => say("Answered.") });
  t.after(() => provider.close());
  await pointNameAtStandIn(ZAI_HOST);
  // The stand-in stays the default; the owner also added Z.ai's standard API from its
  // built-in template, giving a key and no base URL of their own, which reaches api.z.ai.
  const providerConfig = providerConfiguration({ baseUrl: provider.baseUrl });
  providerConfig.config.providerConfigRules.providerRules.push({
    providerId: "zai-from-template",
    providerName: "Z.ai",
    templateId: "zai-standard-api",
    config: { group: "standard-personal", access: { type: "api-key", apiKey: "owner-key" } },
  });
  const home = await createOwnerHome({
    providerConfig,
    cliConfig: plantedMcpServer(`http://${ZAI_HOST}:${provider.port}${MCP_PATH}`),
  });
  t.after(() => home.remove());
  const run = launch({ home, prompt: "Say anything." });
  t.after(() => run.dispose());
  const outcome = await run.outcome;

  assert.equal(outcome.exitCode, 0, outcome.stderr);
  assert.notDeepEqual(provider.requests.filter(isPlantedRequest), [], "the request was made");
  assert.deepEqual(await reportedRefusals(home), [], "nothing was refused");
});

/** The owner's CLI configuration sending everything but loopback through `proxy`, with a planted MCP server. */
const proxiedPlantedMcpServer = (proxy, url) => ({
  ...plantedMcpServer(url),
  network: { httpProxy: proxy.url, noProxy: "127.0.0.1,localhost" },
});

async function runThroughProxy(t, mcpHost) {
  const provider = await startModelProvider({ script: () => say("Answered.") });
  t.after(() => provider.close());
  const proxy = await startHttpProxy();
  t.after(() => proxy.close());
  const home = await createOwnerHome({
    providerConfig: providerConfiguration({ baseUrl: provider.baseUrl }),
    cliConfig: proxiedPlantedMcpServer(proxy, `https://${mcpHost}${MCP_PATH}`),
  });
  t.after(() => home.remove());
  const run = launch({ home, prompt: "Say anything." });
  t.after(() => run.dispose());
  return { home, proxy, outcome: await run.outcome };
}

test("through the owner's HTTP proxy, a planted request reaches the proxy", async (t) => {
  const { proxy, outcome } = await runThroughProxy(t, "mcp.example");

  assert.equal(outcome.exitCode, 0, outcome.stderr);
  assert.ok(proxy.destinations.includes("mcp.example:443"), JSON.stringify(proxy.destinations));
});

test("through the owner's HTTP proxy, a request to a Z.ai host is refused and reported", async (t) => {
  const { home, proxy, outcome } = await runThroughProxy(t, ZAI_HOST);

  assert.equal(outcome.exitCode, 0, outcome.stderr);
  assert.equal(outcome.result.response, "Answered.", "the run goes on without the refused server");
  assert.deepEqual(
    proxy.destinations.filter((destination) => destination.startsWith(`${ZAI_HOST}:`)),
    [],
    "the proxy was never asked for the Z.ai host",
  );
  assert.deepEqual(
    (await reportedRefusals(home)).map(({ host, port }) => ({ host, port })),
    [{ host: ZAI_HOST, port: 443 }],
    "the attempt is reported once",
  );
});
