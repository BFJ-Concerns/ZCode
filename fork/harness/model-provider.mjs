/**
 * Stand-in model provider: an OpenAI-compatible endpoint on loopback that serves a
 * model listing, records every request it receives, and answers each model request
 * from a script.
 *
 * A rung configures this as one of the owner's providers (see owner-home.mjs), runs
 * `zcode` against it, and then reads `requests` to see what the fork actually sent.
 */

import { createServer } from "node:http";
import { noZcodeRunning, zcodeRunning } from "./zcode-processes.mjs";

const LOOPBACK = "127.0.0.1";
const SSE_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  connection: "keep-alive",
};
const SCRIPT_EXHAUSTED_STATUS = 500;

/** The model says `content` and ends its turn. */
export const say = (content, { inputTokens = 1, outputTokens = 1 } = {}) => ({
  kind: "say",
  content,
  inputTokens,
  outputTokens,
});

/** The model calls one tool; the fork runs it and sends the result in its next request. */
export const callTool = (name, args = {}) => ({ kind: "callTool", name, args });

/** The provider answers with an HTTP error instead of a model reply. */
export const fail = (status, message = "stand-in provider failure") => ({
  kind: "fail",
  status,
  message,
});

/** The provider answers with an HTTP error whose JSON body is `body`, in its own shape. */
export const refuse = (status, body) => ({ kind: "refuse", status, body });

/** The provider accepts the request and never answers it. */
export const hang = () => ({ kind: "hang" });

/**
 * @typedef {ReturnType<typeof say> | ReturnType<typeof callTool> | ReturnType<typeof fail> | ReturnType<typeof refuse> | ReturnType<typeof hang>} Reply
 *
 * @typedef {object} RecordedRequest
 * @property {string} method
 * @property {string} path     Path and query as received, e.g. `/v1/chat/completions`.
 * @property {import("node:http").IncomingHttpHeaders} headers
 * @property {any} body        Parsed JSON body, or `undefined` when there was none.
 *
 * @typedef {object} ModelProvider
 * @property {string} baseUrl                    What the owner writes as the provider's `api.baseUrl`.
 * @property {number} port
 * @property {RecordedRequest[]} requests        Every request, in arrival order.
 * @property {() => RecordedRequest[]} modelRequests   The chat-completion requests among them.
 * @property {(matches: (request: RecordedRequest) => boolean) => Promise<RecordedRequest>} request
 *   The first request `matches` accepts, past or future: how a rung waits for the fork to
 *   call. Rejects, with what the last `zcode` to end printed, once no `zcode` the
 *   harness started is running and every request it sent has arrived.
 * @property {() => Promise<void>} close
 */

/**
 * @param {object} [options]
 * @param {unknown} [options.listing]
 *   The JSON body served at `GET /v1/models`, in whichever provider's shape the rung
 *   is proving. Left out, the listing answers 404: a provider with no listing.
 *   `hang()` accepts the listing request and never answers it.
 * @param {Reply[] | ((request: RecordedRequest, index: number) => Reply)} [options.script]
 *   The reply to each model request: a list consumed in arrival order, or a function
 *   of the request for a rung whose replies depend on what the fork sent. A request
 *   that arrives after a list has run out is answered 500 and stays in `requests`,
 *   so an unexpected extra request fails the rung where it can be seen.
 *
 *   The terminal UI asks the model for a session title beside the first turn of a
 *   session, and either request can arrive first. A rung that drives the UI therefore
 *   scripts its replies with a function, answering the title request apart from the
 *   turn (see `asksForSessionTitle`), and not with a list.
 * @returns {Promise<ModelProvider>}
 */
export async function startModelProvider({ listing, script = [] } = {}) {
  /** @type {RecordedRequest[]} */
  const requests = [];
  const waiters = new Set();
  let modelRequestCount = 0;
  /** Connections still open, and what waits for them all to close. */
  const connections = new Set();
  const drainWaiters = new Set();
  const drained = () =>
    connections.size === 0
      ? Promise.resolve()
      : new Promise((resolve) => drainWaiters.add(resolve));

  const server = createServer(async (request, response) => {
    const recorded = {
      method: request.method ?? "",
      path: request.url ?? "",
      headers: request.headers,
      body: await readJsonBody(request),
    };
    requests.push(recorded);
    for (const waiter of waiters) {
      if (!waiter.matches(recorded)) continue;
      waiters.delete(waiter);
      waiter.resolve(recorded);
    }

    const { pathname } = new URL(recorded.path, `http://${LOOPBACK}`);
    if (recorded.method === "GET" && pathname === "/v1/models") {
      if (listing === undefined) return sendJson(response, 404, errorBody("no model listing"));
      if (listing?.kind === "hang") return undefined;
      return sendJson(response, 200, listing);
    }
    if (recorded.method === "POST" && pathname === "/v1/chat/completions") {
      const index = modelRequestCount;
      modelRequestCount += 1;
      const reply = typeof script === "function" ? script(recorded, index) : script[index];
      return sendReply(response, recorded, index, reply);
    }
    return sendJson(response, 404, errorBody(`stand-in provider has no ${pathname}`));
  });
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.once("close", () => {
      connections.delete(socket);
      if (connections.size > 0) return;
      for (const resolve of drainWaiters) resolve();
      drainWaiters.clear();
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK, resolve);
  });
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());

  return {
    baseUrl: `http://${LOOPBACK}:${port}/v1`,
    port,
    requests,
    modelRequests: () => requests.filter(isModelRequest),
    request: (matches) => {
      const seen = requests.find(matches);
      if (seen !== undefined) return Promise.resolve(seen);
      return new Promise((resolve, reject) => {
        const waiter = { matches, resolve };
        waiters.add(waiter);
        // A request sent just before `zcode` ended is still read once its connection closes,
        // and a `zcode` launched while this waited may yet call: then it waits on that one.
        const settled = async () => {
          for (;;) {
            const account = await noZcodeRunning();
            await drained();
            if (!zcodeRunning()) return account;
          }
        };
        settled().then((account) => {
          if (!waiters.delete(waiter)) return;
          reject(
            new Error(`zcode ended before the provider received the awaited request.\n${account}`),
          );
        });
      });
    },
    close: () =>
      new Promise((resolve) => {
        // A hung reply holds its connection open; drop them all so close() always returns.
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Whether a recorded request asks the model for a reply, as opposed to the listing. */
export const isModelRequest = (request) => request.path.endsWith("/chat/completions");

/** The instruction upstream's terminal UI opens its session title request with. */
const SESSION_TITLE_INSTRUCTION = "Generate a concise title for this coding session.";

/**
 * Whether a model request asks for the session's title rather than a turn. The title
 * is read as JSON, so a rung answers it with `say('{"title":"..."}')`.
 */
export const asksForSessionTitle = (request) =>
  isModelRequest(request) &&
  (request.body?.messages ?? []).some(
    ({ role, content }) =>
      role === "system" &&
      typeof content === "string" &&
      content.startsWith(SESSION_TITLE_INSTRUCTION),
  );

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const errorBody = (message) => ({ error: { message, type: "stand_in_error" } });

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function sendReply(response, recorded, index, reply) {
  if (reply === undefined) {
    const message = `stand-in provider script has no reply for model request ${index + 1}`;
    return sendJson(response, SCRIPT_EXHAUSTED_STATUS, errorBody(message));
  }
  if (reply.kind === "hang") return undefined;
  if (reply.kind === "fail") return sendJson(response, reply.status, errorBody(reply.message));
  if (reply.kind === "refuse") return sendJson(response, reply.status, reply.body);

  const id = `chatcmpl-standin-${index + 1}`;
  const model = recorded.body?.model ?? "stand-in";
  const delta =
    reply.kind === "say"
      ? { role: "assistant", content: reply.content }
      : {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              index: 0,
              id: `call_standin_${index + 1}`,
              type: "function",
              function: { name: reply.name, arguments: JSON.stringify(reply.args) },
            },
          ],
        };
  const finishReason = reply.kind === "say" ? "stop" : "tool_calls";
  const inputTokens = reply.kind === "say" ? reply.inputTokens : 1;
  const outputTokens = reply.kind === "say" ? reply.outputTokens : 1;
  const usage = {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
  };

  if (recorded.body?.stream !== true) {
    const { role, ...message } = delta;
    return sendJson(response, 200, {
      id,
      object: "chat.completion",
      model,
      choices: [{ index: 0, message: { role, ...message }, finish_reason: finishReason }],
      usage,
    });
  }

  const chunk = (choice, extra = {}) =>
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", model, choices: [choice], ...extra })}\n\n`;
  response.writeHead(200, SSE_HEADERS);
  response.write(chunk({ index: 0, delta, finish_reason: null }));
  response.write(chunk({ index: 0, delta: {}, finish_reason: finishReason }, { usage }));
  response.end("data: [DONE]\n\n");
  return undefined;
}
