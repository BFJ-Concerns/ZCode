import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BRING_IN_RELEASE = fileURLToPath(new URL("../../bring-in-release.mjs", import.meta.url));
const GATE = "node fork/gate.mjs";
export const ENVIRONMENT = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Rung",
  GIT_AUTHOR_EMAIL: "rung@example.invalid",
  GIT_COMMITTER_NAME: "Rung",
  GIT_COMMITTER_EMAIL: "rung@example.invalid",
  GIT_EDITOR: "true",
};

/**
 * The stand-in gate, reporting as the rungs do: fails where alpha is called beside
 * `gate fails`, and writes a file of its own where alpha is called beside `leaves a file`.
 */
const GATE_SOURCE = `
import { readFileSync, writeFileSync } from "node:fs";
const text = readFileSync("app/src/a.ts", "utf8");
if (text.includes("alpha();") && text.includes("leaves a file")) {
  writeFileSync("fork/left-behind.txt", "written by the gate\\n");
}
const failing = text.includes("alpha();") && text.includes("gate fails");
console.log(failing ? "0 of 1 rung files passed.\\nfailed: fork/rungs/stand-in.rung.mjs" : "1 of 1 rung files passed.");
console.log("ℹ tests 2");
process.exit(failing ? 1 : 0);
`;

export const numbered = (prefix, count = 10) =>
  Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`);

export function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, env: ENVIRONMENT, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

export function write(repository, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repository, path)), { recursive: true });
    writeFileSync(
      join(repository, path),
      Array.isArray(content) ? `${content.join("\n")}\n` : content,
    );
  }
}

export function commit(repository, subject, files) {
  write(repository, files);
  git(repository, "add", "--all");
  git(repository, "commit", "--quiet", "--message", subject);
  return git(repository, "rev-parse", "HEAD");
}

/** Replaces line `number` (from 1) of a file of numbered lines with `replacement` lines. */
export function withLine(lines, number, ...replacement) {
  return [...lines.slice(0, number - 1), ...replacement, ...lines.slice(number)];
}

/**
 * Upstream at 1.0.0 with a fork of three differences on it (base, alpha and beta) and a
 * repair to alpha after them; then upstream's next release, made by `release`. Upstream
 * 1.0.0 also holds the files `upstream` gives.
 */
export function forkAndRelease(t, release, { fork = forkOfThree, upstream = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "bring-in-release-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = join(root, "repository");
  mkdirSync(repository);
  git(repository, "init", "--quiet", "--initial-branch", "main");
  commit(repository, "chore: sync source v1.0.0", {
    "app/src/a.ts": numbered("a"),
    "app/src/c.ts": numbered("c"),
    ...upstream,
  });
  git(repository, "tag", "v1.0.0");
  git(repository, "switch", "--quiet", "-c", "fork");
  fork(repository);
  const forkTip = git(repository, "rev-parse", "fork");
  git(repository, "switch", "--quiet", "main");
  release(repository);
  git(repository, "tag", "v2.0.0");
  git(repository, "switch", "--quiet", "--detach");
  return { root, repository, forkTip };
}

export function forkOfThree(repository) {
  commit(repository, "fork: gate the fork", {
    // The fork's own files may quote a marker; it names no difference there.
    "fork/gate.mjs": `${GATE_SOURCE}// a join reads "// fork(gamma): what the fork does"\n`,
    "fork/rungs/base/stand-in.rung.mjs": "",
    "fork/README.md": ["# The fork", "", "The fork's ground."],
  });
  commit(repository, "alpha: call alpha", {
    "app/src/fork/alpha/index.ts": ["export const alpha = 1; // not a join: fork(beta): "],
    "app/src/a.ts": withLine(numbered("a"), 2, "a 2", "// fork(alpha): calls alpha", "alpha();"),
  });
  commit(repository, "beta: change line five", {
    "fork/rungs/beta/stand-in.rung.mjs": "",
    "app/src/c.ts": withLine(numbered("c"), 5, "// fork(beta): line five", "beta 5"),
  });
  commit(repository, "alpha: repair alpha", {
    "app/src/fork/alpha/index.ts": ["export const alpha = 2;"],
  });
}

/** Runs the process from `cwd`, as the owner does from a checkout. */
export function bringIn(cwd, ...args) {
  return bringInWithEnvironment(cwd, ENVIRONMENT, ...args);
}

export function bringInWithEnvironment(cwd, env, ...args) {
  const result = spawnSync(
    process.execPath,
    [BRING_IN_RELEASE, "v2.0.0", "--gate", GATE, ...args],
    {
      cwd,
      env,
      encoding: "utf8",
    },
  );
  return { exitCode: result.status, account: result.stdout, stderr: result.stderr };
}

export const subjects = (repository, range) =>
  git(repository, "log", "--format=%s", range).split("\n");
