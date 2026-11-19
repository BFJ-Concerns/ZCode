/**
 * Non-interactive runs side by side: several runs started together against one home
 * directory all complete, and afterwards each run's session can be resumed with its
 * own records and nobody else's. An interactive session open in the same home at the
 * same time keeps its own conversation through it all.
 *
 * What a session holds is observed where it matters, at the provider: a resumed
 * session sends the model its history, so a lost or mixed-up record shows there.
 */

import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { launch } from "../../harness/launcher.mjs";
import { callTool, say, startModelProvider } from "../../harness/model-provider.mjs";
import { createOwnerHome, providerConfiguration } from "../../harness/owner-home.mjs";
import { openTerminalUi } from "../../harness/terminal-ui.mjs";

const RUN_COUNT = 4;
const RUN_TAGS = Array.from({ length: RUN_COUNT }, (_, index) => `RUN-${index + 1}`);
const TERMINAL_TAG = "TERMINAL";

const transcript = (request) => JSON.stringify(request.body.messages);
/** The latest prompt in a request: its last user message that the fork did not add. */
const lastUserText = (request) =>
  request.body.messages
    .filter((message) => message.role === "user")
    .map((message) => JSON.stringify(message.content))
    .findLast((content) => !content.includes("<system-reminder>")) ?? "";

/**
 * Each session is told apart by the tag in its prompts. A first prompt has the model
 * run a command that prints the tag, so the session's records hold a tool result as
 * well as the conversation; every later prompt is answered directly.
 */
function scriptedBySessionTag(request) {
  const prompt = lastUserText(request);
  const tag = [TERMINAL_TAG, ...RUN_TAGS].find((candidate) => prompt.includes(candidate));
  if (!tag) return say("No tag in the prompt.");
  if (prompt.includes("again")) return say(`${tag} answered again.`);
  const toolResults = request.body.messages.filter((message) => message.role === "tool");
  if (toolResults.length === 0) {
    return callTool("Bash", { command: `echo ${tag}-tool-output`, description: "Print the tag" });
  }
  return say(`${tag} answered.`);
}

/** The model request that answered the prompt naming `tag` and "again". */
const againRequestFor = (provider, tag) =>
  provider.modelRequests().findLast((request) => lastUserText(request).includes(`${tag} again`));

function assertHistoryIsOnly(request, tag) {
  const history = transcript(request);
  assert.ok(history.includes(`${tag} first`), `${tag}'s session holds its first prompt`);
  assert.ok(history.includes(`${tag}-tool-output`), `${tag}'s session holds its tool result`);
  assert.ok(history.includes(`${tag} answered.`), `${tag}'s session holds its answer`);
  for (const other of [TERMINAL_TAG, ...RUN_TAGS].filter((candidate) => candidate !== tag)) {
    assert.ok(!history.includes(other), `${tag}'s session holds nothing of ${other}'s`);
  }
}

test("runs side by side in one home each keep their own session, as does an open terminal UI", async (t) => {
  const provider = await startModelProvider({ script: scriptedBySessionTag });
  t.after(() => provider.close());
  const home = await createOwnerHome({
    providerConfig: providerConfiguration({ baseUrl: provider.baseUrl }),
  });
  t.after(() => home.remove());
  // The terminal UI works in a project of its own, so that `--continue` there finds its session.
  const terminalProject = join(home.dir, "terminal-project");
  await mkdir(terminalProject);

  const ui = openTerminalUi({ home, cwd: terminalProject });
  t.after(() => ui.dispose());
  await ui.submit(`${TERMINAL_TAG} first`);
  await ui.shows(`${TERMINAL_TAG} answered.`);

  const runs = RUN_TAGS.map((tag) => launch({ home, prompt: `${tag} first` }));
  for (const run of runs) t.after(() => run.dispose());
  const outcomes = await Promise.all(runs.map((run) => run.outcome));

  for (const [index, outcome] of outcomes.entries()) {
    assert.equal(outcome.exitCode, 0, outcome.stderr);
    assert.equal(outcome.result.response, `${RUN_TAGS[index]} answered.`);
  }
  const sessionIds = outcomes.map((outcome) => outcome.result.sessionId);
  assert.equal(new Set(sessionIds).size, RUN_COUNT, "every run has a session of its own");

  // The terminal UI, open throughout, carries on with its own conversation.
  await ui.submit(`${TERMINAL_TAG} again`);
  await ui.shows(`${TERMINAL_TAG} answered again.`);
  assertHistoryIsOnly(againRequestFor(provider, TERMINAL_TAG), TERMINAL_TAG);
  const exit = await ui.quit();
  assert.equal(exit.exitCode, 0, exit.screen);

  // Every run's session resumes, side by side again, with its own records and no one else's.
  const resumed = RUN_TAGS.map((tag, index) =>
    launch({ home, prompt: `${tag} again`, args: ["--resume", sessionIds[index]] }),
  );
  for (const run of resumed) t.after(() => run.dispose());
  const resumedOutcomes = await Promise.all(resumed.map((run) => run.outcome));
  for (const [index, outcome] of resumedOutcomes.entries()) {
    const tag = RUN_TAGS[index];
    assert.equal(outcome.exitCode, 0, outcome.stderr);
    assert.equal(outcome.result.sessionId, sessionIds[index]);
    assertHistoryIsOnly(againRequestFor(provider, tag), tag);
  }

  // So does the terminal UI's, with both of its turns.
  const continued = launch({
    home,
    cwd: terminalProject,
    prompt: `${TERMINAL_TAG} again, from the command line`,
    args: ["--continue"],
  });
  t.after(() => continued.dispose());
  const continuedOutcome = await continued.outcome;
  assert.equal(continuedOutcome.exitCode, 0, continuedOutcome.stderr);
  const continuedHistory = transcript(againRequestFor(provider, TERMINAL_TAG));
  assert.ok(continuedHistory.includes(`${TERMINAL_TAG} answered again.`));
  assertHistoryIsOnly(againRequestFor(provider, TERMINAL_TAG), TERMINAL_TAG);
});
