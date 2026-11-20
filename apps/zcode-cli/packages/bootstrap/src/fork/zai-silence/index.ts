import {
  loadMarketplaceManifestSync,
  refreshableMarketplaces,
  writeBundledOfficialMarketplacePartition,
} from "@zcode/adapters/plugins";
import type { SharedZCodeCredentialStore } from "@zcode/adapters/auth";
import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE } from "@zcode/contracts";
import type { ProviderEndpointRoutingPort } from "@zcode/contracts";
import type { ZCodePluginInstallData } from "../../plugins.js";

/** ZCode Sites publishes a project to Z.ai's hosting and works only with a Z.ai account. */
const SITE_PUBLISHING_PLUGIN = "zcode-site";

/** The bundled plugins whose files the fork changes: their setup no longer fetches fonts from Z.ai. */
const PLUGINS_THE_FORK_CHANGES: ReadonlySet<string> = new Set(["documents", "pdf", "spreadsheets"]);

/**
 * Marks the version of a plugin the fork changes. A home seeds a bundled plugin once per
 * version, so a home upstream already seeded at the same version would otherwise keep
 * serving upstream's files.
 */
const FORK_VERSION_SUFFIX = "+fork.zai-silence";

/**
 * The plugins bundled with the fork: site publishing is taken out, since nothing else
 * does its job, and each plugin the fork changes has a version of its own.
 */
export function forkBundledPlugins<
  Definition extends { readonly name: string; readonly version: string },
>(definitions: readonly Definition[]): readonly Definition[] {
  return definitions
    .filter((definition) => definition.name !== SITE_PUBLISHING_PLUGIN)
    .map((definition) =>
      PLUGINS_THE_FORK_CHANGES.has(definition.name)
        ? { ...definition, version: `${definition.version}${FORK_VERSION_SUFFIX}` }
        : definition,
    );
}

/**
 * The Z.ai account the standalone command line would sign its account-only providers in
 * with. The fork asks for, accepts and uses no Z.ai account, so there is none: those
 * providers stay unentitled, their models are never offered, and no account request is
 * ever made.
 */
export function standaloneZaiAccountCredentials(): SharedZCodeCredentialStore | undefined {
  return undefined;
}

/**
 * Sends every model request to the endpoint the owner configured. Upstream reroutes
 * requests for Z.ai's Coding Plan endpoints through ZCode's own gateway on
 * `zcode.z.ai`, a host the owner never configured as a provider.
 */
export const directProviderEndpoints: ProviderEndpointRoutingPort = {
  resolve: async (url) => ({ routed: false, url }),
};

/** Upstream's built-in account connections, which need a Z.ai account, all take this prefix. */
const ACCOUNT_PROVIDER_PREFIX = "account:";

/**
 * A plugin agent as the fork runs it. An agent pinned to a model of an account-only
 * provider would name a provider the fork never has, so it runs on the session's model
 * instead, as an agent that names no model does.
 */
export function withoutAccountOnlyModel<
  Profile extends { readonly modelSelection?: { readonly providerId: string } },
>(profile: Profile): Profile {
  if (!profile.modelSelection?.providerId.startsWith(ACCOUNT_PROVIDER_PREFIX)) return profile;
  const { modelSelection: _accountOnly, ...inheritsSessionModel } = profile;
  return inheritsSessionModel as Profile;
}

/** Publish what this build carries, even if upstream left a downloaded catalogue in this home. */
export function publishBundledCatalogue(
  input: Parameters<typeof writeBundledOfficialMarketplacePartition>[0],
): Promise<Record<string, unknown>> {
  return writeBundledOfficialMarketplacePartition({ ...input, publishBundledOnly: true });
}

/** An unnamed refresh visits the owner's known marketplaces and skips the bundled catalogue. */
export function bulkMarketplaceIds(known: readonly { readonly id: string }[]): string[] {
  return refreshableMarketplaces(known, undefined).map(({ id }) => id);
}

/** Describe the published catalogue without reusing the saved CDN source or its metadata. */
export function bundledCatalogueSummary(id: string, pluginCount: number) {
  if (id !== ZCODE_OFFICIAL_PLUGIN_MARKETPLACE) return undefined;
  return {
    id,
    name: id,
    isOfficial: true,
    source: { source: "bundled" },
    description: "Official ZCode plugins bundled with this build.",
    pluginCount,
  };
}

/** For official installs, check the bundled catalogue after preparing the current build's seed. */
export async function checkBundledCatalogueInstall(input: {
  marketplace: string;
  pluginName: string;
  storageRoot: string;
  prepare: () => Promise<unknown>;
}): Promise<ZCodePluginInstallData | undefined> {
  const { marketplace, pluginName, storageRoot, prepare } = input;
  if (marketplace !== ZCODE_OFFICIAL_PLUGIN_MARKETPLACE) return undefined;

  // A saved upstream catalogue can still contain download-only entries before seeding.
  await prepare();
  const source = loadMarketplaceManifestSync(storageRoot, marketplace)?.plugins.find(
    (entry) => entry.name === pluginName,
  )?.source;
  if (source === "filesystem" || source === "sea") return undefined;

  const pluginId = `${pluginName}@${marketplace}`;
  return {
    dependencyClosure: [],
    installedPlugins: [],
    diagnostics: [
      {
        code: "plugin_not_found",
        message: `This build does not carry ${pluginId}.`,
        pluginId,
        severity: "error",
      },
    ],
  };
}
