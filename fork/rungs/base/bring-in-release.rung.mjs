/**
 * Bringing in an upstream release, exercised on small repositories made for each test:
 * an upstream branch with releases on it and a fork of a few differences, one of them
 * repaired after it landed. The receiver is what the owner sees: the fork's branch, the
 * account the process prints and its exit status. A gate stands in for the fork's gates;
 * it fails once alpha's call and a line a release can plant meet in one file.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const BRING_IN_RELEASE = fileURLToPath(new URL("../../bring-in-release.mjs", import.meta.url));
const GATE = "node fork/gate.mjs";
const ENVIRONMENT = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Rung",
  GIT_AUTHOR_EMAIL: "rung@example.invalid",
  GIT_COMMITTER_NAME: "Rung",
  GIT_COMMITTER_EMAIL: "rung@example.invalid",
  GIT_EDITOR: "true",
};

/** The stand-in gate, reporting as the rungs do: fails where alpha is called beside `gate fails`. */
const GATE_SOURCE = `
import { readFileSync } from "node:fs";
const text = readFileSync("app/src/a.ts", "utf8");
const failing = text.includes("alpha();") && text.includes("gate fails");
console.log(failing ? "0 of 1 rung files passed.\\nfailed: fork/rungs/stand-in.rung.mjs" : "1 of 1 rung files passed.");
console.log("ℹ tests 2");
process.exit(failing ? 1 : 0);
`;

const numbered = (prefix, count = 10) =>
  Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`);

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, env: ENVIRONMENT, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function write(repository, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repository, path)), { recursive: true });
    writeFileSync(
      join(repository, path),
      Array.isArray(content) ? `${content.join("\n")}\n` : content,
    );
  }
}

function commit(repository, subject, files) {
  write(repository, files);
  git(repository, "add", "--all");
  git(repository, "commit", "--quiet", "--message", subject);
  return git(repository, "rev-parse", "HEAD");
}

/** Replaces line `number` (from 1) of a file of numbered lines with `replacement` lines. */
function withLine(lines, number, ...replacement) {
  return [...lines.slice(0, number - 1), ...replacement, ...lines.slice(number)];
}

/**
 * Upstream at 1.0.0 with a fork of three differences on it (base, alpha and beta) and a
 * repair to alpha after them; then upstream's next release, made by `release`.
 */
function forkAndRelease(t, release, { fork = forkOfThree } = {}) {
  const root = mkdtempSync(join(tmpdir(), "bring-in-release-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = join(root, "repository");
  mkdirSync(repository);
  git(repository, "init", "--quiet", "--initial-branch", "main");
  commit(repository, "chore: sync source v1.0.0", {
    "app/src/a.ts": numbered("a"),
    "app/src/c.ts": numbered("c"),
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

function forkOfThree(repository) {
  commit(repository, "fork: gate the fork", {
    // The fork's own files may quote a marker; it names no difference there.
    "fork/gate.mjs": `${GATE_SOURCE}// a join reads "// fork(gamma): what the fork does"\n`,
    "fork/rungs/base/stand-in.rung.mjs": "",
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

function bringIn(repository, ...args) {
  const result = spawnSync(
    process.execPath,
    [BRING_IN_RELEASE, "v2.0.0", "--gate", GATE, ...args],
    { cwd: repository, env: ENVIRONMENT, encoding: "utf8" },
  );
  return { exitCode: result.status, account: result.stdout, stderr: result.stderr };
}

const subjects = (repository, range) => git(repository, "log", "--format=%s", range).split("\n");

test("a release every difference replays onto moves the fork to it, one commit per difference", (t) => {
  const { root, repository } = forkAndRelease(t, (repository) => {
    commit(repository, "chore: sync source v2.0.0", {
      "app/src/a.ts": withLine(numbered("a"), 9, "a 9 changed upstream"),
      "app/src/b.ts": ["new upstream file"],
    });
    git(repository, "mv", "app/src/c.ts", "app/src/c2.ts");
    git(repository, "commit", "--quiet", "--amend", "--no-edit");
  });

  const { exitCode, account, stderr } = bringIn(repository);

  assert.equal(exitCode, 0, `${account}${stderr}`);
  assert.deepEqual(subjects(repository, "v2.0.0..fork"), [
    "beta: change line five",
    "alpha: call alpha",
    "fork: gate the fork",
  ]);
  const show = (path) => git(repository, "show", `fork:${path}`);
  assert.match(show("app/src/fork/alpha/index.ts"), /alpha = 2/, "the repair is folded into alpha");
  assert.match(show("app/src/a.ts"), /alpha\(\);[\s\S]*a 9 changed upstream/);
  assert.match(
    show("app/src/c2.ts"),
    /beta 5/,
    "beta follows its file to the name the release gave it",
  );
  assert.match(git(repository, "log", "-1", "--format=%B", "fork~1"), /alpha: repair alpha/);

  assert.match(account, /^# Upstream v2\.0\.0 brought into the fork$/m);
  assert.match(account, /`fork` moved from upstream v1\.0\.0 to v2\.0\.0/);
  assert.match(account, /`git push --force-with-lease=fork:[0-9a-f]{40} origin fork`/);
  assert.match(
    account,
    /\*\*base\*\*: replayed cleanly.*`node fork\/gate\.mjs` passed; 1 of 1 rung files, 2 tests/,
  );
  assert.match(
    account,
    /\*\*alpha\*\* \(1 repair folded in\): replayed cleanly over the release's changes to `app\/src\/a\.ts`/,
  );
  assert.match(account, /\*\*beta\*\*: .*`app\/src\/c\.ts` renamed to `app\/src\/c2\.ts`/);
  assert.match(
    account,
    /3 files changed since v1\.0\.0: 1 added, 1 modified, 1 renamed, 0 deleted/,
  );

  assert.equal(existsSync(join(root, "repository-Worktrees", "bring-in-v2.0.0")), false);
  assert.equal(git(repository, "branch", "--list", "bring-in-*"), "");
});

test("a release a difference conflicts with stops there and leaves the fork where it was", (t) => {
  const { root, repository, forkTip } = forkAndRelease(t, (repository) => {
    commit(repository, "chore: sync source v2.0.0", {
      "app/src/c.ts": withLine(numbered("c"), 5, "c 5 changed upstream"),
    });
  });

  const stopped = bringIn(repository);

  assert.equal(stopped.exitCode, 1, `${stopped.account}${stopped.stderr}`);
  assert.equal(git(repository, "rev-parse", "fork"), forkTip);
  assert.match(stopped.account, /^# Upstream v2\.0\.0 not brought in$/m);
  assert.match(
    stopped.account,
    /Stopped at \*\*beta\*\*\. It does not replay onto the release: `app\/src\/c\.ts` conflict/,
  );
  assert.match(stopped.account, /`fork` stays at [0-9a-f]{8}, on upstream v1\.0\.0/);
  assert.match(stopped.account, /\*\*alpha\*\* \(1 repair folded in\): replayed cleanly.*passed/);
  assert.match(
    stopped.account,
    /\*\*beta\*\*: conflicted in `app\/src\/c\.ts`; waiting to be reworked/,
  );

  // An agent reworks beta where the replay stopped, and runs the process again.
  const worktree = join(root, "repository-Worktrees", "bring-in-v2.0.0");
  write(worktree, {
    "app/src/c.ts": withLine(
      numbered("c"),
      5,
      "// fork(beta): line five",
      "beta 5 over c 5 changed upstream",
    ),
  });
  git(worktree, "add", "app/src/c.ts");
  git(worktree, "cherry-pick", "--continue");
  const resumed = bringIn(repository);

  assert.equal(resumed.exitCode, 0, `${resumed.account}${resumed.stderr}`);
  assert.deepEqual(subjects(repository, "v2.0.0..fork").length, 3);
  assert.match(git(repository, "show", "fork:app/src/c.ts"), /beta 5 over c 5 changed upstream/);
  assert.match(
    resumed.account,
    /\*\*beta\*\*: conflicted in `app\/src\/c\.ts`.*; reworked; `node fork\/gate\.mjs` passed/,
  );
});

test("a release that fails the gates with a difference replayed stops at that difference", (t) => {
  const { repository, forkTip } = forkAndRelease(t, (repository) => {
    // The release passes alone and with base; the gate fails once alpha is replayed.
    commit(repository, "chore: sync source v2.0.0", {
      "app/src/a.ts": withLine(numbered("a"), 9, "a 9 gate fails"),
    });
  });

  const { exitCode, account, stderr } = bringIn(repository);

  assert.equal(exitCode, 1, `${account}${stderr}`);
  assert.equal(git(repository, "rev-parse", "fork"), forkTip);
  assert.match(
    account,
    /Stopped at \*\*alpha\*\*\. With it replayed, `node fork\/gate\.mjs` fails\./,
  );
  assert.match(account, /\*\*base\*\*: replayed cleanly.*`node fork\/gate\.mjs` passed/);
  assert.match(
    account,
    /\*\*alpha\*\* \(1 repair folded in\): .*`node fork\/gate\.mjs` failed: `fork\/rungs\/stand-in\.rung\.mjs`/,
  );
  assert.match(account, /\*\*beta\*\*: not reached\./);
});

test("rework left uncommitted, or committed apart from its step, is refused until folded in", (t) => {
  const { root, repository, forkTip } = forkAndRelease(t, (repository) => {
    commit(repository, "chore: sync source v2.0.0", {
      "app/src/a.ts": withLine(numbered("a"), 9, "a 9 gate fails"),
    });
  });
  assert.equal(bringIn(repository).exitCode, 1);

  // The fix that would pass the gate is made in the worktree but never committed.
  const worktree = join(root, "repository-Worktrees", "bring-in-v2.0.0");
  const fixed = readFileSync(join(worktree, "app/src/a.ts"), "utf8").replace("gate fails", "");
  writeFileSync(join(worktree, "app/src/a.ts"), fixed);
  const refused = bringIn(repository);

  assert.equal(refused.exitCode, 2, `${refused.account}${refused.stderr}`);
  assert.match(refused.stderr, /holds changes no commit holds: app\/src\/a\.ts/);
  assert.equal(git(repository, "rev-parse", "fork"), forkTip);
  assert.equal(existsSync(worktree), true);

  // Committed as a commit of its own, the fix would be taken for beta's step.
  git(worktree, "commit", "--quiet", "--all", "--message", "alpha: fix for v2.0.0");
  const separate = bringIn(repository);

  assert.equal(separate.exitCode, 2, `${separate.account}${separate.stderr}`);
  assert.match(separate.stderr, /holds 1 commit\(s\) past the step that stopped/);
  assert.equal(git(repository, "rev-parse", "fork"), forkTip);

  git(worktree, "reset", "--quiet", "--soft", "HEAD~1");
  git(worktree, "commit", "--quiet", "--amend", "--no-edit");
  const resumed = bringIn(repository);

  assert.equal(resumed.exitCode, 0, `${resumed.account}${resumed.stderr}`);
  assert.doesNotMatch(git(repository, "show", "fork~1:app/src/a.ts"), /gate fails/);
  assert.match(
    resumed.account,
    /\*\*alpha\*\* \(1 repair folded in\): .*reworked; `node fork\/gate\.mjs` passed/,
  );
});

test("a fork checked out in a worktree stays put, with the release ready on its own branch", (t) => {
  const { root, repository, forkTip } = forkAndRelease(t, (repository) => {
    commit(repository, "chore: sync source v2.0.0", { "app/src/b.ts": ["new upstream file"] });
  });
  git(repository, "worktree", "add", "--quiet", join(root, "fork-checkout"), "fork");

  const { exitCode, account, stderr } = bringIn(repository);

  assert.equal(exitCode, 0, `${account}${stderr}`);
  assert.equal(git(repository, "rev-parse", "fork"), forkTip);
  assert.match(account, /ready on `bring-in-v2\.0\.0`.*`fork` stays at .*it is checked out in/);
  assert.equal(subjects(repository, "v2.0.0..bring-in-v2.0.0").length, 3);
});

test("a fork commit that changes two differences together stops the process before any replay", (t) => {
  const { root, repository, forkTip } = forkAndRelease(
    t,
    (repository) => commit(repository, "chore: sync source v2.0.0", { "app/src/b.ts": ["new"] }),
    {
      fork: (repository) => {
        forkOfThree(repository);
        commit(repository, "fork: touch alpha and beta at once", {
          "app/src/fork/alpha/index.ts": ["export const alpha = 3;"],
          "fork/rungs/beta/stand-in.rung.mjs": "// changed",
        });
      },
    },
  );

  const { exitCode, account, stderr } = bringIn(repository);

  assert.equal(exitCode, 1, `${account}${stderr}`);
  assert.equal(git(repository, "rev-parse", "fork"), forkTip);
  assert.match(
    account,
    /Stopped before any difference was replayed\. [0-9a-f]{8} \(fork: touch alpha and beta at once\) changes alpha and beta together/,
  );
  assert.equal(existsSync(join(root, "repository-Worktrees", "bring-in-v2.0.0")), false);
});
