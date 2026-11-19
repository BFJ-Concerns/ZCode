import type { SharedZCodeCredentialStore } from "@zcode/adapters/auth";
import type { ProviderEndpointRoutingPort } from "@zcode/contracts";

/** ZCode Sites publishes a project to Z.ai's hosting and works only with a Z.ai account. */
const SITE_PUBLISHING_PLUGIN = "zcode-site";

/** The bundled plugins with site publishing taken out; nothing else does its job. */
export function withoutSitePublishing<Definition extends { readonly name: string }>(
  definitions: readonly Definition[],
): readonly Definition[] {
  return definitions.filter((definition) => definition.name !== SITE_PUBLISHING_PLUGIN);
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
