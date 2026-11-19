/**
 * Silence towards Z.ai: the fork driven through start-up, an interactive session, a
 * non-interactive run that calls tools, a document skill producing a document, the
 * plugin and model commands, and an idle period, with only the stand-ins configured.
 * The sandbox's record shows no attempt to reach any host but the stand-ins; upstream
 * shows attempts to `zcode.z.ai` at start-up and on its idle timer.
 */

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
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
const DOCX_SKILL_SCRIPTS =
  "$HOME/.zcode/cli/plugins/cache/zcode-plugins-official/documents/*/skills/docx/scripts";
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
      command: `python3 '${FOOTER_DOCUMENT}' report.docx && python3 ${DOCX_SKILL_SCRIPTS}/fix_footer_fields.py report.docx`,
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
