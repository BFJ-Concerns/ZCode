import {
  WEB_SEARCH_BUDGET_EXHAUSTED_ERROR_CODE,
  WEBSEARCH_TOOL_CONTRACT,
  WebSearchInputSchema,
  WebSearchOutputSchema,
  type WebSearchInput,
  type WebSearchOutput,
} from "@zcode/contracts";
import { z } from "zod";
import type { ToolEntry, ToolExecutionContext, ToolHandler } from "../../tool/types.js";

const SEARCH_TIMEOUT_MS = 60_000;
const MAX_RESULTS = 20;
const ImageSearchInputSchema = z.object({ query: z.string().min(2) }).strict();
const ImageSearchOutputSchema = z.object({
  query: z.string(),
  results: z.array(
    z.object({ url: z.string(), imageUrl: z.string(), title: z.string().optional() }),
  ),
});
const SearxngResponseSchema = z.object({ results: z.array(z.unknown()) });
const SearxngResultSchema = z.object({
  url: z.string(),
  title: z.string().nullish(),
  content: z.string().nullish(),
  img_src: z.string().nullish(),
});

export function withSearxngSearchTools(
  entries: readonly ToolEntry[],
  instance: string | undefined,
): readonly ToolEntry[] {
  if (!instance) return entries;
  return entries.flatMap((entry) =>
    entry.metadata.name === "WebFetch" ? [entry, ...createSearchTools(instance)] : [entry],
  );
}

const searchContract = {
  ...WEBSEARCH_TOOL_CONTRACT,
  permission: {
    ...WEBSEARCH_TOOL_CONTRACT.permission,
    reason: "Read-only search on the configured SearXNG instance",
  },
};

function createSearchTools(instance: string): ToolEntry[] {
  return [
    {
      ...searchContract,
      metadata: searchMetadata("WebSearch", "Search the web for pages and snippets."),
      runtimeInputSchema: WebSearchInputSchema,
      runtimeOutputSchema: WebSearchOutputSchema,
      handler: webSearchHandler(instance),
    },
    {
      ...searchContract,
      metadata: searchMetadata("ImageSearch", "Search for images and their source pages."),
      inputSchema: z.toJSONSchema(ImageSearchInputSchema),
      outputSchema: z.toJSONSchema(ImageSearchOutputSchema),
      runtimeInputSchema: ImageSearchInputSchema,
      runtimeOutputSchema: ImageSearchOutputSchema,
      handler: async (value, context) => {
        const { query } = ImageSearchInputSchema.parse(value);
        const results = await search(instance, query, "images", context);
        return {
          query,
          results: results
            .flatMap(({ url, title, img_src }) => {
              const imageUrl = img_src && httpUrl(img_src);
              return imageUrl ? [{ url: url.href, imageUrl: imageUrl.href, title }] : [];
            })
            .slice(0, MAX_RESULTS),
        };
      },
    },
  ];
}

function searchMetadata(name: string, description: string): ToolEntry["metadata"] {
  return {
    name,
    description,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: SEARCH_TIMEOUT_MS,
    maxOutputBytes: 20_000,
    sideEffectScope: "network",
    riskLevel: "low",
    needsApproval: false,
  };
}

function webSearchHandler(instance: string): ToolHandler {
  return async (value, context) => {
    const input = WebSearchInputSchema.parse(value);
    const startedAt = Date.now();
    const charge = context.webSearchBudget?.charge();
    if (charge?.kind === "exhausted") {
      return {
        result: false,
        errorCode: WEB_SEARCH_BUDGET_EXHAUSTED_ERROR_CODE,
        message: charge.message,
      };
    }

    const found = await search(instance, input.query, "general", context);
    const seen = new Set<string>();
    const matches = found
      .filter(({ url }) => {
        if (seen.has(url.href) || !matchesDomains(url.hostname, input)) return false;
        seen.add(url.href);
        return true;
      })
      .slice(0, MAX_RESULTS);
    const results = matches.map(({ url, title }) => ({ url: url.href, title }));
    const snippets = matches.flatMap(({ url, title, content }) =>
      content ? [`${title ?? url.href}: ${content}`] : [],
    );
    return {
      query: input.query,
      results,
      sources: results,
      ...(snippets.length > 0 ? { summary: snippets.join("\n\n") } : {}),
      durationMs: Math.max(0, Date.now() - startedAt),
    } satisfies WebSearchOutput;
  };
}

function matchesDomains(hostname: string, input: WebSearchInput): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const matches = (domain: string) => {
    const normalized = domain.trim().toLowerCase().replace(/\.$/, "");
    return host === normalized || host.endsWith(`.${normalized}`);
  };
  return (
    (!input.allowed_domains?.length || input.allowed_domains.some(matches)) &&
    !input.blocked_domains?.some(matches)
  );
}

async function search(
  instance: string,
  query: string,
  category: "general" | "images",
  context: ToolExecutionContext,
) {
  if (!context.httpClientPort) throw new Error("Search requires an HTTP client.");

  const url = new URL(instance);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/search`;
  url.search = new URLSearchParams({ q: query, format: "json", categories: category }).toString();
  // The destination comes from the owner's configuration and may be on a private network.
  const response = await context.httpClientPort.request(
    {
      url: url.href,
      headers: { accept: "application/json" },
      redirect: "manual",
      timeoutMs: SEARCH_TIMEOUT_MS,
      maxResponseBytes: 2 * 1024 * 1024,
    },
    { signal: context.abortSignal },
  );
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`SearXNG returned HTTP ${response.status} for the JSON search request.`);
  }

  const body = SearxngResponseSchema.parse(JSON.parse(new TextDecoder().decode(response.body)));
  return body.results.flatMap((value) => {
    const parsed = SearxngResultSchema.safeParse(value);
    if (!parsed.success) return [];
    const resultUrl = httpUrl(parsed.data.url);
    if (!resultUrl) return [];
    return [
      {
        url: resultUrl,
        title: parsed.data.title?.slice(0, 250),
        content: parsed.data.content?.slice(0, 500),
        img_src: parsed.data.img_src,
      },
    ];
  });
}

function httpUrl(value: string): URL | undefined {
  const url = URL.parse(value);
  return url && ["http:", "https:"].includes(url.protocol) ? url : undefined;
}
