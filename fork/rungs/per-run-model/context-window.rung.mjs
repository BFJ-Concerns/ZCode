import assert from "node:assert/strict";
import { test } from "node:test";
import { launch } from "../../harness/launcher.mjs";
import { say, startModelProvider } from "../../harness/model-provider.mjs";
import { createOwnerHome, providerConfiguration } from "../../harness/owner-home.mjs";

const model = "small-window";
const smallWindow = 24_000;
const maxOutput = 1_000;
const secondInputTokens = 12_000;
const firstReply = "The first turn recorded some older details.";
const compactedReply = "The older details were recorded; continue with the new prompt.";

async function playConversation(t, contextWindow, afterHistory) {
  const provider = await startModelProvider({
    listing: {
      models: [
        {
          slug: model,
          context_window: contextWindow,
          max_tokens: maxOutput,
          supported_reasoning_levels: [{ effort: "low" }],
        },
      ],
    },
    script: [
      say(firstReply),
      say("The second turn added another detail.", { inputTokens: secondInputTokens }),
      ...afterHistory,
    ],
  });
  t.after(() => provider.close());
  const home = await createOwnerHome({
    providerConfig: providerConfiguration({
      baseUrl: provider.baseUrl,
      modelIds: ["first-configured-model", model],
      defaultModelId: model,
      defaultReasoningLevel: "low",
    }),
  });
  t.after(() => home.remove());

  async function run(prompt, sessionId) {
    const invocation = launch({ home, prompt, args: sessionId ? ["--resume", sessionId] : [] });
    t.after(() => invocation.dispose());
    const outcome = await invocation.outcome;
    assert.equal(outcome.exitCode, 0, outcome.stderr);
    return outcome.result;
  }

  const first = await run("Keep these older details.");
  const second = await run("Keep one more detail.", first.sessionId);
  const final = await run("Use what you kept to answer.", second.sessionId);

  const requests = provider.modelRequests();
  for (const { body } of requests) {
    assert.equal(body.model, model);
    assert.equal(body.max_tokens ?? body.max_completion_tokens, maxOutput);
  }
  return { final, requests };
}

test("the listed small window triggers compaction before the stand-in reports a full window", async (t) => {
  const { final, requests } = await playConversation(t, smallWindow, [
    say(`<summary>${compactedReply}</summary>`),
    say("Answered after compaction."),
  ]);

  assert.equal(final.response, "Answered after compaction.");
  assert.equal(requests.length, 4);
  const [, , summary, continuation] = requests;
  const summaryMessages = JSON.stringify(summary.body.messages);
  assert.match(summaryMessages, /create a detailed summary of the conversation/);
  assert.ok(summaryMessages.includes(firstReply));
  const continuedMessages = JSON.stringify(continuation.body.messages);
  assert.ok(continuedMessages.includes(compactedReply));
  assert.ok(continuedMessages.includes("Use what you kept to answer."));
  assert.ok(!continuedMessages.includes(firstReply), "the summary replaces the older reply");
  const secondRequestOutputCap =
    requests[1].body.max_tokens ?? requests[1].body.max_completion_tokens;
  assert.ok(secondInputTokens + secondRequestOutputCap < smallWindow);
});

test("the same conversation fits without compaction when the listing gives a larger window", async (t) => {
  const { final, requests } = await playConversation(t, 200_000, [
    say("Answered with full history."),
  ]);

  assert.equal(final.response, "Answered with full history.");
  assert.equal(requests.length, 3);
  assert.ok(JSON.stringify(requests[2].body.messages).includes(firstReply));
});
