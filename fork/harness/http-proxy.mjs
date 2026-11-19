/**
 * Stand-in HTTP proxy: a forward proxy on loopback that records every destination it is
 * asked for and reaches none of them. A tunnel request (`CONNECT host:port`) and a
 * plain proxied request (`GET http://host/...`) are both answered 502.
 *
 * A rung names it as the owner's proxy to see where the fork asked to go through it.
 */

import { createServer } from "node:http";

const LOOPBACK = "127.0.0.1";
const NOT_FORWARDED = "HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\ncontent-length: 0\r\n\r\n";

/**
 * @typedef {object} HttpProxy
 * @property {string} url              What the owner writes as the proxy, e.g. `http://127.0.0.1:41234`.
 * @property {string[]} destinations  Every `host:port` asked for, in arrival order.
 * @property {() => Promise<void>} close
 */

/** @returns {Promise<HttpProxy>} */
export async function startHttpProxy() {
  /** @type {string[]} */
  const destinations = [];
  const server = createServer((request, response) => {
    const target = new URL(request.url ?? "", "http://unknown");
    destinations.push(`${target.hostname}:${target.port || 80}`);
    response.writeHead(502, { connection: "close" }).end();
  });
  server.on("connect", (request, socket) => {
    destinations.push(request.url ?? "");
    socket.end(NOT_FORWARDED);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK, resolve);
  });
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
  return {
    url: `http://${LOOPBACK}:${port}`,
    destinations,
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
