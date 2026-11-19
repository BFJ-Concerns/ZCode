/**
 * The owner's home directory for one rung: a fresh directory holding the two files
 * the owner configures `zcode` with, and the environment that makes `zcode` use it
 * and nothing from the machine it runs on.
 *
 * Several runs may share one home, which is how the side-by-side rungs put them in
 * contention; a rung that wants isolation creates one home per run.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Environment variables a run inherits from the rung's own process. */
const INHERITED_ENVIRONMENT = /^(PATH|LANG|LC_ALL|TERM|TMPDIR)$/;

/**
 * The owner's model configuration (`~/.zcode/v2/provider_config.json`) naming one
 * provider reached with an API key over OpenAI chat completions, and the model a
 * run uses when it names none.
 *
 * @param {object} options
 * @param {string} options.baseUrl          The provider's `api.baseUrl`, e.g. a stand-in's `baseUrl`.
 * @param {string} [options.providerId]
 * @param {string[]} [options.modelIds]     Models the configuration file itself names.
 * @param {string} [options.defaultModelId] Defaults to the first of `modelIds`.
 * @param {string} [options.defaultReasoningLevel] Makes the default selection complete for the registry.
 */
export function providerConfiguration({
  baseUrl,
  providerId = "stand-in",
  modelIds = ["stand-in-model"],
  defaultModelId = modelIds[0],
  defaultReasoningLevel,
}) {
  return {
    schemaVersion: 1,
    config: {
      providerConfigRules: {
        providerRules: [
          {
            providerId,
            providerName: providerId,
            config: {
              group: "standard-personal",
              access: { type: "api-key", apiKey: "stand-in-key" },
              api: { type: "openai-chat-completions", baseUrl },
              personalModelIds: modelIds,
            },
          },
        ],
      },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
      ...(defaultModelId
        ? {
            defaultModelSelection: {
              providerId,
              modelId: defaultModelId,
              ...(defaultReasoningLevel === undefined
                ? {}
                : { options: { reasoningLevel: defaultReasoningLevel } }),
            },
          }
        : {}),
    },
  };
}

/**
 * @typedef {object} OwnerHome
 * @property {string} dir        The home directory.
 * @property {string} workspace  An empty project directory inside it, for `--cwd`.
 * @property {Record<string, string>} env  The whole environment a run in this home gets.
 * @property {() => Promise<void>} remove
 */

/**
 * @param {object} options
 * @param {unknown} options.providerConfig
 *   Written to `.zcode/v2/provider_config.json`; build it with `providerConfiguration`
 *   or write the object out when the rung is about the file's own shape.
 * @param {unknown} [options.cliConfig]  Written to `.zcode/cli/config.json`.
 * @returns {Promise<OwnerHome>}
 */
export async function createOwnerHome({ providerConfig, cliConfig = {} }) {
  const dir = await mkdtemp(join(tmpdir(), "zcode-rung-home-"));
  const workspace = join(dir, "workspace");
  await Promise.all([
    mkdir(workspace),
    writeJson(join(dir, ".zcode", "v2", "provider_config.json"), providerConfig),
    writeJson(join(dir, ".zcode", "cli", "config.json"), cliConfig),
  ]);

  const env = { HOME: dir, USERPROFILE: dir, ZCODE_DATA_BASE_DIR: dir };
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && INHERITED_ENVIRONMENT.test(name)) env[name] = value;
  }

  return { dir, workspace, env, remove: () => rm(dir, { recursive: true, force: true }) };
}

async function writeJson(path, value) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
