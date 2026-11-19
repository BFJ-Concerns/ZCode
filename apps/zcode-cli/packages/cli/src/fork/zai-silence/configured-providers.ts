import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  PERSONAL_PROVIDER_CONFIG_FILE_NAME,
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
 * that a provider added while the process runs is honoured at once. The built-in
 * provider rules are not the owner's configuration and are never read here.
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
  } catch (error) {
    return { readable: false, reason: `${path}: ${(error as Error).message}` };
  }
  return { readable: true, hosts: new Set(providerBaseUrls(parsed).flatMap(hostOf)) };
}

function providerBaseUrls(file: unknown): string[] {
  const rules = field(field(field(file, "config"), "providerConfigRules"), "providerRules");
  if (!Array.isArray(rules)) return [];
  return rules
    .map((rule) => field(field(field(rule, "config"), "api"), "baseUrl"))
    .filter((baseUrl): baseUrl is string => typeof baseUrl === "string");
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
