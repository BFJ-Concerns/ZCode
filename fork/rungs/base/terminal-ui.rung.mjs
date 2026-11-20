/**
 * The terminal UI driver every rung of the interactive UI is built on, exercised on its
 * own: it leaves the UI whatever the UI shows, leaves no `zcode` behind, and fails a
 * rung at once when `zcode` ends before what the rung waits for.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { launch, ZCODE_ENTRY } from "../../harness/launcher.mjs";
import {
  asksForSessionTitle,
  isModelRequest,
  say,
  startModelProvider,
} from "../../harness/model-provider.mjs";
import { createOwnerHome, providerConfiguration } from "../../harness/owner-home.mjs";
import { openTerminalUi } from "../../harness/terminal-ui.mjs";

const REPLY = "The stand-in answered.";

/** One provider answering every turn and title request, one home for it. */
async function ownerWithProvider(t) {
  const provider = await startModelProvider({
    script: (request) => (asksForSessionTitle(request) ? say('{"title":"Driver"}') : say(REPLY)),
  });
  t.after(() => provider.close());
  const home = await createOwnerHome({
    providerConfig: providerConfiguration({ baseUrl: provider.baseUrl }),
  });
  t.after(() => home.remove());
  return { provider, home };
}

/** Every process still running the built `zcode`. */
function zcodeProcesses() {
  return readdirSync("/proc")
    .filter((name) => /^\d+$/.test(name))
    .filter((pid) => {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z")) return false;
        return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").includes(ZCODE_ENTRY);
      } catch {
        return false;
      }
    });
}

test("the terminal UI is left with Ctrl-C while its model picker is open", async (t) => {
  const { home } = await ownerWithProvider(t);
  const ui = openTerminalUi({ home });
  t.after(() => ui.dispose());

  await ui.submit("Answer once.");
  await ui.shows(REPLY);
  // Typing the command opens the picker; Enter would choose its first model and close it.
  await ui.type("/model");
  await ui.shows("> stand-in-model");
  const exit = await ui.quit();

  assert.equal(exit.exitCode, 0, exit.screen);
});

test("the terminal UI is left with Ctrl-C while a draft is typed", async (t) => {
  const { home } = await ownerWithProvider(t);
  const ui = openTerminalUi({ home });
  t.after(() => ui.dispose());

  await ui.shows("Type a prompt");
  const draft = "A draft never submitted";
  await ui.type(draft);
  await ui.shows(draft);
  const exit = await ui.quit();

  assert.equal(exit.exitCode, 0, exit.screen);
});

test("disposing of the terminal UI leaves no zcode running", async (t) => {
  const { home } = await ownerWithProvider(t);
  const ui = openTerminalUi({ home });
  t.after(() => ui.dispose());
  await ui.shows("Type a prompt");
  assert.notDeepEqual(zcodeProcesses(), [], "the UI runs zcode");

  await ui.dispose();

  assert.deepEqual(zcodeProcesses(), []);
});

test("removing a home ends the zcode still running in it", async (t) => {
  const { home } = await ownerWithProvider(t);
  const ui = openTerminalUi({ home });
  t.after(() => ui.dispose());
  await ui.shows("Type a prompt");

  await home.remove();

  assert.equal(ui.running(), false);
  assert.deepEqual(zcodeProcesses(), []);
});

test("a wait on the screen fails at once when the terminal UI exits", async (t) => {
  const { home } = await ownerWithProvider(t);
  const ui = openTerminalUi({ home, args: ["--no-such-option"] });
  t.after(() => ui.dispose());

  await assert.rejects(ui.shows("Type a prompt"), /The terminal UI exited/);
});

test("a wait on the provider fails at once when zcode exits without calling it", async (t) => {
  const { provider, home } = await ownerWithProvider(t);
  const run = launch({ home, prompt: "Never sent.", args: ["--no-such-option"] });
  t.after(() => run.dispose());

  await assert.rejects(
    provider.request(isModelRequest),
    /zcode ended before the provider received the awaited request/,
  );
  assert.equal(run.running(), false);
});

test("a wait on the provider holds while a zcode launched after an earlier one ended runs", async (t) => {
  const { provider, home } = await ownerWithProvider(t);
  const earlier = launch({ home, prompt: "Never sent.", args: ["--no-such-option"] });
  t.after(() => earlier.dispose());
  await earlier.outcome;

  const request = provider.request(isModelRequest);
  const run = launch({ home, prompt: "Answer once." });
  t.after(() => run.dispose());

  const received = await request;
  assert.equal(received.body.model, "stand-in-model");
  assert.equal((await run.outcome).exitCode, 0);
});
