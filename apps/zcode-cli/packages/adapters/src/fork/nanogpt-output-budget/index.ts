import type { Logger } from "@zcode/contracts";
import type { JsonObject } from "@zcode/model-option-map";

/**
 * NanoGPT checks a chat request against the model's context window before it forwards
 * it: when its own count of the input plus the output the request asks for
 * (`max_completion_tokens` or `max_tokens`) exceeds the window, it refuses with
 *
 * ```json
 * { "error": { "code": "context_length_exceeded", "input_tokens": 18119,
 *   "output_tokens": 57547, "max_context_tokens": 65536, ... } }
 * ```
 *
 * The runtime sizes each request's output to the room its own estimate leaves in the
 * window, and that estimate does not count everything NanoGPT counts (the tool
 * definitions, for one), so on a model whose maximum output is close to its window a
 * request can be refused although its input fits. When the refusal says the input
 * fits and leaves room for a useful reply, the request is sent once more asking for
 * only that room. Any other refusal reaches the runtime as NanoGPT sent it, so a
 * window that is really full is compacted as usual.
 */

type ProviderFetch = typeof globalThis.fetch;

/** Room left unasked, because NanoGPT's input count is an estimate. */
export const NANOGPT_OUTPUT_MARGIN_TOKENS = 1_000;

/**
 * Below this much room the window is effectively full: the refusal stands, and the
 * runtime's compaction frees room instead of a reply being squeezed into what is left.
 */
export const NANOGPT_MIN_REFIT_OUTPUT_TOKENS = 4_096;

const OUTPUT_FIELDS = ["max_completion_tokens", "max_tokens"] as const;
type OutputField = (typeof OUTPUT_FIELDS)[number];

interface WindowRefusal {
  readonly inputTokens: number;
  readonly maxContextTokens: number;
}

export interface NanoGptOutputBudgetOptions {
  readonly logger?: Logger;
  /** Updated with the body actually sent when the request is sent again. */
  readonly capture?: { body?: JsonObject };
}

/**
 * Wraps the transport of an OpenAI chat-completions provider. Requests to other kinds
 * of provider never carry these fields or this refusal, so they are passed through.
 */
export function fitOutputToNanoGptWindow(
  fetch: ProviderFetch,
  providerKind: string,
  options: NanoGptOutputBudgetOptions = {},
): ProviderFetch {
  if (providerKind !== "openai-compatible") return fetch;
  return async (request, init) => {
    const sent = await readJsonBody(request, init);
    const response = await fetch(request instanceof Request ? request.clone() : request, init);
    if (response.status !== 400 || sent === undefined) return response;
    const asked = requestedOutput(sent);
    if (asked === undefined) return response;

    const refusal = await readWindowRefusal(response);
    if (refusal === undefined) return response;
    const room = refusal.maxContextTokens - refusal.inputTokens - NANOGPT_OUTPUT_MARGIN_TOKENS;
    if (room >= asked.tokens || room < NANOGPT_MIN_REFIT_OUTPUT_TOKENS) return response;

    await response.body?.cancel().catch(() => undefined);
    const refitted: JsonObject = { ...sent, [asked.field]: room };
    if (options.capture) options.capture.body = refitted;
    options.logger?.warn("NanoGPT refused the requested output; asking for the room it reports", {
      event: "model.request.nanogpt_output_refit",
      module: "adapters.fork.nanogpt-output-budget",
      inputTokens: refusal.inputTokens,
      maxContextTokens: refusal.maxContextTokens,
      requestedOutputTokens: asked.tokens,
      refittedOutputTokens: room,
    });
    const body = JSON.stringify(refitted);
    return request instanceof Request
      ? fetch(new Request(request, { ...init, body }))
      : fetch(request, { ...init, body });
  };
}

function requestedOutput(body: JsonObject): { field: OutputField; tokens: number } | undefined {
  for (const field of OUTPUT_FIELDS) {
    const tokens = positiveInteger(body[field]);
    if (tokens !== undefined) return { field, tokens };
  }
  return undefined;
}

async function readWindowRefusal(response: Response): Promise<WindowRefusal | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await response.clone().text());
  } catch {
    return undefined;
  }
  const error = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : undefined;
  if (error?.code !== "context_length_exceeded") return undefined;
  const inputTokens = positiveInteger(error.input_tokens);
  const maxContextTokens = positiveInteger(error.max_context_tokens);
  if (inputTokens === undefined || maxContextTokens === undefined) return undefined;
  return { inputTokens, maxContextTokens };
}

async function readJsonBody(
  request: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<JsonObject | undefined> {
  let text: string | undefined;
  if (typeof init?.body === "string") text = init.body;
  else if (init?.body == null && request instanceof Request) text = await request.clone().text();
  if (text === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? (parsed as JsonObject) : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}
