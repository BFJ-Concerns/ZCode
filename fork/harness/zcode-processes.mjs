/**
 * Every `zcode` the harness starts in a rung file, from the launcher and the terminal
 * UI driver alike, and the ending of each one together with whatever it started.
 *
 * A stand-in waiting for `zcode` to call learns from here that no `zcode` is left to
 * call it, and a home is removed only once nothing the harness started is writing
 * into it.
 */

import { readdirSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

/** How often a process that was killed is looked for again until it is gone. */
const GONE_POLL_MS = 20;

/**
 * @typedef {object} TrackedZcode
 * @property {import("./owner-home.mjs").OwnerHome} home
 * @property {Promise<unknown>} ended  Settles when the process has exited or could not start.
 * @property {() => string} account    What the process left behind to explain its ending.
 * @property {() => Promise<void>} dispose
 */

/** @type {Set<TrackedZcode>} */
const started = new Set();
/** @type {Set<TrackedZcode>} */
const running = new Set();
/** @type {Set<(account: string) => void>} */
const idleWaiters = new Set();
/** @type {string | undefined} */
let lastAccount;

/** Records a `zcode` the harness has just started. */
export function trackZcode(/** @type {TrackedZcode} */ zcode) {
  started.add(zcode);
  running.add(zcode);
  const ended = () => {
    running.delete(zcode);
    lastAccount = zcode.account();
    if (running.size > 0) return;
    for (const resolve of idleWaiters) resolve(lastAccount);
    idleWaiters.clear();
  };
  zcode.ended.then(ended, ended);
}

/**
 * Settles, with what the last `zcode` to end left behind, once no `zcode` the harness
 * started is running. Never settles before the first one is started.
 * @returns {Promise<string>}
 */
export function noZcodeRunning() {
  if (running.size === 0 && lastAccount !== undefined) return Promise.resolve(lastAccount);
  return new Promise((resolve) => idleWaiters.add(resolve));
}

/** Whether a `zcode` the harness started is running now. */
export const zcodeRunning = () => running.size > 0;

/** Ends every `zcode` started in `home`, and what each started, running or not. */
export async function endZcodeIn(/** @type {import("./owner-home.mjs").OwnerHome} */ home) {
  const inHome = [...started].filter((zcode) => zcode.home === home);
  await Promise.all(inHome.map((zcode) => zcode.dispose()));
}

/**
 * Kills `rootPid`, which was started leading a process group of its own, every process
 * descended from it, and every process in a group or session one of those leads, then
 * waits until they are all gone.
 * `zcode` runs in a session of its own under the terminal, so killing a process group
 * alone leaves it running.
 *
 * Each process is stopped before any is killed, so none can start another that
 * escapes, and a process killed before its children would leave them to be adopted
 * where its descendants can no longer be traced.
 */
export async function endProcessTree(/** @type {number} */ rootPid) {
  const stopped = new Set();
  for (;;) {
    const table = processTable();
    const members = new Set();
    const groups = new Set();
    const sessions = new Set();
    const join = (pid) => {
      members.add(pid);
      const entry = table.get(pid);
      if (entry === undefined) return;
      // A group or session that a member leads is the tree's; the rung's own are not.
      if (entry.group === pid) groups.add(pid);
      if (entry.session === pid) sessions.add(pid);
    };
    join(rootPid);
    // The root was started leading a group of its own, which outlives it while it has members.
    groups.add(rootPid);
    for (let grew = true; grew; ) {
      grew = false;
      for (const [pid, { parent, group, session }] of table) {
        if (members.has(pid)) continue;
        if (!members.has(parent) && !groups.has(group) && !sessions.has(session)) continue;
        join(pid);
        grew = true;
      }
    }
    const unstopped = [...members].filter((pid) => !stopped.has(pid) && table.has(pid));
    if (unstopped.length === 0) break;
    for (const pid of unstopped) {
      signal(pid, "SIGSTOP");
      stopped.add(pid);
    }
  }
  for (const pid of stopped) signal(pid, "SIGKILL");
  while ([...stopped].some(isAlive)) await delay(GONE_POLL_MS);
}

/** Every process this one can see: its parent, process group and session. */
function processTable() {
  const table = new Map();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const stat = readStat(Number(name));
    if (stat !== undefined && stat.state !== "Z") table.set(Number(name), stat);
  }
  return table;
}

/** A process that has exited stays a zombie until reaped; it holds nothing and counts as gone. */
const isAlive = (pid) => {
  const stat = readStat(pid);
  return stat !== undefined && stat.state !== "Z";
};

function readStat(pid) {
  let text;
  try {
    text = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    // The process has gone, which is what every caller is waiting for.
    return undefined;
  }
  // The command name is in parentheses and may hold anything; the fields follow its last `)`.
  const [state, parent, group, session] = text.slice(text.lastIndexOf(")") + 2).split(" ");
  return { state, parent: Number(parent), group: Number(group), session: Number(session) };
}

function signal(pid, name) {
  try {
    process.kill(pid, name);
  } catch (error) {
    // ESRCH: it has already gone.
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ESRCH") throw error;
  }
}
