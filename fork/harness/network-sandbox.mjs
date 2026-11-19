/**
 * A rung's view of the sealed network sandbox it runs in: the record of every
 * attempt to reach anything but loopback, and the names that lead to a stand-in.
 *
 * Inside the sandbox only loopback exists, so the stand-ins a rung starts are the
 * only hosts there are. Everything else is refused, and recorded whichever process
 * tried: `zcode`, a command it ran, or the rung itself.
 */

import { request } from "node:http";

/** Set by `fork/rungs.mjs` for every rung file; absent anywhere else. */
export const SANDBOX_SOCKET_ENV = "FORK_RUNG_SANDBOX";

/**
 * Throws outside the sandbox. The launcher calls this, so a rung run by hand with
 * `node --test` can never drive `zcode` against the real network.
 */
export function requireSandbox() {
  const socketPath = process.env[SANDBOX_SOCKET_ENV];
  if (!socketPath) {
    throw new Error("Rungs run inside the network sandbox: use `node fork/rungs.mjs [path]`.");
  }
  return socketPath;
}

/**
 * @typedef {object} Connection
 * @property {"tcp" | "udp"} protocol
 * @property {string} address
 * @property {number} port
 * @property {string} [name]  The name that was looked up to get the address; absent for a literal address.
 *
 * @typedef {object} Attempts
 * @property {string[]} names            Every host name looked up that no stand-in answers to, in the order first asked.
 * @property {Connection[]} connections  Every destination outside loopback that a packet was sent to.
 */

/**
 * Everything that tried to leave since the rung file started or last called `forgetAttempts`.
 * @returns {Promise<Attempts>}
 */
export const attempts = () => control("GET", "/attempts");

/** Empties the record, so that one test's attempts are not read as the next one's. */
export const forgetAttempts = async () => {
  await control("POST", "/forget");
};

/**
 * Makes `name` resolve to a stand-in, for a rung that needs the fork to reach one
 * by a particular host name. Stand-in names are left out of `attempts().names`.
 */
export const pointNameAtStandIn = async (name, address = "127.0.0.1") => {
  await control("POST", "/stand-in-name", { name, address });
};

function control(method, path, body) {
  const socketPath = requireSandbox();
  return new Promise((resolve, reject) => {
    const call = request({ socketPath, method, path }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const reply = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (response.statusCode === 200) resolve(reply);
        else reject(new Error(reply.error));
      });
    });
    call.once("error", reject);
    call.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
