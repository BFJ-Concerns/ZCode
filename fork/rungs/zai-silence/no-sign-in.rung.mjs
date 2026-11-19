/**
 * No sign-in is offered: nothing in start-up, the model picker or the command list of the
 * terminal UI offers it, including when no usable model is configured, and the command
 * line has no sign-in commands.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { ZCODE_ENTRY } from "../../harness/launcher.mjs";
import { createOwnerHome } from "../../harness/owner-home.mjs";
import { openTerminalUi } from "../../harness/terminal-ui.mjs";

/** The owner's model configuration with no provider in it. */
const NO_PROVIDERS = {
  schemaVersion: 1,
  config: {
    providerConfigRules: { providerRules: [] },
    modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
  },
};

/** Words that offer a sign-in to a Z.ai account, in the UI's English. */
const SIGN_IN = /\/login|\/logout|sign[ -]?in|log[ -]?in|coding plan|z\.ai|bigmodel/iu;

async function ownerWithoutProviders(t) {
  const home = await createOwnerHome({ providerConfig: NO_PROVIDERS });
  t.after(() => home.remove());
  return home;
}

/** Runs one `zcode` command to completion in the home. */
function zcodeCommand(home, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ZCODE_ENTRY, ...args], {
      cwd: home.workspace,
      env: home.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode, output }));
  });
}

test("with no usable model, the terminal UI's start-up, model picker and commands offer no sign-in", async (t) => {
  const home = await ownerWithoutProviders(t);
  const ui = openTerminalUi({ home });
  t.after(() => ui.dispose());

  await ui.shows("Configure a model provider");
  assert.doesNotMatch(ui.screen(), SIGN_IN, ui.screen());

  await ui.submit("/model");
  await ui.shows("No selectable models are configured.");
  assert.doesNotMatch(ui.screen(), SIGN_IN, ui.screen());

  await ui.submit("/help");
  await ui.shows("/compact");
  assert.doesNotMatch(ui.screen(), SIGN_IN, ui.screen());

  await ui.submit("/login");
  await ui.shows("Unknown command: /login");
  // Ended before the home is removed; quitting with Ctrl-C is not what this observes.
  await ui.dispose();
});

test("the command line has no sign-in commands", async (t) => {
  const home = await ownerWithoutProviders(t);

  const help = await zcodeCommand(home, ["help"]);
  assert.equal(help.exitCode, 0, help.output);
  assert.doesNotMatch(help.output, SIGN_IN, help.output);

  for (const command of ["login", "logout"]) {
    const { exitCode, output } = await zcodeCommand(home, [command]);
    assert.notEqual(exitCode, 0, output);
    assert.match(output, new RegExp(`Unknown command: ${command}`, "u"));
  }
});
