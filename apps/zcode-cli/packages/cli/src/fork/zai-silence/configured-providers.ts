import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  PERSONAL_PROVIDER_CONFIG_FILE_NAME,
  ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV,
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
  ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV,
} from "@zcode/provider-node";
import { normalizeHost } from "./zai-hosts.js";

export type ProviderHosts =
  | { readonly readable: true; readonly hosts: ReadonlySet<string> }
  | { readonly readable: false; readonly reason: string };

/**
 * Where the owner's model providers are configured: the file the CLI entry points the
 * provider runtime at, or `~/.zcode/v2/provider_config.json` under the data directory.
 */
export function personalProviderConfigPath(env: NodeJS.ProcessEnv): string {
  const explicit = env[ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]?.trim();
  if (explicit) return explicit;
  const dataBaseDir = env.ZCODE_DATA_BASE_DIR?.trim() || homedir();
  return join(dataBaseDir, ".zcode", "v2", PERSONAL_PROVIDER_CONFIG_FILE_NAME);
}

/**
 * The hosts of the model providers the owner has configured, read afresh on each call so
 * that a provider added while the process runs is honoured at once. A provider the owner
 * added from one of the built-in templates, with no base URL of its own, takes the
 * template's, as the provider resolver does. The built-in providers themselves are not
 * the owner's configuration and are never counted.
 */
export function readConfiguredProviderHosts(env: NodeJS.ProcessEnv): ProviderHosts {
  const path = personalProviderConfigPath(env);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { readable: true, hosts: new Set() };
    }
    return { readable: false, reason: `${path}: ${(error as Error).message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A JSON parser diagnostic can quote a fragment of a provider key.
    return { readable: false, reason: `${path}: invalid JSON` };
  }
  const templateBaseUrls = lazily(() => readTemplateBaseUrls(env));
  const baseUrls = rulesOf(parsed, "providerRules").flatMap((rule) => {
    const own = baseUrlOf(rule);
    if (own !== undefined) return [own];
    const templateId = field(rule, "templateId");
    const inherited =
      typeof templateId === "string" ? templateBaseUrls().get(templateId) : undefined;
    return inherited === undefined ? [] : [inherited];
  });
  return { readable: true, hosts: new Set(baseUrls.flatMap(hostOf)) };
}

/**
 * The base URL of each built-in provider template, from the built-in rules the provider
 * runtime reads: the active copy the CLI entry prepared, or the copy the build carries.
 * Neither is readable before the entry has prepared them, and then no template resolves.
 */
function readTemplateBaseUrls(env: NodeJS.ProcessEnv): ReadonlyMap<string, string> {
  for (const name of [
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
    ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV,
  ]) {
    const path = env[name]?.trim();
    if (!path) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      // An unreadable copy resolves nothing; the next one may.
      continue;
    }
    return new Map(
      rulesOf(parsed, "templateRules").flatMap((rule) => {
        const templateId = field(rule, "templateId");
        const baseUrl = baseUrlOf(rule);
        return typeof templateId === "string" && baseUrl !== undefined
          ? [[templateId, baseUrl] as const]
          : [];
      }),
    );
  }
  return new Map();
}

function rulesOf(file: unknown, list: "providerRules" | "templateRules"): unknown[] {
  const rules = field(field(field(file, "config"), "providerConfigRules"), list);
  return Array.isArray(rules) ? rules : [];
}

function baseUrlOf(rule: unknown): string | undefined {
  const baseUrl = field(field(field(rule, "config"), "api"), "baseUrl");
  return typeof baseUrl === "string" ? baseUrl : undefined;
}

function lazily<Value>(read: () => Value): () => Value {
  let value: { readonly read: Value } | undefined;
  return () => (value ??= { read: read() }).read;
}

function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[name]
    : undefined;
}

function hostOf(baseUrl: string): string[] {
  try {
    return [normalizeHost(new URL(baseUrl).hostname)];
  } catch {
    // A base URL that does not parse names no host the fork could connect to.
    return [];
  }
}
