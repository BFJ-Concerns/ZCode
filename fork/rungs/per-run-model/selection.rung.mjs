import assert from "node:assert/strict";
import { test } from "node:test";
import { launch } from "../../harness/launcher.mjs";
import { asksForSessionTitle, say, startModelProvider } from "../../harness/model-provider.mjs";
import { createOwnerHome, providerConfiguration } from "../../harness/owner-home.mjs";
import { openTerminalUi } from "../../harness/terminal-ui.mjs";

const listedModel = "vendor/listed-only";
const modelFlags = ({ provider = "gateway", model = listedModel, level = "high" } = {}) => [
  "--provider",
  provider,
  "--model",
  model,
  "--reasoning-level",
  level,
];
const modelArgs = modelFlags();

async function receivers(t, script = [say("Used the named model.")]) {
  const fallback = await startModelProvider({ script: () => say("Used the owner's default.") });
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

test("a named level from the built-in rules is sent as effort for a capability-only listing", async (t) => {
  const model = "openai/gpt-5.4";
  const gateway = await startModelProvider({
    listing: { data: [{ id: model, supported_parameters: ["reasoning"] }] },
    script: [say("Used the named level.")],
  });
  t.after(() => gateway.close());
  const providerConfig = providerConfiguration({
    baseUrl: gateway.baseUrl,
    providerId: "gateway",
    modelIds: ["owner-choice"],
  });
  const home = await createOwnerHome({ providerConfig });
  t.after(() => home.remove());

  const outcome = await run(t, home, [
    "--provider",
    "gateway",
    "--model",
    model,
    "--reasoning-level",
    "xhigh",
  ]);

  assert.equal(outcome.exitCode, 0, outcome.stderr);
  assert.equal(outcome.result.response, "Used the named level.");
  const requests = gateway.modelRequests();
  assert.equal(requests.length, 1);
  const [{ body }] = requests;
  assert.equal(body.model, model);
  assert.equal(body.reasoning_effort, "xhigh");
  assert.equal(body.thinking, undefined);
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
  assert.match(outcome.stdout, /--provider .*--model .*--reasoning-level .*interactive/);
});

test("model options require a complete selection and a session launch", async (t) => {
  const { home, fallback, gateway } = await receivers(t);
  const incomplete = await run(t, home, modelArgs.slice(0, -2));
  assert.equal(incomplete.exitCode, 1);
  assert.match(incomplete.stderr, /--provider, --model and --reasoning-level together/);

  const doctor = launch({ home, command: ["doctor"], args: modelArgs });
  t.after(() => doctor.dispose());
  const outcome = await doctor.outcome;
  assert.equal(outcome.exitCode, 1);
  assert.match(outcome.stderr, /require --prompt, --target, or tui/);
  assert.equal(gateway.modelRequests().length, 0);
  assert.equal(fallback.modelRequests().length, 0);
});

for (const { command, resume = false } of [
  { command: [] },
  { command: ["tui"] },
  { command: ["tui", "--resume"], resume: true },
]) {
  test(`interactive ${["zcode", ...command].join(" ")} uses the named model and level for its session`, async (t) => {
    const { home, fallback, gateway } = await receivers(t, (request) =>
      asksForSessionTitle(request) ? say('{"title":"Named model"}') : say("Used the named model."),
    );
    const args = [...command];
    if (resume) {
      const earlier = await run(t, home, []);
      assert.equal(earlier.exitCode, 0, earlier.stderr);
      args.push(earlier.result.sessionId);
    }
    const fallbackCount = fallback.modelRequests().length;
    const ui = openTerminalUi({ home, args: [...args, ...modelArgs] });
    t.after(() => ui.dispose());

    const prompt = "Reply from the selected model.";
    await ui.submit(prompt);
    await ui.shows("Used the named model.");
    const request = gateway
      .modelRequests()
      .find(
        (request) =>
          !asksForSessionTitle(request) && JSON.stringify(request.body.messages).includes(prompt),
      );
    assert.ok(request, "the named provider received the prompt");
    assert.equal(request.body.model, listedModel);
    assert.equal(request.body.reasoning_effort, "high");
    assert.equal(fallback.modelRequests().length, fallbackCount);
    if (resume) assert.match(JSON.stringify(request.body.messages), /Used the owner's default\./);

    const exit = await ui.quit();
    assert.equal(exit.exitCode, 0, exit.screen);
    const next = await run(t, home, []);
    assert.equal(next.exitCode, 0, next.stderr);
    assert.equal(fallback.modelRequests()[fallbackCount].body.model, "owner-choice");
  });
}

for (const { flags, error } of [
  { flags: modelFlags({ provider: "missing" }), error: 'Unknown provider "missing"' },
  { flags: modelFlags({ model: "missing" }), error: 'Unknown model "missing"' },
  { flags: modelFlags({ level: "medium" }), error: 'Unsupported reasoning level "medium"' },
  { flags: modelArgs.slice(0, -2), error: "Supply non-empty values" },
]) {
  test(`interactive startup refuses ${error.toLowerCase()}`, async (t) => {
    const { home, fallback, gateway } = await receivers(t);
    const ui = openTerminalUi({ home, args: ["tui", ...flags] });
    t.after(() => ui.dispose());

    await ui.shows(error);
    const outcome = await ui.quit();
    assert.equal(outcome.exitCode, 1, outcome.screen);
    assert.equal(gateway.modelRequests().length, 0);
    assert.equal(fallback.modelRequests().length, 0);
  });
}

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
