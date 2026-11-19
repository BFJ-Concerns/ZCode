import { formatJson } from "@zcode/core";
import { readHeadlessRuntimeFacts, waitForHeadlessWorkflowSettle } from "../../headless-workflow.js";
import {
  SessionEventType,
  type SessionEvent,
  type TurnCompletePayload,
  type TurnErrorPayload,
} from "@zcode/contracts";

/** How a non-interactive run ended, as its result and exit status report it. */
export type RunOutcome = "finished" | "failed" | "cancelled";

/** The fields a run's closing result carries to say how it ended. */
export interface RunEndingFields {
  outcome: RunOutcome;
  /** Why the run failed; present only when it did. */
  error?: string;
}

interface WriteStream {
  write: (chunk: string) => unknown;
}

/** Which closing result the run prints, as its output options choose. */
export interface ResultFormat {
  /** `--output-format stream-json`: one `type: "result"` line. */
  streams: boolean;
  /** `--json` or `--output-format json`: one JSON object. */
  json: boolean;
}

const FINISHED_EXIT_CODE = 0;
const FAILED_EXIT_CODE = 1;
/** A cancelled run exits as the shell reports death by its signal: 128 + the signal number. */
const SIGNAL_EXIT_CODES: Partial<Record<NodeJS.Signals, number>> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};
/** A turn cancelled with no signal behind it reports as an interrupt does. */
const CANCELLED_EXIT_CODE = 130;

/** Where and how a closing result is printed, and what can still wake the model. */
export interface ClosingOutput {
  stdout: WriteStream;
  stderr: WriteStream;
  format: ResultFormat;
  sessionId?: string;
  traceId?: string;
  /** The run's runtime, whose background work can still wake the model. */
  runtime?: unknown;
  /** Aborted when the run is cancelled; the wait ends with it. */
  signal?: AbortSignal;
}

interface TurnEnding {
  turnId: string | undefined;
  outcome: RunOutcome;
  response?: string;
  error?: string;
}

/**
 * What a non-interactive run knows about how it ended, and how it says so.
 *
 * The run's last turn decides: a run finishes when its last turn completes, fails when
 * that turn fails or the run cannot start one, and is cancelled when a signal stops it,
 * whichever turn was in progress. A run whose background work woke the model several
 * times is judged by the last of those turns, not the first.
 */
export interface RunEnding {
  /** Records the signal that is stopping the run. */
  cancelledBy: (signal: NodeJS.Signals) => void;
  /** A session-event sink that remembers how each of the run's own turns ended. */
  observerFor: (sessionId: string) => (event: SessionEvent) => void;
  /** The text of each of the run's own turns that ended after `firstTurnId`, in order. */
  laterTurnResponses: (firstTurnId: string | undefined) => string[];
  /** The fields the closing result carries. */
  fields: () => RunEndingFields;
  exitCode: () => number;
  /** In text output, says on stderr how a run that did not finish ended. */
  reportInText: (stderr: WriteStream) => void;
  /**
   * Closes a run that ended in an error: records the error, waits while anything the run
   * started can still wake the model (a failed turn does not end a run whose background
   * work is still running), prints the closing result and returns the exit status.
   * Without `runtime` nothing can wake the model and the run closes at once.
   */
  closeAfterError: (cause: unknown, output: ClosingOutput) => Promise<number>;
  /**
   * Waits while anything the run started can still wake the model: a background
   * command, subagent or workflow still running, or a turn one of them queued. Has no
   * time limit; ends at once when the run is cancelled. Settles with the text of the
   * last of the run's turns that finished while it waited, if one did.
   */
  waitWhileWakeable: (runtime: unknown, signal: AbortSignal) => Promise<string | undefined>;
  /** Prints a closing result for `response` in a JSON format, and returns the exit status. */
  writeResult: (
    output: Omit<ClosingOutput, "runtime" | "signal">,
    response: string,
  ) => number;
  /**
   * Runs `cleanup` once the run has printed its result, so that a signal arriving while
   * the run is waiting does not end the process before the result says it was cancelled.
   */
  afterResult: (cleanup: () => Promise<void>) => Promise<void>;
  /** Marks the run's result as printed, or the run as past printing one. */
  resultPrinted: () => void;
}

export const createRunEnding = (): RunEnding => {
  const turns: TurnEnding[] = [];
  const printed = Promise.withResolvers<void>();
  let signal: NodeJS.Signals | undefined;
  let error: string | undefined;

  const lastTurn = (): TurnEnding | undefined => turns.at(-1);

  const fields = (): RunEndingFields => {
    if (signal) return { outcome: "cancelled" };
    if (error !== undefined) return { outcome: "failed", error };
    const last = lastTurn();
    if (!last) return { outcome: "finished" };
    return last.error === undefined
      ? { outcome: last.outcome }
      : { outcome: last.outcome, error: last.error };
  };

  const exitCode = (): number => {
    switch (fields().outcome) {
      case "finished":
        return FINISHED_EXIT_CODE;
      case "failed":
        return FAILED_EXIT_CODE;
      case "cancelled":
        return (signal && SIGNAL_EXIT_CODES[signal]) ?? CANCELLED_EXIT_CODE;
    }
  };

  const reportInText = (stderr: WriteStream): void => {
    const ending = fields();
    if (ending.outcome === "failed") stderr.write(`Error: ${ending.error ?? "the run failed"}\n`);
    if (ending.outcome === "cancelled") stderr.write(`Cancelled${signal ? ` by ${signal}` : ""}\n`);
  };

  const waitWhileWakeable = async (
    runtime: unknown,
    abortSignal: AbortSignal,
  ): Promise<string | undefined> => {
    const facts = readHeadlessRuntimeFacts(runtime);
    if (!facts || signal) return undefined;
    const endedBefore = turns.length;
    await waitForHeadlessWorkflowSettle({ runtime: facts, signal: abortSignal });
    const woken = turns.slice(endedBefore).findLast((turn) => turn.outcome === "finished");
    return woken?.response;
  };

  const writeResult = (
    output: Omit<ClosingOutput, "runtime" | "signal">,
    response: string | undefined,
  ): number => {
    const result = {
      ...(output.sessionId ? { sessionId: output.sessionId } : {}),
      ...(output.traceId ? { traceId: output.traceId } : {}),
      ...(response === undefined ? {} : { response }),
      ...fields(),
    };
    if (output.format.streams) {
      output.stdout.write(`${JSON.stringify({ type: "result", ...result })}\n`);
    } else {
      output.stdout.write(formatJson(result));
    }
    return exitCode();
  };

  return {
    cancelledBy: (stoppedBy) => {
      signal ??= stoppedBy;
    },
    observerFor: (sessionId) => (event) => {
      // The resident subscription also carries the events of subagents and workflow
      // actors; only the run's own session has turns that decide how the run ended.
      if (String(event.sessionId) !== sessionId) return;
      const ending = turnEndingOf(event);
      if (ending) turns.push(ending);
    },
    laterTurnResponses: (firstTurnId) =>
      turns
        .filter((turn) => turn.turnId !== firstTurnId && turn.outcome === "finished")
        .flatMap((turn) =>
          turn.response !== undefined && turn.response.trim().length > 0 ? [turn.response] : [],
        ),
    fields,
    exitCode,
    reportInText,
    closeAfterError: async (cause, output) => {
      // A turn that failed has already said why in its own event, and a turn its
      // background work wakes may still finish the run. Any other error is the run's own.
      if (lastTurn()?.outcome !== "failed") error ??= messageOf(cause);
      if (output.runtime !== undefined && output.signal) {
        await waitWhileWakeable(output.runtime, output.signal);
      }
      const ending = fields();
      const response = ending.outcome === "finished" ? lastTurn()?.response : undefined;
      if (output.format.streams || output.format.json) {
        return writeResult(output, response);
      }
      if (response !== undefined) output.stdout.write(`${response}\n`);
      // The caller has already reported the error it caught; say only what it has not.
      if (ending.outcome !== "failed" || ending.error !== messageOf(cause)) {
        reportInText(output.stderr);
      }
      return exitCode();
    },
    writeResult: (output, response) => writeResult(output, response),
    waitWhileWakeable,
    afterResult: async (cleanup) => {
      await printed.promise;
      await cleanup();
    },
    resultPrinted: () => printed.resolve(),
  };
};

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const turnEndingOf = (event: SessionEvent): TurnEnding | undefined => {
  const turnId = event.turnId === undefined ? undefined : String(event.turnId);
  if (event.type === SessionEventType.TurnError) {
    const { error } = event.payload as TurnErrorPayload;
    return { turnId, outcome: "failed", error: describeTurnError(error) };
  }
  if (event.type !== SessionEventType.TurnComplete) return undefined;
  const { response, resultType } = event.payload as TurnCompletePayload;
  switch (resultType) {
    case "success":
      return { turnId, outcome: "finished", response };
    case "cancelled":
      return { turnId, outcome: "cancelled", response };
    default:
      // error_max_turns, error_max_budget and the like: the turn stopped short of its work.
      return { turnId, outcome: "failed", response, error: `The turn ended with ${resultType}.` };
  }
};

const describeTurnError = (error: TurnErrorPayload["error"]): string => {
  const underlying = error.underlyingErrorMessage;
  return underlying && underlying !== error.message
    ? `${error.message} (${underlying})`
    : error.message;
};
