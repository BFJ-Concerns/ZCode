/**
 * The domains Z.ai (Zhipu AI) operates: its international and Chinese services, the
 * ChatGLM and CodeGeeX products whose CDNs serve ZCode's assets, and the company's own.
 * A host is Z.ai's when it is one of these or a name under one.
 */
const ZAI_DOMAINS: readonly string[] = [
  "z.ai",
  "bigmodel.cn",
  "chatglm.cn",
  "zhipuai.cn",
  "codegeex.cn",
];

/** Lower case, without a trailing dot or the brackets of an IPv6 literal. */
export function normalizeHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/u, "$1")
    .replace(/\.$/u, "");
}

export function isZaiHost(host: string): boolean {
  const name = normalizeHost(host);
  return ZAI_DOMAINS.some((domain) => name === domain || name.endsWith(`.${domain}`));
}
