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
