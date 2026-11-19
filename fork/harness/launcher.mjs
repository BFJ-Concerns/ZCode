/**
 * Launches the built `zcode` the way Ensemble's command-line engine launches a
 * worker: the prompt as one argument, stdin closed, machine-readable output read
 * from stdout apart from stderr, the exit status read, and a signal to stop it.
 *
 * A rung starts a run, optionally waits for something the run prints or does, and
 * then reads how it ended.
 */

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { requireSandbox } from "./network-sandbox.mjs";

/** The command line and the terminal UI, as `node fork/build.mjs` leaves them. */
export const ZCODE_ENTRY = fileURLToPath(
  new URL("../../apps/zcode-cli/packages/cli/dist/zcode.cjs", import.meta.url),
);

const KILL_SIGNAL = "SIGKILL";
/** How often a live run's stdout is read, so that `event()` can see a line soon after it is printed. */
const OUTPUT_POLL_MS = 20;

/**
 * @typedef {object} RunOutcome
 * @property {number | null} exitCode   The exit status; `null` when a signal ended the process.
 * @property {NodeJS.Signals | null} signal
 * @property {string} stdout
 * @property {string} stderr
 * @property {any[]} events             Every JSON line printed on stdout, in order.
 * @property {any} result               The closing `type: "result"` line, or `undefined`.
 *
 * @typedef {object} Run
 * @property {number} pid
 * @property {() => boolean} running
 * @property {Promise<RunOutcome>} outcome
 *   Settles when the `zcode` process has exited, whatever it left running.
 * @property {(matches: (event: any) => boolean) => Promise<any>} event
 *   The first stdout line `matches` accepts, past or future. Rejects if the run
 *   exits without printing one.
 * @property {(signal?: NodeJS.Signals) => Promise<RunOutcome>} stop
 *   Sends the signal to `zcode` itself, as a launcher stopping a worker does, and
 *   waits for the exit.
 * @property {() => Promise<void>} dispose
 *   Kills the run and the process group it started. Call it when the rung is over,
 *   however it ended.
 */

/**
 * @param {object} options
 * @param {import("./owner-home.mjs").OwnerHome} options.home
 * @param {string} [options.prompt]
 * @param {string[]} [options.command]
 *   A command to run in place of a prompt, e.g. `["models"]`. It prints its own
 *   output rather than stream-json, so read `stdout` and not `events`.
 * @param {string[]} [options.args]  Further arguments, placed before the prompt or command.
 * @param {string} [options.cwd]     Defaults to the home's empty workspace.
 * @returns {Run}
 */
export function launch({ home, prompt, command, args = [], cwd = home.workspace }) {
  requireSandbox();
  if (!existsSync(ZCODE_ENTRY)) {
    throw new Error(`${ZCODE_ENTRY} is not built; run \`node fork/build.mjs\` first.`);
  }

  // Output goes to files, not pipes: a command the run leaves behind can hold a pipe
  // open long after `zcode` exits, and everything `zcode` wrote is in a file the
  // moment it exits.
  const outputDirectory = mkdtempSync(join(tmpdir(), "zcode-rung-run-"));
  const stdoutReader = fileReader(join(outputDirectory, "stdout"));
  const stderrReader = fileReader(join(outputDirectory, "stderr"));

  const child = spawn(
    process.execPath,
    command
      ? [ZCODE_ENTRY, "--cwd", cwd, "--no-color", ...args, ...command]
      : [
          ZCODE_ENTRY,
          "--cwd",
          cwd,
          "--output-format",
          "stream-json",
          "--no-color",
          ...args,
          "--prompt",
          prompt,
        ],
    {
      cwd,
      env: home.env,
      stdio: ["ignore", stdoutReader.fd, stderrReader.fd],
      // Its own process group, so dispose() can reach the commands the run started.
      detached: true,
    },
  );

  const events = [];
  const waiters = new Set();
  let stdout = "";
  let stderr = "";
  let unparsed = "";
  let exited = false;

  const readOutput = () => {
    const printed = stdoutReader.readNew();
    stdout += printed;
    stderr += stderrReader.readNew();
    const lines = (unparsed + printed).split("\n");
    unparsed = lines.pop() ?? "";
    for (const line of lines) {
      const event = parseJsonLine(line);
      if (event === undefined) continue;
      events.push(event);
      for (const waiter of waiters) {
        if (!waiter.matches(event)) continue;
        waiters.delete(waiter);
        waiter.resolve(event);
      }
    }
  };
  const poll = setInterval(readOutput, OUTPUT_POLL_MS);

  /** @type {Promise<RunOutcome>} */
  const outcome = new Promise((resolve, reject) => {
    const finish = () => {
      clearInterval(poll);
      exited = true;
      readOutput();
      stdoutReader.close();
      stderrReader.close();
    };
    // A process that could not be started reports an error and never an exit.
    child.once("error", (error) => {
      finish();
      reject(error);
    });
    child.once("exit", (exitCode, signal) => {
      finish();
      for (const waiter of waiters) {
        waiter.reject(
          new Error(`zcode exited (${exitCode ?? signal}) before the awaited output.\n${stderr}`),
        );
      }
      waiters.clear();
      resolve({
        exitCode,
        signal,
        stdout,
        stderr,
        events,
        result: events.findLast((event) => event?.type === "result"),
      });
    });
  });

  return {
    pid: /** @type {number} */ (child.pid),
    running: () => !exited,
    outcome,
    event: (matches) => {
      const seen = events.find(matches);
      if (seen !== undefined) return Promise.resolve(seen);
      if (exited) return Promise.reject(new Error("zcode has already exited."));
      return new Promise((resolve, reject) => waiters.add({ matches, resolve, reject }));
    },
    stop: (signal = "SIGTERM") => {
      child.kill(signal);
      return outcome;
    },
    dispose: async () => {
      try {
        process.kill(-(/** @type {number} */ (child.pid)), KILL_SIGNAL);
      } catch (error) {
        // ESRCH: the whole group is already gone, which is the state dispose() wants.
        if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ESRCH") throw error;
      }
      await outcome;
    },
  };
}

/** A file the child writes and this process reads as it grows. */
function fileReader(path) {
  const fd = openSync(path, "w+");
  const decoder = new StringDecoder("utf8");
  const buffer = Buffer.alloc(64 * 1024);
  let position = 0;
  return {
    fd,
    readNew: () => {
      let text = "";
      for (;;) {
        const length = readSync(fd, buffer, 0, buffer.length, position);
        if (length === 0) return text;
        position += length;
        text += decoder.write(buffer.subarray(0, length));
      }
    },
    close: () => closeSync(fd),
  };
}

function parseJsonLine(line) {
  if (line.trim() === "") return undefined;
  try {
    return JSON.parse(line);
  } catch {
    // Not every stdout line is JSON (a slash command prints text); the raw text stays in `stdout`.
    return undefined;
  }
}
