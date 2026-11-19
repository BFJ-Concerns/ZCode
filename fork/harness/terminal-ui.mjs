/**
 * Drives the built `zcode` terminal UI as its owner uses it: in a terminal of its own,
 * typing a prompt, reading what the screen shows, and leaving with Ctrl-C twice.
 *
 * The terminal is a pseudo-terminal from util-linux's `script`, which the sandbox
 * already requires (its `unshare` and `mount` come from the same package). What the UI
 * draws is played onto a grid of characters the size of that terminal, so a rung waits
 * for words to be on the screen. Reading the drawing as a stream would not do: the UI
 * redraws only the cells that change, so text it draws a second time arrives in pieces.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { ZCODE_ENTRY } from "./launcher.mjs";
import { requireSandbox } from "./network-sandbox.mjs";

const COLUMNS = 120;
const ROWS = 40;
const ENTER = "\r";
const CTRL_C = "\x03";
/** The input's placeholder: once the UI shows it, it is reading what is typed. */
const READY_TEXT = "Type a prompt";
const KILL_SIGNAL = "SIGKILL";

/**
 * OpenTUI, which draws the terminal UI, uses `node:ffi` when Node has it, and that
 * backend cannot yet pass the `usize` values the renderer needs: on Node 26 the UI
 * stops at start-up with "Node FFI backend does not support usize until (yet)".
 * Without `node:ffi` OpenTUI uses its Node 22 backend, the one it uses on the Node
 * that `mise.toml` pins, which has no `node:ffi` to turn off.
 */
const NODE_FLAGS = process.allowedNodeEnvironmentFlags.has("--no-experimental-ffi")
  ? ["--no-experimental-ffi"]
  : [];

/**
 * @typedef {object} TerminalUiExit
 * @property {number | null} exitCode
 * @property {NodeJS.Signals | null} signal
 * @property {string} screen   The screen as the UI left it.
 *
 * @typedef {object} TerminalUi
 * @property {() => string} screen   The screen now, one line per row.
 * @property {(text: string) => Promise<void>} shows
 *   Settles once `text` is on the screen. Rejects if the UI exits first.
 * @property {(prompt: string) => Promise<void>} submit
 *   Once the UI reads its input, types the prompt, waits for it to be on the screen,
 *   and presses Enter.
 * @property {() => Promise<TerminalUiExit>} quit
 *   Leaves the UI with Ctrl-C twice, as the owner does, and waits for it to exit.
 * @property {() => boolean} running
 * @property {() => Promise<void>} dispose
 *   Kills the UI and everything it started. Call it when the rung is over.
 */

/**
 * @param {object} options
 * @param {import("./owner-home.mjs").OwnerHome} options.home
 * @param {string} [options.cwd]     Defaults to the home's empty workspace.
 * @param {string[]} [options.args]  Further arguments to `zcode`.
 * @returns {TerminalUi}
 */
export function openTerminalUi({ home, cwd = home.workspace, args = [] }) {
  requireSandbox();
  if (!existsSync(ZCODE_ENTRY)) {
    throw new Error(`${ZCODE_ENTRY} is not built; run \`node fork/build.mjs\` first.`);
  }

  const command = [
    `stty cols ${COLUMNS} rows ${ROWS}`,
    `exec ${[process.execPath, ...NODE_FLAGS, ZCODE_ENTRY, "--cwd", cwd, ...args].map(shellQuote).join(" ")}`,
  ].join("; ");
  // -q: no start and end banners; -f: flush as it is drawn; -e: exit as zcode exits.
  const child = spawn("script", ["-qfec", command, "/dev/null"], {
    cwd,
    // English, so that what the UI shows is the text this driver and the rungs look for.
    env: { ...home.env, TERM: "xterm-256color", LANG: "en_US.UTF-8" },
    stdio: ["pipe", "pipe", "pipe"],
    // Its own process group, so dispose() can reach what the UI started.
    detached: true,
  });

  const terminal = createScreen(ROWS, COLUMNS);
  let exited = false;
  const waiters = new Set();
  const onOutput = (chunk) => {
    terminal.play(chunk);
    const screen = terminal.text();
    for (const waiter of waiters) {
      if (!screen.includes(waiter.text)) continue;
      waiters.delete(waiter);
      waiter.resolve();
    }
  };
  child.stdout.setEncoding("utf8").on("data", onOutput);
  child.stderr.setEncoding("utf8").on("data", onOutput);

  /** @type {Promise<TerminalUiExit>} */
  const exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => {
      exited = true;
      const screen = terminal.text();
      for (const waiter of waiters) {
        waiter.reject(
          new Error(`The terminal UI exited before showing "${waiter.text}".\n${screen}`),
        );
      }
      waiters.clear();
      resolve({ exitCode, signal, screen });
    });
  });

  const shows = (text) => {
    if (terminal.text().includes(text)) return Promise.resolve();
    if (exited) return Promise.reject(new Error(`The terminal UI has exited.\n${terminal.text()}`));
    return new Promise((resolve, reject) => waiters.add({ text, resolve, reject }));
  };

  // Typing before the UI reads its input is lost: the terminal discards it when the UI
  // takes it over.
  const ready = shows(READY_TEXT);
  // Reported to whoever submits; a UI that is never typed into has nothing to report it to.
  ready.catch(() => {});

  return {
    screen: () => terminal.text(),
    shows,
    submit: async (prompt) => {
      await ready;
      child.stdin.write(prompt);
      await shows(prompt);
      child.stdin.write(ENTER);
    },
    quit: async () => {
      // The second press confirms the first if it comes within two seconds; the prompt
      // the first one sets is not always drawn, so there is nothing to wait for between.
      child.stdin.write(CTRL_C);
      child.stdin.write(CTRL_C);
      return await exit;
    },
    running: () => !exited,
    dispose: async () => {
      try {
        process.kill(-(/** @type {number} */ (child.pid)), KILL_SIGNAL);
      } catch (error) {
        // ESRCH: the whole group is already gone, which is the state dispose() wants.
        if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ESRCH") throw error;
      }
      await exit;
    },
  };
}

const shellQuote = (word) => `'${word.replaceAll("'", `'\\''`)}'`;

const ESCAPE = "\x1b";
const BELL = "\x07";

/**
 * A character grid that plays what a program writes to its terminal: cursor movement,
 * erasing, scrolling and text. Colours, modes and titles change no character, so they
 * are consumed and dropped. Every character takes one cell.
 */
function createScreen(rows, columns) {
  const blankRow = () => Array.from({ length: columns }, () => " ");
  let grid = Array.from({ length: rows }, blankRow);
  let row = 0;
  let column = 0;
  let saved = { row: 0, column: 0 };
  /** A control sequence cut off at the end of the last chunk, finished by the next. */
  let pending = "";

  const clamp = (value, size) => Math.max(0, Math.min(value, size - 1));
  const lineFeed = () => {
    if (row < rows - 1) {
      row += 1;
      return;
    }
    grid = [...grid.slice(1), blankRow()];
  };
  const put = (character) => {
    if (column >= columns) {
      column = 0;
      lineFeed();
    }
    grid[row][column] = character;
    column += 1;
  };
  const eraseInLine = (mode) => {
    const [from, to] = mode === 1 ? [0, column + 1] : mode === 2 ? [0, columns] : [column, columns];
    for (let index = from; index < Math.min(to, columns); index += 1) grid[row][index] = " ";
  };
  const eraseInDisplay = (mode) => {
    if (mode === 2 || mode === 3) {
      grid = Array.from({ length: rows }, blankRow);
      return;
    }
    const [fromRow, toRow] = mode === 1 ? [0, row] : [row + 1, rows];
    eraseInLine(mode);
    for (let index = fromRow; index < toRow; index += 1) grid[index] = blankRow();
  };

  /** Applies one CSI sequence: its parameters as written, and its final character. */
  const control = (parameters, final) => {
    if (/^[?<=>]/.test(parameters)) return; // private modes change no character
    const numbers = parameters.split(";").map((part) => Number.parseInt(part, 10));
    const [first, second] = numbers.map((number) => (Number.isNaN(number) ? undefined : number));
    const count = Math.max(1, first ?? 1);
    switch (final) {
      case "H":
      case "f":
        row = clamp((first ?? 1) - 1, rows);
        column = clamp((second ?? 1) - 1, columns);
        return;
      case "A":
        row = clamp(row - count, rows);
        return;
      case "B":
        row = clamp(row + count, rows);
        return;
      case "C":
        column = clamp(column + count, columns);
        return;
      case "D":
        column = clamp(column - count, columns);
        return;
      case "G":
        column = clamp(count - 1, columns);
        return;
      case "d":
        row = clamp(count - 1, rows);
        return;
      case "J":
        eraseInDisplay(first ?? 0);
        return;
      case "K":
        eraseInLine(first ?? 0);
        return;
      case "s":
        saved = { row, column };
        return;
      case "u":
        ({ row, column } = saved);
        return;
      default:
        // Colours (m), scroll regions (r) and the rest change no character.
        return;
    }
  };

  /** Plays `text`, and returns where a control sequence it ends in was cut off. */
  const playUntilCut = (text) => {
    let index = 0;
    while (index < text.length) {
      const character = text[index];
      if (character !== ESCAPE) {
        if (character === "\r") column = 0;
        else if (character === "\n") lineFeed();
        else if (character === "\b") column = Math.max(0, column - 1);
        else if (character === "\t")
          column = Math.min(columns - 1, (Math.floor(column / 8) + 1) * 8);
        else if (character >= " " && character !== "\x7f") put(character);
        index += 1;
        continue;
      }
      const kind = text[index + 1];
      if (kind === undefined) return index;
      if (kind === "[") {
        const sequence = /^[0-?]*[ -/]*[@-~]/.exec(text.slice(index + 2))?.[0];
        if (sequence === undefined) return index;
        control(sequence.slice(0, -1).replace(/[ -/]+$/, ""), sequence.at(-1));
        index += 2 + sequence.length;
        continue;
      }
      if (kind === "]" || kind === "P" || kind === "_") {
        // OSC, DCS and APC carry a string that BEL or ESC \ ends.
        // oxlint-disable-next-line no-control-regex -- the terminators are control characters
        const end = text.slice(index + 2).search(/\x07|\x1b\\/);
        if (end === -1) return index;
        index += 2 + end + (text[index + 2 + end] === BELL ? 1 : 2);
        continue;
      }
      if (kind === "(" || kind === ")") {
        // A character-set designation takes one more character.
        if (text[index + 2] === undefined) return index;
        index += 3;
        continue;
      }
      if (kind === "7") saved = { row, column };
      if (kind === "8") ({ row, column } = saved);
      index += 2;
    }
    return text.length;
  };

  return {
    play: (chunk) => {
      const text = pending + chunk;
      pending = text.slice(playUntilCut(text));
    },
    text: () => grid.map((cells) => cells.join("").trimEnd()).join("\n"),
  };
}
