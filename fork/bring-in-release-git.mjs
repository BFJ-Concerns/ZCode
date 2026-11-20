import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";

export const run = (command, args, options = {}) =>
  spawnSync(command, args, { encoding: "utf8", maxBuffer: 1 << 28, ...options });

export function git(args, { cwd = process.cwd(), allowFailure = false } = {}) {
  const result = run("git", args, { cwd });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`git ${args.join(" ")} failed:\n${result.stderr.trim()}`);
  }
  return allowFailure ? result : result.stdout.trimEnd();
}

const gitDiagnostic = (result) =>
  result.stderr?.trim() ||
  result.stdout?.trim() ||
  result.error?.message ||
  (result.signal
    ? `Git was stopped by ${result.signal}.`
    : `Git exited with status ${result.status}.`);

export function cherryPick(cwd, commit, { sign = true } = {}) {
  // --keep-redundant-commits is --empty=keep under the name Git before 2.45 knows.
  const args = ["cherry-pick", "--allow-empty", "--keep-redundant-commits"];
  if (!sign) args.push("--no-gpg-sign");
  const result = git([...args, commit], { cwd, allowFailure: true });
  if (result.status === 0) return { ok: true };
  const unmerged = git(["diff", "--name-only", "--diff-filter=U"], { cwd, allowFailure: true });
  const conflicts = unmerged.status === 0 ? unmerged.stdout.split("\n").filter(Boolean) : [];
  return { ok: false, conflicts, diagnostic: gitDiagnostic(result) };
}

/** Previews a cherry-pick with Git's merge engine, without touching the index or checkout. */
export function previewPick(parent, commit) {
  const args = [
    "merge-tree",
    "--write-tree",
    "--name-only",
    "--no-messages",
    "-z",
    `--merge-base=${commit}^`,
    parent,
    commit,
  ];
  const result = git(args, { allowFailure: true });
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`Git could not preview the pick of ${commit}: ${gitDiagnostic(result)}`);
  }
  const [tree, ...paths] = result.stdout.split("\0");
  return { tree, conflicts: paths.filter(Boolean) };
}

const records = (text) => text.split("\0").filter(Boolean);

/** The release's changes since the fork's base, by path at the base and at the release. */
export function releaseChanges(base, release) {
  const changes = [];
  const entries = records(git(["diff", "--name-status", "-z", "-M", base, release]));
  for (let i = 0; i < entries.length; ) {
    const status = entries[i++][0];
    const from = entries[i++];
    const to = status === "R" || status === "C" ? entries[i++] : from;
    changes.push({ status, from, to });
  }
  return changes;
}

export const pathsBetween = (from, to) =>
  records(git(["diff", "--name-only", "--no-renames", "-z", from, to]));
export const filesOf = (commit) => pathsBetween(`${commit}^`, commit);

function blobAt(ref, path) {
  const result = git(["rev-parse", "--verify", "--quiet", `${ref}:${path}`], {
    allowFailure: true,
  });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/** The old and new line ranges Git changed between two text blobs. */
function changedLines(from, to) {
  const diff = git([
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--unified=0",
    from,
    to,
  ]);
  const ranges = [...diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)];
  return ranges.map(([, oldStart, oldCount, newStart, newCount]) => ({
    oldStart: Number(oldStart),
    oldCount: Number(oldCount ?? 1),
    newStart: Number(newStart),
    newCount: Number(newCount ?? 1),
  }));
}

/**
 * Adjacent joins can conflict in a preview even when the insertion is already present.
 * Compare the original inserted lines to the candidate using Git's line alignment.
 */
function retainsInsertions(step, path, target, targetPath) {
  const before = blobAt(`${step.replay}^`, path);
  const after = blobAt(step.replay, path);
  const candidate = blobAt(target, targetPath);
  if (!before || !after || !candidate) return false;
  const insertions = changedLines(before, after);
  if (insertions.length === 0 || insertions.some(({ oldCount }) => oldCount !== 0)) return false;
  if (after === candidate) return true;
  const changes = changedLines(after, candidate);
  if (changes.length === 0) return false;
  const unchanged = (start, end) =>
    changes.every(({ oldStart, oldCount }) =>
      oldCount === 0
        ? oldStart < start || oldStart >= end
        : oldStart + oldCount <= start || oldStart > end,
    );
  const text = git(["cat-file", "blob", after], { allowFailure: true }).stdout;
  const lineCount = text.split("\n").length - Number(text.endsWith("\n"));
  // Keep at least one adjacent line aligned with each insertion so a matching
  // snippet elsewhere in the file does not by itself count as upstream adoption.
  return insertions.every(({ newStart, newCount }) => {
    const end = newStart + newCount - 1;
    return (
      (newStart > 1 && unchanged(newStart - 1, end)) ||
      (end < lineCount && unchanged(newStart, end + 1))
    );
  });
}

/** Traces missing edits to the release itself or to rework along the replay. */
export function omittedEdits(release, changes, step, earlierSteps) {
  const changed = new Set(filesOf(step.commit));
  const renamed = new Map(
    changes.filter((change) => change.status === "R").map(({ from, to }) => [from, to]),
  );
  const destination = (path) => renamed.get(path) ?? path;
  const missing = new Set(
    step.files.filter((path) => !changed.has(path) && !changed.has(destination(path))),
  );

  // A clean no-op on the candidate tree proves it already supplies the edit.
  // For adjacent insertions, the line comparison can establish this even if Git's
  // merge would conflict because the candidate lacks neighbouring fork lines.
  const previews = new Map();
  const supplies = (target, path) => {
    if (!previews.has(target)) {
      const { tree, conflicts } = previewPick(target, step.replay);
      previews.set(target, new Set([...conflicts, ...pathsBetween(target, tree)]));
    }
    const outstanding = previews.get(target);
    const targetPath = destination(path);
    return (
      (!outstanding.has(path) && !outstanding.has(targetPath)) ||
      retainsInsertions(step, path, target, targetPath)
    );
  };

  const releasePaths = new Set(changes.flatMap(({ from, to }) => [from, to]));
  const upstream = new Set(
    [...missing].filter((path) => releasePaths.has(path) && supplies(release, path)),
  );
  const reworked = new Set(step.reworkedFiles ?? []);
  const removed = [];
  const supplied = [];
  for (const path of step.edits) {
    if (!missing.has(path) || upstream.has(path)) continue;
    const targetPath = destination(path);
    if (reworked.has(path) || reworked.has(targetPath)) {
      removed.push(path);
    } else if (
      earlierSteps.some(
        (earlier) =>
          (earlier.reworkedFiles.includes(path) || earlier.reworkedFiles.includes(targetPath)) &&
          !supplies(`${earlier.commit}^`, path) &&
          supplies(earlier.commit, path),
      ) &&
      supplies(`${step.commit}^`, path)
    ) {
      supplied.push(path);
    }
  }
  return { empty: changed.size === 0, upstream, removed, supplied };
}

export class LayoutError extends Error {
  constructor(operation, diagnostic) {
    super(
      `Git could not lay out the replay while ${operation}. Fix the Git error and run the release command again.\n\n` +
        diagnostic.replace(/^/gm, "    "),
    );
  }
}

function layoutGit(cwd, args, operation) {
  const result = git(args, { cwd, allowFailure: true });
  if (result.status !== 0) throw new LayoutError(operation, gitDiagnostic(result));
  return result.stdout.trimEnd();
}

/** Reuses a commit already in position. Only conflicts defer a repair during layout. */
export function pickForLayout(cwd, commit) {
  const operation = `placing \`${commit.subject}\``;
  const head = layoutGit(cwd, ["rev-parse", "HEAD"], operation);
  if (layoutGit(cwd, ["rev-parse", `${commit.sha}^`], operation) === head) {
    layoutGit(cwd, ["checkout", "--quiet", "--detach", commit.sha], operation);
    return true;
  }
  // 布局提交只是重放的输入。签名只在新版本上的实际重放提交中执行。
  const picked = cherryPick(cwd, commit.sha, { sign: false });
  if (picked.ok) return true;
  if (picked.conflicts.length === 0) throw new LayoutError(operation, picked.diagnostic);
  layoutGit(cwd, ["cherry-pick", "--abort"], operation);
  return false;
}

/** Folds the checkout's last `count` commits into the first, with their messages. */
export function foldForLayout(cwd, count, commits) {
  if (count < 2) return;
  const operation = `folding repairs for \`${commits[0].subject}\``;
  const message = commits
    .map((commit) => layoutGit(cwd, ["log", "-1", "--format=%B", commit.sha], operation).trim())
    .join("\n\n");
  layoutGit(cwd, ["reset", "--quiet", "--soft", `HEAD~${count - 1}`], operation);
  layoutGit(
    cwd,
    [
      "commit",
      "--quiet",
      "--no-verify",
      "--no-gpg-sign",
      "--allow-empty",
      "--amend",
      "--message",
      message,
    ],
    operation,
  );
}

export const refTip = (ref) =>
  git(["rev-parse", "--verify", "--quiet", ref], { allowFailure: true }).stdout.trim();

/** Whether a pseudo-ref such as CHERRY_PICK_HEAD is set in a checkout. */
export const refIsSet = (checkout, ref) =>
  git(["rev-parse", "--verify", "--quiet", ref], { cwd: checkout, allowFailure: true }).status ===
  0;

/** The operations under way in a checkout that moving its branch would end. */
const OPERATIONS = { MERGE_HEAD: "merge", CHERRY_PICK_HEAD: "cherry-pick", REVERT_HEAD: "revert" };

export function forkCheckout(forkRef) {
  const entry = git(["worktree", "list", "--porcelain"])
    .split("\n\n")
    .find((worktree) => worktree.split("\n").includes(`branch ${forkRef}`));
  if (!entry) return undefined;
  const path = entry.split("\n")[0].replace(/^worktree /, "");
  const operation = Object.entries(OPERATIONS).find(([ref]) => refIsSet(path, ref))?.[1];
  // A failed mailbox patch can leave a clean index and no operation pseudo-ref.
  const applying = git(
    ["rev-parse", "--path-format=absolute", "--git-path", "rebase-apply/applying"],
    {
      cwd: path,
    },
  );
  return { path, operation: operation ?? (existsSync(applying) ? "git am" : undefined) };
}

/**
 * Git verifies the old tip and locks the ref before the checkout is updated. Closing
 * the transaction without committing releases the lock and leaves the ref unchanged.
 */
async function moveCheckout(checkout, forkRef, oldTip, newTip, reason) {
  const transaction = spawn("git", ["update-ref", "--stdin", "-m", reason], { cwd: checkout });
  let diagnostic = "";
  transaction.stderr.setEncoding("utf8").on("data", (text) => (diagnostic += text));
  const recordError = (error) => (diagnostic += `${error.message}\n`);
  transaction.on("error", recordError);
  transaction.stdin.on("error", recordError);
  const closed = new Promise((resolve) => transaction.once("close", resolve));
  const replies = createInterface({ input: transaction.stdout });

  let phase = "prepare";
  let status;
  transaction.stdin.write(`start\nupdate ${forkRef} ${newTip} ${oldTip}\nprepare\n`);
  try {
    for await (const reply of replies) {
      if (reply !== "prepare: ok") continue;
      const head = git(["symbolic-ref", "--quiet", "HEAD"], { cwd: checkout, allowFailure: true });
      if (head.stdout.trim() !== forkRef) {
        diagnostic += "The checkout no longer has the fork branch checked out.\n";
        break;
      }
      // read-tree updates the index and files while the transaction still owns the ref lock.
      const files = git(["read-tree", "-m", "-u", oldTip, newTip], {
        cwd: checkout,
        allowFailure: true,
      });
      if (files.status !== 0) {
        phase = "checkout";
        diagnostic += files.stderr;
        break;
      }
      phase = "commit";
      transaction.stdin.end("commit\n");
    }
  } finally {
    if (!transaction.stdin.writableEnded) transaction.stdin.end();
    status = await closed;
  }
  if (phase === "commit" && status === 0) return { kind: "moved" };
  if (phase === "commit") {
    diagnostic += "\nInspect the checkout: Git updated its files before the ref commit failed.\n";
  }
  return { kind: phase === "prepare" ? "ref" : phase, diagnostic: diagnostic.trim() };
}
export function moveReleaseRef(forkRef, oldTip, newTip, reason, checkout) {
  if (checkout) return moveCheckout(checkout, forkRef, oldTip, newTip, reason);
  const result = git(["update-ref", "-m", reason, forkRef, newTip, oldTip], { allowFailure: true });
  return result.status === 0
    ? { kind: "moved" }
    : { kind: "ref", diagnostic: result.stderr.trim() };
}

export function cleanUpReplay({ worktree, intakeBranch }) {
  git(["worktree", "remove", "--force", worktree]);
  git(["branch", "--quiet", "-D", intakeBranch]);
  git(["update-ref", "-d", `refs/bring-in/${intakeBranch}`]);
}
