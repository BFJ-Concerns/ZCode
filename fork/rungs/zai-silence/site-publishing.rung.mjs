/**
 * Site publishing stays gone in a home upstream used, where ZCode Sites is installed in the
 * plugin cache, recorded as installed and enabled: no command lists it and no session gets
 * its skill, commands or server.
 *
 * The installed copy is upstream's plugin as it ships in this checkout.
 */

import assert from "node:assert/strict";
import { cp, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { launch } from "../../harness/launcher.mjs";
import { createOwnerHome, providerConfiguration } from "../../harness/owner-home.mjs";
import { openTerminalUi } from "../../harness/terminal-ui.mjs";

const SITES_PLUGIN = fileURLToPath(
  new URL("../../../apps/zcode-cli/packages/zcode-site-plugin", import.meta.url),
);
const SITES_ID = "zcode-site@zcode-plugins-official";
const SITES_VERSION = "0.5.1";

/** A home whose plugin storage holds an installed, enabled ZCode Sites. */
async function ownerWithSitesInstalled(t) {
  const home = await createOwnerHome({
    providerConfig: providerConfiguration({ baseUrl: "http://127.0.0.1:9/v1" }),
    cliConfig: { plugins: { enabledPlugins: { [SITES_ID]: true } } },
  });
  t.after(() => home.remove());
  const storage = join(home.dir, ".zcode", "cli", "plugins");
  const installPath = join(storage, "cache", "zcode-plugins-official", "zcode-site", SITES_VERSION);
  await mkdir(installPath, { recursive: true });
  for (const part of [".zcode-plugin", "commands", "scripts", "skills"]) {
    await cp(join(SITES_PLUGIN, part), join(installPath, part), { recursive: true });
  }
  const installed = {
    version: 1,
    plugins: [
      {
        id: SITES_ID,
        name: "zcode-site",
        marketplace: "zcode-plugins-official",
        version: SITES_VERSION,
        installPath,
        installedAt: new Date().toISOString(),
        scope: "user",
      },
    ],
  };
  await writeFile(join(storage, "installed_plugins.json"), JSON.stringify(installed, null, 2));
  return home;
}

test("an installed, enabled ZCode Sites is not loaded", async (t) => {
  const home = await ownerWithSitesInstalled(t);

  const plugins = launch({ home, command: ["plugins", "list"] });
  t.after(() => plugins.dispose());
  const listed = await plugins.outcome;
  assert.equal(listed.exitCode, 0, listed.stderr);
  assert.match(listed.stdout, /documents@zcode-plugins-official/u, "plugins are listed");
  assert.doesNotMatch(listed.stdout, /zcode-site/u, listed.stdout);

  const skills = launch({ home, command: ["skills", "list"] });
  t.after(() => skills.dispose());
  const discovered = await skills.outcome;
  assert.equal(discovered.exitCode, 0, discovered.stderr);
  assert.doesNotMatch(discovered.stdout, /site-deploy/u, discovered.stdout);
});

test("a session gets none of the installed ZCode Sites commands", async (t) => {
  const home = await ownerWithSitesInstalled(t);
  const ownerCommands = join(home.workspace, ".zcode", "commands");
  await mkdir(ownerCommands, { recursive: true });
  await writeFile(join(ownerCommands, "zz-owner-command.md"), "An owner's command.\n");

  const ui = openTerminalUi({ home });
  t.after(() => ui.dispose());
  await ui.submit("/help");
  await ui.shows("Use /help <command> for details.");
  const screen = ui.screen();
  assert.match(screen, /\/zz-owner-command\b/u, "custom commands are listed");
  const siteCommands = (await readdir(join(SITES_PLUGIN, "commands")))
    .filter((file) => file.endsWith(".md"))
    .map((file) => file.slice(0, -3));
  assert.ok(siteCommands.length > 0, "the installed fixture carries commands");
  for (const name of siteCommands) {
    assert.ok(!screen.includes(`/${name}`), `the session lists /${name}`);
  }
  await ui.dispose();
});
