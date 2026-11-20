/**
 * Builds the fork and runs its rungs: every `*.rung.mjs` under fork/rungs/, each
 * file in a sealed network sandbox of its own (harness/network-sandbox-supervisor.mjs).
 *
 *   node fork/rungs.mjs                    every rung
 *   node fork/rungs.mjs model-listings     the rung files whose path contains the text
 *   node fork/rungs.mjs --no-build ...     against the build already in place
 *
 * Exits 0 when every rung passes. A test that is skipped, or marked to do, has not
 * passed: a rung that cannot exercise its behaviour where it runs skips with the
 * reason, and its file fails.
 */

import { spawn, spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { build, REPOSITORY_ROOT } from "./build.mjs";

const RUNGS_DIRECTORY = fileURLToPath(new URL("rungs", import.meta.url));
const SUPERVISOR = fileURLToPath(
  new URL("harness/network-sandbox-supervisor.mjs", import.meta.url),
);
const RUNG_SUFFIX = ".rung.mjs";
/** What the sandbox is built with: util-linux, iproute2 and nftables. */
const SANDBOX_COMMANDS = ["unshare", "mount", "ip", "nft"];
/** A rung that has not finished by then has hung; a test may set its own `timeout`. */
const TEST_TIMEOUT_MS = 120_000;
const SANDBOX_FILES_AT_ONCE = Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));

const { values: flags, positionals: filters } = parseArgs({
  allowPositionals: true,
  options: { "no-build": { type: "boolean" } },
});

async function rungFiles() {
  const entries = await readdir(RUNGS_DIRECTORY, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(RUNG_SUFFIX))
    .map((entry) => join(entry.parentPath, entry.name))
    .filter(
      (file) =>
        filters.length === 0 ||
        filters.some((text) => relative(REPOSITORY_ROOT, file).includes(text)),
    )
    .sort();
}

/** Colour and other terminal controls, which the reporter adds when colour is forced. */
// oxlint-disable-next-line no-control-regex -- the controls begin with ESC
const TERMINAL_CONTROLS = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** What the spec reporter counts in its closing summary, e.g. `ℹ skipped 1`. */
const summaryCount = (output, label) =>
  Number(
    new RegExp(`^ℹ ${label} (\\d+)$`, "m").exec(output.replace(TERMINAL_CONTROLS, ""))?.[1] ?? 0,
  );

/** Runs one rung file in its own sandbox; resolves with its output and whether it passed. */
function runSandboxed(file) {
  return new Promise((resolve) => {
    const sandbox = spawn(
      "unshare",
      [
        "--user",
        "--map-root-user",
        "--net",
        "--mount",
        "--pid",
        "--fork",
        "--kill-child",
        "--mount-proc",
        "--",
        process.execPath,
        SUPERVISOR,
        String(process.getuid()),
        String(process.getgid()),
        file,
        "--test-reporter=spec",
        `--test-timeout=${TEST_TIMEOUT_MS}`,
        // A stand-in or a run that a rung forgot to close must not keep its file alive.
        "--test-force-exit",
      ],
      { cwd: REPOSITORY_ROOT, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    sandbox.stdout.on("data", (chunk) => (output += chunk));
    sandbox.stderr.on("data", (chunk) => (output += chunk));
    sandbox.once("error", (error) => resolve({ file, passed: false, output: `${error}\n` }));
    sandbox.once("close", (exitCode) => {
      const unexercised = summaryCount(output, "skipped") + summaryCount(output, "todo");
      if (unexercised > 0) output += `\nNot passed: ${unexercised} tests skipped or left to do.\n`;
      resolve({ file, passed: exitCode === 0 && unexercised === 0, output });
    });
  });
}

if (process.platform !== "linux") {
  console.error("The rungs need Linux: the sandbox is built from its namespaces.");
  process.exit(1);
}
const missing = SANDBOX_COMMANDS.filter(
  (command) => spawnSync("sh", ["-c", `command -v ${command}`]).status !== 0,
);
if (missing.length > 0) {
  console.error(`The sandbox needs these commands on the PATH: ${missing.join(", ")}.`);
  process.exit(1);
}

const files = await rungFiles();
if (files.length === 0) {
  console.error(filters.length > 0 ? `No rung file matches ${filters.join(", ")}.` : "No rungs.");
  process.exit(1);
}
if (!flags["no-build"]) build();

const waiting = [...files];
const failed = [];
await Promise.all(
  Array.from({ length: SANDBOX_FILES_AT_ONCE }, async () => {
    for (let file = waiting.shift(); file !== undefined; file = waiting.shift()) {
      const outcome = await runSandboxed(file);
      if (!outcome.passed) failed.push(file);
      console.log(`\n${relative(REPOSITORY_ROOT, file)}\n${outcome.output.trimEnd()}`);
    }
  }),
);

console.log(`\n${files.length - failed.length} of ${files.length} rung files passed.`);
for (const file of failed.sort()) console.log(`failed: ${relative(REPOSITORY_ROOT, file)}`);
process.exit(failed.length === 0 ? 0 : 1);
