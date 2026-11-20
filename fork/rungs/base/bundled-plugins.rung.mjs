import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { officialSeaPlugins } from "../../../apps/zcode-cli/packages/cli/scripts/sea-official-plugin-assets.mjs";
import { launch } from "../../harness/launcher.mjs";
import { createOwnerHome } from "../../harness/owner-home.mjs";

const official = "zcode-plugins-official";

test("every plugin in the bundled catalogue has a complete local cache", async (t) => {
  const home = await createOwnerHome({ providerConfig: {} });
  t.after(() => home.remove());

  const list = launch({ home, command: ["plugins", "list", "--available", "--json"] });
  t.after(() => list.dispose());
  const listing = await list.outcome;
  assert.equal(listing.exitCode, 0, listing.stderr);
  const available = JSON.parse(listing.stdout).available.filter(
    ({ marketplace }) => marketplace === official,
  );

  const storageRoot = join(home.dir, ".zcode", "cli", "plugins");
  const catalogue = JSON.parse(
    await readFile(join(storageRoot, "marketplaces", official, "bundled-marketplace.json"), "utf8"),
  );
  const entries = catalogue.manifest.plugins;
  const names = entries.map(({ name }) => name);
  assert.deepEqual(
    available.map(({ name }) => name).sort(),
    names.toSorted(),
    "the CLI offers every entry in the local catalogue",
  );
  for (const name of ["browser-use", "node-repl-host"]) {
    assert.ok(names.includes(name), `the build carries ${name}`);
  }

  for (const { cachePath, name, version } of entries) {
    const root = join(storageRoot, "cache", official, name, version);
    assert.equal(cachePath, root);
    const marker = JSON.parse(await readFile(join(root, ".zcode-plugin-seed.json"), "utf8"));
    assert.equal(marker.plugin, name);
    assert.equal(marker.pluginVersion, version);
    const manifest = JSON.parse(await readFile(join(root, ".zcode-plugin", "plugin.json"), "utf8"));
    assert.equal(manifest.name, name);

    // The CLI release recipe also declares runtime paths for plugins whose filesystem
    // seed contract only checks for a manifest, such as the simulator servers.
    const releaseAssets = officialSeaPlugins.find((plugin) => plugin.name === name);
    for (const path of releaseAssets?.requiredRuntimePaths ?? []) {
      assert.ok((await stat(join(root, path))).isFile(), `${name} carries ${path}`);
    }
  }

  const install = launch({
    home,
    command: ["plugins", "install", `browser-use@${official}`],
  });
  t.after(() => install.dispose());
  const installed = await install.outcome;
  assert.equal(installed.exitCode, 0, installed.stderr || installed.stdout);
});
