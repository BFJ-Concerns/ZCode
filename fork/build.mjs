/**
 * Builds the terminal UI and the command line from this checkout, and nothing else:
 * `@zcode/cli`, the workspace packages it depends on, and its bundled plugins. The
 * desktop, browser and mobile surfaces are neither installed for nor built.
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

/** Bundled plugins whose runtime has to be generated before the CLI can seed it. */
const BUNDLED_PLUGIN_BUILDS = [
  "@zcode/android-emulator-plugin",
  "@zcode/browser-use-plugin",
  "@zcode/documents-plugin",
  "@zcode/ios-simulator-plugin",
  "@zcode/node-repl-host",
  "@zcode/pdf-plugin",
  "@zcode/presentations-plugin",
  "@zcode/spreadsheets-plugin",
];
const filters = (packages) => packages.flatMap((name) => ["--filter", name]);

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
    ...filters(BUNDLED_PLUGIN_BUILDS.map((name) => `${name}...`)),
  ]);
}

export function build() {
  install();
  pnpm(["--filter", CLI_AND_ITS_DEPENDENCIES, "build"]);
  pnpm([...filters(BUNDLED_PLUGIN_BUILDS), "build"]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) build();
