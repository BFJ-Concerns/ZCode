import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  bringIn,
  bringInWithEnvironment,
  commit,
  ENVIRONMENT,
  forkAndRelease,
  forkOfThree,
  git,
  subjects,
} from "./bring-in-release-fixture.mjs";

for (const adjacent of [true, false]) {
  const repairOrder = adjacent ? "adjacent" : "out-of-order";
  const fixture = (t) =>
    forkAndRelease(
      t,
      (repository) => {
        commit(repository, "chore: sync source v2.0.0", { "upstream.txt": ["new release"] });
      },
      {
        fork(repository) {
          forkOfThree(repository);
          if (adjacent) {
            // Keep base, alpha and its repair, with no beta between alpha and its repair.
            git(repository, "rebase", "--onto", "HEAD~2", "HEAD~1");
          }
        },
      },
    );

  test(`a broken signer stops in replay with an ${repairOrder} repair folded`, (t) => {
    const { root, repository, forkTip } = fixture(t);
    git(repository, "config", "gpg.program", "false");
    git(repository, "config", "commit.gpgsign", "true");

    const stopped = bringIn(repository);

    assert.equal(stopped.exitCode, 1, `${stopped.account}${stopped.stderr}`);
    assert.equal(git(repository, "rev-parse", "fork"), forkTip);
    assert.match(stopped.account, /Stopped at \*\*base\*\*.*Git could not replay/);
    assert.match(stopped.account, /failed to sign the data/);
    assert.match(stopped.account, /\*\*alpha\*\* \(1 repair folded in\): not reached/);
    assert.doesNotMatch(stopped.account, /Not yet one commit/);
    assert.doesNotMatch(stopped.stderr, /Error: git|\s+at \w/);

    const worktree = join(root, "repository-Worktrees", "bring-in-v2.0.0");
    git(repository, "config", "commit.gpgsign", "false");
    git(worktree, "cherry-pick", "--continue");
    const resumed = bringIn(repository);

    assert.equal(resumed.exitCode, 0, `${resumed.account}${resumed.stderr}`);
    assert.deepEqual(subjects(repository, "v2.0.0..fork"), [
      ...(adjacent ? [] : ["beta: change line five"]),
      "alpha: call alpha",
      "fork: gate the fork",
    ]);
    assert.match(git(repository, "show", "fork:app/src/fork/alpha/index.ts"), /alpha = 2/);
  });

  test(`missing Git identity during layout reports and retries an ${repairOrder} repair`, (t) => {
    const { root, repository, forkTip } = fixture(t);
    git(repository, "config", "user.useConfigOnly", "true");
    const env = { ...ENVIRONMENT };
    delete env.GIT_COMMITTER_NAME;
    delete env.GIT_COMMITTER_EMAIL;
    const accountFile = join(root, "account.md");
    const args = ["--account", accountFile];

    const stopped = bringInWithEnvironment(repository, env, ...args);

    assert.equal(stopped.exitCode, 1, `${stopped.account}${stopped.stderr}`);
    assert.equal(git(repository, "rev-parse", "fork"), forkTip);
    assert.match(stopped.account, /Stopped before any difference was replayed.*lay out/);
    const operation = adjacent
      ? "folding repairs for `alpha: call alpha`"
      : "placing `alpha: repair alpha`";
    assert.ok(stopped.account.includes(operation), stopped.account);
    assert.match(stopped.account, /[Cc]ommitter identity unknown|no email was given/);
    assert.doesNotMatch(stopped.stderr, /Error: git|\s+at \w/);
    assert.equal(readFileSync(accountFile, "utf8"), stopped.account);
    assert.equal(existsSync(join(root, "repository-Worktrees", "bring-in-v2.0.0")), false);

    const resumed = bringIn(repository, ...args);
    assert.equal(resumed.exitCode, 0, `${resumed.account}${resumed.stderr}`);
    assert.match(resumed.account, /\*\*alpha\*\* \(1 repair folded in\): replayed cleanly/);
  });
}
