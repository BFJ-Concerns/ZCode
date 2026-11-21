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
      max_context_window: 300_000,
      max_tokens: 64_000,
      input_modalities: ["text", "image"],
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
      max_context_window: 128_000,
      max_tokens: 16_384,
      input_modalities: ["text"],
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
      context_length: 450_000,
      architecture: { input_modalities: ["text", "image", "file", "video", "audio"] },
      top_provider: {
        context_length: 400_000,
        max_completion_tokens: 100_000,
        is_moderated: false,
      },
      supported_parameters: ["include_reasoning", "max_tokens", "reasoning", "tools"],
      reasoning: { supported_efforts: ["xhigh", "high", "low", "minimal", "none"] },
    },
    { id: "openai/gpt-6-astra", supported_parameters: ["reasoning"] },
    { id: "openai/gpt-5.4", supported_parameters: ["reasoning"] },
    {
      id: "vendor/plain",
      name: "Vendor: Plain",
      context_length: 32_768,
      top_provider: { max_completion_tokens: 8_192, is_moderated: true },
      supported_parameters: ["max_tokens", "temperature", "tools"],
    },
  ],
};

/** NanoGPT gives only IDs unless the detailed catalogue is requested. */
export function nanoGptListing(url) {
  if (url.searchParams.get("detailed") !== "true") {
    return { data: [{ id: "nano-vision" }, { id: "nano-text" }] };
  }
  return {
    data: [
      {
        id: "nano-vision",
        context_length: 900_000,
        max_output_tokens: 180_000,
        reasoning_efforts: ["none", "low", "high", "max"],
        architecture: { input_modalities: ["text", "image", "video", "audio"] },
        capabilities: {
          vision: true,
          video_input: true,
          audio_input: true,
          pdf_upload: true,
          reasoning: true,
        },
      },
      {
        id: "nano-text",
        context_length: 80_000,
        max_output_tokens: 12_000,
        architecture: { input_modalities: ["text"] },
        capabilities: { vision: false, reasoning: false },
      },
      { id: "TEE/paused", available: false },
    ],
  };
}
