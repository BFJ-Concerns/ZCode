// The main-turn event carries the model window. Project it with the usage so the
// session’s initial default does not remain in the display.
export function mainTurnContextWindow(payload: {
  readonly querySource?: unknown;
  readonly contextWindow?: unknown;
}): { readonly contextWindow?: number } {
  const { contextWindow } = payload;
  return payload.querySource === "main_turn" &&
    typeof contextWindow === "number" &&
    Number.isInteger(contextWindow) &&
    contextWindow > 0
    ? { contextWindow }
    : {};
}
