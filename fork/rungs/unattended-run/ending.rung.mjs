/**
 * A non-interactive run's exit status and its result say whether it finished its last
 * turn, failed or was cancelled: 0 and `"finished"`, 1 and `"failed"` with the reason,
 * or the stopping signal's status (128 + its number) and `"cancelled"`. The last turn
 * decides, so a run whose background work woke the model is judged by the woken turn.
 */

import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { launch } from "../../harness/launcher.mjs";
import {
  callTool,
  fail,
  hang,
  isModelRequest,
  say,
  startModelProvider,
} from "../../harness/model-provider.mjs";
import { createOwnerHome, providerConfiguration } from "../../harness/owner-home.mjs";

/** Status 400 is not retried, so the failure reaches the run at once. */
const REJECTED = 400;
const REJECTION = "the stand-in rejects this request";
const SIGINT_STATUS = 130;
const SIGTERM_STATUS = 143;

async function ownerWithProvider(t, script) {
  const provider = await startModelProvider({ script });
  t.after(() => provider.close());
  const home = await createOwnerHome({
    providerConfig: providerConfiguration({ baseUrl: provider.baseUrl }),
  });
  t.after(() => home.remove());
  return { provider, home };
}

function start(t, home, prompt = "Do the work.") {
  const run = launch({ home, prompt });
  t.after(() => run.dispose());
  return run;
}

/** A background command that runs until the run is stopped. */
const backgroundCommandThatOutlivesTheTurn = callTool("Bash", {
  command: "until false; do sleep 1; done",
  description: "Run until stopped",
  run_in_background: true,
});

test("a run whose last turn completes exits 0 and says it finished", async (t) => {
  const { home } = await ownerWithProvider(t, [say("Done.")]);

  const outcome = await start(t, home).outcome;

  assert.equal(outcome.exitCode, 0, outcome.stderr);
  assert.equal(outcome.result.outcome, "finished");
  assert.equal(outcome.result.error, undefined);
  assert.equal(outcome.result.response, "Done.");
});

test("a run whose only turn the provider fails exits 1 and says it failed, and why", async (t) => {
  const { home } = await ownerWithProvider(t, [fail(REJECTED, REJECTION)]);

  const outcome = await start(t, home).outcome;

  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.result.outcome, "failed");
  assert.match(outcome.result.error, new RegExp(REJECTION));
  assert.ok(outcome.result.sessionId, "the failed run still names its session");
});

test("a run whose woken last turn the provider fails exits 1 and says it failed", async (t) => {
  const { provider, home } = await ownerWithProvider(t, [
    // Finishes only once the first turn is over, so its end wakes a turn of its own.
    callTool("Bash", {
      command: "until [ -e release ]; do sleep 0.1; done",
      description: "Wait for the release",
      run_in_background: true,
    }),
    say("Started."),
    fail(REJECTED, REJECTION),
  ]);

  const run = start(t, home);
  await run.event((event) => event.type === "turn.completed");
  await writeFile(join(home.workspace, "release"), "");
  const outcome = await run.outcome;

  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.result.outcome, "failed");
  assert.match(outcome.result.error, new RegExp(REJECTION));
  assert.equal(outcome.result.response, "Started.", "the first turn's answer still stands");
  assert.equal(provider.modelRequests().length, 3, "the failed request was the woken turn's");
});

test("a run stopped by a signal while its background command runs says it was cancelled", async (t) => {
  const { home } = await ownerWithProvider(t, [
    backgroundCommandThatOutlivesTheTurn,
    say("Started."),
  ]);

  const run = start(t, home);
  await run.event((event) => event.type === "turn.completed");
  assert.ok(run.running(), "the run waits for its background command");
  const outcome = await run.stop("SIGTERM");

  assert.equal(outcome.exitCode, SIGTERM_STATUS);
  assert.equal(outcome.result.outcome, "cancelled");
});

test("a run stopped by a signal while the model is answering says it was cancelled", async (t) => {
  const { provider, home } = await ownerWithProvider(t, [hang()]);

  const run = start(t, home);
  await provider.request(isModelRequest);
  const outcome = await run.stop("SIGINT");

  assert.equal(outcome.exitCode, SIGINT_STATUS);
  assert.equal(outcome.result.outcome, "cancelled");
});
