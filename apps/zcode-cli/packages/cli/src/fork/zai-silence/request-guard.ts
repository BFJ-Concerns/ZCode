import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { urlToHttpOptions } from "node:url";
import { refusalError, type ConnectionGuardOptions, type Destination } from "./connection-guard.js";
import { isZaiHost } from "./zai-hosts.js";

type RequestFunction = (...args: unknown[]) => http.ClientRequest;

const INSTALLED = Symbol.for("zcode.fork.zai-silence.request-guard");

/**
 * Refuses every `http` and `https` request this process makes to a host Z.ai operates,
 * unless the owner has configured that host as a model provider, judged by the host the
 * request is for rather than the one its socket reaches.
 *
 * Through an HTTP proxy the two differ: the socket goes to the proxy, which is asked to
 * tunnel to the real host, so the connection guard sees only the proxy. The CLI's proxied
 * requests all go through `http.request` and `https.request` with a proxy agent, so they
 * are guarded here. A refused request never reaches its agent: it is given a connection
 * that fails at once, so nothing is sent to the proxy either, and it fails as a request
 * to an unreachable host does.
 *
 * Installing it a second time in the same process does nothing.
 */
export function installRequestGuard(options: ConnectionGuardOptions): void {
  for (const [transport, defaultPort] of [
    [http, 80],
    [https, 443],
  ] as const) {
    const guarded = transport as typeof transport & { [INSTALLED]?: true };
    if (guarded[INSTALLED]) continue;
    guarded[INSTALLED] = true;

    const request = transport.request as unknown as RequestFunction;
    const guardedRequest: RequestFunction = (...args) => {
      const destination = requestDestination(args, defaultPort);
      const decision =
        destination !== undefined && isZaiHost(destination.host)
          ? options.decide(destination.host)
          : undefined;
      if (destination === undefined || decision === undefined || decision.allowed) {
        return request(...args);
      }
      options.report(destination, decision.note);
      return request(...withFailingConnection(args, destination));
    };
    transport.request = guardedRequest as unknown as typeof transport.request;
    // Node's `get` calls the module's own `request`, not the export, so it is rebuilt on the guarded one.
    transport.get = ((...args: unknown[]) => {
      const clientRequest = guardedRequest(...args);
      clientRequest.end();
      return clientRequest;
    }) as unknown as typeof transport.get;
  }
  syncBuiltinESMExports();
}

type RequestOptions = {
  readonly host?: unknown;
  readonly hostname?: unknown;
  readonly port?: unknown;
  readonly defaultPort?: unknown;
  readonly socketPath?: unknown;
};

/** Resolve the URL and options in Node's order, then use its hostname/host precedence. */
function requestDestination(
  args: readonly unknown[],
  defaultPort: number,
): Destination | undefined {
  const [input, options] = args;
  let merged: RequestOptions;
  if (typeof input === "string" || isRequestUrl(input)) {
    try {
      const url = typeof input === "string" ? new URL(input) : input;
      // URL fields are the base options. Own overrides can clear a field as well as set it.
      merged = { ...urlToHttpOptions(url), ...(isOptions(options) ? options : undefined) };
    } catch {
      // Node rejects the request itself; there is no host to judge.
      return undefined;
    }
  } else {
    merged = isOptions(input) ? { ...input } : {};
  }
  // Node uses a Unix socket only for a non-empty socketPath.
  if (stringOf(merged.socketPath) !== undefined) return undefined;
  const host = stringOf(merged.hostname) ?? stringOf(merged.host) ?? "localhost";
  // Proxy agents can derive their default from the call stack inside Node. Use the request protocol.
  const rawPort = merged.port || merged.defaultPort || defaultPort;
  const port = typeof rawPort === "string" ? Number(rawPort) : rawPort;
  return { host, port: typeof port === "number" && Number.isInteger(port) ? port : undefined };
}

/** The same request arguments, connected through a socket that fails with the refusal. */
function withFailingConnection(args: readonly unknown[], destination: Destination): unknown[] {
  const failingConnection = {
    agent: undefined,
    createConnection: () => {
      const socket = new net.Socket();
      process.nextTick(() => socket.destroy(refusalError(destination)));
      return socket;
    },
  };
  if (typeof args[0] === "string" || isRequestUrl(args[0])) {
    const [url, second, ...rest] = args;
    return isOptions(second)
      ? [url, { ...second, ...failingConnection }, ...rest]
      : [url, failingConnection, ...args.slice(1)];
  }
  const [options, ...rest] = args;
  return [{ ...(options as object), ...failingConnection }, ...rest];
}

// Node distinguishes URL-shaped input from request options by these fields, including on
// URL objects extended with request options such as path.
function isRequestUrl(value: unknown): value is URL {
  if (!isOptions(value)) return false;
  const { href, protocol, auth, path } = value as Record<string, unknown>;
  return Boolean(href && protocol && auth === undefined && path === undefined);
}

function isOptions(value: unknown): value is RequestOptions {
  return typeof value === "object" && value !== null;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}
