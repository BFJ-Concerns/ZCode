import assert from "node:assert/strict";
import { test } from "node:test";
import { say, startModelProvider } from "../../harness/model-provider.mjs";
import { createOwnerHome, providerConfiguration } from "../../harness/owner-home.mjs";
import { openTerminalUi } from "../../harness/terminal-ui.mjs";

test("the built terminal UI accepts a prompt without Node flags", async (t) => {
  const reply = "Terminal startup confirmed.";
  const provider = await startModelProvider({ script: [say(reply)] });
  t.after(() => provider.close());
  const home = await createOwnerHome({
    providerConfig: providerConfiguration({ baseUrl: provider.baseUrl }),
  });
  t.after(() => home.remove());

  const ui = openTerminalUi({ home });
  t.after(() => ui.dispose());
  await ui.submit("Check terminal startup.");
  await ui.shows(reply);
  const exit = await ui.quit();
  assert.equal(exit.exitCode, 0, exit.screen);
});
