/**
 * A non-interactive run stays alive while its own work can still wake the model: a
 * background command, a background subagent or a workflow the run started keeps it
 * running after its turn ends, the model is woken when that work finishes, and the run
 * exits after the woken turn. A scheduled automation is not such work.
 *
 * The background work in these rungs waits for a file the rung creates, so the run is
 * observed waiting for as long as the rung chooses, with no clock involved.
 */

import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { launch } from "../../harness/launcher.mjs";
import { callTool, say, startModelProvider } from "../../harness/model-provider.mjs";
import { createOwnerHome, providerConfiguration } from "../../harness/owner-home.mjs";

const RELEASE_FILE = "release";
const FINISHED_MARKER = "background-work-finished";
/** Waits in the workspace until the rung creates the release file, then says so. */
const WAIT_FOR_RELEASE = `until [ -e ${RELEASE_FILE} ]; do sleep 0.1; done; echo ${FINISHED_MARKER}`;

async function ownerWithProvider(t, script) {
  const provider = await startModelProvider({ script });
  t.after(() => provider.close());
  const home = await createOwnerHome({
    providerConfig: providerConfiguration({ baseUrl: provider.baseUrl }),
  });
  t.after(() => home.remove());
  return { provider, home };
}

const release = (home) => writeFile(join(home.workspace, RELEASE_FILE), "");

/** The prompt a session was started with: its first user message that the fork did not add. */
const openingPrompt = (request) =>
  request.body.messages
    .filter((message) => message.role === "user")
    .map((message) => JSON.stringify(message.content))
    .find((content) => !content.includes("<system-reminder>")) ?? "";

const toolResultCount = (request) =>
  request.body.messages.filter((message) => message.role === "tool").length;

const mentions = (request, text) => JSON.stringify(request.body.messages).includes(text);

/**
 * Starts the run, waits for its first turn to end, checks it is still running, lets the
 * background work finish, and returns how the run ended.
 */
async function runPastItsFirstTurn(t, home, args = []) {
  const run = launch({ home, prompt: "Start the work in the background.", args });
  t.after(() => run.dispose());
  await run.event((event) => event.type === "turn.completed");
  assert.ok(run.running(), "the run is still running after its turn ends");
  await release(home);
  return await run.outcome;
}

function assertWokenAfterTheWork(outcome, provider) {
  assert.equal(outcome.exitCode, 0, outcome.stderr);
  assert.equal(outcome.result.outcome, "finished");
  assert.equal(outcome.result.response, "Woken by the finished work.");
  assert.deepEqual(outcome.result.turnResponses, ["Started.", "Woken by the finished work."]);
  const woken = provider
    .modelRequests()
    .find((request) => mentions(request, "Started.") && mentions(request, FINISHED_MARKER));
  assert.ok(woken, "the model is woken with the finished work's result");
}

test("a background command keeps the run alive until the model is woken by its end", async (t) => {
  const { provider, home } = await ownerWithProvider(t, [
    callTool("Bash", {
      command: WAIT_FOR_RELEASE,
      description: "Wait in the background",
      run_in_background: true,
    }),
    say("Started."),
    say("Woken by the finished work."),
  ]);

  const outcome = await runPastItsFirstTurn(t, home);

  assertWokenAfterTheWork(outcome, provider);
  assert.equal(provider.modelRequests().length, 3, "the woken turn is the last one");
});

test("a background subagent keeps the run alive until the model is woken by its end", async (t) => {
  const { provider, home } = await ownerWithProvider(t, (request) => {
    if (openingPrompt(request).includes("SUBAGENT-TASK")) {
      return toolResultCount(request) === 0
        ? callTool("Bash", { command: WAIT_FOR_RELEASE, description: "Wait for the release" })
        : say(`The subagent's work is done: ${FINISHED_MARKER}.`);
    }
    if (toolResultCount(request) === 0) {
      return callTool("Agent", {
        description: "Wait for the release",
        prompt: "SUBAGENT-TASK: wait for the release file.",
        run_in_background: true,
      });
    }
    return mentions(request, "Started.") ? say("Woken by the finished work.") : say("Started.");
  });

  const outcome = await runPastItsFirstTurn(t, home);

  assertWokenAfterTheWork(outcome, provider);
});

test("a workflow keeps the run alive until the model is woken by its end", async (t) => {
  const script = [
    `const answer = await agent("waiter").ask<string>("WORKFLOW-ACTOR-TASK: wait for the release file.");`,
    `log(answer);`,
    `return answer;`,
  ].join("\n");
  const { provider, home } = await ownerWithProvider(t, (request) => {
    if (openingPrompt(request).includes("WORKFLOW-ACTOR-TASK")) {
      return toolResultCount(request) === 0
        ? callTool("Bash", { command: WAIT_FOR_RELEASE, description: "Wait for the release" })
        : say(`The actor's work is done: ${FINISHED_MARKER}.`);
    }
    // The workflow tools refuse a script until the session has loaded their skill.
    if (toolResultCount(request) === 0) return callTool("Skill", { skill: "dynamic-workflows" });
    if (toolResultCount(request) === 1) {
      return callTool("CreateWorkflow", { name: "Wait for the release", script });
    }
    return mentions(request, "Started.") ? say("Woken by the finished work.") : say("Started.");
  });

  const outcome = await runPastItsFirstTurn(t, home, ["--workflow-mode", "alwaysOn"]);

  assertWokenAfterTheWork(outcome, provider);
});

test("a scheduled automation the model asks for does not hold the run open", async (t) => {
  const { provider, home } = await ownerWithProvider(t, [
    callTool("CronCreate", {
      cron: "*/20 * * * *",
      prompt: "Check the build.",
      title: "Every 20 minutes, check the build",
      recurring: true,
    }),
    say("Scheduled."),
  ]);

  const run = launch({ home, prompt: "Check the build every 20 minutes." });
  t.after(() => run.dispose());
  const outcome = await run.outcome;

  assert.equal(outcome.exitCode, 0, outcome.stderr);
  assert.equal(outcome.result.outcome, "finished");
  assert.equal(outcome.result.response, "Scheduled.");
  assert.equal(provider.modelRequests().length, 2, "the run ends with the turn that scheduled it");
});
