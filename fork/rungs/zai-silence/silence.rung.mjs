/**
 * Silence towards Z.ai: the fork driven through start-up, an interactive session, a
 * non-interactive run that calls tools, a document skill producing a document, the
 * plugin and model commands, and an idle period, with only the stand-ins configured.
 * The sandbox's record shows no attempt to reach any host but the stand-ins; upstream
 * shows attempts to `zcode.z.ai` at start-up and on its idle timer.
 */

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { launch, ZCODE_ENTRY } from "../../harness/launcher.mjs";
import { callTool, say, startModelProvider } from "../../harness/model-provider.mjs";
import { attempts, forgetAttempts } from "../../harness/network-sandbox.mjs";
import { createOwnerHome, providerConfiguration } from "../../harness/owner-home.mjs";
import { openTerminalUi } from "../../harness/terminal-ui.mjs";

const FOOTER_DOCUMENT = fileURLToPath(new URL("footer-document.py", import.meta.url));
/** Where `zcode` seeds the bundled Word plugin's `docx` skill in a home. */
const DOCX_SKILL = "$HOME/.zcode/cli/plugins/cache/zcode-plugins-official/documents/*/skills/docx";
/**
 * How long the idle terminal UI is left alone: past the one-minute timer on which
 * upstream checks for new built-in model rules, which is the work an idle `zcode` does.
 */
const IDLE_MS = 70_000;

beforeEach(forgetAttempts);

async function ownerWithProvider(t, script) {
  const provider = await startModelProvider({ script });
  t.after(() => provider.close());
  const home = await createOwnerHome({
    providerConfig: providerConfiguration({ baseUrl: provider.baseUrl }),
  });
  t.after(() => home.remove());
  return { provider, home };
}

/**
 * Nothing left the sandbox, and nothing was stopped short of it either: the fork refuses
 * a Z.ai host before looking it up, so an attempt it refused is in its own report and
 * not in the sandbox's record.
 */
async function assertNothingAttempted(home) {
  assert.deepEqual(await attempts(), { names: [], connections: [] });
  const refusals = await readFile(
    join(home.dir, ".zcode", "cli", "refused-zai-connections.jsonl"),
    "utf8",
  ).catch((error) => (error.code === "ENOENT" ? "" : Promise.reject(error)));
  assert.equal(refusals, "", "the fork refused no connection to a Z.ai host");
}

/** Runs one `zcode` command to completion in the home, as the owner would type it. */
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

test("start-up and an interactive session with model choice reach no host but the stand-ins", async (t) => {
  // The UI asks the model for a session title beside the turn itself, so every request
  // gets the same answer.
  const { provider, home } = await ownerWithProvider(t, () => say("The session answers."));

  const ui = openTerminalUi({ home });
  t.after(() => ui.dispose());
  await ui.submit("Answer me.");
  await ui.shows("The session answers.");
  await ui.submit("/model");
  await ui.shows("stand-in-model");
  // Ended, not quit: what is observed is the record, and the driver's Ctrl-C pair is
  // sometimes read as one press, which leaves the UI asking to confirm.
  await ui.dispose();

  assert.ok(provider.modelRequests().length > 0, "the session reached the stand-in provider");
  await assertNothingAttempted(home);
});

test("a non-interactive run that calls tools reaches no host but the stand-ins", async (t) => {
  const { provider, home } = await ownerWithProvider(t, [
    callTool("Write", { file_path: "notes.txt", content: "written by a tool\n" }),
    callTool("Bash", { command: "cat notes.txt", description: "Read the notes back" }),
    say("Both tools ran."),
  ]);

  const run = launch({ home, prompt: "Write the notes and read them back." });
  t.after(() => run.dispose());
  const outcome = await run.outcome;

  assert.equal(outcome.exitCode, 0, outcome.stderr);
  assert.equal(outcome.result.response, "Both tools ran.");
  assert.ok(
    JSON.stringify(provider.modelRequests().at(-1).body.messages).includes("written by a tool"),
    "the tools ran and their output went back to the model",
  );
  await assertNothingAttempted(home);
});

test("a document skill producing a document reaches no host but the stand-ins", async (t) => {
  const { provider, home } = await ownerWithProvider(t, [
    callTool("Skill", { skill: "docx" }),
    callTool("Bash", {
      command: `python3 '${FOOTER_DOCUMENT}' report.docx && python3 ${DOCX_SKILL}/scripts/fix_footer_fields.py report.docx`,
      description: "Finish the report's page numbers with the docx skill",
    }),
    say("The report is ready."),
  ]);

  const run = launch({ home, prompt: "Prepare the report as a Word document." });
  t.after(() => run.dispose());
  const outcome = await run.outcome;

  assert.equal(outcome.exitCode, 0, outcome.stderr);
  const [, afterSkill] = provider.modelRequests();
  assert.ok(
    JSON.stringify(afterSkill.body.messages).includes("DOCX Creation, Editing, and Analysis"),
    "the docx skill was loaded",
  );
  const footer = execFileSync(
    "python3",
    [
      "-c",
      "import sys, zipfile; print(zipfile.ZipFile(sys.argv[1]).read('word/footer1.xml').decode())",
      join(home.workspace, "report.docx"),
    ],
    { encoding: "utf8" },
  );
  assert.match(
    footer,
    /PAGE \\\* arabic \\\* MERGEFORMAT/u,
    "the document's page numbers are finished",
  );
  assert.ok(
    JSON.stringify(provider.modelRequests().at(-1).body.messages).includes(
      "Successfully fixed footer fields",
    ),
    "the skill's script finished the document",
  );
  await assertNothingAttempted(home);
});

test("the plugin commands reach no host but the stand-ins", async (t) => {
  const { home } = await ownerWithProvider(t, []);

  const list = await zcodeCommand(home, ["plugins", "list"]);
  assert.equal(list.exitCode, 0, list.output);
  assert.match(list.output, /documents@zcode-plugins-official/u);
  assert.doesNotMatch(list.output, /zcode-site/u, "site publishing is not bundled");

  const marketplaces = await zcodeCommand(home, ["plugins", "marketplace", "list"]);
  assert.equal(marketplaces.exitCode, 0, marketplaces.output);

  const catalogue = await zcodeCommand(home, [
    "plugins",
    "marketplace",
    "update",
    "zcode-plugins-official",
  ]);
  assert.notEqual(catalogue.exitCode, 0, "the official catalogue cannot be fetched");
  assert.match(catalogue.output, /bundled with zcode/u);

  await assertNothingAttempted(home);
});

const SETUP_ENV = 'USE_CN_MIRROR_FORCE=true PATH="$PWD/setup-bin:$PATH"';

async function standInSetupDependencies(home, extra = {}) {
  const bin = join(home.workspace, "setup-bin");
  await mkdir(bin);
  for (const [name, body] of Object.entries({
    node: "exit 0",
    npm: "exit 0",
    python3: "exit 0",
    "fc-list": "exit 0",
    "fc-cache": "exit 0",
    ...extra,
  })) {
    await writeFile(
      join(bin, name),
      `#!/bin/sh
${body}
`,
      { mode: 0o755 },
    );
  }
}

test("a document skill uses installed fonts and reports no download without a mirror", async (t) => {
  const { provider, home } = await ownerWithProvider(t, [
    callTool("Skill", { skill: "docx" }),
    callTool("Bash", {
      command: `env -u ZCODE_FONT_SOURCE_URL ${SETUP_ENV} bash ${DOCX_SKILL}/env_setup/setup_mac_linux.sh`,
      description: "Run the Word skill's setup with no font mirror",
    }),
    say("Setup finished."),
  ]);
  // These stand-ins make the existing dependencies available and model a machine with
  // no CJK fonts. Record any download the font step tries to make.
  await standInSetupDependencies(home, {
    curl: 'printf "%s\\n" "$*" >> font-downloads; exit 1',
  });

  const run = launch({ home, prompt: "Set up the Word document skill." });
  t.after(() => run.dispose());
  const outcome = await run.outcome;
  assert.equal(outcome.exitCode, 0, outcome.stderr);

  const result = provider
    .modelRequests()
    .at(-1)
    .body.messages.filter((message) => message.role === "tool")
    .at(-1)?.content;
  assert.match(result, /No font mirror named: using installed fonts/u);
  assert.match(result, /No CJK font detected/u);
  assert.match(result, /All dependencies OK/u);
  assert.doesNotMatch(result, /fonts were (?:just installed|downloaded)|Downloading .* fonts/u);
  await assert.rejects(readFile(join(home.workspace, "font-downloads")), { code: "ENOENT" });
  await assertNothingAttempted(home);
});

test("a document skill downloads fonts from the mirror the owner names", async (t) => {
  const font = "stand-in font bytes";
  const requests = [];
  const mirror = createServer((request, response) => {
    requests.push(request.url);
    response.end(font);
  }).listen(0, "127.0.0.1");
  t.after(
    () =>
      new Promise((resolve, reject) => {
        mirror.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  await once(mirror, "listening");

  const { provider, home } = await ownerWithProvider(t, [
    callTool("Skill", { skill: "docx" }),
    callTool("Bash", {
      command: `${SETUP_ENV} bash ${DOCX_SKILL}/env_setup/setup_mac_linux.sh`,
      description: "Run the Word skill's setup with the owner's font mirror",
    }),
    say("Setup finished."),
  ]);
  await standInSetupDependencies(home);
  home.env.ZCODE_FONT_SOURCE_URL = `http://127.0.0.1:${mirror.address().port}/owner-fonts`;

  const run = launch({ home, prompt: "Set up the Word document skill." });
  t.after(() => run.dispose());
  const { exitCode, stderr } = await run.outcome;
  assert.equal(exitCode, 0, stderr);
  assert.ok(
    requests.some((path) =>
      path.endsWith("/usr/share/fonts/truetype/chinese/NotoSansSC%5Bwght%5D.ttf"),
    ),
    "the mirror received the request for Noto Sans SC",
  );
  assert.ok(requests.every((path) => path.startsWith("/owner-fonts/")));
  assert.equal(
    await readFile(join(home.dir, ".local", "share", "fonts", "NotoSansSC[wght].ttf"), "utf8"),
    font,
  );
  const result = provider
    .modelRequests()
    .at(-1)
    .body.messages.filter((message) => message.role === "tool")
    .at(-1)?.content;
  assert.match(result, /All dependencies OK/u);
  await assertNothingAttempted(home);
});

test("bulk refresh updates the owner's marketplaces and stays silent about the bundled catalogue", async (t) => {
  const { home } = await ownerWithProvider(t, []);
  const args = ["plugins", "marketplace"];
  const knownPath = join(home.dir, ".zcode", "cli", "plugins", "known_marketplaces.json");
  const official = "zcode-plugins-official";
  const list = await zcodeCommand(home, [...args, "list"]);
  assert.equal(list.exitCode, 0, list.output);

  for (const name of ["owner-one", "owner-two", "claude-plugins-official"]) {
    const path = join(home.workspace, `${name}.json`);
    await writeFile(path, JSON.stringify({ name, description: "Original", plugins: [] }));
    if (name === "claude-plugins-official") continue;
    const add = await zcodeCommand(home, [...args, "add", path]);
    assert.equal(add.exitCode, 0, add.output);
    await writeFile(path, JSON.stringify({ name, description: "Refreshed", plugins: [] }));
  }

  const known = JSON.parse(await readFile(knownPath, "utf8"));
  const claude = known.marketplaces.find(({ id }) => id === "claude-plugins-official");
  assert.ok(claude, "the default Claude marketplace was seeded");
  claude.source = { source: "file", path: join(home.workspace, "claude-plugins-official.json") };
  const bundled = known.marketplaces.find(({ id }) => id === official);
  assert.ok(bundled, "the bundled catalogue was seeded");
  bundled.lastRefreshFailure = {
    code: "plugin_marketplace_invalid",
    failedAt: new Date().toISOString(),
    message: "Old official refresh failure",
  };
  await writeFile(knownPath, JSON.stringify(known));

  const run = launch({ home, command: [...args, "update"], args: ["--json"] });
  t.after(() => run.dispose());
  const refresh = await run.outcome;
  assert.equal(refresh.exitCode, 0, [refresh.stdout, refresh.stderr].join("\n"));
  const result = JSON.parse(refresh.stdout);
  assert.equal(result.ok, true);
  assert.deepEqual(result.diagnostics, []);
  assert.ok(!result.marketplaces.some(({ id }) => id === official));
  assert.deepEqual(
    result.marketplaces
      .filter(({ id }) => id.startsWith("owner-"))
      .map(({ id, description }) => [id, description])
      .sort(),
    [
      ["owner-one", "Refreshed"],
      ["owner-two", "Refreshed"],
    ],
  );
  await assertNothingAttempted(home);
});

test("listing models reaches no host but the configured provider", async (t) => {
  const { provider, home } = await ownerWithProvider(t, []);
  const run = launch({ home, command: ["models"] });
  t.after(() => run.dispose());
  const outcome = await run.outcome;
  assert.equal(outcome.exitCode, 0, outcome.stderr);
  assert.match(outcome.stdout, /stand-in-model/u);
  assert.ok(provider.requests.some(({ path }) => path.startsWith("/v1/models")));
  await assertNothingAttempted(home);
});

test(
  "an idle terminal UI reaches no host but the stand-ins",
  { timeout: IDLE_MS + 60_000 },
  async (t) => {
    const { home } = await ownerWithProvider(t, []);

    const ui = openTerminalUi({ home });
    t.after(() => ui.dispose());
    await ui.shows("Type a prompt");
    await new Promise((resolve) => setTimeout(resolve, IDLE_MS));
    assert.ok(ui.running(), "the terminal UI is still open after the idle period");
    await ui.dispose();

    await assertNothingAttempted(home);
  },
);
