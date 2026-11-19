import assert from "node:assert/strict";
import { once } from "node:events";
import http, { get as httpGet, request as httpRequest } from "node:http";
import https, { get as httpsGet, request as httpsRequest } from "node:https";
import net from "node:net";
import { test } from "node:test";
import {
  installConnectionGuard,
  REFUSED_ERROR_CODE,
  type ConnectionGuardOptions,
  type Destination,
} from "../src/fork/zai-silence/connection-guard.js";
import { installRequestGuard } from "../src/fork/zai-silence/request-guard.js";

const refused = "api.z.ai";
const allowed = "market.example";
const reports: Destination[] = [];
const guard: ConnectionGuardOptions = {
  decide: () => ({ allowed: false }),
  report: (destination) => reports.push(destination),
};
installConnectionGuard(guard);
installRequestGuard(guard);

const httpRequests = { request: () => httpRequest, get: () => httpGet };
const httpsRequests = { request: () => httpsRequest, get: () => httpsGet };

for (const [transport, requests, protocol, port] of [
  [http, httpRequests, "http:", 80],
  [https, httpsRequests, "https:", 443],
] as const) {
  for (const [method, request] of Object.entries(requests)) {
    test(`${protocol} ${method} judges the merged destination before invoking the agent`, async () => {
      const calls: string[] = [];
      const agent = new transport.Agent();
      agent.addRequest = (client, options) => {
        calls.push(options.host);
        const socket = new net.Socket();
        client.onSocket(socket);
        queueMicrotask(() => socket.destroy(new Error("stand-in agent")));
      };

      const settled = (client: http.ClientRequest) => {
        const error = once(client, "error").then(([reason]) => reason);
        if (method === "request") client.end();
        return error;
      };

      const blocked = [
        () => request()({ hostname: refused, agent }),
        () => request()(`${protocol}//${refused}/`, { host: allowed, agent }),
        () =>
          request()(new URL(`${protocol}//${allowed}/`), {
            hostname: undefined,
            host: refused,
            agent,
          }),
        () => request()({ host: refused, socketPath: "", agent }),
        () =>
          request()(
            {
              href: `${protocol}//${refused}/`,
              protocol,
              hostname: refused,
              pathname: "/",
              search: "",
              port: "",
            } as unknown as URL,
            { agent },
          ),
        () =>
          request()(
            Object.defineProperty(
              Object.assign(new URL(`${protocol}//${allowed}/`), { path: "/", agent }),
              "host",
              { value: refused, enumerable: true },
            ),
          ),
      ];
      for (const [index, open] of blocked.entries()) {
        reports.length = 0;
        assert.equal((await settled(open())).code, REFUSED_ERROR_CODE, `request form ${index + 1}`);
        assert.deepEqual(reports, [{ host: refused, port }]);
      }
      assert.deepEqual(calls, [], "the proxy agent was never invoked");

      const allowedOverrides = [
        { hostname: allowed, host: refused, agent },
        { hostname: "", host: allowed, agent },
      ];
      for (const overrides of allowedOverrides) {
        reports.length = 0;
        const client = request()(new URL(`${protocol}//${refused}/`), overrides);
        assert.equal((await settled(client)).message, "stand-in agent");
        assert.deepEqual(reports, []);
      }
      assert.deepEqual(calls, [allowed, allowed]);

      reports.length = 0;
      const withCallback = request()(new URL(`${protocol}//${refused}:8123/`), () => {
        assert.fail("a refused request cannot receive a response");
      });
      assert.equal((await settled(withCallback)).code, REFUSED_ERROR_CODE);
      assert.deepEqual(reports, [{ host: refused, port: 8123 }]);
    });
  }
}

test("TCP connections are judged before lookup for positional and options arguments", async () => {
  for (const connect of [
    () => new net.Socket().connect("8123", refused),
    () =>
      net.createConnection({
        port: 8123,
        host: refused,
        path: "",
        lookup: () => assert.fail("a refused connection cannot look up its host"),
      }),
  ]) {
    reports.length = 0;
    const [error] = await once(connect(), "error");
    assert.equal(error.code, REFUSED_ERROR_CODE);
    assert.deepEqual(reports, [{ host: refused, port: 8123 }]);
  }
});
