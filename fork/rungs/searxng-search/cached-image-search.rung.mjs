import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { launch } from "../../harness/launcher.mjs";
import { say, startModelProvider } from "../../harness/model-provider.mjs";
import { attempts, forgetAttempts } from "../../harness/network-sandbox.mjs";
import { createOwnerHome, providerConfiguration } from "../../harness/owner-home.mjs";
import { openTerminalUi } from "../../harness/terminal-ui.mjs";

const MARKETPLACE = "zcode-plugins-official";
const RETIRED_HOST = "zcode.z.ai";
const STALE_CACHE_HOST = "cached-image-search.example";
const CONTROL_HOST = "working-plugin.example";
const ANSWER = "Both receivers are ready.";

beforeEach(forgetAttempts);

async function cachedPluginsHome(t) {
  const provider = await startModelProvider({
    script: ({ body }) => {
      // 会话标题请求可能先到，按用途响应以免用掉交互轮次的回复。
      const titleRequest = body.messages.some(
        ({ role, content }) =>
          role === "system" &&
          typeof content === "string" &&
          content.startsWith("Generate a concise title for this coding session."),
      );
      return titleRequest ? say('{"title":"Cached image search check"}') : say(ANSWER);
    },
  });
  t.after(() => provider.close());
  const home = await createOwnerHome({
    providerConfig: providerConfiguration({ baseUrl: provider.baseUrl }),
    cliConfig: {
      plugins: {
        enabledPlugins: {
          [`image-search@${MARKETPLACE}`]: true,
          [`working-plugin@${MARKETPLACE}`]: true,
        },
      },
    },
  });
  t.after(() => home.remove());
  // Pin the built-in rules locally so the unrelated refresh does not contact
  // the same origin as image search.
  home.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = fileURLToPath(
    new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
  );
  home.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = join(
    home.dir,
    ".zcode",
    "v2",
    "provider_config.json",
  );

  const storage = join(home.dir, ".zcode", "cli", "plugins");
  const plugins = {};
  for (const [name, host] of [
    ["image-search", RETIRED_HOST],
    ["working-plugin", CONTROL_HOST],
  ]) {
    const version = "0.1.1";
    const installPath = join(storage, "cache", MARKETPLACE, name, version);
    await mkdir(join(installPath, ".zcode-plugin"), { recursive: true });
    await writeFile(
      join(installPath, ".zcode-plugin", "plugin.json"),
      JSON.stringify({ name, version }),
    );
    // Leave out official auth so a leaked registration attempts a connection
    // even in a home with no Z.ai credentials.
    const server = {
      type: "http",
      url: `https://${host}/api/v1/mcp/server/image_search`,
      alwaysLoad: true,
    };
    const mcpServers = { image_search: server };
    // Exercise a stale key and endpoint override too. The fixture host lets
    // the sandbox detect leaked registration independently of Z.ai egress rules.
    if (name === "image-search") {
      mcpServers.stale_image_search = {
        ...server,
        url: `https://${STALE_CACHE_HOST}/api/v1/mcp/server/image_search`,
      };
    }
    await writeFile(join(installPath, ".mcp.json"), JSON.stringify({ mcpServers }));
    plugins[`${name}@${MARKETPLACE}`] = [{ installPath, version, scope: "user" }];
  }
  await writeFile(join(storage, "installed_plugins.json"), JSON.stringify({ version: 1, plugins }));
  return home;
}

async function assertOnlyControlReached() {
  const record = await attempts();
  assert.ok(
    record.connections.some(({ name }) => name === CONTROL_HOST),
    "the sandbox saw a connection from the other cached plugin",
  );
  for (const host of [RETIRED_HOST, STALE_CACHE_HOST]) {
    assert.ok(!record.names.includes(host), JSON.stringify(record));
    assert.ok(!record.connections.some(({ name }) => name === host), JSON.stringify(record));
  }
}

test("the command line connects other cached plugins but leaves upstream image search unreachable", async (t) => {
  const home = await cachedPluginsHome(t);
  const run = launch({ home, prompt: "Find a photo." });
  t.after(() => run.dispose());
  const outcome = await run.outcome;
  assert.equal(outcome.exitCode, 0, outcome.stderr);
  assert.equal(outcome.result?.response, ANSWER);
  await assertOnlyControlReached();
});

test("the terminal UI connects other cached plugins but leaves upstream image search unreachable", async (t) => {
  const home = await cachedPluginsHome(t);
  const ui = openTerminalUi({ home });
  t.after(() => ui.dispose());
  await ui.submit("Find a photo.");
  await ui.shows(ANSWER);
  await assertOnlyControlReached();
  assert.equal((await ui.quit()).exitCode, 0);
});
