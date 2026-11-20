import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import {
  bringIn,
  commit,
  forkAndRelease,
  forkOfThree,
  git,
  numbered,
  subjects,
  withLine,
  write,
} from "./bring-in-release-fixture.mjs";

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

for (const upstreamSuppliesJoin of [true, false]) {
  const source = upstreamSuppliesJoin ? "the release" : "earlier rework";
  test(`the account credits ${source} for a later join beside an earlier reworked join`, (t) => {
    const alpha = ["// fork(alpha): calls alpha", "alpha();"];
    const beta = ["// fork(beta): calls beta", "beta();"];
    const joined = (...joins) => withLine(numbered("a"), 2, "a 2", ...joins.flat());
    const upstream = ["// addition from upstream"];
    const releaseFile = upstreamSuppliesJoin
      ? joined(beta)
      : withLine(joined(upstream), 10, "a 9", ...beta);
    const resolvedFile = upstreamSuppliesJoin
      ? joined(alpha, beta)
      : withLine(joined(alpha, beta), 13, "a 9", ...beta);
    const { root, repository } = forkAndRelease(
      t,
      (repository) =>
        commit(repository, "chore: sync source v2.0.0", { "app/src/a.ts": releaseFile }),
      {
        fork: (repository) => {
          forkOfThree(repository);
          commit(repository, "beta: add a join after alpha", {
            "app/src/a.ts": joined(alpha, beta),
            "app/src/fork/beta/index.ts": ["export const beta = 1;"],
          });
        },
      },
    );

    const stopped = bringIn(repository);
    assert.equal(stopped.exitCode, 1, `${stopped.account}${stopped.stderr}`);
    assert.match(stopped.account, /^- \*\*alpha\*\*.*conflicted in `app\/src\/a\.ts`/m);
    const worktree = join(root, "repository-Worktrees", "bring-in-v2.0.0");
    write(worktree, { "app/src/a.ts": resolvedFile });
    git(worktree, "add", "app/src/a.ts");
    git(worktree, "cherry-pick", "--continue");

    const resumed = bringIn(repository);
    assert.equal(resumed.exitCode, 0, `${resumed.account}${resumed.stderr}`);
    const adopted = /^- \*\*beta\*\*.*the release already makes its changes to `app\/src\/a\.ts`/m;
    const supplied = /^- \*\*beta\*\*.*earlier rework supplied its edits to `app\/src\/a\.ts`/m;
    assert.match(resumed.account, upstreamSuppliesJoin ? adopted : supplied);
    assert.doesNotMatch(resumed.account, upstreamSuppliesJoin ? supplied : adopted);
  });
}

test("rework in an earlier step can supply a later join even where the release changed the file", (t) => {
  const releaseA = withLine(numbered("a"), 9, "a 9 gate fails");
  const releaseC = withLine(numbered("c"), 9, "c 9 changed upstream");
  const { root, repository } = forkAndRelease(t, (repository) => {
    commit(repository, "chore: sync source v2.0.0", {
      "app/src/a.ts": releaseA,
      "app/src/c.ts": releaseC,
    });
  });
  assert.equal(bringIn(repository).exitCode, 1);

  const worktree = join(root, "repository-Worktrees", "bring-in-v2.0.0");
  write(worktree, {
    "app/src/a.ts": releaseA,
    "app/src/c.ts": withLine(releaseC, 5, "// fork(beta): line five", "beta 5"),
  });
  git(worktree, "commit", "--quiet", "--all", "--amend", "--no-edit");

  const { exitCode, account, stderr } = bringIn(repository);
  assert.equal(exitCode, 0, `${account}${stderr}`);
  assert.match(
    account,
    /^- \*\*alpha\*\*.*rework removed its edits to `app\/src\/a\.ts`.*reworked/m,
  );
  assert.match(account, /^- \*\*beta\*\*.*earlier rework supplied its edits to `app\/src\/c\.ts`/m);
  assert.doesNotMatch(account, /^- \*\*(alpha|beta)\*\*.*already makes/m);
  assert.doesNotMatch(account, /^- \*\*beta\*\*.*; reworked/m);
});

test("an empty reworked commit does not credit upstream with edits it removed", (t) => {
  const { root, repository } = forkAndRelease(
    t,
    (repository) =>
      commit(repository, "chore: sync source v2.0.0", {
        "app/src/c.ts": withLine(numbered("c"), 5, "c 5 changed upstream"),
      }),
    {
      fork: (repository) => {
        forkOfThree(repository);
        git(repository, "rm", "fork/rungs/beta/stand-in.rung.mjs");
        commit(repository, "beta: join another file", {
          "app/src/d.ts": withLine(numbered("d"), 5, "// fork(beta): line five", "beta d5"),
        });
      },
      upstream: { "app/src/d.ts": numbered("d") },
    },
  );
  assert.equal(bringIn(repository).exitCode, 1);

  const worktree = join(root, "repository-Worktrees", "bring-in-v2.0.0");
  git(worktree, "restore", "--source=HEAD", "--staged", "--worktree", ".");
  git(worktree, "commit", "--quiet", "--allow-empty", "--no-edit");
  const { exitCode, account, stderr } = bringIn(repository);
  assert.equal(exitCode, 0, `${account}${stderr}`);
  assert.match(
    account,
    /^- \*\*beta\*\*.*its commit is empty; rework removed its edits to `app\/src\/c\.ts`, `app\/src\/d\.ts`.*reworked/m,
  );
  assert.doesNotMatch(account, /^- \*\*beta\*\*.*already makes/m);
});
