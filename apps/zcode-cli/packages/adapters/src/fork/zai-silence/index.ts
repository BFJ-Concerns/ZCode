import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE } from "@zcode/contracts";

/**
 * Whether a marketplace is ZCode's official plugin catalogue. Its listing lives on
 * Z.ai's CDN and the fork never fetches it: the official plugins are the ones bundled
 * with `zcode` itself, seeded from the build. Plugins still install from any other
 * marketplace or source the owner names.
 */
export function isOfficialCatalogue(marketplaceId: string): boolean {
  return marketplaceId === ZCODE_OFFICIAL_PLUGIN_MARKETPLACE;
}

/**
 * The marketplaces a refresh fetches: every one selected but the official catalogue.
 * Asking for the official catalogue by name is an error that says why.
 */
export function refreshableMarketplaces<Marketplace extends { readonly id: string }>(
  selected: readonly Marketplace[],
  requested: string | undefined,
): Marketplace[] {
  if (requested !== undefined && isOfficialCatalogue(requested)) {
    throw new Error(
      `${requested} is not fetched by this build: its plugins are the ones bundled with zcode.`,
    );
  }
  return selected.filter((marketplace) => !isOfficialCatalogue(marketplace.id));
}

/**
 * ZCode Sites, the official plugin that publishes a project to Z.ai's hosting. It works
 * only with a Z.ai account, so the fork loads it from nowhere: not bundled, and not from
 * a copy upstream installed in the owner's plugin storage.
 */
const SITE_PUBLISHING_PLUGIN_ID = `zcode-site@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`;

export function isSitePublishing(pluginId: string): boolean {
  return pluginId === SITE_PUBLISHING_PLUGIN_ID;
}
