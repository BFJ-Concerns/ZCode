/**
 * Runs pnpm with the arguments given. Upstream's scripts/run-cli-lint.mjs starts
 * pnpm as `node $npm_execpath`, which fails where pnpm is installed as a native
 * executable; fork/check.mjs points `npm_execpath` here so the script works with
 * either kind of installation.
 */

import { spawnSync } from "node:child_process";

const { status, error } = spawnSync("pnpm", process.argv.slice(2), { stdio: "inherit" });
if (error) throw error;
process.exit(status ?? 1);
