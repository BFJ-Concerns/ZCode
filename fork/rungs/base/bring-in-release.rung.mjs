/**
 * Bringing in an upstream release, exercised on small repositories made for each test:
 * an upstream branch with releases on it and a fork of a few differences, one of them
 * repaired after it landed. The receiver is what the owner sees: the fork's branch and its
 * checkout, the account the process prints and its exit status. A gate stands in for the
 * fork's gates; it fails once alpha's call and a line a release can plant meet in one
 * file, and leaves a file behind once alpha's call meets another.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import {
  bringIn,
  bringInWithEnvironment,
  commit,
  ENVIRONMENT,
  forkAndRelease,
  forkOfThree,
  git,
  numbered,
  subjects,
  withLine,
  write,
} from "./bring-in-release-fixture.mjs";

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

test("a signing failure stops at the pick and resumes with the commit made by hand", (t) => {
  const { root, repository, forkTip } = forkAndRelease(t, (repository) => {
    commit(repository, "chore: sync source v2.0.0", { "upstream.txt": ["new release"] });
  });
  // Turn on signing after base is gated, so the failure is in the replay of alpha.
  const signingGate =
    "test -f app/src/fork/alpha/index.ts || " +
    "(git config gpg.program false && git config commit.gpgsign true)";
  const accountFile = join(root, "account.md");
  const args = ["--gate", signingGate, "--account", accountFile];
  const stopped = bringIn(repository, ...args);

  assert.equal(stopped.exitCode, 1, `${stopped.account}${stopped.stderr}`);
  assert.equal(git(repository, "rev-parse", "fork"), forkTip);
  assert.match(stopped.account, /Stopped at \*\*alpha\*\*.*Git could not replay/);
  assert.match(stopped.account, /failed to sign the data/);
  assert.match(stopped.account, /git cherry-pick --continue/);
  assert.match(stopped.account, /\*\*beta\*\*: not reached/);
  assert.doesNotMatch(stopped.stderr, /at cherryPick|Error: git cherry-pick/);
  assert.equal(readFileSync(accountFile, "utf8"), stopped.account);

  const worktree = join(root, "repository-Worktrees", "bring-in-v2.0.0");
  assert.equal(git(worktree, "log", "-1", "--format=%s"), "fork: gate the fork");
  assert.equal(git(worktree, "diff", "--name-only", "--diff-filter=U"), "");
  git(worktree, "config", "commit.gpgsign", "false");
  git(worktree, "cherry-pick", "--continue");
  const finished = git(worktree, "rev-parse", "HEAD");

  const resumed = bringIn(repository, ...args);
  assert.equal(resumed.exitCode, 0, `${resumed.account}${resumed.stderr}`);
  assert.doesNotMatch(resumed.stderr, /^base$/m, "base keeps its gate result");
  assert.match(resumed.stderr, /^alpha$/m, "the manually completed pick is gated");
  assert.equal(git(repository, "rev-parse", "fork~1"), finished);
  assert.doesNotMatch(resumed.account, /^- \*\*alpha\*\*.*reworked/m);
  assert.deepEqual(subjects(repository, "v2.0.0..fork"), [
    "beta: change line five",
    "alpha: call alpha",
    "fork: gate the fork",
  ]);
});

test("a pick blocked before it starts is retried at the same step", (t) => {
  const { root, repository, forkTip } = forkAndRelease(t, (repository) => {
    commit(repository, "chore: sync source v2.0.0", { "upstream.txt": ["new release"] });
  });
  const lockGate =
    'test -f app/src/fork/alpha/index.ts || touch "$(git rev-parse --git-path index.lock)"';
  const stopped = bringIn(repository, "--gate", lockGate);

  assert.equal(stopped.exitCode, 1, `${stopped.account}${stopped.stderr}`);
  assert.equal(git(repository, "rev-parse", "fork"), forkTip);
  assert.match(stopped.account, /Stopped at \*\*alpha\*\*.*Git could not replay/);
  assert.match(stopped.account, /index\.lock/);
  assert.doesNotMatch(stopped.account, /git cherry-pick --continue/);

  const worktree = join(root, "repository-Worktrees", "bring-in-v2.0.0");
  rmSync(git(worktree, "rev-parse", "--path-format=absolute", "--git-path", "index.lock"));
  const resumed = bringIn(repository, "--gate", lockGate);

  assert.equal(resumed.exitCode, 0, `${resumed.account}${resumed.stderr}`);
  assert.deepEqual(subjects(repository, "v2.0.0..fork"), [
    "beta: change line five",
    "alpha: call alpha",
    "fork: gate the fork",
  ]);
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
  write(checkout, {
    "notes.txt": "the owner's notes",
    "app/src/c.ts": numbered("c edited"),
    "fork/README.md": "staged notes on the fork\n",
  });
  git(checkout, "add", "fork/README.md");

  const { exitCode, account, stderr } = bringIn(checkout);

  assert.equal(exitCode, 0, `${account}${stderr}`);
  assert.notEqual(git(repository, "rev-parse", "fork"), forkTip);
  assert.equal(subjects(repository, "v2.0.0..fork").length, 3);
  assert.equal(git(checkout, "rev-parse", "HEAD"), git(repository, "rev-parse", "fork"));
  assert.equal(git(checkout, "symbolic-ref", "HEAD"), "refs/heads/fork");
  assert.equal(readFileSync(join(checkout, "app/src/b.ts"), "utf8"), "new upstream file\n");
  assert.equal(readFileSync(join(checkout, "notes.txt"), "utf8"), "the owner's notes");
  assert.match(readFileSync(join(checkout, "app/src/c.ts"), "utf8"), /^c edited 1$/m);
  assert.equal(git(checkout, "diff", "--cached", "--name-only"), "fork/README.md");
  assert.equal(git(checkout, "show", ":fork/README.md"), "staged notes on the fork");
  assert.match(
    account,
    /`fork` moved from upstream v1\.0\.0 to v2\.0\.0, and its checkout in `[^`]*fork-checkout` with it/,
  );
  assert.equal(git(repository, "branch", "--list", "bring-in-*"), "");
});

test("an account file that cannot be written leaves the successful move status intact", (t) => {
  const { repository, forkTip } = forkAndRelease(t, (repository) => {
    commit(repository, "chore: sync source v2.0.0", { "app/src/b.ts": ["new upstream file"] });
  });

  const moved = bringIn(repository, "--account", repository);

  assert.equal(moved.exitCode, 0, `${moved.account}${moved.stderr}`);
  assert.notEqual(git(repository, "rev-parse", "fork"), forkTip);
  assert.match(moved.account, /`fork` moved from upstream v1\.0\.0 to v2\.0\.0/);
  assert.match(moved.stderr, /Could not write the account/);
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

  assert.equal(waiting.exitCode, 3, `${waiting.account}${waiting.stderr}`);
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

test("a paused git am holds the release until the owner aborts it", (t) => {
  const { root, repository, forkTip } = forkAndRelease(t, (repository) => {
    commit(repository, "chore: sync source v2.0.0", { "app/src/b.ts": ["new upstream file"] });
  });
  commit(repository, "a patch that overlaps beta", {
    "app/src/c.ts": withLine(numbered("c"), 5, "patched line five"),
  });
  const patch = join(root, "mailbox.patch");
  writeFileSync(patch, git(repository, "format-patch", "-1", "--stdout") + "\n");

  const checkout = join(root, "fork-checkout");
  git(repository, "worktree", "add", "--quiet", checkout, "fork");
  const am = spawnSync("git", ["am", patch], { cwd: checkout, env: ENVIRONMENT, encoding: "utf8" });
  assert.notEqual(am.status, 0);
  assert.match(am.stdout, /Patch failed/);
  assert.equal(git(checkout, "status", "--porcelain"), "");

  const waiting = bringIn(checkout);

  assert.equal(git(checkout, "rev-parse", "HEAD"), forkTip);
  assert.equal(waiting.exitCode, 3, `${waiting.account}${waiting.stderr}`);
  assert.match(waiting.account, /where `git am` is under way/);
  git(checkout, "am", "--abort");
  const [finish] = commandsAfter(waiting.account, "then run");
  const finished = runAsOwner(checkout, finish);
  assert.equal(finished.exitCode, 0, `${finished.account}${finished.stderr}`);
  assert.notEqual(git(checkout, "rev-parse", "HEAD"), forkTip);
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

  assert.equal(waiting.exitCode, 3, `${waiting.account}${waiting.stderr}`);
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

test("a checked-out fork that moves after the tip check is kept with its checkout", (t) => {
  const { root, repository, forkTip } = forkAndRelease(t, (repository) => {
    commit(repository, "chore: sync source v2.0.0", { "app/src/b.ts": ["new upstream file"] });
  });
  const checkout = join(root, "fork-checkout");
  git(repository, "worktree", "add", "--quiet", checkout, "fork");

  // Land between the early tip check and the move, as Git returns the worktree list.
  const bin = join(root, "bin");
  write(bin, {
    git: `#!/bin/sh
if [ "$*" = 'worktree list --porcelain' ]; then
  "$RELEASE_RUNG_GIT" -C "$RELEASE_RUNG_CHECKOUT" -c core.hooksPath=/dev/null \
    commit --allow-empty --quiet -m 'landed after tip check' || exit
fi
exec "$RELEASE_RUNG_GIT" "$@"
`,
  });
  chmodSync(join(bin, "git"), 0o755);
  const waiting = bringInWithEnvironment(checkout, {
    ...ENVIRONMENT,
    PATH: bin + delimiter + ENVIRONMENT.PATH,
    RELEASE_RUNG_CHECKOUT: checkout,
    RELEASE_RUNG_GIT: execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim(),
  });

  assert.equal(git(checkout, "log", "-1", "--format=%s", "HEAD"), "landed after tip check");
  assert.equal(waiting.exitCode, 3, `${waiting.account}${waiting.stderr}`);
  assert.equal(git(checkout, "rev-parse", "fork^"), forkTip);
  assert.equal(git(checkout, "symbolic-ref", "HEAD"), "refs/heads/fork");
  assert.equal(git(checkout, "status", "--porcelain"), "");
  assert.equal(existsSync(join(checkout, "app/src/b.ts")), false);
  assert.match(waiting.account, /it moved while the release was being brought in/);
  assert.match(waiting.account, /Start again from the fork as it now is/);
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
  assert.equal(held.exitCode, 3, `${held.account}${held.stderr}`);
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
  assert.equal(held.exitCode, 3, `${held.account}${held.stderr}`);
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

test("the account breaks the release's changes down by the packages the command line builds from", (t) => {
  const manifest = (name, dependencies = {}) =>
    JSON.stringify({ name, version: "1.0.0", dependencies });
  const workspace = (cliDependencies) => ({
    "package.json": JSON.stringify({ name: "root", private: true }),
    "pnpm-workspace.yaml": ["packages:", '  - "app"', '  - "libs/*"'],
    "app/package.json": manifest("@zcode/cli", cliDependencies),
  });
  const { root, repository } = forkAndRelease(
    t,
    (repository) =>
      commit(repository, "chore: sync source v2.0.0", {
        ...workspace({ "@zcode/lib": "workspace:*", "@zcode/extra": "workspace:*" }),
        "app/src/a.ts": withLine(numbered("a"), 9, "a 9 changed upstream"),
        "libs/lib/src/lib.ts": withLine(numbered("lib"), 9, "lib 9 changed upstream"),
        "libs/extra/package.json": manifest("@zcode/extra"),
        "libs/other/src/other.ts": ["changed upstream"],
      }),
    {
      upstream: {
        ...workspace({ "@zcode/lib": "workspace:*", "@zcode/old": "workspace:*" }),
        "libs/lib/package.json": manifest("@zcode/lib"),
        "libs/lib/src/lib.ts": numbered("lib"),
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

  git(repository, "branch", "reworked-fork", "v1.0.0");
  git(repository, "switch", "--quiet", "reworked-fork");
  forkOfThree(repository);
  commit(repository, "alpha: join the library", {
    "libs/lib/src/lib.ts": withLine(
      numbered("lib"),
      2,
      "lib 2",
      "// fork(alpha): calls alpha",
      "alpha();",
    ),
  });
  git(repository, "switch", "--quiet", "--detach");
  const gate = "test ! -f app/src/fork/alpha/index.ts";
  const args = ["--fork", "reworked-fork", "--gate", gate];
  const stopped = bringIn(repository, ...args);
  assert.equal(stopped.exitCode, 1, `${stopped.account}${stopped.stderr}`);
  assert.doesNotMatch(stopped.account, /## Changed where no difference sits/);
  const worktree = join(root, "repository-Worktrees", "bring-in-v2.0.0");
  git(worktree, "rm", "app/src/fork/alpha/index.ts");
  git(
    worktree,
    "restore",
    "--source=HEAD^",
    "--staged",
    "--worktree",
    "app/src/a.ts",
    "libs/lib/src/lib.ts",
  );
  write(worktree, { "libs/extra/src/fork/alpha/index.ts": ["export const alpha = 2;"] });
  git(worktree, "add", "--all");
  git(worktree, "commit", "--quiet", "--amend", "--no-edit");

  const resumed = bringIn(repository, ...args);
  assert.equal(resumed.exitCode, 0, `${resumed.account}${resumed.stderr}`);
  const replayAreas = resumed.account.slice(
    resumed.account.indexOf("## Changed where no difference sits"),
  );
  assert.match(replayAreas, /^- `libs\/lib`: 1 file$/m);
  assert.doesNotMatch(replayAreas, /^- `libs\/extra`:/m);
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
