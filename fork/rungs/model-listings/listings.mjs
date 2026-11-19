/**
 * Model listings in the shapes the fork reads, as the stand-in provider serves them.
 */

/**
 * CLIProxyAPI's client catalogue, `GET /v1/models?client_version=cpa`, trimmed to the
 * fields that carry limits. The gateway hides image and video models from clients.
 */
export const cliProxyApiCatalogue = {
  models: [
    {
      slug: "gateway-coder",
      display_name: "gateway-coder",
      context_window: 272_000,
      max_context_window: 272_000,
      max_tokens: 64_000,
      supported_reasoning_levels: [
        { effort: "low", description: "Fast responses with lighter reasoning" },
        { effort: "medium", description: "Balances speed and reasoning depth" },
        { effort: "high", description: "Greater reasoning depth" },
        { effort: "xhigh", description: "Extra high reasoning depth" },
      ],
      default_reasoning_level: "medium",
    },
    {
      slug: "gateway-chat",
      display_name: "gateway-chat",
      context_window: 128_000,
      max_context_window: 128_000,
      max_tokens: 16_384,
      supported_reasoning_levels: [
        { effort: "none", description: "No reasoning" },
        { effort: "low", description: "Fast responses with lighter reasoning" },
      ],
      default_reasoning_level: "low",
    },
    { slug: "gateway-image", display_name: "gateway-image", visibility: "hide" },
  ],
};

/** OpenRouter's `GET /api/v1/models`, trimmed to the fields that carry limits. */
export const openRouterListing = {
  data: [
    {
      id: "vendor/reasoner",
      name: "Vendor: Reasoner",
      context_length: 400_000,
      top_provider: {
        context_length: 400_000,
        max_completion_tokens: 100_000,
        is_moderated: false,
      },
      supported_parameters: ["include_reasoning", "max_tokens", "reasoning", "tools"],
    },
    {
      id: "vendor/plain",
      name: "Vendor: Plain",
      context_length: 32_768,
      top_provider: { context_length: 32_768, max_completion_tokens: 8_192, is_moderated: true },
      supported_parameters: ["max_tokens", "temperature", "tools"],
    },
  ],
};
