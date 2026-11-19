/**
 * The sealed network sandbox one rung file runs in. `fork/rungs.mjs` starts this
 * inside fresh user, network, mount and PID namespaces; it runs here as the
 * namespaces' root, seals and instruments the network, then runs the rung file as
 * the invoking user, who has no power over the seal.
 *
 * The seal is the kernel's: the network namespace holds a loopback interface and
 * nothing else, so no packet leaves the machine whatever this file gets wrong.
 * What this file adds is the record. Every address is routed to loopback, so an
 * attempt on any address fails fast as "connection refused" after passing the
 * packet filter, which notes its destination; and the only name server is the one
 * below, which notes every name it is asked for.
 *
 * usage: network-sandbox-supervisor.mjs <uid> <gid> <rung file> [node --test arguments...]
 */

import { execFileSync, spawn } from "node:child_process";
import { createSocket } from "node:dgram";
import { existsSync, mkdirSync, readlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, isAbsolute, resolve } from "node:path";
import { SANDBOX_SOCKET_ENV } from "./network-sandbox.mjs";

const [uid, gid, rungFile, ...testArguments] = process.argv.slice(2);

const LOOPBACK = "127.0.0.1";
const DNS_PORT = 53;
const CONTROL_SOCKET = "/run/fork-rung-sandbox.sock";
const FILTER_TABLE = "fork_rung_sandbox";
const RECORD_SETS = [
  { set: "tcp4", protocol: "tcp" },
  { set: "udp4", protocol: "udp" },
  { set: "tcp6", protocol: "tcp" },
  { set: "udp6", protocol: "udp" },
];
/**
 * Each name that is not a stand-in's resolves to an address of its own in the range
 * reserved for benchmarking (RFC 2544), which nothing real uses, so a recorded
 * connection can be traced back to the name that was looked up.
 */
const ELSEWHERE_PREFIX = [198, 18];
const ELSEWHERE_CAPACITY = 0xfffe;

const run = (command, args, input) =>
  execFileSync(command, args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "inherit"] });

function sealAndInstrumentNetwork() {
  run("ip", ["link", "set", "lo", "up"]);
  // Every address is local: an attempt anywhere reaches the packet filter and is then refused.
  run("ip", ["route", "add", "local", "default", "dev", "lo"]);
  run("ip", ["-6", "route", "add", "local", "default", "dev", "lo"]);
  run(
    "nft",
    ["-f", "-"],
    `table inet ${FILTER_TABLE} {
      set tcp4 { type ipv4_addr . inet_service; flags dynamic; size 65535; }
      set udp4 { type ipv4_addr . inet_service; flags dynamic; size 65535; }
      set tcp6 { type ipv6_addr . inet_service; flags dynamic; size 65535; }
      set udp6 { type ipv6_addr . inet_service; flags dynamic; size 65535; }
      chain output {
        type filter hook output priority 0;
        ip daddr != 127.0.0.0/8 tcp flags syn / syn,ack add @tcp4 { ip daddr . tcp dport }
        ip daddr != 127.0.0.0/8 meta l4proto udp add @udp4 { ip daddr . udp dport }
        ip6 daddr != ::1 tcp flags syn / syn,ack add @tcp6 { ip6 daddr . tcp dport }
        ip6 daddr != ::1 meta l4proto udp add @udp6 { ip6 daddr . udp dport }
      }
    }`,
  );
}

function hideTheMachine() {
  // Sockets under /run and /tmp reach services outside the sandbox (the system
  // resolver, the session bus, a keyring) without touching the network.
  run("mount", ["-t", "tmpfs", "tmpfs", "/run"]);
  run("mount", ["-t", "tmpfs", "tmpfs", "/tmp"]);

  const resolverConfig = `nameserver ${LOOPBACK}\n`;
  const target = resolverConfigTarget();
  if (existsSync(target)) {
    const replacement = "/run/fork-rung-resolv.conf";
    writeFileSync(replacement, resolverConfig);
    run("mount", ["--bind", replacement, target]);
  } else {
    // /etc/resolv.conf pointed into /run, which is now empty.
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, resolverConfig);
  }
}

function resolverConfigTarget() {
  let path = "/etc/resolv.conf";
  for (;;) {
    let link;
    try {
      link = readlinkSync(path);
    } catch {
      return path;
    }
    path = isAbsolute(link) ? link : resolve(dirname(path), link);
  }
}

/** Names in the order first asked for, each with the address it was given. */
const namesAsked = new Map();
/** Names a rung has pointed at a stand-in. */
const standInNames = new Map();

function addressFor(name) {
  const standIn = standInNames.get(name);
  if (standIn !== undefined) return standIn;
  if (!namesAsked.has(name)) {
    const index = namesAsked.size + 1;
    if (index > ELSEWHERE_CAPACITY) throw new Error("The sandbox has run out of addresses.");
    namesAsked.set(name, [...ELSEWHERE_PREFIX, index >> 8, index & 0xff].join("."));
  }
  return namesAsked.get(name);
}

function startNameServer() {
  const TYPE_A = 1;
  const CLASS_INTERNET = 1;
  const HEADER_LENGTH = 12;
  const socket = createSocket("udp4");

  /** The reply to one query, or `undefined` for a datagram that is not a well-formed query. */
  const answerTo = (query) => {
    // After the header comes one question: the name's labels, a zero byte, type and class.
    let offset = HEADER_LENGTH;
    const labels = [];
    while (query[offset]) {
      labels.push(query.toString("latin1", offset + 1, offset + 1 + query[offset]));
      offset += query[offset] + 1;
    }
    const questionEnd = offset + 5;
    if (labels.length === 0 || query.length < questionEnd) return undefined;
    const type = query.readUInt16BE(offset + 1);
    const address = addressFor(labels.join(".").toLowerCase());

    // Only IPv4 addresses are given out: any other question is answered with nothing.
    const answer = Buffer.alloc(type === TYPE_A ? 16 : 0);
    if (type === TYPE_A) {
      answer.writeUInt16BE(0xc000 | HEADER_LENGTH, 0); // the name, as a pointer to the question's
      answer.writeUInt16BE(TYPE_A, 2);
      answer.writeUInt16BE(CLASS_INTERNET, 4);
      answer.writeUInt32BE(0, 6); // time to live: never cached
      answer.writeUInt16BE(4, 10);
      answer.set(address.split(".").map(Number), 12);
    }
    const header = Buffer.from(query.subarray(0, HEADER_LENGTH));
    header.writeUInt16BE(0x8180, 2); // a response, recursion available, no error
    header.writeUInt16BE(1, 4); // one question
    header.writeUInt16BE(type === TYPE_A ? 1 : 0, 6); // answers
    header.writeUInt32BE(0, 8); // no authority or additional records
    return Buffer.concat([header, query.subarray(HEADER_LENGTH, questionEnd), answer]);
  };

  socket.on("message", (query, peer) => {
    const reply = answerTo(query);
    if (reply) socket.send(reply, peer.port, peer.address);
  });
  return new Promise((done, failed) => {
    socket.once("error", failed);
    socket.bind(DNS_PORT, LOOPBACK, done);
  });
}

function recordedConnections() {
  const namesByAddress = new Map([...namesAsked].map(([name, address]) => [address, name]));
  const listing = JSON.parse(run("nft", ["-j", "list", "table", "inet", FILTER_TABLE]));
  const connections = [];
  for (const { set, protocol } of RECORD_SETS) {
    const recorded = listing.nftables.find((entry) => entry.set?.name === set)?.set;
    for (const element of recorded?.elem ?? []) {
      const [address, port] = element.concat;
      const name = namesByAddress.get(address);
      connections.push({ protocol, address, port, ...(name ? { name } : {}) });
    }
  }
  return connections;
}

function forgetAttempts() {
  namesAsked.clear();
  for (const { set } of RECORD_SETS) run("nft", ["flush", "set", "inet", FILTER_TABLE, set]);
}

function startControlServer() {
  const routes = {
    "GET /attempts": () => ({ names: [...namesAsked.keys()], connections: recordedConnections() }),
    "POST /forget": () => forgetAttempts(),
    "POST /stand-in-name": ({ name, address }) => {
      standInNames.set(name.toLowerCase(), address);
    },
  };
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    try {
      const route = routes[`${request.method} ${request.url}`];
      if (!route) throw new Error(`The sandbox has no ${request.method} ${request.url}.`);
      const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(route(body) ?? {}));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: String(error) }));
    }
  });
  return new Promise((done, failed) => {
    server.once("error", failed);
    server.listen(CONTROL_SOCKET, done);
  });
}

sealAndInstrumentNetwork();
hideTheMachine();
await startNameServer();
await startControlServer();

// The rung, and every `zcode` it launches, runs as the invoking user in a user
// namespace of its own: not root, and without any capability over this network.
const rung = spawn(
  "unshare",
  [
    "--user",
    `--map-user=${uid}`,
    `--map-group=${gid}`,
    "--",
    process.execPath,
    "--test",
    ...testArguments,
    rungFile,
  ],
  {
    stdio: "inherit",
    env: { ...process.env, TMPDIR: "/tmp", [SANDBOX_SOCKET_ENV]: CONTROL_SOCKET },
  },
);
rung.once("close", (exitCode) => {
  // Exiting ends the PID namespace, and with it anything the rung left running.
  process.exit(exitCode ?? 1);
});
