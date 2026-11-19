/**
 * Site publishing stays gone in a home upstream used, where ZCode Sites is installed in the
 * plugin cache, recorded as installed and enabled: no command lists it and no session gets
 * its skill, commands or server.
 *
 * The installed copy is upstream's plugin as it ships in this checkout.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ZCODE_ENTRY } from "../../harness/launcher.mjs";
import { createOwnerHome, providerConfiguration } from "../../harness/owner-home.mjs";

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

function zcodeCommand(home, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ZCODE_ENTRY, ...args], {
      cwd: home.workspace,
      env: home.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

test("an installed, enabled ZCode Sites is not loaded", async (t) => {
  const home = await ownerWithSitesInstalled(t);

  const plugins = await zcodeCommand(home, ["plugins", "list"]);
  assert.equal(plugins.exitCode, 0, plugins.stderr);
  assert.match(plugins.stdout, /documents@zcode-plugins-official/u, "plugins are listed");
  assert.doesNotMatch(plugins.stdout, /zcode-site/u, plugins.stdout);

  const skills = await zcodeCommand(home, ["skills", "list"]);
  assert.equal(skills.exitCode, 0, skills.stderr);
  assert.doesNotMatch(skills.stdout, /site-deploy/u, skills.stdout);
});
