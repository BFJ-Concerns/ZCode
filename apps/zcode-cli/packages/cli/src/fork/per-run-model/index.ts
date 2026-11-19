import type { ModelSelection } from "@zcode/contracts";
import type { RunDependencies } from "../../cli-types.js";

type Registry = Awaited<
  ReturnType<NonNullable<RunDependencies["startProcessProviderRegistryRuntime"]>>
>["runtime"]["registryService"];

export const RUN_MODEL_ARGUMENTS = {
  provider: { type: "string" },
  model: { type: "string" },
  "reasoning-level": { type: "string" },
} as const;

type RunModelFlags = Partial<Record<keyof typeof RUN_MODEL_ARGUMENTS, string>>;

export function readRunModelFlags(
  flags: RunModelFlags,
  headless: boolean,
): ModelSelection | undefined {
  const { provider, model, "reasoning-level": reasoning } = flags;
  if (provider === undefined && model === undefined && reasoning === undefined) return undefined;
  if (!headless) {
    throw new Error("--provider, --model and --reasoning-level require --prompt or --target.");
  }
  const providerId = provider?.trim();
  const modelId = model?.trim();
  const reasoningLevel = reasoning?.trim();
  if (!providerId || !modelId || !reasoningLevel) {
    throw new Error(
      "Supply non-empty values for --provider, --model and --reasoning-level together.",
    );
  }
  return { providerId, modelId, options: { reasoningLevel } };
}

export function validateRunModelSelection(registry: Registry, selection: ModelSelection): void {
  const result = registry.validateSelection(selection);
  if (result.ok) return;
  switch (result.code) {
    case "provider-not-found":
      throw new Error(
        `Unknown provider "${result.providerId}". Run zcode models to list usable models.`,
      );
    case "model-not-found":
      throw new Error(
        `Unknown model "${result.modelId}" for provider "${result.providerId}". Run zcode models to list usable models.`,
      );
    case "reasoning-level-missing":
      throw new Error("--reasoning-level is required when naming a model for a run.");
    case "reasoning-level-not-supported":
      throw new Error(
        `Unsupported reasoning level "${result.reasoningLevel}" for model "${result.modelId}" from provider "${result.providerId}". Supported levels: ${result.supportedLevels.join(", ")}.`,
      );
  }
}
