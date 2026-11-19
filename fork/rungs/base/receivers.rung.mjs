/**
 * The receivers every other rung is proven at, exercised on their own: the launcher,
 * the stand-in model provider, the stand-in SearXNG and the sandbox's record. None
 * of this depends on a difference the fork makes, so when an upstream release breaks
 * these, it broke the way `zcode` is launched or answers, not a difference.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect } from "node:net";
import { beforeEach, test } from "node:test";
import { launch } from "../../harness/launcher.mjs";
import {
  callTool,
  hang,
  isModelRequest,
  say,
  startModelProvider,
} from "../../harness/model-provider.mjs";
import { attempts, forgetAttempts, pointNameAtStandIn } from "../../harness/network-sandbox.mjs";
import { createOwnerHome, providerConfiguration } from "../../harness/owner-home.mjs";
import { startSearxng } from "../../harness/searxng.mjs";

beforeEach(forgetAttempts);

/** One provider, one home configured for it, both removed when the test ends. */
async function ownerWithProvider(t, script) {
  const provider = await startModelProvider({ script });
  t.after(() => provider.close());
  const home = await createOwnerHome({
    providerConfig: providerConfiguration({ baseUrl: provider.baseUrl }),
  });
  t.after(() => home.remove());
  return { provider, home };
}

test("a run completes the turn the stand-in provider scripts, and reports it on stdout", async (t) => {
  const { provider, home } = await ownerWithProvider(t, [
    callTool("Bash", { command: "echo marker-from-the-tool", description: "Print the marker" }),
    say("The marker is printed."),
  ]);

  const run = launch({ home, prompt: "Print the marker." });
  t.after(() => run.dispose());
  const outcome = await run.outcome;

  assert.equal(outcome.exitCode, 0, outcome.stderr);
  assert.equal(outcome.result.response, "The marker is printed.");

  const [first, second, ...others] = provider.modelRequests();
  assert.deepEqual(others, [], "the turn takes exactly the two scripted model requests");
  assert.equal(first.body.model, "stand-in-model");
  assert.ok(
    first.body.messages.some((message) => JSON.stringify(message).includes("Print the marker.")),
    "the prompt reaches the model",
  );
  assert.ok(
    second.body.messages.some(
      (message) =>
        message.role === "tool" && JSON.stringify(message).includes("marker-from-the-tool"),
    ),
    "the tool ran and its output went back to the model",
  );
});

test("a signal stops a run that is waiting for the model", async (t) => {
  const { provider, home } = await ownerWithProvider(t, [hang()]);

  const run = launch({ home, prompt: "Wait for a reply that never comes." });
  t.after(() => run.dispose());
  await provider.request(isModelRequest);
  assert.ok(run.running(), "the run waits while the model has not answered");

  const outcome = await run.stop("SIGTERM");

  assert.notEqual(outcome.exitCode, 0, "a stopped run does not report success");
});

test("only the stand-ins can be reached, and every other attempt is recorded", async (t) => {
  const provider = await startModelProvider({
    listing: { object: "list", data: [{ id: "listed-model" }] },
  });
  t.after(() => provider.close());
  const searxng = await startSearxng({
    results: ({ q }) => [{ url: "https://example.org/", title: `A result for ${q}` }],
  });
  t.after(() => searxng.close());
  await pointNameAtStandIn("gateway.example");
  await pointNameAtStandIn("search.example");

  // The stand-ins answer, by address and by the names pointed at them.
  const listing = await (await fetch(`http://gateway.example:${provider.port}/v1/models`)).json();
  assert.equal(listing.data[0].id, "listed-model");
  assert.equal(provider.requests[0].path, "/v1/models");
  const { port: searchPort } = new URL(searxng.url);
  const found = await (
    await fetch(`http://search.example:${searchPort}/search?q=rungs&format=json&categories=images`)
  ).json();
  assert.equal(found.results[0].title, "A result for rungs");
  assert.deepEqual(searxng.queries, [
    { q: "rungs", params: { q: "rungs", format: "json", categories: "images" } },
  ]);

  // Anything else is refused: a host by name, and an address with no name.
  await assert.rejects(fetch("http://elsewhere.example:8080/"));
  await assert.rejects(
    new Promise((resolve, reject) =>
      connect(443, "203.0.113.7").once("connect", resolve).once("error", reject),
    ),
    { code: "ECONNREFUSED" },
  );

  const { names, connections } = await attempts();
  assert.deepEqual(names, ["elsewhere.example"], "stand-in names are not attempts");
  assert.deepEqual(
    connections.map(({ protocol, name, address, port }) => ({
      protocol,
      to: name ?? address,
      port,
    })),
    [
      { protocol: "tcp", to: "elsewhere.example", port: 8080 },
      { protocol: "tcp", to: "203.0.113.7", port: 443 },
    ],
  );
});

test("a non-loopback address is refused even when a server listens on every interface", async (t) => {
  const server = createServer((_request, response) => response.end("unexpected connection"));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", resolve);
  });
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const { port } = server.address();

  const allowed = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(allowed.status, 200);
  await allowed.text();

  await assert.rejects(
    new Promise((resolve, reject) =>
      connect(port, "203.0.113.8").once("connect", resolve).once("error", reject),
    ),
    { code: "ECONNREFUSED" },
  );
  assert.deepEqual((await attempts()).connections, [
    { protocol: "tcp", address: "203.0.113.8", port },
  ]);
});
