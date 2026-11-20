/**
 * Bringing in an upstream release, exercised on small repositories made for each test:
 * an upstream branch with releases on it and a fork of a few differences, one of them
 * repaired after it landed. The receiver is what the owner sees: the fork's branch and its
 * checkout, the account the process prints and its exit status. A gate stands in for the
 * fork's gates; it fails once alpha's call and a line a release can plant meet in one
 * file, and leaves a file behind once alpha's call meets another.
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
 * repair to alpha after them; then upstream's next release, made by `release`. Upstream
 * 1.0.0 also holds the files `upstream` gives.
 */
function forkAndRelease(t, release, { fork = forkOfThree, upstream = {} } = {}) {
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

function forkOfThree(repository) {
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
function bringIn(cwd, ...args) {
  const result = spawnSync(
    process.execPath,
    [BRING_IN_RELEASE, "v2.0.0", "--gate", GATE, ...args],
    {
      cwd,
      env: ENVIRONMENT,
      encoding: "utf8",
    },
  );
  return { exitCode: result.status, account: result.stdout, stderr: result.stderr };
}

/** Runs a command the account gives, as the owner pastes it into a shell at `cwd`. */
function runAsOwner(cwd, command) {
  const result = spawnSync("sh", ["-c", command], { cwd, env: ENVIRONMENT, encoding: "utf8" });
  return { exitCode: result.status, account: result.stdout, stderr: result.stderr };
}

/** The commands the account quotes after `before`, in the order it gives them. */
function commandsAfter(account, before) {
  const text = account.slice(account.indexOf(before));
  return [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
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
  assert.doesNotMatch(account, /Not yet one commit/, "every repair folds into its difference");
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

test("run from a checkout of the fork, the fork and its checkout move, keeping what the release leaves alone", (t) => {
  const { root, repository, forkTip } = forkAndRelease(t, (repository) => {
    commit(repository, "chore: sync source v2.0.0", { "app/src/b.ts": ["new upstream file"] });
  });
  const checkout = join(root, "fork-checkout");
  git(repository, "worktree", "add", "--quiet", checkout, "fork");
  write(checkout, { "notes.txt": "the owner's notes", "app/src/c.ts": numbered("c edited") });

  const { exitCode, account, stderr } = bringIn(checkout);

  assert.equal(exitCode, 0, `${account}${stderr}`);
  assert.notEqual(git(repository, "rev-parse", "fork"), forkTip);
  assert.equal(subjects(repository, "v2.0.0..fork").length, 3);
  assert.equal(git(checkout, "rev-parse", "HEAD"), git(repository, "rev-parse", "fork"));
  assert.equal(git(checkout, "symbolic-ref", "HEAD"), "refs/heads/fork");
  assert.equal(readFileSync(join(checkout, "app/src/b.ts"), "utf8"), "new upstream file\n");
  assert.equal(readFileSync(join(checkout, "notes.txt"), "utf8"), "the owner's notes");
  assert.match(readFileSync(join(checkout, "app/src/c.ts"), "utf8"), /^c edited 1$/m);
  assert.match(
    account,
    /`fork` moved from upstream v1\.0\.0 to v2\.0\.0, and its checkout in `[^`]*fork-checkout` with it/,
  );
  assert.equal(git(repository, "branch", "--list", "bring-in-*"), "");
});

test("a checkout whose changes the move would overwrite waits, and the account's commands finish it", (t) => {
  const { root, repository, forkTip } = forkAndRelease(t, (repository) => {
    commit(repository, "chore: sync source v2.0.0", {
      "app/src/c.ts": withLine(numbered("c"), 9, "c 9 changed upstream"),
    });
  });
  const checkout = join(root, "fork-checkout");
  git(repository, "worktree", "add", "--quiet", checkout, "fork");
  const edited = readFileSync(join(checkout, "app/src/c.ts"), "utf8").replace("c 9", "c 9 edited");
  writeFileSync(join(checkout, "app/src/c.ts"), edited);

  const waiting = bringIn(checkout);

  assert.equal(waiting.exitCode, 0, `${waiting.account}${waiting.stderr}`);
  assert.equal(git(repository, "rev-parse", "fork"), forkTip);
  assert.equal(readFileSync(join(checkout, "app/src/c.ts"), "utf8"), edited);
  assert.match(waiting.account, /^# Upstream v2\.0\.0 brought in, waiting to move the fork$/m);
  assert.match(
    waiting.account,
    /ready on `bring-in-v2\.0\.0`.*`fork` stays at .*would overwrite changes no commit holds/,
  );
  assert.match(waiting.account, /would overwrite changes no commit holds to `app\/src\/c\.ts`/);
  const [stash, finish] = commandsAfter(waiting.account, "Put them aside");
  assert.match(stash, /^git -C .* stash --include-untracked$/);
  assert.match(finish, /^node .*bring-in-release\.mjs v2\.0\.0 --gate 'node fork\/gate\.mjs'$/);

  assert.equal(runAsOwner(checkout, stash).exitCode, 0);
  const finished = runAsOwner(checkout, finish);

  assert.equal(finished.exitCode, 0, `${finished.account}${finished.stderr}`);
  assert.match(
    finished.account,
    /`fork` moved from upstream v1\.0\.0 to v2\.0\.0, and its checkout/,
  );
  assert.equal(git(checkout, "rev-parse", "HEAD"), git(repository, "rev-parse", "fork"));
  assert.match(readFileSync(join(checkout, "app/src/c.ts"), "utf8"), /c 9 changed upstream/);
  assert.equal(existsSync(join(root, "repository-Worktrees", "bring-in-v2.0.0")), false);
});

test("a fork that moves while the release is brought in is kept, and the account's command starts again", (t) => {
  const { repository, forkTip } = forkAndRelease(t, (repository) => {
    commit(repository, "chore: sync source v2.0.0", { "app/src/b.ts": ["new upstream file"] });
  });
  // A commit that lands on the fork while the gates run, as another landing would.
  git(repository, "switch", "--quiet", "-c", "landed", "fork");
  const landed = commit(repository, "beta: land a repair meanwhile", {
    "fork/rungs/beta/stand-in.rung.mjs": "// repaired meanwhile",
  });
  git(repository, "switch", "--quiet", "--detach");
  const landsMeanwhile = `git update-ref refs/heads/fork ${landed}`;

  const waiting = bringIn(repository, "--gate", landsMeanwhile);

  assert.equal(waiting.exitCode, 0, `${waiting.account}${waiting.stderr}`);
  assert.equal(git(repository, "rev-parse", "fork"), landed, "the landing is not overwritten");
  assert.match(waiting.account, /^# Upstream v2\.0\.0 brought in, waiting to move the fork$/m);
  assert.match(
    waiting.account,
    /`fork` stays at [0-9a-f]{8}: it moved while the release was being brought in/,
  );
  assert.notEqual(forkTip, landed);
  const [startAgain] = commandsAfter(waiting.account, "Start again");
  assert.match(
    startAgain,
    /^git worktree remove --force .* && git branch -D bring-in-v2\.0\.0 && node /,
  );

  const again = runAsOwner(repository, startAgain);

  assert.equal(again.exitCode, 0, `${again.account}${again.stderr}`);
  assert.match(again.account, /`fork` moved from upstream v1\.0\.0 to v2\.0\.0/);
  assert.equal(
    git(repository, "show", "fork:fork/rungs/beta/stand-in.rung.mjs"),
    "// repaired meanwhile",
  );
  assert.match(again.account, /\*\*beta\*\* \(1 repair folded in\)/);
});

test("files the gates leave behind are cleared away, so the step can be gated again once reworked", (t) => {
  const { root, repository, forkTip } = forkAndRelease(t, (repository) => {
    commit(repository, "chore: sync source v2.0.0", {
      "app/src/a.ts": withLine(numbered("a"), 9, "a 9 leaves a file"),
    });
  });

  const stopped = bringIn(repository);

  assert.equal(stopped.exitCode, 1, `${stopped.account}${stopped.stderr}`);
  assert.match(
    stopped.account,
    /Stopped at \*\*alpha\*\*\. The gates changed `fork\/left-behind\.txt`, so what they passed is not what its commit holds\./,
  );
  const worktree = join(root, "repository-Worktrees", "bring-in-v2.0.0");
  assert.equal(existsSync(join(worktree, "fork/left-behind.txt")), false);

  // The owner reworks alpha so that its gates leave nothing behind, and runs it again.
  const reworked = readFileSync(join(worktree, "app/src/a.ts"), "utf8").replace(
    "leaves a file",
    "",
  );
  writeFileSync(join(worktree, "app/src/a.ts"), reworked);
  git(worktree, "commit", "--quiet", "--all", "--amend", "--no-edit");
  const resumed = bringIn(repository);

  assert.equal(resumed.exitCode, 0, `${resumed.account}${resumed.stderr}`);
  assert.notEqual(git(repository, "rev-parse", "fork"), forkTip);
  assert.match(
    resumed.account,
    /\*\*alpha\*\* \(1 repair folded in\): .*reworked; `node fork\/gate\.mjs` passed/,
  );
});

test("a repair known only by its marker in one of upstream's files is folded into its difference", (t) => {
  const { repository } = forkAndRelease(
    t,
    (repository) => commit(repository, "chore: sync source v2.0.0", { "app/src/b.ts": ["new"] }),
    {
      fork: (repository) => {
        forkOfThree(repository);
        commit(repository, "alpha: call alpha twice", {
          "app/src/a.ts": withLine(
            numbered("a"),
            2,
            "a 2",
            "// fork(alpha): calls alpha twice",
            "alpha();",
            "alpha();",
          ),
        });
      },
    },
  );

  const { exitCode, account, stderr } = bringIn(repository);

  assert.equal(exitCode, 0, `${account}${stderr}`);
  assert.deepEqual(subjects(repository, "v2.0.0..fork"), [
    "beta: change line five",
    "alpha: call alpha",
    "fork: gate the fork",
  ]);
  assert.match(
    git(repository, "show", "fork~1:app/src/a.ts"),
    /calls alpha twice\nalpha\(\);\nalpha\(\);/,
  );
  assert.match(git(repository, "log", "-1", "--format=%B", "fork~1"), /alpha: call alpha twice/);
  assert.match(account, /\*\*alpha\*\* \(2 repairs folded in\)/);
});

test("repairs made on a later difference, the ground's among them, are replayed after it", (t) => {
  const { repository, forkTip } = forkAndRelease(
    t,
    (repository) => commit(repository, "chore: sync source v2.0.0", { "app/src/b.ts": ["new"] }),
    {
      fork: (repository) => {
        forkOfThree(repository);
        // Gamma brings a harness file and lines of the fork's README, and joins next to alpha.
        commit(repository, "gamma: drive the terminal", {
          "fork/harness/driver.mjs": ["export const quit = 1;"],
          "fork/README.md": [
            "# The fork",
            "",
            "The fork's ground.",
            "",
            "## Gamma",
            "",
            "Gamma drives.",
          ],
          "fork/rungs/gamma/stand-in.rung.mjs": "",
          "app/src/a.ts": withLine(
            numbered("a"),
            2,
            "a 2",
            "// fork(alpha): calls alpha",
            "alpha();",
            "// fork(gamma): calls gamma",
            "gamma();",
          ),
        });
        // A ground repair to what gamma brought, and an alpha repair beside gamma's join.
        commit(repository, "fork: quit the terminal in two presses", {
          "fork/harness/driver.mjs": ["export const quit = 2;"],
          "fork/README.md": [
            "# The fork",
            "",
            "The fork's ground.",
            "",
            "## Gamma",
            "",
            "Gamma quits.",
          ],
        });
        commit(repository, "alpha: call alpha with an argument", {
          "app/src/a.ts": withLine(
            numbered("a"),
            2,
            "a 2",
            "// fork(alpha): calls alpha with one",
            "alpha(1);",
            "// fork(gamma): calls gamma",
            "gamma();",
          ),
        });
      },
    },
  );

  // Not one commit for each difference, the fork waits for the owner's word to move.
  const held = bringIn(repository);
  assert.equal(held.exitCode, 0, `${held.account}${held.stderr}`);
  assert.equal(git(repository, "rev-parse", "fork"), forkTip);
  assert.match(held.account, /^# Upstream v2\.0\.0 brought in, waiting to move the fork$/m);
  assert.match(
    held.account,
    /`fork` stays at [0-9a-f]{8}: it would not be one commit for each difference/,
  );
  const [startAgain, moveAnyway] = commandsAfter(held.account, "Fold each");
  assert.match(
    startAgain,
    /^git worktree remove --force .* && git branch -D bring-in-v2\.0\.0 && node /,
  );
  assert.match(moveAnyway, / --keep-separate-repairs$/);

  const { exitCode, account, stderr } = runAsOwner(repository, moveAnyway);

  assert.equal(exitCode, 0, `${account}${stderr}`);
  assert.deepEqual(subjects(repository, "v2.0.0..fork"), [
    "alpha: call alpha with an argument",
    "fork: quit the terminal in two presses",
    "gamma: drive the terminal",
    "beta: change line five",
    "alpha: call alpha",
    "fork: gate the fork",
  ]);
  assert.equal(git(repository, "show", "fork:fork/harness/driver.mjs"), "export const quit = 2;");
  assert.match(
    git(repository, "show", "fork:fork/README.md"),
    /ground\.\n\n## Gamma\n\nGamma quits\.$/,
  );
  assert.match(git(repository, "show", "fork:app/src/a.ts"), /alpha\(1\);\n\/\/ fork\(gamma\)/);
  assert.match(account, /\*\*alpha\*\* \(1 repair folded in\): replayed cleanly/);
  assert.match(account, /\*\*base\*\*, its repair made on \*\*gamma\*\*: replayed cleanly.*passed/);
  assert.match(
    account,
    /\*\*alpha\*\*, its repair made on \*\*gamma\*\*: replayed cleanly.*passed/,
  );
  assert.match(account, /^## Not yet one commit for each difference$/m);
});

test("a repair made on another repair still waiting is placed once that one is", (t) => {
  const { repository, forkTip } = forkAndRelease(
    t,
    (repository) => commit(repository, "chore: sync source v2.0.0", { "app/src/b.ts": ["new"] }),
    {
      fork: (repository) => {
        forkOfThree(repository);
        commit(repository, "gamma: drive the terminal", {
          "fork/harness/driver.mjs": ["export const quit = 1;"],
          "fork/rungs/gamma/stand-in.rung.mjs": "",
        });
        // Alpha's repair changes gamma's harness file, and a ground repair is made on it.
        commit(repository, "alpha: quit in two presses", {
          "app/src/fork/alpha/index.ts": ["export const alpha = 3;"],
          "fork/harness/driver.mjs": ["export const quit = 2;"],
        });
        commit(repository, "fork: quit in three presses", {
          "fork/harness/driver.mjs": ["export const quit = 3;"],
        });
      },
    },
  );

  // Not one commit for each difference, the fork waits for the owner's word to move.
  const held = bringIn(repository);
  assert.equal(held.exitCode, 0, `${held.account}${held.stderr}`);
  assert.equal(git(repository, "rev-parse", "fork"), forkTip);
  assert.match(held.account, /^# Upstream v2\.0\.0 brought in, waiting to move the fork$/m);
  assert.match(
    held.account,
    /`fork` stays at [0-9a-f]{8}: it would not be one commit for each difference/,
  );
  const [startAgain, moveAnyway] = commandsAfter(held.account, "Fold each");
  assert.match(
    startAgain,
    /^git worktree remove --force .* && git branch -D bring-in-v2\.0\.0 && node /,
  );
  assert.match(moveAnyway, / --keep-separate-repairs$/);

  const { exitCode, account, stderr } = runAsOwner(repository, moveAnyway);

  assert.equal(exitCode, 0, `${account}${stderr}`);
  assert.deepEqual(subjects(repository, "v2.0.0..fork").slice(0, 3), [
    "fork: quit in three presses",
    "alpha: quit in two presses",
    "gamma: drive the terminal",
  ]);
  assert.equal(git(repository, "show", "fork:fork/harness/driver.mjs"), "export const quit = 3;");
  assert.match(account, /\*\*alpha\*\*, its repair made on \*\*gamma\*\*: .*passed/);
  assert.match(account, /\*\*base\*\*, its repair made on \*\*gamma\*\*: .*passed/);
  const notOne = account.slice(account.indexOf("## Not yet one commit for each difference"));
  assert.match(
    notOne,
    /^- \*\*alpha\*\*, its repair made on \*\*gamma\*\*: [0-9a-f]{8} \(alpha: quit in two presses\)$/m,
  );
  assert.match(
    notOne,
    /^- \*\*base\*\*, its repair made on \*\*gamma\*\*: [0-9a-f]{8} \(fork: quit in three presses\)$/m,
  );
});

test("a difference the release already provides is replayed empty, and one it partly provides says where", (t) => {
  const betaLines = withLine(numbered("c"), 5, "// fork(beta): line five", "beta 5");
  const gammaLines = (lines) => withLine(lines, 9, "// fork(gamma): line eight", "gamma 8");
  const { repository } = forkAndRelease(
    t,
    // Upstream comes to make beta's change to c.ts and the whole of gamma's.
    (repository) =>
      commit(repository, "chore: sync source v2.0.0", { "app/src/c.ts": gammaLines(betaLines) }),
    {
      fork: (repository) => {
        forkOfThree(repository);
        commit(repository, "gamma: change line eight", { "app/src/c.ts": gammaLines(betaLines) });
      },
    },
  );

  const { exitCode, account, stderr } = bringIn(repository);

  assert.equal(exitCode, 0, `${account}${stderr}`);
  assert.equal(subjects(repository, "v2.0.0..fork").length, 4);
  assert.equal(
    git(repository, "diff", "--name-only", "fork~1", "fork"),
    "",
    "gamma's commit is empty",
  );
  assert.equal(
    git(repository, "diff", "--name-only", "fork~2", "fork~1"),
    "fork/rungs/beta/stand-in.rung.mjs",
  );
  assert.match(
    account,
    /\*\*gamma\*\*: .*its commit is empty: the release already makes every change it made/,
  );
  assert.match(
    account,
    /\*\*beta\*\*: .*the release already makes its changes to `app\/src\/c\.ts`/,
  );
  assert.doesNotMatch(account, /\*\*alpha\*\*.*already makes/);
});

test("the account breaks the release's changes down by the packages the command line builds from", (t) => {
  const manifest = (name, dependencies = {}) =>
    JSON.stringify({ name, version: "1.0.0", dependencies });
  const workspace = (cliDependencies) => ({
    "package.json": JSON.stringify({ name: "root", private: true }),
    "pnpm-workspace.yaml": ["packages:", '  - "app"', '  - "libs/*"'],
    "app/package.json": manifest("@zcode/cli", cliDependencies),
  });
  const { repository } = forkAndRelease(
    t,
    (repository) =>
      commit(repository, "chore: sync source v2.0.0", {
        ...workspace({ "@zcode/lib": "workspace:*", "@zcode/extra": "workspace:*" }),
        "app/src/a.ts": withLine(numbered("a"), 9, "a 9 changed upstream"),
        "libs/lib/src/lib.ts": ["changed upstream"],
        "libs/extra/package.json": manifest("@zcode/extra"),
        "libs/other/src/other.ts": ["changed upstream"],
      }),
    {
      upstream: {
        ...workspace({ "@zcode/lib": "workspace:*", "@zcode/old": "workspace:*" }),
        "libs/lib/package.json": manifest("@zcode/lib"),
        "libs/lib/src/lib.ts": ["lib"],
        "libs/old/package.json": manifest("@zcode/old"),
        "libs/other/package.json": manifest("@zcode/other"),
        "libs/other/src/other.ts": ["other"],
      },
    },
  );

  const { exitCode, account, stderr } = bringIn(repository);

  assert.equal(exitCode, 0, `${account}${stderr}`);
  assert.match(
    account,
    /- 5 files changed since v1\.0\.0: 1 added, 4 modified, 0 renamed, 0 deleted\./,
  );
  // app/package.json, app/src/a.ts, libs/lib/src/lib.ts and libs/extra/package.json.
  assert.match(account, /- 4 files of them in the packages the command line builds from\./);
  assert.match(account, /- The command line now also builds from `libs\/extra`\./);
  assert.match(account, /- It no longer builds from `libs\/old`\./);
  const unexercised = account.slice(account.indexOf("## Changed where no difference sits"));
  assert.match(unexercised, /^- `libs\/lib`: 1 file$/m);
  assert.match(unexercised, /^- `libs\/extra`: 1 file$/m);
  assert.doesNotMatch(
    unexercised,
    /`app`|`libs\/other`/,
    "app holds alpha; other is not built from",
  );
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
