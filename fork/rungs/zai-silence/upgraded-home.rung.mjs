/**
 * A home upstream already used: its document plugins were seeded by upstream, at the same
 * plugin version, with setup scripts that download fonts from Z.ai's CDN. The fork
 * serves its own document plugins there all the same, so a session that loads the docx
 * skill is given the fork's setup scripts.
 *
 * The home is made as upstream leaves it by seeding it with the fork and rewriting that
 * seed into upstream's: its version directory, its seed marker, its catalogue entry and
 * the font source line of its setup script.
 */

import assert from "node:assert/strict";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { launch } from "../../harness/launcher.mjs";
import { callTool, say, startModelProvider } from "../../harness/model-provider.mjs";
import { attempts, forgetAttempts } from "../../harness/network-sandbox.mjs";
import { createOwnerHome, providerConfiguration } from "../../harness/owner-home.mjs";

const UPSTREAM_VERSION = "0.2.2";
const UPSTREAM_FONT_SOURCE = 'FONT_CDN_BASE="https://z-cdn.chatglm.cn/office-skill/fonts"';
const FONT_SOURCE_LINE = /^FONT_CDN_BASE=.*$/mu;
const SETUP_SCRIPT = join("skills", "docx", "env_setup", "setup_mac_linux.sh");

const toolResults = (request) =>
  request.body.messages
    .filter((message) => message.role === "tool")
    .map((message) => JSON.stringify(message.content));

/**
 * Nothing left the sandbox and the fork refused nothing: a catalogue upstream saved names
 * Z.ai's host as the source of its plugins, and no plugin command may go there for one.
 */
async function assertNothingAttempted(home) {
  assert.deepEqual(await attempts(), { names: [], connections: [] });
  const refusals = await readFile(
    join(home.dir, ".zcode", "cli", "refused-zai-connections.jsonl"),
    "utf8",
  ).catch((error) => (error.code === "ENOENT" ? "" : Promise.reject(error)));
  assert.equal(refusals, "", "the fork refused no connection to a Z.ai host");
}

/** Rewrites the fork's seed of the Word plugin in `home` into the one upstream leaves. */
async function makeUpstreamSeed(home) {
  const plugins = join(home.dir, ".zcode", "cli", "plugins");
  const documents = join(plugins, "cache", "zcode-plugins-official", "documents");
  const [forkVersion] = await readdir(documents);
  const upstream = join(documents, UPSTREAM_VERSION);
  if (forkVersion !== UPSTREAM_VERSION) {
    await cp(join(documents, forkVersion), upstream, { recursive: true });
    await rm(join(documents, forkVersion), { recursive: true });
  }

  const markerPath = join(upstream, ".zcode-plugin-seed.json");
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  await writeFile(markerPath, JSON.stringify({ ...marker, pluginVersion: UPSTREAM_VERSION }));

  const scriptPath = join(upstream, SETUP_SCRIPT);
  const script = await readFile(scriptPath, "utf8");
  await writeFile(scriptPath, script.replace(FONT_SOURCE_LINE, UPSTREAM_FONT_SOURCE));

  const cataloguePath = join(
    plugins,
    "marketplaces",
    "zcode-plugins-official",
    "bundled-marketplace.json",
  );
  const catalogue = JSON.parse(await readFile(cataloguePath, "utf8"));
  for (const plugin of catalogue.manifest.plugins) {
    if (plugin.name !== "documents") continue;
    plugin.cachePath = upstream;
    plugin.version = UPSTREAM_VERSION;
  }
  await writeFile(cataloguePath, JSON.stringify(catalogue, null, 2));
}

test("a home upstream seeded is given the fork's document setup scripts", async (t) => {
  const provider = await startModelProvider({
    script: (request) => {
      const results = toolResults(request);
      if (
        !request.body.messages.some((message) =>
          JSON.stringify(message).includes("Load the docx skill."),
        )
      ) {
        return say("Seeded.");
      }
      if (results.length === 0) return callTool("Skill", { skill: "docx" });
      if (results.length === 1) {
        const skillDirectory = results[0].match(/\/[^\s"'\\]*\/skills\/docx/u)?.[0];
        return callTool("Bash", {
          command: `grep -h '^FONT_CDN_BASE=' '${skillDirectory}/env_setup/setup_mac_linux.sh'`,
          description: "Read where the skill's setup takes fonts from",
        });
      }
      return say("Read.");
    },
  });
  t.after(() => provider.close());
  const home = await createOwnerHome({
    providerConfig: providerConfiguration({ baseUrl: provider.baseUrl }),
  });
  t.after(() => home.remove());

  const seeding = launch({ home, prompt: "Say anything." });
  t.after(() => seeding.dispose());
  assert.equal((await seeding.outcome).exitCode, 0);
  await makeUpstreamSeed(home);

  const run = launch({ home, prompt: "Load the docx skill." });
  t.after(() => run.dispose());
  const outcome = await run.outcome;

  assert.equal(outcome.exitCode, 0, outcome.stderr);
  const fontSource = toolResults(provider.modelRequests().at(-1)).at(-1);
  assert.match(fontSource, /ZCODE_FONT_SOURCE_URL/u, fontSource);
  assert.doesNotMatch(fontSource, /chatglm/u, "the session is not given upstream's setup script");
});

test("an upgraded home lists only the official plugins bundled by this build", async (t) => {
  const home = await createOwnerHome({
    providerConfig: providerConfiguration({ baseUrl: "http://127.0.0.1:9/v1" }),
  });
  t.after(() => home.remove());
  const official = "zcode-plugins-official";
  const catalogueDir = join(home.dir, ".zcode", "cli", "plugins", "marketplaces", official);
  await mkdir(catalogueDir, { recursive: true });
  const downloadedSource = {
    source: "url",
    type: "zip",
    url: "https://zcode.z.ai/download.zip",
  };
  const downloaded = {
    name: official,
    version: 1,
    plugins: ["zcode-site", "download-only", "documents"].map((name) => ({
      name,
      version: "99.0.0",
      source: downloadedSource,
    })),
  };
  for (const filename of ["cdn-marketplace.json", "marketplace.json"]) {
    await writeFile(join(catalogueDir, filename), JSON.stringify(downloaded));
  }
  await forgetAttempts();

  const install = launch({ home, command: ["plugins", "install", `download-only@${official}`] });
  t.after(() => install.dispose());
  const refused = await install.outcome;
  assert.equal(refused.exitCode, 1);
  assert.match(refused.stderr, /This build does not carry download-only@zcode-plugins-official/u);
  await assertNothingAttempted(home);

  const list = launch({ home, command: ["plugins", "list", "--available"], args: ["--json"] });
  t.after(() => list.dispose());
  const { exitCode, stderr, stdout } = await list.outcome;
  assert.equal(exitCode, 0, stderr);
  const entries = JSON.parse(stdout).available.filter(
    ({ marketplace }) => marketplace === official,
  );
  const names = entries.map(({ name }) => name);
  for (const name of ["documents", "pdf", "presentations", "spreadsheets"]) {
    assert.ok(names.includes(name), `missing bundled plugin ${name}`);
  }
  assert.ok(!names.includes("zcode-site"), "the catalogue lists site publishing");
  assert.ok(!names.includes("download-only"), "the catalogue lists an upstream download");
  assert.match(entries.find(({ name }) => name === "documents").version, /\+fork\.zai-silence$/u);
  await assertNothingAttempted(home);
});
