import type { ModelSelection } from "@zcode/contracts";
import type { ZCodeAppOptions } from "../../app/types.js";

export function resolveResumedRunModel(
  options: ZCodeAppOptions,
  savedSelection: ModelSelection | undefined,
): ModelSelection | undefined {
  return options.modelSelectionMode === "cli-default"
    ? (options.runtimeConfig?.modelSelection ?? savedSelection)
    : savedSelection;
}
