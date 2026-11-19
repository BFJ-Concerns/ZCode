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
