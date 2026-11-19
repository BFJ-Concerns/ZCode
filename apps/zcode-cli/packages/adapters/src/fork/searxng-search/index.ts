export function readOwnerSearxngUrl(
  value: unknown,
  scope: "user" | "project" = "user",
): string | undefined {
  if (scope !== "user" || !value || typeof value !== "object" || !("searxngUrl" in value)) {
    return undefined;
  }
  if (typeof value.searxngUrl !== "string") return undefined;

  const url = URL.parse(value.searxngUrl);
  if (!url || !["http:", "https:"].includes(url.protocol)) return undefined;
  if (url.username || url.password || url.search || url.hash) return undefined;
  return url.href;
}
