import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { launch } from "../../harness/launcher.mjs";
import { say, startModelProvider } from "../../harness/model-provider.mjs";
import { createOwnerHome, providerConfiguration } from "../../harness/owner-home.mjs";

const invalidEndpoints = [
  ["non-string value", 42, "an absolute HTTP or HTTPS URL"],
  ["malformed URL", "not a URL", "an absolute HTTP or HTTPS URL"],
  ["unsupported scheme", "ftp://search.example/", "the HTTP or HTTPS scheme"],
  ["credentials", "https://user:fixture-password@search.example/", "credentials"],
  ["query string", "https://search.example/?token=fixture-secret", "a query string"],
  ["empty query string", "https://search.example/?", "a query string"],
  ["fragment", "https://search.example/#fragment", "a fragment"],
  ["empty fragment", "https://search.example/#", "a fragment"],
];

for (const [name, endpoint, reason] of invalidEndpoints) {
  test(`the owner search endpoint diagnostic gives the reason for rejection (${name})`, async (t) => {
    const provider = await startModelProvider({ script: [say("Done.")] });
    t.after(() => provider.close());
    const home = await createOwnerHome({
      providerConfig: providerConfiguration({ baseUrl: provider.baseUrl }),
      cliConfig: { searxngUrl: endpoint },
    });
    t.after(() => home.remove());
    home.env.ZCODE_LOG_CONSOLE = "1";

    const run = launch({ home, prompt: "Continue without search." });
    t.after(() => run.dispose());
    const outcome = await run.outcome;
    assert.equal(outcome.exitCode, 0, outcome.stderr);
    assert.equal(outcome.result?.response, "Done.");
    assert.ok(outcome.stderr.includes(reason), outcome.stderr);
    assert.doesNotMatch(outcome.stderr, /fixture-password|fixture-secret/);
    const [request] = provider.modelRequests();
    const offered = request.body.tools?.map((tool) => tool.function?.name) ?? [];
    assert.ok(offered.length > 0, "the request carries tools");
    assert.ok(
      !offered.includes("WebSearch") && !offered.includes("ImageSearch"),
      offered.join(", "),
    );

    const logDir = join(home.dir, ".zcode", "cli", "log");
    const logFiles = (await readdir(logDir)).filter((name) => name.endsWith(".jsonl"));
    const log = (
      await Promise.all(logFiles.map((name) => readFile(join(logDir, name), "utf8")))
    ).join("");
    const entries = log
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const warning = entries.find((entry) => entry.event === "config.searxng_url.skipped");
    assert.ok(warning, "the configuration log explains why search is unavailable");
    assert.equal(warning.context.configPath, join(home.dir, ".zcode", "cli", "config.json"));
    assert.equal(warning.context.diagnosticPath, "searxngUrl");
    assert.ok(warning.context.diagnosticMessage.includes(reason));
    assert.doesNotMatch(log, /fixture-password|fixture-secret/);
  });
}
