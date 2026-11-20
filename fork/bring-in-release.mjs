/**
 * Brings an upstream release into the fork. The fork's differences are replayed onto the
 * release one at a time, and each step must pass the gates before the next is replayed,
 * so the first difference the release breaks is the one named. The process ends in one
 * of two ways. Either every difference is replayed and proven and the fork's branch moves
 * to the result, or the replay stops at the broken difference and the fork stays where it
 * was. Either way it prints an account of what the release did to each difference.
 *
 *   node fork/bring-in-release.mjs <release> [options]
 *
 *   <release>            the upstream release: a tag or a commit on the upstream branch
 *   --fork <branch>      the fork's branch, moved when the release is brought in (fork)
 *   --upstream <branch>  the branch upstream's releases are published on (main)
 *   --worktree <dir>     where the release is replayed and built
 *                        (<repository>-Worktrees/bring-in-<release>, beside the repository)
 *   --gate <command>     a command each step must pass, run by the shell at the top of
 *                        the worktree; repeatable (node fork/check.mjs, node fork/rungs.mjs)
 *   --account <file>     also write the account to this file
 *
 * A difference is told apart by its name, wherever the name appears in a commit: a
 * `src/fork/<name>/` directory, a `fork/rungs/<name>/` directory, or a `fork(<name>): `
 * join marker in a file upstream ships (fork/README.md); text in the fork's own files is
 * never read as a marker. A commit is the unit of a difference: one that brings in new
 * names is one difference carrying them all. A commit whose names all belong to a difference already
 * on the fork is a repair of that difference, and is folded into its commit on the way,
 * so that the fork on the release is the release plus one commit for each difference.
 * A commit that names nothing else belongs to the fork's ground, `base`.
 *
 * After a stop, the worktree is left as the replay reached it: a conflicting difference
 * is mid cherry-pick, and a difference whose gates failed is its last commit. Rework it
 * there (resolve and `git cherry-pick --continue`, or amend), then run the same command
 * again: it gates what was reworked and carries on from the next difference.
 *
 * Exits 0 when the release is brought in, 1 when the replay stops at a difference, and
 * 2 when it cannot start.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const DEFAULT_GATES = ["node fork/check.mjs", "node fork/rungs.mjs"];
const NAME_IN_PATH = [/(?:^|\/)src\/fork\/([a-z0-9-]+)\//, /^fork\/rungs\/([a-z0-9-]+)\//];
const JOIN_MARKER = /fork\(([a-z0-9-]+)\): /g;
const GROUND = "base";
/** The longest list of files the account prints in one place. */
const LISTED_AT_MOST = 8;

class Stop extends Error {}

const run = (command, args, options = {}) =>
  spawnSync(command, args, { encoding: "utf8", maxBuffer: 1 << 28, ...options });

function git(args, { cwd = process.cwd(), allowFailure = false } = {}) {
  const result = run("git", args, { cwd });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`git ${args.join(" ")} failed:\n${result.stderr.trim()}`);
  }
  return allowFailure ? result : result.stdout.trimEnd();
}

const lines = (text) => text.split("\n").filter(Boolean);
const short = (sha) => sha.slice(0, 8);
const code = (text) => `\`${text}\``;

// ---------------------------------------------------------------------------------------
// The fork's differences

/** The difference names a commit carries, in its paths and its join markers. */
function namesIn(commit) {
  const names = new Set();
  for (const path of lines(git(["diff-tree", "--no-commit-id", "-r", "--name-only", commit]))) {
    for (const pattern of NAME_IN_PATH) {
      const match = pattern.exec(path);
      if (match) names.add(match[1]);
    }
  }
  // Joins are edits to upstream's files; the fork's own files may quote a marker freely.
  const patch = git([
    "show",
    "--format=",
    "--unified=0",
    commit,
    "--",
    ".",
    ":(exclude)fork/",
    ":(exclude,glob)**/src/fork/**",
  ]);
  for (const line of patch.split("\n")) {
    if (!/^[+-](?![+-]{2} )/.test(line)) continue;
    for (const match of line.matchAll(JOIN_MARKER)) names.add(match[1]);
  }
  // The ground is touched by many differences alongside their own work.
  if (names.size > 1) names.delete(GROUND);
  if (names.size === 0) names.add(GROUND);
  return names;
}

const labelOf = (difference) => [...difference.names].sort().join(" + ");

/**
 * Groups the fork's commits into differences, in the order each first appears. A commit
 * with a name no earlier difference holds starts a difference of its own; one whose names
 * belong to a single earlier difference is a repair of it.
 */
function groupIntoDifferences(commits) {
  const differences = [];
  const owner = new Map();
  for (const commit of commits) {
    const names = namesIn(commit.sha);
    const unowned = [...names].filter((name) => !owner.has(name));
    if (unowned.length > 0) {
      const edited = new Set([...names].filter((name) => owner.has(name)).map((n) => owner.get(n)));
      const difference = {
        names: new Set(unowned),
        footprint: new Set(names),
        alsoEdits: [...edited].map(labelOf),
        commits: [commit],
      };
      for (const name of unowned) owner.set(name, difference);
      differences.push(difference);
      continue;
    }
    const owners = new Set([...names].map((name) => owner.get(name)));
    const candidates =
      owners.size === 1
        ? [...owners]
        : differences.filter((d) => [...names].every((name) => d.footprint.has(name)));
    if (candidates.length !== 1) {
      throw new Stop(
        `${short(commit.sha)} (${commit.subject}) changes ${[...owners].map(labelOf).join(" and ")} ` +
          "together, so it cannot be replayed as a repair of either. Split it into one commit " +
          "for each difference on the fork, then run this again.",
      );
    }
    candidates[0].commits.push(commit);
    for (const name of names) candidates[0].footprint.add(name);
  }
  return differences.map((difference) => ({
    label: labelOf(difference),
    alsoEdits: difference.alsoEdits,
    commits: difference.commits,
  }));
}

function forkCommits(base, tip) {
  if (git(["rev-list", "--merges", `${base}..${tip}`]) !== "") {
    throw new Stop(
      `The fork holds merge commits above upstream ${short(base)}; it must be linear.`,
    );
  }
  return lines(git(["log", "--reverse", "--format=%H%x09%s", `${base}..${tip}`])).map((line) => {
    const [sha, subject] = line.split("\t");
    return { sha, subject };
  });
}

// ---------------------------------------------------------------------------------------
// Upstream releases

/** A release's name: the ref given, a tag on it, or the version its sync commit names. */
function releaseLabel(commit, given) {
  if (given && !/^[0-9a-f]{7,40}$/.test(given)) return given;
  const tag = git(["describe", "--tags", "--exact-match", commit], { allowFailure: true });
  if (tag.status === 0) return tag.stdout.trim();
  const version = /\bv\d+\.\d+\.\d+\S*/.exec(git(["log", "-1", "--format=%s", commit]));
  return version ? version[0] : short(commit);
}

/** The release's changes since the fork's base, by path at the base and at the release. */
function releaseChanges(base, release) {
  const changes = [];
  for (const line of lines(git(["diff", "--name-status", "-M", base, release]))) {
    const [status, from, to] = line.split("\t");
    changes.push({ status: status[0], from, to: to ?? from });
  }
  return changes;
}

/** The workspace packages the command line builds from, at the worktree's checkout. */
function cliPackages(worktree) {
  if (!existsSync(join(worktree, "pnpm-workspace.yaml"))) return undefined;
  const listing = run("pnpm", ["--filter", "@zcode/cli...", "list", "--depth", "-1", "--json"], {
    cwd: worktree,
  });
  if (listing.status !== 0) return undefined;
  try {
    const packages = JSON.parse(listing.stdout).map((p) => p.path.slice(worktree.length + 1));
    return packages.length > 0 ? packages.sort((a, b) => b.length - a.length) : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------
// Replay and gates

function cherryPick(worktree, commits) {
  // --keep-redundant-commits is --empty=keep under the name Git before 2.45 knows.
  const picked = git(["cherry-pick", "--allow-empty", "--keep-redundant-commits", ...commits], {
    cwd: worktree,
    allowFailure: true,
  });
  if (picked.status === 0) return [];
  const conflicts = lines(git(["diff", "--name-only", "--diff-filter=U"], { cwd: worktree }));
  if (conflicts.length === 0) throw new Error(`git cherry-pick failed:\n${picked.stderr.trim()}`);
  return conflicts;
}

/** The difference as one commit on the base: its first commit, its repairs folded in. */
function foldIntoOne(worktree, difference) {
  const [first, ...repairs] = difference.commits;
  if (cherryPick(worktree, [first.sha]).length > 0) {
    throw new Stop(
      `${difference.label} does not apply on the fork's upstream base without the ` +
        "differences after it, so the fork cannot be replayed one difference at a time.",
    );
  }
  if (repairs.length === 0) return;
  const picked = git(["cherry-pick", "--no-commit", ...repairs.map((c) => c.sha)], {
    cwd: worktree,
    allowFailure: true,
  });
  if (picked.status !== 0) {
    throw new Stop(
      `The repairs to ${difference.label} do not apply directly after its first commit, ` +
        `${short(first.sha)}; they lean on a later difference. Move what they need into ` +
        "the difference itself, then run this again.",
    );
  }
  const message = difference.commits
    .map((commit) => git(["log", "-1", "--format=%B", commit.sha]).trim())
    .join("\n\n");
  git(["commit", "--no-verify", "--allow-empty", "--amend", "--message", message], {
    cwd: worktree,
  });
}

/** Runs the gates at the worktree's checkout; resolves with what they proved. */
function runGates(worktree, gates, logFile) {
  const proof = { passed: [], failedGate: undefined, rungFiles: undefined, tests: 0, failed: [] };
  const env = {
    ...process.env,
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH}`,
  };
  for (const gate of gates) {
    process.stderr.write(`  ${gate} ... `);
    const result = run("sh", ["-c", gate], { cwd: worktree, env });
    const output = `${result.stdout}${result.stderr}`;
    writeFileSync(logFile, `$ ${gate}\n${output}\n`, { flag: "a" });
    const files = /(\d+) of (\d+) rung files passed\./.exec(output);
    if (files) proof.rungFiles = { passed: Number(files[1]), of: Number(files[2]) };
    for (const tests of output.matchAll(/^ℹ tests (\d+)$/gm)) proof.tests += Number(tests[1]);
    for (const failed of output.matchAll(/^failed: (.+)$/gm)) proof.failed.push(failed[1]);
    process.stderr.write(result.status === 0 ? "passed\n" : "failed\n");
    if (result.status !== 0) {
      proof.failedGate = gate;
      return proof;
    }
    proof.passed.push(gate);
  }
  return proof;
}

// ---------------------------------------------------------------------------------------
// The account

/** The upstream files a difference edits, and what the release did to each. */
function joinedFilesTouched(state, difference) {
  const byPath = new Map(state.changes.map((change) => [change.from, change]));
  const touched = [];
  for (const path of difference.edits) {
    const change = byPath.get(path);
    if (!change) continue;
    if (change.status === "R") touched.push(`${code(path)} renamed to ${code(change.to)}`);
    else if (change.status === "D") touched.push(`${code(path)} deleted`);
    else touched.push(code(path));
  }
  return touched;
}

function listed(items) {
  if (items.length <= LISTED_AT_MOST) return items.join(", ");
  return `${items.slice(0, LISTED_AT_MOST).join(", ")} and ${items.length - LISTED_AT_MOST} more`;
}

function proofText(proof) {
  if (!proof) return "";
  const rungs = proof.rungFiles
    ? `; ${proof.rungFiles.passed} of ${proof.rungFiles.of} rung files, ${proof.tests} tests`
    : "";
  if (proof.leftChanges?.length > 0) {
    return `the gates changed ${listed(proof.leftChanges.map(code))}${rungs}`;
  }
  if (proof.failedGate) {
    const failed = proof.failed.length > 0 ? `: ${listed(proof.failed.map(code))}` : "";
    return `${code(proof.failedGate)} failed${failed}${rungs}`;
  }
  return `${proof.passed.map(code).join(" and ")} passed${rungs}`;
}

function differenceLine(state, difference) {
  const step = difference.step;
  const parts = [];
  const folded = difference.commits.length - 1;
  const name = `**${difference.label}**${folded > 0 ? ` (${folded} repair${folded > 1 ? "s" : ""} folded in)` : ""}`;
  const touched = joinedFilesTouched(state, difference);
  if (step.status === "pending") return `- ${name}: not reached.`;
  if (step.conflicts.length > 0) {
    parts.push(`conflicted in ${listed(step.conflicts.map(code))}`);
    if (step.status === "conflicted") parts.push("waiting to be reworked");
  } else if (touched.length > 0) {
    parts.push(`replayed cleanly over the release's changes to ${listed(touched)}`);
  } else {
    parts.push("replayed cleanly; the release changed none of the upstream files it edits");
  }
  if (step.conflicts.length > 0 && touched.length > 0) {
    parts.push(`the release changed ${listed(touched)}`);
  }
  if (step.empty) parts.push("its commit is empty: the release already makes every change it made");
  if (step.reworked && step.status !== "conflicted") parts.push("reworked");
  if (step.proof) parts.push(proofText(step.proof));
  if (difference.alsoEdits.length > 0)
    parts.push(`it also edits ${difference.alsoEdits.join(", ")}`);
  return `- ${name}: ${parts.join("; ")}.`;
}

function count(n, noun) {
  return `${n.toLocaleString("en-GB")} ${noun}${n === 1 ? "" : "s"}`;
}

function packageOf(path, packages) {
  return packages.find((directory) => path.startsWith(`${directory}/`));
}

function account(state) {
  const { release, base, fork } = state;
  const out = [];
  const differences = state.differences ?? [];
  const stoppedAt = differences.find(
    (d) => d.step.status === "conflicted" || d.step.status === "failed",
  );
  if (state.outcome === "moved" || state.outcome === "ready") {
    out.push(`# Upstream ${release.label} brought into the fork`, "");
    out.push(
      state.outcome === "moved"
        ? `${code(fork.branch)} moved from upstream ${base.label} to ${release.label}: it is now ${short(state.head)}, and was ${short(fork.tip)}. ` +
            `Publish it with ${code(`git push --force-with-lease=${fork.branch}:${fork.tip} origin ${fork.branch}`)}.`
        : `The fork on ${release.label} is ready on ${code(state.intakeBranch)} at ${short(state.head)}. ` +
            `${code(fork.branch)} stays at ${short(fork.tip)}: ${state.notMovedBecause}`,
    );
  } else {
    out.push(`# Upstream ${release.label} not brought in`, "");
    const where = stoppedAt ? `at **${stoppedAt.label}**` : "before any difference was replayed";
    out.push(
      `Stopped ${where}. ${state.stopReason ?? ""}`.trim(),
      "",
      `${code(fork.branch)} stays at ${short(fork.tip)}, on upstream ${base.label}.` +
        (stoppedAt
          ? ` The replay so far is on ${code(state.intakeBranch)} in ${code(state.worktree)}; ` +
            `the gates' output is in ${code(state.gateLog)}. Rework the difference there and ` +
            "run the same command again."
          : ""),
    );
  }
  if (differences.length > 0) {
    out.push("", "## The differences", "");
    for (const difference of differences) out.push(differenceLine(state, difference));
  }
  if (state.changes) {
    out.push("", `## What upstream ${release.label} brought`, "");
    const of = (status) => state.changes.filter((change) => change.status === status).length;
    out.push(
      `- ${count(state.changes.length, "file")} changed since ${base.label}: ${of("A")} added, ` +
        `${of("M")} modified, ${of("R")} renamed, ${of("D")} deleted.`,
    );
    if (state.packages) {
      const inCli = state.changes.filter((change) =>
        packageOf(change.to, state.packages.atRelease),
      );
      out.push(
        `- ${count(inCli.length, "file")} of them in the packages the command line builds from.`,
      );
      const added = state.packages.atRelease.filter((p) => !state.packages.atBase?.includes(p));
      const dropped = (state.packages.atBase ?? []).filter(
        (p) => !state.packages.atRelease.includes(p),
      );
      if (state.packages.atBase && added.length > 0) {
        out.push(`- The command line now also builds from ${listed(added.map(code))}.`);
      }
      if (dropped.length > 0) out.push(`- It no longer builds from ${listed(dropped.map(code))}.`);
    } else {
      out.push(
        "- The packages the command line builds from could not be listed, so the changes are " +
          "not broken down by package.",
      );
    }
    if (state.changes.some((change) => change.to === "pnpm-lock.yaml")) {
      out.push("- The lockfile changed: the installed dependencies differ.");
    }
    const unexercised = unexercisedAreas(state);
    if (unexercised.length > 0) {
      out.push(
        "",
        "## Changed where no difference sits",
        "",
        "The release changed these packages of the command line, which hold none of the " +
          "fork's code or joins. The rungs reach them only along the paths they drive.",
        "",
        ...unexercised.map(
          ({ directory, files }) => `- ${code(directory)}: ${count(files, "file")}`,
        ),
      );
    }
  }
  return `${out.join("\n")}\n`;
}

function unexercisedAreas(state) {
  if (!state.packages) return [];
  const packages = state.packages.atRelease;
  const forkAreas = new Set(
    state.differences.flatMap((d) => d.files.map((path) => packageOf(path, packages))),
  );
  const changed = new Map();
  for (const change of state.changes) {
    const directory = packageOf(change.to, packages);
    if (directory && !forkAreas.has(directory))
      changed.set(directory, (changed.get(directory) ?? 0) + 1);
  }
  return [...changed].map(([directory, files]) => ({ directory, files }));
}

// ---------------------------------------------------------------------------------------
// The process

/** A reason the process cannot start: nothing has been done, and the fork is untouched. */
class Refusal extends Error {}

const HEAD = (worktree) => git(["rev-parse", "HEAD"], { cwd: worktree });
const treeOf = (commit) => git(["rev-parse", `${commit}^{tree}`]);
const branchExists = (branch) =>
  git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { allowFailure: true })
    .status === 0;
/** Files in the worktree that differ from its commit, untracked ones included. */
const uncommitted = (worktree) =>
  lines(git(["status", "--porcelain", "--untracked-files=all"], { cwd: worktree })).map((line) =>
    line.slice(3),
  );
const cherryPickInProgress = (worktree) =>
  git(["rev-parse", "--verify", "--quiet", "CHERRY_PICK_HEAD"], {
    cwd: worktree,
    allowFailure: true,
  }).status === 0;

function parseCommandLine() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      fork: { type: "string", default: "fork" },
      upstream: { type: "string", default: "main" },
      worktree: { type: "string" },
      gate: { type: "string", multiple: true },
      account: { type: "string" },
    },
  });
  if (positionals.length !== 1) {
    throw new Refusal("Name one upstream release: node fork/bring-in-release.mjs <release>.");
  }
  return { ...values, release: positionals[0], gates: values.gate ?? DEFAULT_GATES };
}

function startState(options) {
  if (!branchExists(options.fork)) {
    throw new Refusal(`There is no branch ${options.fork} to bring the release into.`);
  }
  const tip = git(["rev-parse", `refs/heads/${options.fork}`]);
  const release = git(["rev-parse", "--verify", "--quiet", `${options.release}^{commit}`], {
    allowFailure: true,
  });
  if (release.status !== 0) throw new Refusal(`There is no commit ${options.release}.`);
  const releaseCommit = release.stdout.trim();
  const upstreamTip = git(["rev-parse", "--verify", `${options.upstream}^{commit}`]);
  const base = git(["merge-base", tip, upstreamTip]);
  const isAncestor = (older, newer) =>
    git(["merge-base", "--is-ancestor", older, newer], { allowFailure: true }).status === 0;
  if (!isAncestor(releaseCommit, upstreamTip)) {
    throw new Refusal(
      `${options.release} is not on ${options.upstream}, where upstream's releases are.`,
    );
  }
  if (releaseCommit === base) throw new Refusal(`The fork is already on ${options.release}.`);
  if (!isAncestor(base, releaseCommit)) {
    throw new Refusal(
      `${options.release} is older than upstream ${releaseLabel(base)}, which the fork is on.`,
    );
  }
  const label = releaseLabel(releaseCommit, options.release);
  const repositoryTop = dirname(git(["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  const worktree = resolve(
    options.worktree ??
      join(dirname(repositoryTop), `${basename(repositoryTop)}-Worktrees`, `bring-in-${label}`),
  );
  return {
    release: { ref: options.release, commit: releaseCommit, label },
    base: { commit: base, label: releaseLabel(base) },
    fork: { branch: options.fork, tip },
    gates: options.gates,
    worktree,
    intakeBranch: `bring-in-${label.replaceAll(/[^A-Za-z0-9._-]/g, "-")}`,
    outcome: "running",
  };
}

function stateFile(worktree) {
  const gitDirectory = git(["rev-parse", "--path-format=absolute", "--git-dir"], { cwd: worktree });
  return join(gitDirectory, "fork-bring-in", "state.json");
}

function save(state) {
  const file = stateFile(state.worktree);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * Makes the worktree, puts each difference into it as one commit on the fork's base, and
 * checks that together they give the fork's tree. The worktree then moves to the release.
 */
function prepare(state) {
  const differences = groupIntoDifferences(forkCommits(state.base.commit, state.fork.tip));
  if (branchExists(state.intakeBranch)) {
    throw new Refusal(
      `A branch ${state.intakeBranch} is left from an earlier attempt without its worktree. ` +
        `Delete it (git branch -D ${state.intakeBranch}) to start again.`,
    );
  }
  git(["worktree", "add", "--detach", state.worktree, state.base.commit]);
  try {
    const atBase = cliPackages(state.worktree);
    for (const difference of differences) {
      const [first] = difference.commits;
      const firstApplies = git(["rev-parse", `${first.sha}^`]) === HEAD(state.worktree);
      if (difference.commits.length === 1 && firstApplies) {
        git(["checkout", "--quiet", "--detach", first.sha], { cwd: state.worktree });
      } else {
        foldIntoOne(state.worktree, difference);
      }
      difference.replay = HEAD(state.worktree);
      difference.files = lines(
        git(["diff", "--name-only", `${difference.replay}^`, difference.replay]),
      );
      difference.edits = difference.files.filter(
        (path) =>
          git(["cat-file", "-e", `${state.base.commit}:${path}`], { allowFailure: true }).status ===
          0,
      );
      difference.step = { status: "pending", conflicts: [] };
    }
    if (treeOf(HEAD(state.worktree)) !== treeOf(state.fork.tip)) {
      throw new Stop(
        "The fork's differences, each made one commit on its upstream base, do not give the fork's own tree.",
      );
    }
    // The differences' commits are kept reachable until the process ends.
    git(["update-ref", `refs/bring-in/${state.intakeBranch}`, HEAD(state.worktree)]);
    git(["switch", "--quiet", "-c", state.intakeBranch, state.release.commit], {
      cwd: state.worktree,
    });
    const atRelease = cliPackages(state.worktree);
    state.packages = atRelease ? { atBase, atRelease } : undefined;
  } catch (error) {
    git(["worktree", "remove", "--force", state.worktree]);
    throw error;
  }
  state.differences = differences;
  state.changes = releaseChanges(state.base.commit, state.release.commit);
  state.gateLog = join(dirname(stateFile(state.worktree)), "gates.log");
}

/** Takes up an earlier attempt after rework: the commits on the intake branch are its steps. */
function resume(state) {
  const file = existsSync(join(state.worktree, ".git")) ? stateFile(state.worktree) : undefined;
  if (!file || !existsSync(file)) {
    throw new Refusal(`${state.worktree} is in the way: it holds no release being brought in.`);
  }
  const saved = JSON.parse(readFileSync(file, "utf8"));
  if (saved.release.commit !== state.release.commit || saved.fork.branch !== state.fork.branch) {
    throw new Refusal(`${state.worktree} holds the bringing in of another release or fork.`);
  }
  if (saved.fork.tip !== state.fork.tip) {
    throw new Refusal(
      `${state.fork.branch} has moved since this release was started in ${state.worktree}. ` +
        `Remove that worktree and the branch ${saved.intakeBranch} to start again.`,
    );
  }
  if (cherryPickInProgress(state.worktree)) {
    throw new Refusal(
      `A cherry-pick is still in progress in ${state.worktree}: finish the rework with ` +
        "git cherry-pick --continue, or give it up with git cherry-pick --abort, then run this again.",
    );
  }
  const changed = uncommitted(state.worktree);
  if (changed.length > 0) {
    throw new Refusal(
      `${state.worktree} holds changes no commit holds: ${changed.join(", ")}. Only committed ` +
        "rework is gated and brought in, so commit it (or amend the step) or discard it, " +
        "then run this again.",
    );
  }
  const branch = git(["symbolic-ref", "--quiet", "--short", "HEAD"], {
    cwd: state.worktree,
    allowFailure: true,
  });
  if (branch.stdout.trim() !== saved.intakeBranch) {
    throw new Refusal(
      `Switch ${state.worktree} back to ${saved.intakeBranch}, then run this again.`,
    );
  }
  const steps = lines(
    git(["rev-list", "--reverse", "--first-parent", `${saved.release.commit}..HEAD`], {
      cwd: state.worktree,
    }),
  );
  // Every step up to the one that stopped has its commit; a commit past it is rework
  // made as a commit of its own, and would be taken for the next difference.
  const reached = saved.differences.filter((d) => d.step.status !== "pending").length;
  if (steps.length > reached) {
    throw new Refusal(
      `${saved.intakeBranch} holds ${steps.length - reached} commit(s) past the step that ` +
        "stopped. Each difference is one commit, so fold the rework into that step's commit " +
        "(git reset --soft HEAD~1, then git commit --amend), then run this again.",
    );
  }
  Object.assign(state, saved, { gates: state.gates, outcome: "running", stopReason: undefined });
  state.differences.forEach((difference, index) => {
    const step = difference.step;
    if (index >= steps.length) {
      Object.assign(step, {
        status: "pending",
        commit: undefined,
        conflicts: [],
        proof: undefined,
      });
      return;
    }
    if (step.status === "passed" && step.commit === steps[index]) return;
    if (step.commit !== steps[index] && step.status !== "pending") step.reworked = true;
    Object.assign(step, { status: "replayed", commit: steps[index], proof: undefined });
  });
}

function stopAt(state, reason) {
  state.outcome = "stopped";
  state.stopReason = reason;
}

/**
 * Replays each difference not yet on the release and gates each step not yet proven, in
 * the fork's order, stopping at the first that conflicts or fails.
 */
function replay(state) {
  save(state);
  for (const difference of state.differences) {
    const step = difference.step;
    if (step.status === "passed") continue;
    process.stderr.write(`${difference.label}\n`);
    if (step.status === "pending") {
      const conflicts = cherryPick(state.worktree, [difference.replay]);
      if (conflicts.length > 0) {
        Object.assign(step, { status: "conflicted", conflicts });
        return stopAt(
          state,
          `It does not replay onto the release: ${listed(conflicts.map(code))} conflict.`,
        );
      }
      step.commit = HEAD(state.worktree);
    }
    step.empty = treeOf(step.commit) === treeOf(`${step.commit}^`);
    const atTop = step.commit === HEAD(state.worktree);
    if (!atTop) git(["checkout", "--quiet", "--detach", step.commit], { cwd: state.worktree });
    step.proof = runGates(state.worktree, state.gates, state.gateLog);
    // What passed must be what the commit holds, not files the gates changed beside it.
    step.proof.leftChanges = uncommitted(state.worktree);
    if (step.proof.leftChanges.length > 0) {
      git(["checkout", "--quiet", "--", "."], { cwd: state.worktree });
    }
    if (!atTop) git(["switch", "--quiet", state.intakeBranch], { cwd: state.worktree });
    const failed = step.proof.failedGate || step.proof.leftChanges.length > 0;
    step.status = failed ? "failed" : "passed";
    save(state);
    if (step.proof.failedGate) {
      return stopAt(state, `With it replayed, ${code(step.proof.failedGate)} fails.`);
    }
    if (failed) {
      return stopAt(
        state,
        `The gates changed ${listed(step.proof.leftChanges.map(code))}, so what they ` +
          "passed is not what its commit holds.",
      );
    }
  }
  state.head = HEAD(state.worktree);
  return undefined;
}

/** Moves the fork's branch to the replay, unless it is checked out or has moved meanwhile. */
function moveFork(state) {
  const forkRef = `refs/heads/${state.fork.branch}`;
  const checkedOut = git(["worktree", "list", "--porcelain"])
    .split("\n\n")
    .find((entry) => entry.split("\n").includes(`branch ${forkRef}`));
  if (checkedOut) {
    state.outcome = "ready";
    state.notMovedBecause = `it is checked out in ${code(checkedOut.split("\n")[0].replace(/^worktree /, ""))}.`;
    return;
  }
  const moved = git(
    [
      "update-ref",
      "-m",
      `bring in upstream ${state.release.label}`,
      forkRef,
      state.head,
      state.fork.tip,
    ],
    { allowFailure: true },
  );
  if (moved.status !== 0) {
    state.outcome = "ready";
    state.notMovedBecause = "it moved while the release was being brought in.";
    return;
  }
  state.outcome = "moved";
  git(["worktree", "remove", "--force", state.worktree]);
  git(["branch", "--quiet", "-D", state.intakeBranch]);
  git(["update-ref", "-d", `refs/bring-in/${state.intakeBranch}`]);
}

function main() {
  let options;
  let state;
  try {
    options = parseCommandLine();
    state = startState(options);
    if (existsSync(state.worktree)) resume(state);
    else prepare(state);
    replay(state);
  } catch (error) {
    if (error instanceof Refusal) {
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
    if (!(error instanceof Stop)) throw error;
    stopAt(state, error.message);
  }
  if (state.outcome === "running") moveFork(state);
  if (state.outcome !== "moved" && existsSync(state.worktree)) save(state);
  const text = account(state);
  process.stdout.write(text);
  if (options.account) writeFileSync(options.account, text);
  return state.outcome === "stopped" ? 1 : 0;
}

process.exitCode = main();
