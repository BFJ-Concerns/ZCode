import net from "node:net";
import { isZaiHost } from "./zai-hosts.js";

export interface Destination {
  readonly host: string;
  readonly port: number | undefined;
}

/** Whether a connection to a Z.ai host may be made, and anything the refusal report should add. */
export type Decision = { readonly allowed: true } | { readonly allowed: false; readonly note?: string };

export interface ConnectionGuardOptions {
  /** Allows a Z.ai host only when the owner has configured it as a model provider. */
  readonly decide: (host: string) => Decision;
  /** Called once for each connection refused, before the caller sees the error. */
  readonly report: (destination: Destination, note: string | undefined) => void;
}

export const REFUSED_ERROR_CODE = "ZCODE_ZAI_HOST_REFUSED";

const INSTALLED = Symbol.for("zcode.fork.zai-silence.connection-guard");

/**
 * Refuses every TCP connection this process opens to a host Z.ai operates, unless the
 * owner has configured that host as a model provider.
 *
 * Every client in a Node process reaches the network through `net.Socket#connect`:
 * `http`, `https`, `tls`, the built-in `fetch`, and the WebSocket and SDK clients built on
 * them. The guard sits there, so no request site has to know about it. (Through an HTTP
 * proxy the socket goes to the proxy; `request-guard.ts` covers that case.) A refused socket
 * fails as an unreachable host does, with an error whose code is `REFUSED_ERROR_CODE`,
 * and the caller handles it on the path it already has for a host that cannot be reached.
 *
 * Installing it a second time in the same process does nothing.
 */
export function installConnectionGuard(options: ConnectionGuardOptions): void {
  const prototype = net.Socket.prototype as net.Socket & { [INSTALLED]?: true };
  if (prototype[INSTALLED]) return;
  prototype[INSTALLED] = true;

  const connect = prototype.connect;
  prototype.connect = function guardedConnect(this: net.Socket, ...args: unknown[]) {
    const destination = destinationOf(args);
    const decision =
      destination !== undefined && isZaiHost(destination.host)
        ? options.decide(destination.host)
        : undefined;
    if (destination === undefined || decision === undefined || decision.allowed) {
      return (connect as (...connectArgs: unknown[]) => net.Socket).apply(this, args);
    }
    options.report(destination, decision.note);
    // Asynchronously, as a failed connection would be: the caller attaches its error
    // listener after connect() returns.
    process.nextTick(() => this.destroy(refusalError(destination)));
    return this;
  } as typeof connect;
}

/** The error a refused connection or request fails with. */
export function refusalError(destination: Destination): Error {
  return Object.assign(
    new Error(
      `Refused a connection to ${describe(destination)}: Z.ai operates it and it is not a configured model provider.`,
    ),
    { code: REFUSED_ERROR_CODE },
  );
}

export function describe({ host, port }: Destination): string {
  return port === undefined ? host : `${host}:${port}`;
}

/**
 * The host and port a `connect` call is for, in any of the forms Node accepts: an options
 * object, a port and host, or the normalised arguments `net.connect` passes on. A call
 * for a local socket path has no host and is not guarded.
 */
function destinationOf(args: readonly unknown[]): Destination | undefined {
  const first = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
  if (typeof first === "object" && first !== null) {
    const options = first as { host?: unknown; path?: unknown; port?: unknown };
    if (typeof options.path === "string" && options.path !== "") return undefined;
    return {
      host: typeof options.host === "string" ? options.host : "localhost",
      port: portOf(options.port),
    };
  }
  const port = portOf(first);
  if (port === undefined) return undefined;
  return { host: typeof args[1] === "string" ? args[1] : "localhost", port };
}

function portOf(value: unknown): number | undefined {
  const port = typeof value === "string" ? Number(value) : value;
  return typeof port === "number" && Number.isInteger(port) ? port : undefined;
}
