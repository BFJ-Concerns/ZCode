/**
 * Stand-in SearXNG instance: answers the search endpoint on loopback and records
 * every query it receives.
 *
 * A rung names `url` as the instance in the owner's configuration, drives the fork
 * to search, and reads `queries` to see what arrived.
 */

import { createServer } from "node:http";

const LOOPBACK = "127.0.0.1";

/**
 * @typedef {object} RecordedQuery
 * @property {string} q                        The search terms.
 * @property {Record<string, string>} params   Every parameter of the request, `q` and `categories` included.
 *
 * @typedef {object} Searxng
 * @property {string} url                The instance's address, as the owner would configure it.
 * @property {RecordedQuery[]} queries   Every search received, in arrival order.
 * @property {() => Promise<void>} close
 */

/**
 * @param {object} [options]
 * @param {(query: RecordedQuery) => unknown[]} [options.results]
 *   The `results` array of the JSON reply to a query, in SearXNG's own shape.
 *   Left out, every search finds nothing.
 * @returns {Promise<Searxng>}
 */
export async function startSearxng({ results = () => [] } = {}) {
  /** @type {RecordedQuery[]} */
  const queries = [];

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${LOOPBACK}`);
    const body = [];
    for await (const chunk of request) body.push(chunk);
    // SearXNG takes its parameters in the query string, or form-encoded in a POST body.
    const params = Object.fromEntries([
      ...url.searchParams,
      ...new URLSearchParams(Buffer.concat(body).toString("utf8")),
    ]);

    if (url.pathname !== "/search") {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end(`stand-in SearXNG has no ${url.pathname}`);
      return;
    }
    const query = { q: params.q ?? "", params };
    queries.push(query);
    const found = results(query);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ query: query.q, number_of_results: found.length, results: found }),
    );
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK, resolve);
  });
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());

  return {
    url: `http://${LOOPBACK}:${port}`,
    queries,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
