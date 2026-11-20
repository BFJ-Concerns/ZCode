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

/** Where and how a closing result is printed, and what the run has started. */
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
  /** Detaches the run's event stream, so that nothing is written after the result. */
  stopEvents?: () => void;
}

/** Closes something the run started; a stopped run calls every one at once. */
type RunCloser = () => Promise<void> | void;

interface TurnEnding {
  outcome: RunOutcome;
  response?: string;
  error?: string;
}

/**
 * What a non-interactive run knows about how it ended, and how it says so.
 *
 * The run's last turn decides: a run finishes when its last turn completes, fails when
 * that turn fails or the run cannot start one, and is cancelled when that turn is
 * cancelled or a signal stops it, whichever turn was in progress. A run whose background
 * work woke the model several times is judged by the last of those turns, not the first.
 *
 * A run prints exactly one result, and it is the last thing the run writes on stdout:
 * whichever path claims it first detaches the event stream and prints it, and every other
 * path then prints nothing.
 */
export interface RunEnding {
  /** Records the signal that is stopping the run. */
  cancelledBy: (signal: NodeJS.Signals) => void;
  /** Whether a signal is stopping the run. */
  wasStopped: () => boolean;
  /** A session-event sink that remembers how each of the run's own turns ended. */
  observerFor: (sessionId: string) => (event: SessionEvent) => void;
  /**
   * The answer of each of the run's own turns that gave one, in the order the turns
   * ended; `[fallback]` when no turn gave one (a command answered without a model turn, or
   * one that only recorded its input) and `fallback` is not blank.
   */
  answers: (fallback: string) => string[];
  /** The fields the closing result carries. */
  fields: () => RunEndingFields;
  exitCode: () => number;
  /** In text output, says on stderr how a run that did not finish ended. */
  reportInText: (stderr: WriteStream) => void;
  /**
   * Claims the run's one result for a caller that prints it itself. True for the first
   * claim, which detaches the event stream through `stopEvents` before returning; false
   * once the result has been claimed, and the caller then prints nothing.
   */
  claimResult: (stopEvents?: () => void) => boolean;
  /**
   * Prints the run's result with `answer` as its response, unless it has already been
   * printed, and returns the exit status. In text output the answer goes to stdout and a
   * run that did not finish says so on stderr.
   */
  close: (output: ClosingOutput, answer: string | undefined) => number;
  /**
   * Closes a run that ended in an error: records the error, waits while anything the run
   * started can still wake the model (a failed turn does not end a run whose background
   * work is still running), prints the result and returns the exit status. Without
   * `runtime` nothing can wake the model and the run closes at once. Text output does not
   * repeat a failure: the caller has reported the error it caught, so only a turn woken
   * since then that failed is reported again.
   */
  closeAfterError: (cause: unknown, output: ClosingOutput) => Promise<number>;
  /**
   * Ends a run a signal stopped: prints its result at once, without waiting for the turn
   * in progress to give up, and then runs every closer together, so that the time the
   * process has left goes to closing what the run started.
   */
  closeStoppedRun: (output: ClosingOutput, closers: RunCloser[]) => Promise<void>;
  /**
   * Waits while anything the run started can still wake the model: a background
   * command, subagent or workflow still running, or a turn one of them queued. Has no
   * time limit; ends at once when the run is cancelled.
   */
  waitWhileWakeable: (runtime: unknown, signal: AbortSignal) => Promise<void>;
}

export const createRunEnding = (): RunEnding => {
  const turns: TurnEnding[] = [];
  let signal: NodeJS.Signals | undefined;
  let error: string | undefined;
  let claimed = false;

  const lastTurn = (): TurnEnding | undefined => turns.at(-1);

  const answers = (fallback: string): string[] => {
    const given = turns.flatMap((turn) =>
      turn.response !== undefined && turn.response.trim().length > 0 ? [turn.response] : [],
    );
    if (given.length > 0) return given;
    return fallback.trim().length > 0 ? [fallback] : [];
  };

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

  const claimResult = (stopEvents?: () => void): boolean => {
    if (claimed) return false;
    claimed = true;
    stopEvents?.();
    return true;
  };

  /**
   * Prints the result if it is still unclaimed. `alreadyReported` says the caller has
   * reported a failure on stderr, which text output then does not repeat.
   */
  const printResult = (
    output: ClosingOutput,
    answer: string | undefined,
    alreadyReported: boolean,
  ): number => {
    if (!claimResult(output.stopEvents)) return exitCode();
    if (output.format.streams || output.format.json) {
      const result = {
        ...(output.sessionId ? { sessionId: output.sessionId } : {}),
        ...(output.traceId ? { traceId: output.traceId } : {}),
        ...(answer === undefined ? {} : { response: answer }),
        ...fields(),
      };
      output.stdout.write(
        output.format.streams
          ? `${JSON.stringify({ type: "result", ...result })}\n`
          : formatJson(result),
      );
      return exitCode();
    }
    if (answer !== undefined) output.stdout.write(`${answer}\n`);
    if (!(alreadyReported && fields().outcome === "failed")) reportInText(output.stderr);
    return exitCode();
  };

  const lastAnswer = (fallback = ""): string | undefined => answers(fallback).at(-1);

  const waitWhileWakeable = async (runtime: unknown, abortSignal: AbortSignal): Promise<void> => {
    const facts = readHeadlessRuntimeFacts(runtime);
    if (!facts || signal) return;
    await waitForHeadlessWorkflowSettle({ runtime: facts, signal: abortSignal });
  };

  return {
    cancelledBy: (stoppedBy) => {
      signal ??= stoppedBy;
    },
    wasStopped: () => signal !== undefined,
    observerFor: (sessionId) => (event) => {
      // The resident subscription also carries the events of subagents and workflow
      // actors; only the run's own session has turns that decide how the run ended.
      if (String(event.sessionId) !== sessionId) return;
      const ending = turnEndingOf(event);
      if (ending) turns.push(ending);
    },
    answers,
    fields,
    exitCode,
    reportInText,
    claimResult,
    close: (output, answer) => printResult(output, answer, false),
    closeAfterError: async (cause, output) => {
      // A turn that failed has already said why in its own event, and a cancelled turn is
      // a cancelled run, not a failed one; a turn its background work wakes may still
      // finish the run. Any other error is the run's own.
      const last = lastTurn();
      if (last?.outcome !== "failed" && last?.outcome !== "cancelled") {
        error ??= messageOf(cause);
      }
      const endedBefore = turns.length;
      if (output.runtime !== undefined && output.signal) {
        await waitWhileWakeable(output.runtime, output.signal);
      }
      // The caller reported the failure it caught; a turn woken since then that failed is news.
      const failedSince = turns.length > endedBefore && lastTurn()?.outcome === "failed";
      return printResult(output, lastAnswer(), !failedSince);
    },
    closeStoppedRun: async (output, closers) => {
      printResult(output, lastAnswer(), false);
      await Promise.allSettled(closers.map(async (closeOne) => await closeOne()));
    },
    waitWhileWakeable,
  };
};

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const turnEndingOf = (event: SessionEvent): TurnEnding | undefined => {
  if (event.type === SessionEventType.TurnError) {
    const { error } = event.payload as TurnErrorPayload;
    return { outcome: "failed", error: describeTurnError(error) };
  }
  if (event.type !== SessionEventType.TurnComplete) return undefined;
  const { response, resultType } = event.payload as TurnCompletePayload;
  switch (resultType) {
    case "success":
      return { outcome: "finished", response };
    case "cancelled":
      return { outcome: "cancelled", response };
    default:
      // error_max_turns, error_max_budget and the like: the turn stopped short of its work.
      return { outcome: "failed", response, error: `The turn ended with ${resultType}.` };
  }
};

const describeTurnError = (error: TurnErrorPayload["error"]): string => {
  const underlying = error.underlyingErrorMessage;
  return underlying && underlying !== error.message
    ? `${error.message} (${underlying})`
    : error.message;
};
