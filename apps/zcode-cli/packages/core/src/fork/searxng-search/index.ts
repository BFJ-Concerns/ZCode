import {
  WEB_SEARCH_BUDGET_EXHAUSTED_ERROR_CODE,
  WEBSEARCH_TOOL_CONTRACT,
  WebSearchInputSchema,
  WebSearchOutputSchema,
  ImageSearchInputSchema,
  ImageSearchOutputSchema,
  ImageSearchInputJsonSchema,
  ImageSearchOutputJsonSchema,
  type WebSearchInput,
  type WebSearchOutput,
} from "@zcode/contracts";
import { z } from "zod";
import { fitContentWithSuffix } from "../../tool/executor/result-content-projection.js";
import { formatWebSearchModelContent } from "../../tool/handlers/websearch-results.js";
import type { ToolEntry, ToolExecutionContext, ToolHandler } from "../../tool/types.js";

const SEARCH_TIMEOUT_MS = 60_000;
const MAX_RESULTS = 20;
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
      formatModelContent: formatSearxngWebSearch,
    },
    {
      ...searchContract,
      metadata: searchMetadata("ImageSearch", "Search for images and their source pages."),
      inputSchema: ImageSearchInputJsonSchema,
      outputSchema: ImageSearchOutputJsonSchema,
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
      content ? [title && title !== url.href ? `${title}: ${content}` : content] : [],
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

function formatSearxngWebSearch(value: unknown): string {
  const parsed = WebSearchOutputSchema.safeParse(value);
  if (!parsed.success) return formatWebSearchModelContent(value);

  const { summary, query } = parsed.data;
  const budget = Math.min(
    searchContract.resultBudget!.maxInlineBytes,
    searchContract.resultBudget!.maxModelBytes,
  );
  // The model needs complete link destinations. Label untitled pages without
  // repeating the URL, and keep the highest ranked links when space runs out.
  const links = parsed.data.sources.map(({ url, title }) => ({
    url,
    title: title && title !== url ? title : URL.parse(url)?.hostname,
  }));
  const render = (displayQuery: string, displaySummary?: string) =>
    formatWebSearchModelContent({
      ...parsed.data,
      query: displayQuery,
      results: [],
      sources: links,
      summary: displaySummary,
    });

  const full = render(query, summary);
  if (Buffer.byteLength(full) <= budget) return full;

  const displayQuery =
    Buffer.byteLength(query) > 1024 ? fitContentWithSuffix(query, 1024, "…", "head") : query;
  const bounded = render(displayQuery, summary);
  if (Buffer.byteLength(bounded) <= budget) return bounded;

  // Measure the upstream formatter's layout with a minimal summary. Bound the
  // summary first when the links fit, and drop whole links if they need room.
  const shortSummary =
    summary && Buffer.byteLength(summary) > 256
      ? fitContentWithSuffix(summary, 256, "…", "head")
      : summary;
  let shortest = render(displayQuery, shortSummary);
  while (Buffer.byteLength(shortest) > budget && links.length > 0) {
    links.pop();
    shortest = render(displayQuery, shortSummary);
  }
  if (!shortSummary || !summary) return shortest;
  const summaryBudget = budget - Buffer.byteLength(shortest) + Buffer.byteLength(shortSummary);
  return render(
    displayQuery,
    Buffer.byteLength(summary) > summaryBudget
      ? fitContentWithSuffix(summary, summaryBudget, "…", "head")
      : summary,
  );
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
      trace: context.traceContext ?? { traceId: context.traceId },
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
