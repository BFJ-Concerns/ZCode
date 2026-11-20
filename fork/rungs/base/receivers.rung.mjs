/**
 * The receivers every other rung is proven at, exercised on their own: the launcher,
 * the stand-in model provider, the stand-in SearXNG and the sandbox's record. None
 * of this depends on a difference the fork makes, so when an upstream release breaks
 * these, it broke the way `zcode` is launched or answers, not a difference.
 */

import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { lookup } from "node:dns/promises";
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

/** Settles once a TCP connection to `address` is refused; fails if one is made. */
const refusedAt = (port, address) =>
  assert.rejects(
    new Promise((resolve, reject) =>
      connect(port, address).once("connect", resolve).once("error", reject),
    ),
    { code: "ECONNREFUSED" },
  );

/** The recorded connections as `protocol to:port`, sorted: the record has no order. */
const destinations = (connections) =>
  connections
    .map(({ protocol, name, address, port }) => `${protocol} ${name ?? address}:${port}`)
    .sort();

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
    // The marker is worked out by the shell, so only output of a command that ran holds it.
    callTool("Bash", { command: "echo marker-$((40 + 2))", description: "Print the marker" }),
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
      (message) => message.role === "tool" && JSON.stringify(message).includes("marker-42"),
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
  // As a real instance does, SearXNG answers JSON only when it is asked for.
  const page = await fetch(`${searxng.url}/search?q=rungs`);
  assert.match(page.headers.get("content-type") ?? "", /^text\/html/);
  await page.text();

  // Anything else is refused: a host by name, and an address with no name.
  await assert.rejects(fetch("http://elsewhere.example:8080/"));
  await refusedAt(443, "203.0.113.7");
  await refusedAt(443, "2001:db8::7");
  const datagrams = { udp4: "203.0.113.9", udp6: "2001:db8::9" };
  for (const [type, address] of Object.entries(datagrams)) {
    const socket = createSocket(type);
    await new Promise((resolve) => socket.send("attempt", 5353, address, () => resolve()));
    socket.close();
  }

  const { names, connections } = await attempts();
  assert.deepEqual(names, ["elsewhere.example"], "stand-in names are not attempts");
  assert.deepEqual(destinations(connections), [
    "tcp 2001:db8::7:443",
    "tcp 203.0.113.7:443",
    "tcp elsewhere.example:8080",
    "udp 2001:db8::9:5353",
    "udp 203.0.113.9:5353",
  ]);
});

test("zcode, and a command it runs, are refused and recorded wherever they reach", async (t) => {
  // The command says what became of its connection, and its output goes back to the model.
  const reach = [
    `const net = require("node:net");`,
    `const socket = net.connect(9, "command.elsewhere.example");`,
    `socket.on("connect", () => { console.log("command connected"); socket.destroy(); });`,
    `socket.on("error", (error) => console.log("command " + error.code));`,
  ].join(" ");
  const { provider, home } = await ownerWithProvider(t, [
    callTool("Bash", {
      command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(reach)}`,
      description: "Reach another host",
    }),
    say("The command was refused."),
  ]);
  const run = launch({ home, prompt: "Reach another host." });
  t.after(() => run.dispose());
  const outcome = await run.outcome;
  assert.equal(outcome.exitCode, 0, outcome.stderr);
  const [, afterCommand] = provider.modelRequests();
  const commandOutput = afterCommand.body.messages
    .filter((message) => message.role === "tool")
    .map((message) => JSON.stringify(message.content))
    .join("\n");
  assert.match(commandOutput, /command ECONNREFUSED/, "the command's connection is refused");

  // A provider the owner names on a host the sandbox does not hold: zcode itself reaches
  // for it, and retries for minutes, so the rung stops it once an attempt has failed.
  const unreachableUrl = "http://provider.elsewhere.example:8080/v1";
  const unreachable = await createOwnerHome({
    providerConfig: providerConfiguration({ baseUrl: unreachableUrl }),
  });
  t.after(() => unreachable.remove());
  const refused = launch({ home: unreachable, prompt: "Reach the provider." });
  t.after(() => refused.dispose());
  const failure = await refused.event(
    ({ payload }) => payload?.baseURL === unreachableUrl && payload.errorPhase !== undefined,
  );
  assert.match(JSON.stringify(failure.payload), /ECONNREFUSED/);
  await refused.stop();

  const { names, connections } = await attempts();
  assert.ok(names.includes("command.elsewhere.example"), names.join(", "));
  assert.ok(names.includes("provider.elsewhere.example"), names.join(", "));
  const recorded = destinations(connections);
  assert.ok(recorded.includes("tcp command.elsewhere.example:9"), recorded.join(", "));
  assert.ok(recorded.includes("tcp provider.elsewhere.example:8080"), recorded.join(", "));
});

test("a name keeps the address it was given after the record is forgotten", async () => {
  const [earlier] = await lookup("earlier.example", { all: true, family: 4 });
  await pointNameAtStandIn("stand-in.example");
  await forgetAttempts();

  // After forgetting, a name pointed at a stand-in is refused and recorded like any other,
  // and a late connection to an address looked up before is still the earlier name's.
  await assert.rejects(fetch("http://stand-in.example:8081/"));
  const [later] = await lookup("later.example", { all: true, family: 4 });
  assert.notEqual(later.address, earlier.address);
  await refusedAt(8082, earlier.address);

  const { names, connections } = await attempts();
  assert.deepEqual(names, ["stand-in.example", "later.example"]);
  assert.deepEqual(destinations(connections), [
    "tcp earlier.example:8082",
    "tcp stand-in.example:8081",
  ]);
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

  await refusedAt(port, "203.0.113.8");
  assert.deepEqual(destinations((await attempts()).connections), [`tcp 203.0.113.8:${port}`]);
});

test("a non-loopback IPv6 address is refused even when a server listens on every interface", async (t) => {
  const server = createServer((_request, response) => response.end("unexpected connection"));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "::", resolve);
  });
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const { port } = server.address();

  const allowed = await fetch(`http://[::1]:${port}/`);
  assert.equal(allowed.status, 200);
  await allowed.text();

  await refusedAt(port, "2001:db8::8");
  assert.deepEqual(destinations((await attempts()).connections), [`tcp 2001:db8::8:${port}`]);
});

for (const [type, wildcard, address] of [
  ["udp4", "0.0.0.0", "203.0.113.10"],
  ["udp6", "::", "2001:db8::10"],
]) {
  test(`a ${type} datagram to a non-loopback address is refused even when a socket listens on every interface`, async (t) => {
    const listener = createSocket(type);
    await new Promise((resolve, reject) => {
      listener.once("error", reject);
      listener.bind(0, wildcard, resolve);
    });
    t.after(() => listener.close());
    const { port } = listener.address();

    // A refused datagram comes back to a connected socket as ECONNREFUSED; one that gets
    // through reaches the listener instead, and the rung fails on it.
    const sender = createSocket(type);
    t.after(() => sender.close());
    await assert.rejects(
      new Promise((resolve, reject) => {
        listener.once("message", () => resolve("the listener received the datagram"));
        sender.once("error", reject);
        sender.connect(port, address, () => sender.send("attempt"));
      }),
      { code: "ECONNREFUSED" },
    );
    assert.deepEqual(destinations((await attempts()).connections), [`udp ${address}:${port}`]);
  });
}
