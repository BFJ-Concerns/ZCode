/**
 * The static checks that bear on the terminal UI and the command line: the types
 * and lint of `@zcode/cli` and the workspace packages it depends on, and the lint
 * and formatting of the files the fork owns. Nothing here looks at the desktop,
 * browser or mobile surfaces.
 *
 *   node fork/check.mjs
 *
 * Exits 0 when every check passes; stops at the first that fails.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build, CLI_AND_ITS_DEPENDENCIES, pnpm, REPOSITORY_ROOT, run } from "./build.mjs";

const CLI_WORKSPACE = join(REPOSITORY_ROOT, "apps", "zcode-cli");
const PNPM_AS_NODE_SCRIPT = fileURLToPath(new URL("pnpm-as-node-script.mjs", import.meta.url));

/** Repository-relative directories of `@zcode/cli` and the workspace packages it depends on. */
function cliPackageDirectories() {
  const listing = execFileSync(
    "pnpm",
    ["--filter", CLI_AND_ITS_DEPENDENCIES, "list", "--depth", "-1", "--json"],
    { cwd: REPOSITORY_ROOT, encoding: "utf8" },
  );
  return JSON.parse(listing).map((project) => relative(REPOSITORY_ROOT, project.path));
}

// A package's type check reads the built declarations of the packages it depends on.
build();
pnpm(["--filter", CLI_AND_ITS_DEPENDENCIES, "typecheck"]);

const packages = cliPackageDirectories();
const insideCliWorkspace = (directory) =>
  join(REPOSITORY_ROOT, directory).startsWith(CLI_WORKSPACE + sep);

// Upstream lints the CLI workspace package by package, and accepts the line counts of
// the over-long files it ships unchanged. Its script starts pnpm as a Node script.
run(process.execPath, [join(REPOSITORY_ROOT, "scripts", "run-cli-lint.mjs")], {
  cwd: CLI_WORKSPACE,
  env: { npm_execpath: PNPM_AS_NODE_SCRIPT },
});
// The packages outside that workspace, and the fork's own directory, take the root lint.
pnpm(["exec", "oxlint", "fork", ...packages.filter((directory) => !insideCliWorkspace(directory))]);

// Formatting is held only for files the fork owns; upstream's files keep upstream's.
const forkSourceDirectories = packages
  .map((directory) => join(directory, "src", "fork"))
  .filter((directory) => existsSync(join(REPOSITORY_ROOT, directory)));
pnpm(["exec", "oxfmt", "--check", "fork", ...forkSourceDirectories]);
