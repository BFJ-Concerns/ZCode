/**
 * Builds the terminal UI and the command line from this checkout, and nothing else:
 * `@zcode/cli`, the workspace packages it depends on, and the document plugins it bundles. The desktop, browser and
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

/**
 * The document plugins bundled with the command line: Word, PDF, presentations and
 * spreadsheets. `zcode` seeds each from the checkout when it first runs, and only once
 * the plugin has built the document viewer its manifest requires; unbuilt, the document
 * skills do not exist in the fork at all.
 */
export const BUNDLED_DOCUMENT_PLUGINS = [
  "@zcode/documents-plugin",
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
    ...filters(BUNDLED_DOCUMENT_PLUGINS.map((name) => `${name}...`)),
  ]);
}

export function build() {
  install();
  pnpm(["--filter", CLI_AND_ITS_DEPENDENCIES, "build"]);
  pnpm([...filters(BUNDLED_DOCUMENT_PLUGINS), "build"]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) build();
