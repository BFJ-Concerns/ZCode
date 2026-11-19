/**
 * Account-only models: a bundled agent pinned to a model of an account-only provider runs
 * on the session's model, since the fork never has such a provider. Upstream's document
 * plugins pin their visual reviewer to one.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { launch } from "../../harness/launcher.mjs";
import { callTool, say, startModelProvider } from "../../harness/model-provider.mjs";
import { createOwnerHome, providerConfiguration } from "../../harness/owner-home.mjs";

/** The visual reviewer's own instructions open with this. */
const REVIEWER_PROMPT = "You are the visual acceptance reviewer";

const isReviewerRequest = (request) =>
  JSON.stringify(request.body.messages).includes(REVIEWER_PROMPT);
const toolResultCount = (request) =>
  request.body.messages.filter((message) => message.role === "tool").length;

test("the document plugins' visual reviewer runs on the session's model", async (t) => {
  const provider = await startModelProvider({
    script: (request) => {
      if (isReviewerRequest(request)) return say("page 1: pass");
      if (toolResultCount(request) === 0) return callTool("Skill", { skill: "docx" });
      if (toolResultCount(request) === 1) {
        return callTool("Agent", {
          subagent_type: "documents:visual-judge",
          description: "Review the rendered page",
          prompt: "Judge page 1 at page-1.png.",
        });
      }
      return say("Reviewed.");
    },
  });
  t.after(() => provider.close());
  const home = await createOwnerHome({
    providerConfig: providerConfiguration({ baseUrl: provider.baseUrl }),
  });
  t.after(() => home.remove());

  const run = launch({ home, prompt: "Review the document's rendered page." });
  t.after(() => run.dispose());
  const outcome = await run.outcome;

  assert.equal(outcome.exitCode, 0, outcome.stderr);
  const reviewerRequests = provider.modelRequests().filter(isReviewerRequest);
  assert.notDeepEqual(reviewerRequests, [], "the reviewer was started");
  assert.ok(
    reviewerRequests.every((request) => request.body.model === "stand-in-model"),
    "on the session's model",
  );
  assert.ok(
    JSON.stringify(provider.modelRequests().at(-1).body.messages).includes("page 1: pass"),
    "its verdict came back to the session",
  );
});
