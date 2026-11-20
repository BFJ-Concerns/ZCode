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
