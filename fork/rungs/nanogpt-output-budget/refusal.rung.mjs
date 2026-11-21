import assert from "node:assert/strict";
import { test } from "node:test";
import { launch } from "../../harness/launcher.mjs";
import {
  asksForSessionTitle,
  refuse,
  say,
  startModelProvider,
} from "../../harness/model-provider.mjs";
import { createOwnerHome, providerConfiguration } from "../../harness/owner-home.mjs";
import { openTerminalUi } from "../../harness/terminal-ui.mjs";

// A model whose maximum output is its whole window, as NanoGPT lists several.
const model = "nanogpt-small-window";
const window = 65_536;
const answer = "Answered within the window.";

/**
 * A stand-in that checks each request against the window as NanoGPT does: its own
 * count of the input (`inputTokens`, more than the fork estimates, as NanoGPT's count
 * includes the tool definitions) plus the output asked for must fit, or the request
 * is refused with NanoGPT's body.
 */
function nanoGptWindow(inputTokens) {
  return (request) => {
    if (asksForSessionTitle(request)) return say('{"title":"Within the window"}');
    const asked = request.body.max_completion_tokens ?? request.body.max_tokens;
    if (inputTokens + asked <= window) return say(answer);
    return refuse(400, {
      error: {
        message:
          "Your prompt exceeds the model's context length. Please shorten the input and/or " +
          `reduce max_tokens. Estimated input tokens: ${inputTokens}. Requested output ` +
          `tokens: ${asked}. Max context tokens: ${window}.`,
        status: 400,
        type: "invalid_request_error",
        code: "context_length_exceeded",
        input_tokens: inputTokens,
        output_tokens: asked,
        max_context_tokens: window,
      },
    });
  };
}

async function nanoGptOwner(t, inputTokens) {
  const provider = await startModelProvider({
    listing: { models: [{ slug: model, context_window: window, max_tokens: window }] },
    script: nanoGptWindow(inputTokens),
  });
  t.after(() => provider.close());
  const home = await createOwnerHome({
    providerConfig: providerConfiguration({
      baseUrl: provider.baseUrl,
      providerId: "nanogpt",
      modelIds: [model],
      defaultReasoningLevel: "disabled",
    }),
  });
  t.after(() => home.remove());
  const turnRequests = () =>
    provider.modelRequests().filter((request) => !asksForSessionTitle(request));
  return { home, turnRequests };
}

async function runAgainst(t, inputTokens) {
  const { home, turnRequests } = await nanoGptOwner(t, inputTokens);
  const invocation = launch({ home, prompt: "Say something short." });
  t.after(() => invocation.dispose());
  const outcome = await invocation.outcome;
  return { outcome, requests: turnRequests() };
}

const askedOutput = ({ body }) => body.max_completion_tokens ?? body.max_tokens;

test("a request NanoGPT refuses for its output is sent again asking for the room it reports", async (t) => {
  const inputTokens = 30_000;
  const { outcome, requests } = await runAgainst(t, inputTokens);

  assert.equal(outcome.exitCode, 0, outcome.stderr);
  assert.equal(outcome.result.response, answer);
  assert.equal(requests.length, 2);
  const [refused, refitted] = requests;
  assert.ok(inputTokens + askedOutput(refused) > window, "the first request asked for too much");
  assert.equal(askedOutput(refitted), window - inputTokens - 1_000);
  assert.deepEqual(refitted.body.messages, refused.body.messages);
  assert.deepEqual(refitted.body.tools, refused.body.tools);
});

test("the terminal UI answers on a model NanoGPT refused for its output", async (t) => {
  const inputTokens = 30_000;
  const { home, turnRequests } = await nanoGptOwner(t, inputTokens);
  const ui = openTerminalUi({ home });
  t.after(() => ui.dispose());

  await ui.submit("Say something short.");
  await ui.shows(answer);
  const exit = await ui.quit();

  assert.equal(exit.exitCode, 0, exit.screen);
  // The UI may ask the model for more after the turn; the turn's own requests come first.
  const [refused, refitted] = turnRequests();
  assert.ok(inputTokens + askedOutput(refused) > window, "the first request asked for too much");
  assert.equal(askedOutput(refitted), window - inputTokens - 1_000);
  assert.deepEqual(refitted.body.messages, refused.body.messages);
});

test("a refusal that leaves no useful room reaches the run as NanoGPT sent it", async (t) => {
  for (const inputTokens of [window + 4_000, window - 3_000]) {
    await t.test(`with ${inputTokens} input tokens`, async (t) => {
      const { outcome, requests } = await runAgainst(t, inputTokens);

      assert.notEqual(outcome.exitCode, 0);
      assert.match(outcome.stderr, /context window/);
      assert.equal(requests.length, 1, "the refused request is not sent again");
    });
  }
});
