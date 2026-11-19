/**
 * Builds the terminal UI and the command line from this checkout, and nothing else:
 * `@zcode/cli` and the workspace packages it depends on. The desktop, browser and
 * mobile surfaces are neither installed for nor built.
 *
 *   node fork/build.mjs
 *
 * The result runs in place: apps/zcode-cli/packages/cli/dist/zcode.cjs
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** pnpm's selector for the command line and every workspace package it depends on. */
export const CLI_AND_ITS_DEPENDENCIES = "@zcode/cli...";

/** Runs a command at the repository root and ends this process if it fails. */
export function run(command, args, { cwd = REPOSITORY_ROOT, env = {} } = {}) {
  const { status, error } = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (error) throw error;
  if (status !== 0) process.exit(status ?? 1);
}

// Upstream's `prepare` script installs Git hooks that run its whole-repository checks
// on every push, from every worktree of this clone. The fork's gates are fork/check.mjs
// and fork/rungs.mjs, so pnpm runs with the hooks left uninstalled.
export const pnpm = (args) => run("pnpm", args, { env: { HUSKY: "0" } });

/** Installs the CLI dependencies and the tools declared by both workspace roots. */
export function install() {
  // The upstream hoisted linker installs every importer even with a filter.
  // Public hoisting keeps bundled CLI externals such as koffi resolvable at runtime.
  pnpm([
    "install",
    "--frozen-lockfile",
    "--config.node-linker=isolated",
    "--config.shamefully-hoist=true",
    "--config.confirmModulesPurge=false",
    "--filter",
    ".",
    "--filter",
    "./apps/zcode-cli",
    "--filter",
    CLI_AND_ITS_DEPENDENCIES,
  ]);
}

export function build() {
  install();
  pnpm(["--filter", CLI_AND_ITS_DEPENDENCIES, "build"]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) build();
