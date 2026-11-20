/**
 * Brings an upstream release into the fork. The fork's differences are replayed onto the
 * release one at a time, and each step must pass the gates before the next is replayed,
 * so the first difference the release breaks is the one named. Either every difference
 * is replayed and proven and the fork's branch moves to the result, its checkout with it
 * where it is checked out, or the replay stops at the broken difference and the fork
 * stays where it was. When the result is proven but the fork cannot move (it moved
 * meanwhile, its checkout holds changes the move would overwrite, or it would not be
 * one commit for each difference), the result waits on a branch and the account gives
 * the command that finishes the job. Either way it
 * prints an account of what the release did to each difference.
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
 *   --keep-separate-repairs
 *                        move the fork even though some repairs are commits of their own
 *                        after a later difference, so it is not one commit for each
 *
 * A difference is told apart by its name, wherever the name appears in a commit: a
 * `src/fork/<name>/` directory, a `fork/rungs/<name>/` directory, or a `fork(<name>): `
 * join marker in a file upstream ships (fork/README.md); text in the fork's own files is
 * never read as a marker. A commit is the unit of a difference: one that brings in new
 * names is one difference carrying them all. A commit whose names all belong to a
 * difference already on the fork is a repair of that difference, and is folded into its
 * commit on the way, so that the fork on the release is the release plus one commit for
 * each difference. A repair made on top of a later difference, which does not apply
 * without it, is instead replayed as a step of its own directly after that difference,
 * and the fork moves with such a step only at --keep-separate-repairs.
 * A commit that names nothing else belongs to the fork's ground, `base`.
 *
 * After a stop, the worktree is left as the replay reached it. Fix the Git failure and
 * run `git cherry-pick --continue` if a pick is in progress, or amend the last commit
 * if a gate failed. Files the gates left behind are named in the account and cleared
 * away. Run the same release command again to retry an unstarted pick or gate the
 * completed commit and carry on.
 *
 * Exits 0 when the fork moves, 1 when preparation or replay stops, 2 when it
 * refuses to start or resume, and 3 when the proven result waits on its branch.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  cherryPick,
  cleanUpReplay,
  foldForLayout,
  forkCheckout,
  git,
  LayoutError,
  moveReleaseRef,
  pickForLayout,
  refIsSet,
  refTip,
  run,
} from "./bring-in-release-git.mjs";

const DEFAULT_GATES = ["node fork/check.mjs", "node fork/rungs.mjs"];
const NAME_IN_PATH = [/(?:^|\/)src\/fork\/([a-z0-9-]+)\//, /^fork\/rungs\/([a-z0-9-]+)\//];
const JOIN_MARKER = /fork\(([a-z0-9-]+)\): /g;
const GROUND = "base";
/** The longest list of files the account prints in one place. */
const LISTED_AT_MOST = 8;

class Stop extends Error {}

const lines = (text) => text.split("\n").filter(Boolean);
const short = (sha) => sha.slice(0, 8);
const code = (text) => `\`${text}\``;
/** A word as a POSIX shell reads it back unchanged. */
const shellWord = (word) =>
  /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;

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
  return lines(git(["log", "--reverse", "--format=%H%x09%s", `${base}..${tip}`])).map(
    (line, position) => {
      const [sha, subject] = line.split("\t");
      return { sha, subject, position };
    },
  );
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

/**
 * Lays the fork out on its upstream base as the steps it is replayed in, one commit each.
 * Each difference is a step, its repairs folded in. A repair that does not apply directly
 * after its difference was made on top of a later one, so it becomes a step of its own
 * placed directly after the first difference it applies after, and the repairs made to
 * its difference after it wait with it. The ground's repairs are no different: one that
 * changes a file a later difference brought follows that difference.
 */
function layOut(worktree, differences) {
  const steps = [];
  /** Repairs not yet placed, in the order they were made, whichever difference they repair. */
  const waiting = [];
  const wait = (repair) => {
    const later = waiting.findIndex((other) => other.commit.position > repair.commit.position);
    waiting.splice(later === -1 ? waiting.length : later, 0, repair);
  };
  /** Whether a repair to `difference` waits among the first `count` repairs waiting. */
  const repairWaits = (difference, count = waiting.length) =>
    waiting.slice(0, count).some((repair) => repair.difference === difference);
  /** Places a repair as the last step, joining that step when it is the same difference's. */
  const placeRepair = (repair, follows) => {
    const last = steps.at(-1);
    if (last.follows === follows && last.label === repair.difference.label) {
      last.commits.push(repair.commit);
      foldForLayout(worktree, 2, last.commits);
      last.replay = HEAD(worktree);
    } else {
      steps.push({
        label: repair.difference.label,
        follows,
        alsoEdits: [],
        commits: [repair.commit],
        replay: HEAD(worktree),
      });
    }
  };
  for (const difference of differences) {
    const [first, ...repairs] = difference.commits;
    if (!pickForLayout(worktree, first)) {
      throw new Stop(
        `${difference.label} does not apply on the fork's upstream base without the ` +
          "differences after it, so the fork cannot be replayed one difference at a time.",
      );
    }
    const folded = [first];
    for (const commit of repairs) {
      const repair = { difference, commit };
      if (!repairWaits(difference) && pickForLayout(worktree, commit)) folded.push(commit);
      else wait(repair);
    }
    foldForLayout(worktree, folded.length, folded);
    steps.push({
      label: difference.label,
      alsoEdits: difference.alsoEdits,
      commits: folded,
      replay: HEAD(worktree),
    });
    // A repair placed can be what an earlier one waiting was made on, so the list is
    // gone over again, from the start, until a pass places nothing.
    for (let placed = true; placed; ) {
      placed = false;
      for (let index = 0; index < waiting.length; ) {
        const repair = waiting[index];
        if (!repairWaits(repair.difference, index) && pickForLayout(worktree, repair.commit)) {
          waiting.splice(index, 1);
          placeRepair(repair, difference.label);
          placed = true;
        } else {
          index += 1;
        }
      }
    }
  }
  if (waiting.length > 0) {
    const [{ difference, commit }] = waiting;
    throw new Stop(
      `${short(commit.sha)} (${commit.subject}), a repair to ${difference.label}, applies ` +
        "after none of the fork's differences, so the fork cannot be replayed one " +
        "difference at a time.",
    );
  }
  return steps;
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

/** The upstream files a step edits, and what the release did to each. */
function joinedFilesTouched(state, step) {
  const byPath = new Map(state.changes.map((change) => [change.from, change]));
  const touched = [];
  for (const path of step.edits) {
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

const bold = (text) => `**${text}**`;

const repairs = (n) => `${n} repair${n > 1 ? "s" : ""}`;

/**
 * A step as the account names it: a difference, or repairs to a difference that were
 * made on a later one and are replayed after it.
 */
function stepName(step, mark = (text) => text) {
  if (!step.follows) return mark(step.label);
  const made = step.commits.length > 1 ? repairs(step.commits.length) : "repair";
  return `${mark(step.label)}, its ${made} made on ${mark(step.follows)}`;
}

function stepLine(state, step) {
  const parts = [];
  const folded = step.follows ? 0 : step.commits.length - 1;
  const name = `${stepName(step, bold)}${folded > 0 ? ` (${repairs(folded)} folded in)` : ""}`;
  const touched = joinedFilesTouched(state, step);
  if (step.status === "pending") return `- ${name}: not reached.`;
  if (step.status === "pick-failed") return `- ${name}: Git could not complete the pick.`;
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
  if (step.empty) {
    parts.push("its commit is empty: the release already makes every change it made");
  } else if (step.provided?.length > 0) {
    parts.push(`the release already makes its changes to ${listed(step.provided.map(code))}`);
  }
  if (step.reworked && step.status !== "conflicted") parts.push("reworked");
  if (step.proof) parts.push(proofText(step.proof));
  if (step.alsoEdits.length > 0) parts.push(`it also edits ${step.alsoEdits.join(", ")}`);
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
  const steps = state.steps ?? [];
  const stoppedAt = steps.find((step) =>
    ["conflicted", "pick-failed", "failed"].includes(step.status),
  );
  if (state.outcome === "moved") {
    const withCheckout = state.checkout
      ? `, and its checkout in ${code(state.checkout)} with it`
      : "";
    out.push(
      `# Upstream ${release.label} brought into the fork`,
      "",
      `${code(fork.branch)} moved from upstream ${base.label} to ${release.label}${withCheckout}: ` +
        `it is now ${short(state.head)}, and was ${short(fork.tip)}. ` +
        `Publish it with ${code(`git push --force-with-lease=${fork.branch}:${fork.tip} origin ${fork.branch}`)}.`,
    );
  } else if (state.outcome === "ready") {
    out.push(
      `# Upstream ${release.label} brought in, waiting to move the fork`,
      "",
      `The fork on ${release.label} is ready on ${code(state.intakeBranch)} at ${short(state.head)}. ` +
        `${code(fork.branch)} stays at ${short(fork.tip)}: ${state.notMovedBecause}`,
    );
  } else {
    out.push(`# Upstream ${release.label} not brought in`, "");
    const where = stoppedAt
      ? `at ${stepName(stoppedAt, bold)}`
      : "before any difference was replayed";
    out.push(
      `Stopped ${where}. ${state.stopReason ?? ""}`.trim(),
      "",
      `${code(fork.branch)} stays at ${short(fork.tip)}, on upstream ${base.label}.` +
        (stoppedAt
          ? ` The replay so far is on ${code(state.intakeBranch)} in ${code(state.worktree)}; ` +
            `the gates' output is in ${code(state.gateLog)}. Rework the difference there and ` +
            `run ${code(rerunCommand())} again.`
          : ""),
    );
  }
  if (steps.length > 0) {
    out.push("", "## The differences", "");
    for (const step of steps) out.push(stepLine(state, step));
  }
  const placed = steps.filter((step) => step.follows);
  if (placed.length > 0) {
    out.push(
      "",
      "## Not yet one commit for each difference",
      "",
      "Each of these repairs was made on a later difference and does not apply without it, so " +
        "its difference cannot be withdrawn alone until the owner folds it in by hand.",
      "",
      ...placed.map(
        (step) =>
          `- ${stepName(step, bold)}: ` +
          `${step.commits.map((commit) => `${short(commit.sha)} (${commit.subject})`).join(", ")}`,
      ),
    );
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
    state.steps.flatMap((step) => step.files.map((path) => packageOf(path, packages))),
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
/** A step not yet replayed onto the release. */
const markPending = (step) =>
  Object.assign(step, { status: "pending", commit: undefined, conflicts: [], proof: undefined });
const filesOf = (commit) => lines(git(["diff", "--name-only", `${commit}^`, commit]));
const treeOf = (commit) => git(["rev-parse", `${commit}^{tree}`]);
const branchExists = (branch) =>
  git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { allowFailure: true })
    .status === 0;
/** Files in the worktree that differ from its commit, untracked ones included. */
const uncommitted = (worktree) =>
  lines(git(["status", "--porcelain", "--untracked-files=all"], { cwd: worktree })).map((line) =>
    line.slice(3),
  );
const cherryPickInProgress = (worktree) => refIsSet(worktree, "CHERRY_PICK_HEAD");

function parseCommandLine() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      fork: { type: "string", default: "fork" },
      upstream: { type: "string", default: "main" },
      worktree: { type: "string" },
      gate: { type: "string", multiple: true },
      account: { type: "string" },
      "keep-separate-repairs": { type: "boolean", default: false },
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
    keepSeparateRepairs: options["keep-separate-repairs"],
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
 * Makes the worktree, lays the fork out in it as one commit for each step on the fork's
 * base, and checks that together they give the fork's tree. The worktree then moves to
 * the release.
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
  let steps;
  try {
    const atBase = cliPackages(state.worktree);
    steps = layOut(state.worktree, differences);
    for (const step of steps) {
      step.files = filesOf(step.replay);
      step.edits = step.files.filter(
        (path) =>
          git(["cat-file", "-e", `${state.base.commit}:${path}`], { allowFailure: true }).status ===
          0,
      );
      markPending(step);
    }
    if (treeOf(HEAD(state.worktree)) !== treeOf(state.fork.tip)) {
      throw new Stop(
        "The fork, laid out on its upstream base one commit for each step, does not give the fork's own tree.",
      );
    }
    // The steps' commits are kept reachable until the process ends.
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
  state.steps = steps;
  state.changes = releaseChanges(state.base.commit, state.release.commit);
  state.gateLog = join(dirname(stateFile(state.worktree)), "gates.log");
}

/** The command line this process was run with, as the owner can run it again, plus `flag`. */
function rerunCommand(flag) {
  const script = relative(process.cwd(), process.argv[1]) || process.argv[1];
  const args = process.argv.slice(2);
  if (flag && !args.includes(flag)) args.push(flag);
  return ["node", script, ...args].map(shellWord).join(" ");
}

/** The commands that clear an attempt away and bring the release in from the start. */
function startAgainCommand(worktree, intakeBranch) {
  return (
    `git worktree remove --force ${shellWord(worktree)} && ` +
    `git branch -D ${shellWord(intakeBranch)} && ${rerunCommand()}`
  );
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
        `Start again from the fork as it now is: ${startAgainCommand(state.worktree, saved.intakeBranch)}`,
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
  const commits = lines(
    git(["rev-list", "--reverse", "--first-parent", `${saved.release.commit}..HEAD`], {
      cwd: state.worktree,
    }),
  );
  // A stopped pick counts as reached even if Git did not write its commit. A commit
  // past the reached steps would be mistaken for the next step.
  const reached = saved.steps.filter((step) => step.status !== "pending").length;
  if (commits.length > reached) {
    throw new Refusal(
      `${saved.intakeBranch} holds ${commits.length - reached} commit(s) past the step that ` +
        "stopped. Each step is one commit, so fold the rework into that step's commit " +
        "(git reset --soft HEAD~1, then git commit --amend), then run this again.",
    );
  }
  Object.assign(state, saved, {
    gates: state.gates,
    keepSeparateRepairs: state.keepSeparateRepairs,
    outcome: "running",
    checkout: undefined,
    stopReason: undefined,
    notMovedBecause: undefined,
  });
  state.steps.forEach((step, index) => {
    if (index >= commits.length) return markPending(step);
    if (step.status === "passed" && step.commit === commits[index]) return;
    if (step.commit !== commits[index] && step.status !== "pending") step.reworked = true;
    Object.assign(step, { status: "replayed", commit: commits[index], proof: undefined });
  });
}

function stopAt(state, reason) {
  state.outcome = "stopped";
  state.stopReason = reason;
}

/** The upstream files a step edits whose changes the release already makes. */
function providedByRelease(state, step) {
  const byPath = new Map(state.changes.map((change) => [change.from, change]));
  const changedNow = new Set(filesOf(step.commit));
  return step.edits.filter((path) => {
    const change = byPath.get(path);
    return change?.status !== "D" && !changedNow.has(change?.to ?? path);
  });
}

/**
 * Replays each step not yet on the release and gates each one not yet proven, in the
 * fork's order, stopping at the first that conflicts or fails.
 */
function replay(state) {
  save(state);
  for (const step of state.steps) {
    if (step.status === "passed") continue;
    process.stderr.write(`${stepName(step)}\n`);
    if (step.status === "pending") {
      const picked = cherryPick(state.worktree, step.replay);
      if (!picked.ok) {
        const { conflicts, diagnostic } = picked;
        if (conflicts.length > 0) {
          Object.assign(step, { status: "conflicted", conflicts });
          return stopAt(
            state,
            `It does not replay onto the release: ${listed(conflicts.map(code))} conflict.`,
          );
        }
        // 签名失败时 Git 可能已暂存改动但未提交。记录该步骤以接纳手动完成的提交。
        step.status = "pick-failed";
        const recovery = cherryPickInProgress(state.worktree)
          ? "Fix the Git error and finish the pick with `git cherry-pick --continue`."
          : "Fix the Git error, then run the release command again to retry the pick.";
        const gitOutput = diagnostic.replace(/^/gm, "    ");
        return stopAt(state, `Git could not replay it. ${recovery}\n\n${gitOutput}`);
      }
      step.commit = HEAD(state.worktree);
    }
    step.empty = treeOf(step.commit) === treeOf(`${step.commit}^`);
    step.provided = providedByRelease(state, step);
    const atTop = step.commit === HEAD(state.worktree);
    if (!atTop) git(["checkout", "--quiet", "--detach", step.commit], { cwd: state.worktree });
    step.proof = runGates(state.worktree, state.gates, state.gateLog);
    // What passed must be what the commit holds, not files the gates changed beside it.
    // Those files are named in the account and cleared away, so that the step can be
    // gated again once it is reworked.
    step.proof.leftChanges = uncommitted(state.worktree);
    if (step.proof.leftChanges.length > 0) {
      git(["checkout", "--quiet", "--", "."], { cwd: state.worktree });
      git(["clean", "--quiet", "--force", "-d"], { cwd: state.worktree });
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

/**
 * Moves the fork's branch to the replay, unless it has moved meanwhile. Where the branch
 * is checked out, its checkout moves with it, keeping changes no commit holds where the
 * release leaves their files alone; where it cannot, the fork waits for the owner.
 */
async function moveFork(state) {
  const forkRef = `refs/heads/${state.fork.branch}`;
  const finishCommand = rerunCommand();
  // The fork moves only when it is one commit for each difference, unless the owner says.
  if (state.steps.some((step) => step.follows) && !state.keepSeparateRepairs) {
    state.outcome = "ready";
    state.notMovedBecause =
      "it would not be one commit for each difference: the repairs listed under " +
      '"Not yet one commit for each difference" are commits of their own. Fold each into ' +
      "its difference's commit on the fork and start again " +
      `(${code(startAgainCommand(state.worktree, state.intakeBranch))}), or move the fork ` +
      `with them as they are: ${code(rerunCommand("--keep-separate-repairs"))}`;
    return;
  }
  const movedMeanwhile = () => {
    state.outcome = "ready";
    state.notMovedBecause =
      "it moved while the release was being brought in, so it holds commits this replay " +
      `lacks. Start again from the fork as it now is: ${code(startAgainCommand(state.worktree, state.intakeBranch))}`;
  };
  const tipChanged = () => refTip(forkRef) !== state.fork.tip;
  if (tipChanged()) return movedMeanwhile();
  const reason = `bring in upstream ${state.release.label}`;
  const moveBlocked = (diagnostic) => {
    state.outcome = "ready";
    state.notMovedBecause = `Git could not complete the move. Review the Git error, then run ${code(finishCommand)} again.`;
    process.stderr.write(`${diagnostic}\n`);
  };
  const checkout = forkCheckout(forkRef);
  if (checkout?.operation) {
    state.outcome = "ready";
    state.notMovedBecause =
      `it is checked out in ${code(checkout.path)}, where ${code(checkout.operation)} is under way. ` +
      `Finish it or abort it, then run ${code(finishCommand)} again to move ${code(state.fork.branch)}.`;
    return;
  }
  const moved = await moveReleaseRef(forkRef, state.fork.tip, state.head, reason, checkout?.path);
  if (moved.kind === "ref" && tipChanged()) return movedMeanwhile();
  if (moved.kind === "checkout") {
    const moving = new Set(lines(git(["diff", "--name-only", state.fork.tip, state.head])));
    const overwritten = uncommitted(checkout.path).filter((path) => moving.has(path));
    state.outcome = "ready";
    state.notMovedBecause =
      `it is checked out in ${code(checkout.path)}, where moving it would overwrite changes no ` +
      `commit holds to ${overwritten.length > 0 ? listed(overwritten.map(code)) : "its files"}. Put them aside with ` +
      `${code(`git -C ${shellWord(checkout.path)} stash --include-untracked`)}, then run ` +
      `${code(finishCommand)} again to move it.`;
    process.stderr.write(`${moved.diagnostic}\n`);
    return;
  }
  if (moved.kind !== "moved") return moveBlocked(moved.diagnostic);
  state.checkout = checkout?.path;
  state.outcome = "moved";
}

async function main() {
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
    if (!(error instanceof Stop || error instanceof LayoutError)) throw error;
    stopAt(state, error.message);
  }
  if (state.outcome === "running") await moveFork(state);
  if (state.outcome === "moved") {
    try {
      cleanUpReplay(state);
    } catch (error) {
      process.stderr.write(`The fork moved, but cleaning up the replay failed: ${error.message}\n`);
    }
  }
  if (state.outcome !== "moved" && existsSync(state.worktree)) save(state);
  const text = account(state);
  process.stdout.write(text);
  if (options.account) {
    try {
      writeFileSync(options.account, text);
    } catch (error) {
      process.stderr.write(`Could not write the account to ${options.account}: ${error.message}\n`);
    }
  }
  if (state.outcome === "moved") return 0;
  return state.outcome === "ready" ? 3 : 1;
}

process.exitCode = await main();
