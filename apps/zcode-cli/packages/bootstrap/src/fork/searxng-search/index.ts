import type { McpServerConfig } from "@zcode/contracts";

export function withoutBundledImageSearch(
  servers: Record<string, McpServerConfig> = {},
): Record<string, McpServerConfig> {
  return Object.fromEntries(
    Object.entries(servers).filter(
      ([name, server]) =>
        name !== "plugin:image-search:image_search" || server.source?.kind !== "builtin",
    ),
  );
}
