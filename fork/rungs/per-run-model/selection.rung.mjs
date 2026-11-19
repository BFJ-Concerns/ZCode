import assert from "node:assert/strict";
import { test } from "node:test";
import { launch } from "../../harness/launcher.mjs";
import { say, startModelProvider } from "../../harness/model-provider.mjs";
import { createOwnerHome, providerConfiguration } from "../../harness/owner-home.mjs";

const listedModel = "vendor/listed-only";
const modelArgs = ["--provider", "gateway", "--model", listedModel, "--reasoning-level", "high"];

async function receivers(t, script = [say("Used the named model.")]) {
  const fallback = await startModelProvider({ script: [say("Used the owner's default.")] });
  t.after(() => fallback.close());
  const gateway = await startModelProvider({
    listing: {
      models: [
        {
          slug: listedModel,
          supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
        },
      ],
    },
    script,
  });
  t.after(() => gateway.close());
  const providerConfig = providerConfiguration({
    baseUrl: fallback.baseUrl,
    providerId: "fallback",
    modelIds: ["first-model", "owner-choice"],
    defaultModelId: "owner-choice",
    defaultReasoningLevel: "disabled",
  });
  const { providerRules } = providerConfiguration({
    baseUrl: gateway.baseUrl,
    providerId: "gateway",
    modelIds: [],
  }).config.providerConfigRules;
  providerConfig.config.providerConfigRules.providerRules.push(...providerRules);
  const home = await createOwnerHome({ providerConfig });
  t.after(() => home.remove());
  return { home, fallback, gateway };
}

async function run(t, home, args) {
  const invocation = launch({ home, prompt: "Reply to the prompt.", args });
  t.after(() => invocation.dispose());
  return await invocation.outcome;
}

test("a run names a provider and a listing-only model and sends the requested reasoning level", async (t) => {
  const { home, fallback, gateway } = await receivers(t);

  const outcome = await run(t, home, modelArgs);

  assert.equal(outcome.exitCode, 0, outcome.stderr);
  assert.equal(outcome.result.response, "Used the named model.");
  assert.equal(fallback.modelRequests().length, 0);
  const [request] = gateway.modelRequests();
  assert.equal(gateway.modelRequests().length, 1);
  assert.equal(request.body.model, listedModel);
  assert.equal(request.body.reasoning_effort, "high");

  const next = await run(t, home, []);
  assert.equal(next.exitCode, 0, next.stderr);
  assert.equal(fallback.modelRequests()[0].body.model, "owner-choice");
  assert.equal(gateway.modelRequests().length, 1, "a later run still uses the owner's default");
});

test("a resumed run uses its explicit selection in place of the saved model", async (t) => {
  const { home, fallback, gateway } = await receivers(t);
  const earlier = await run(t, home, []);
  assert.equal(earlier.exitCode, 0, earlier.stderr);

  const outcome = await run(t, home, ["--resume", earlier.result.sessionId, ...modelArgs]);

  assert.equal(outcome.exitCode, 0, outcome.stderr);
  assert.equal(outcome.result.sessionId, earlier.result.sessionId);
  assert.equal(fallback.modelRequests().length, 1);
  const [request] = gateway.modelRequests();
  assert.equal(gateway.modelRequests().length, 1);
  assert.equal(request.body.model, listedModel);
  assert.equal(request.body.reasoning_effort, "high");
  assert.match(JSON.stringify(request.body.messages), /Used the owner's default\./);
});

test("an unsupported level is refused before either provider receives a model request", async (t) => {
  const { home, fallback, gateway } = await receivers(t);

  const outcome = await run(t, home, [...modelArgs.slice(0, -1), "medium"]);

  assert.equal(outcome.exitCode, 1, outcome.stderr);
  assert.equal(outcome.result.outcome, "failed");
  assert.match(outcome.stderr, /reasoning level.*medium.*vendor\/listed-only.*gateway/i);
  assert.match(outcome.stderr, /low, high/);
  assert.equal(gateway.modelRequests().length, 0);
  assert.equal(fallback.modelRequests().length, 0);
});

test("help names the command that prints models as JSON and the per-run options", async (t) => {
  const { home } = await receivers(t);
  const help = launch({ home, command: ["help"], args: ["--locale", "en-US"] });
  t.after(() => help.dispose());

  const outcome = await help.outcome;

  assert.equal(outcome.exitCode, 0, outcome.stderr);
  assert.match(outcome.stdout, /^  models\s+.*JSON/m);
  assert.match(outcome.stdout, /--provider .*--model .*--reasoning-level /);
});

test("model options require a complete selection and a headless invocation", async (t) => {
  const { home, fallback, gateway } = await receivers(t);
  const incomplete = await run(t, home, modelArgs.slice(0, -2));
  assert.equal(incomplete.exitCode, 1);
  assert.match(incomplete.stderr, /--provider, --model and --reasoning-level together/);

  const tui = launch({ home, command: ["tui"], args: modelArgs });
  t.after(() => tui.dispose());
  const outcome = await tui.outcome;
  assert.equal(outcome.exitCode, 1);
  assert.match(outcome.stderr, /require --prompt or --target/);
  assert.equal(gateway.modelRequests().length, 0);
  assert.equal(fallback.modelRequests().length, 0);
});

test("a headless target uses the named provider, model and level", async (t) => {
  const { home, fallback, gateway } = await receivers(t, [
    say("Replied to the target."),
    say('{"passed":true,"reason":"The requested reply was sent.","nextAction":""}'),
  ]);
  const target = launch({
    home,
    command: ["--target", "Reply to the target."],
    args: ["--output-format", "stream-json", "--mode", "yolo", ...modelArgs],
  });
  t.after(() => target.dispose());

  const outcome = await target.outcome;

  assert.equal(outcome.exitCode, 0, outcome.stderr);
  assert.equal(fallback.modelRequests().length, 0);
  const requests = gateway.modelRequests();
  assert.ok(requests.length > 0);
  for (const { body } of requests) {
    assert.equal(body.model, listedModel);
    assert.equal(body.reasoning_effort, "high");
  }
});
