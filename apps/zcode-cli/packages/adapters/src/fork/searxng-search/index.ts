import type { ConfigDiagnostic } from "../../config/schema.js";

const INVALID_SEARXNG_URL = "config_searxng_url_invalid";

export function readOwnerSearxngUrl(
  value: unknown,
  diagnostics: ConfigDiagnostic[],
  scope: "user" | "project" = "user",
): string | undefined {
  if (scope !== "user" || !value || typeof value !== "object" || !("searxngUrl" in value)) {
    return undefined;
  }

  const url = typeof value.searxngUrl === "string" ? URL.parse(value.searxngUrl) : null;
  const message = getInvalidUrlMessage(url);
  if (message) {
    diagnostics.push({
      code: INVALID_SEARXNG_URL,
      message,
      path: "searxngUrl",
      severity: "warning",
    });
    return undefined;
  }
  return url?.href;
}

function getInvalidUrlMessage(url: URL | null): string | undefined {
  if (!url) return "searxngUrl must be an absolute HTTP or HTTPS URL.";
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "searxngUrl must use the HTTP or HTTPS scheme.";
  }
  if (url.username || url.password) return "searxngUrl must omit credentials.";
  if (url.href.includes("?")) return "searxngUrl must omit a query string.";
  if (url.href.includes("#")) return "searxngUrl must omit a fragment.";
}

export function describeOwnerSearxngUrlDiagnostic(diagnostic: ConfigDiagnostic) {
  if (diagnostic.code !== INVALID_SEARXNG_URL) return undefined;
  return { message: diagnostic.message, event: "config.searxng_url.skipped" };
}
