/**
 * A non-interactive run's exit status and its result say whether it finished its last
 * turn, failed or was cancelled: 0 and `"finished"`, 1 and `"failed"` with the reason,
 * or the stopping signal's status (128 + its number) and `"cancelled"`, in text and JSON
 * output as in the event stream. The last turn decides, so a run whose background work
 * woke the model is judged by the woken turn, and the result gives that turn's answer.
 * The result is the last line the run writes, and a stopped run closes what it started
 * before it exits.
 */

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
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

function start(t, home, prompt = "Do the work.", options = {}) {
  const run = launch({ home, prompt, ...options });
  t.after(() => run.dispose());
  return run;
}

/** The stream ends with its result: no event follows the line that says how the run ended. */
function assertResultIsLast(outcome) {
  const lines = outcome.stdout.split("\n").filter((line) => line.trim() !== "");
  assert.equal(JSON.parse(lines.at(-1)).type, "result", "the result is the last line written");
}

/** The lines of text output's stderr that report a failure. */
const errorLines = (outcome) =>
  outcome.stderr.split("\n").filter((line) => line.startsWith("Error:"));

/** Whether a process is still running: absent from /proc, or a zombie, is not. */
async function isRunning(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2)[0] !== "Z";
  } catch {
    return false;
  }
}

/** A command that ignores the polite signals and records its process id in the workspace. */
const stubbornCommand = (pidFile) =>
  `echo $$ > ${pidFile}; trap '' TERM INT HUP; until false; do sleep 0.2; done`;

/** How often a rung looks for a process id a command has yet to record. */
const PID_POLL_MS = 20;

const toolResults = (request) =>
  request.body.messages.filter((message) => message.role === "tool").length;

/** The process id a command recorded in the workspace, once it has. */
async function pidOnceWritten(home, pidFile) {
  for (;;) {
    const written = await readFile(join(home.workspace, pidFile), "utf8").catch(() => "");
    if (written.endsWith("\n")) return Number(written.trim());
    await new Promise((resolve) => setTimeout(resolve, PID_POLL_MS));
  }
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
  assertResultIsLast(outcome);
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

test("a run whose turn fails while its background command runs waits to be woken by it", async (t) => {
  const { provider, home } = await ownerWithProvider(t, [
    callTool("Bash", {
      command: "until [ -e release ]; do sleep 0.1; done",
      description: "Wait for the release",
      run_in_background: true,
    }),
    fail(REJECTED, REJECTION),
    say("Recovered once the background command finished."),
  ]);

  const run = start(t, home);
  await run.event((event) => event.type === "turn.failed");
  assert.ok(run.running(), "a failed turn does not end a run its background command can wake");
  await writeFile(join(home.workspace, "release"), "");
  const outcome = await run.outcome;

  assert.equal(outcome.exitCode, 0, outcome.stderr);
  assert.equal(outcome.result.outcome, "finished");
  assert.equal(outcome.result.response, "Recovered once the background command finished.");
  assert.equal(provider.modelRequests().length, 3, "the woken turn is the last one");
});

test("a run refused before it starts says it failed", async (t) => {
  const { provider, home } = await ownerWithProvider(t, []);

  // Workflows are off unless --workflow-mode turns them on.
  const outcome = await start(t, home, "/workflow check the build").outcome;

  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.result.outcome, "failed");
  assert.match(outcome.result.error, /Dynamic workflows are disabled/);
  assert.equal(provider.modelRequests().length, 0);
});

test("a command answered without a model turn says it finished", async (t) => {
  const { home } = await ownerWithProvider(t, []);

  const outcome = await start(t, home, "/goal").outcome;

  assert.equal(outcome.exitCode, 0, outcome.stderr);
  assert.equal(outcome.result.outcome, "finished");
  assert.equal(typeof outcome.result.response, "string");
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
  assert.equal(outcome.result.response, "Started.", "the last turn's answer stands");
  assertResultIsLast(outcome);
});

test("a run stopped by a signal while the model is answering says it was cancelled", async (t) => {
  const { provider, home } = await ownerWithProvider(t, [hang()]);

  const run = start(t, home);
  await provider.request(isModelRequest);
  const outcome = await run.stop("SIGINT");

  assert.equal(outcome.exitCode, SIGINT_STATUS);
  assert.equal(outcome.result.outcome, "cancelled");
  assertResultIsLast(outcome);
});

test("a run stopped while its turn runs a command closes every command it started before it exits", async (t) => {
  const { provider, home } = await ownerWithProvider(t, [
    callTool("Bash", {
      command: stubbornCommand("background.pid"),
      description: "Run in the background until killed",
      run_in_background: true,
    }),
    callTool("Bash", {
      command: stubbornCommand("foreground.pid"),
      description: "Run until killed",
    }),
  ]);

  const run = start(t, home);
  // The turn's own command is the reply to the request carrying the background command's result.
  await provider.request((request) => isModelRequest(request) && toolResults(request) === 1);
  const foreground = await pidOnceWritten(home, "foreground.pid");
  const background = await pidOnceWritten(home, "background.pid");
  const outcome = await run.stop("SIGTERM");

  assert.equal(outcome.exitCode, SIGTERM_STATUS);
  assert.equal(outcome.result.outcome, "cancelled");
  assertResultIsLast(outcome);
  assert.equal(await isRunning(foreground), false, "the turn's own command is closed");
  assert.equal(await isRunning(background), false, "the background command is closed");
});

test("text output prints the answer and exits 0 when the run finishes", async (t) => {
  const { home } = await ownerWithProvider(t, [say("Done.")]);

  const outcome = await start(t, home, "Do the work.", { outputFormat: "text" }).outcome;

  assert.equal(outcome.exitCode, 0, outcome.stderr);
  assert.equal(outcome.stdout, "Done.\n");
  assert.deepEqual(errorLines(outcome), []);
});

test("text output says once why a failed run failed, and exits 1", async (t) => {
  const { home } = await ownerWithProvider(t, [fail(REJECTED, REJECTION)]);

  const outcome = await start(t, home, "Do the work.", { outputFormat: "text" }).outcome;

  assert.equal(outcome.exitCode, 1);
  assert.equal(errorLines(outcome).length, 1, `one failure is reported once:\n${outcome.stderr}`);
});

test("text output says a stopped run was cancelled, not that it failed", async (t) => {
  const { provider, home } = await ownerWithProvider(t, [hang()]);

  const run = start(t, home, "Do the work.", { outputFormat: "text" });
  await provider.request(isModelRequest);
  const outcome = await run.stop("SIGTERM");

  assert.equal(outcome.exitCode, SIGTERM_STATUS);
  assert.match(outcome.stderr, /^Cancelled by SIGTERM$/m);
  assert.deepEqual(errorLines(outcome), []);
});

test("JSON output says whether the run finished, failed or was cancelled", async (t) => {
  const { provider, home } = await ownerWithProvider(t, (request) => {
    const prompt = JSON.stringify(request.body.messages);
    if (prompt.includes("Fail.")) return fail(REJECTED, REJECTION);
    if (prompt.includes("Wait.")) return hang();
    return say("Done.");
  });
  const json = { outputFormat: "json" };

  const finished = await start(t, home, "Finish.", json).outcome;
  const failed = await start(t, home, "Fail.", json).outcome;
  const stopping = start(t, home, "Wait.", json);
  await provider.request(
    (request) => isModelRequest(request) && JSON.stringify(request.body.messages).includes("Wait."),
  );
  const cancelled = await stopping.stop("SIGTERM");

  assert.equal(finished.exitCode, 0, finished.stderr);
  assert.equal(finished.result.outcome, "finished");
  assert.equal(finished.result.response, "Done.");
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.result.outcome, "failed");
  assert.match(failed.result.error, new RegExp(REJECTION));
  assert.equal(cancelled.exitCode, SIGTERM_STATUS);
  assert.equal(cancelled.result.outcome, "cancelled");
});

test("a run resumed into a goal that takes further turns gives its last turn's answer", async (t) => {
  let goalTurns = 0;
  let verifications = 0;
  const { provider, home } = await ownerWithProvider(t, (request) => {
    const latest = JSON.stringify(request.body.messages.at(-1)?.content ?? "");
    if (latest.includes("Verify whether the active session goal is actually complete")) {
      verifications += 1;
      // Not yet on the first check, so that the goal takes a further turn; done on the second.
      return say(
        JSON.stringify({
          passed: verifications > 1,
          reason: "Not written yet.",
          nextAction: "Write it.",
        }),
      );
    }
    if (latest.includes("Open the session.")) return say("Opened.");
    if (latest.includes("Carry on.")) return say("Carried on.");
    goalTurns += 1;
    // The goal's first turn is never answered: the run that set the goal is killed in it.
    return goalTurns === 1 ? hang() : say("The goal's last turn.");
  });

  const opening = await start(t, home, "Open the session.").outcome;
  const sessionId = opening.result.sessionId;
  // A run killed outright while it pursues a goal leaves the goal active in its session.
  const settingGoal = start(t, home, "/goal Write the report.", { args: ["--resume", sessionId] });
  await provider.request(
    (request) =>
      isModelRequest(request) &&
      JSON.stringify(request.body.messages).includes("Write the report."),
  );
  await settingGoal.dispose();
  const outcome = await start(t, home, "Carry on.", { args: ["--resume", sessionId] }).outcome;

  assert.equal(outcome.exitCode, 0, outcome.stderr);
  assert.equal(outcome.result.outcome, "finished");
  assert.equal(verifications, 2, "the goal took a further turn after the prompt's");
  assert.deepEqual(outcome.result.turnResponses, ["Carried on.", "The goal's last turn."]);
  assert.equal(outcome.result.response, "The goal's last turn.");
});
