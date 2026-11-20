import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { extractDisallowedToolsArgs, parseGlobalArgs } from "../../arguments.js";
import { describe, type Destination } from "./connection-guard.js";

/** One JSON line per refused connection, so that the owner can see what was attempted. */
export const REFUSED_CONNECTIONS_FILE = "refused-zai-connections.jsonl";

export interface RefusalRecord {
  readonly time: string;
  readonly host: string;
  readonly port: number | null;
  readonly pid: number;
  /** What the process was running: `prompt`, `tui`, or a command such as `plugins` or `plugin-host`. */
  readonly command: string;
  /** Why the owner's provider configuration allowed nothing, when it could not be read. */
  readonly providerConfiguration?: string;
}

export function refusedConnectionsPath(env: NodeJS.ProcessEnv): string {
  const dataBaseDir = env.ZCODE_DATA_BASE_DIR?.trim() || homedir();
  return join(dataBaseDir, ".zcode", "cli", REFUSED_CONNECTIONS_FILE);
}

/**
 * Reports a refused connection twice over: a line on stderr where the owner is reading it
 * (the terminal UI keeps stderr off the screen), and a record in the data directory that
 * outlives the process, whatever surface it ran.
 */
export function reportRefusal(input: {
  readonly destination: Destination;
  readonly env: NodeJS.ProcessEnv;
  readonly argv: readonly string[];
  readonly stderr: Pick<NodeJS.WriteStream, "write">;
  readonly unreadableProviderConfiguration?: string;
}): void {
  const { destination, env } = input;
  const record: RefusalRecord = {
    time: new Date().toISOString(),
    host: destination.host,
    port: destination.port ?? null,
    pid: process.pid,
    command: commandOf(input.argv),
    ...(input.unreadableProviderConfiguration
      ? { providerConfiguration: input.unreadableProviderConfiguration }
      : {}),
  };
  const path = refusedConnectionsPath(env);
  let unrecorded = "";
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`);
  } catch (error) {
    unrecorded = ` (not recorded in ${path}: ${(error as Error).message})`;
  }
  input.stderr.write(
    `zcode: refused a connection to ${describe(destination)}, a host Z.ai operates that is not a configured model provider${unrecorded}.\n`,
  );
}

function commandOf(argv: readonly string[]): string {
  try {
    const { values, positionals } = parseGlobalArgs(extractDisallowedToolsArgs(argv).args);
    if (typeof values.prompt === "string" || typeof values.target === "string") return "prompt";
    return positionals[0] ?? "tui";
  } catch {
    // Arguments the CLI itself will reject; the record keeps the first of them.
    return argv[0] ?? "tui";
  }
}
