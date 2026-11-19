/**
 * `zcode models`: prints every model the fork can use as JSON, each with the context
 * window, maximum output and reasoning levels a run against it will hold, and what
 * reading each configured provider's model listing came to.
 */

import { readModelListingReport, type ModelListingResult } from "@zcode/provider-node";
import type { RunContext } from "@zcode/shared-types";
import { loadBootstrapModule } from "../../bootstrap-loader.js";
import type { RunDependencies } from "../../cli-types.js";

const MODELS_COMMAND_USAGE = "Usage: zcode models";

export interface UsableModel {
  readonly provider: string;
  readonly model: string;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly reasoningLevels: readonly string[];
}

export type ListingOutcome =
  | { readonly provider: string; readonly status: "read"; readonly models: number }
  | { readonly provider: string; readonly status: "failed"; readonly reason: string };

export async function runModelsCommand(
  ctx: RunContext,
  deps: RunDependencies,
  args: readonly string[],
): Promise<number> {
  if (args.length > 0) {
    ctx.stderr.write(`${MODELS_COMMAND_USAGE}\n`);
    return 1;
  }
  const startRegistry =
    deps.startProcessProviderRegistryRuntime ??
    (await loadBootstrapModule()).startProcessProviderRegistryRuntime;
  // The same provider registry a run starts with, so the command prints what a run holds.
  const registry = await startRegistry(
    deps.env ?? process.env,
    deps.skipUserConfig
      ? {}
      : {
          standalone: deps.userConfigPath
            ? { legacyCliUserConfigFilePath: deps.userConfigPath }
            : {},
        },
  );
  try {
    const snapshot = registry.runtime.registryService.getSnapshot() ?? registry.snapshot;
    const models = snapshot.registry.providers.flatMap((provider) =>
      provider.models.map(
        ({ modelId, config }): UsableModel => ({
          provider: provider.providerId,
          model: modelId,
          contextWindow: config.properties.contextWindow,
          maxOutputTokens: config.optionSpecs.maxOutputTokens.max,
          reasoningLevels: [...config.optionSpecs.reasoningLevel.values],
        }),
      ),
    );
    const listings = readModelListingReport(snapshot.config).map(listingOutcome);
    ctx.stdout.write(`${JSON.stringify({ models, listings }, null, 2)}\n`);
    return 0;
  } finally {
    registry.dispose();
  }
}

function listingOutcome(result: ModelListingResult): ListingOutcome {
  return result.status === "read"
    ? { provider: result.providerId, status: "read", models: result.models.length }
    : { provider: result.providerId, status: "failed", reason: result.reason };
}
