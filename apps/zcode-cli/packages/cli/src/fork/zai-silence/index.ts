import { installConnectionGuard, type ConnectionGuardOptions } from "./connection-guard.js";
import { readConfiguredProviderHosts } from "./configured-providers.js";
import { reportRefusal } from "./refusal-report.js";
import { installRequestGuard } from "./request-guard.js";
import { normalizeHost } from "./zai-hosts.js";

export { withoutSignInCommands } from "./sign-in-commands.js";


/**
 * Makes this `zcode` process refuse, and report, every connection to a host Z.ai operates
 * that the owner has not configured as a model provider. Commands the agent runs are
 * processes of their own and are not affected.
 */
export function refuseUnconfiguredZaiHosts(argv: readonly string[]): void {
  const guard: ConnectionGuardOptions = {
    decide: (host) => {
      const configured = readConfiguredProviderHosts(process.env);
      if (!configured.readable) return { allowed: false, note: configured.reason };
      return configured.hosts.has(normalizeHost(host)) ? { allowed: true } : { allowed: false };
    },
    report: (destination, note) =>
      reportRefusal({
        destination,
        env: process.env,
        argv,
        stderr: process.stderr,
        unreadableProviderConfiguration: note,
      }),
  };
  installConnectionGuard(guard);
  installRequestGuard(guard);
}
