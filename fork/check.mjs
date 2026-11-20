/**
 * The static checks that bear on the terminal UI and the command line: the types
 * and lint of `@zcode/cli` and the workspace packages it depends on, and the lint
 * and formatting of the files the fork owns. Nothing here looks at the desktop,
 * browser or mobile surfaces.
 *
 * The files the fork owns are everything under `fork/` and under a `src/fork/`
 * directory. Each one is checked, or the gate fails and names it.
 *
 *   node fork/check.mjs
 *
 * Exits 0 when every check passes; stops at the first that fails.
 */

import { execFileSync } from "node:child_process";
import { extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build, CLI_AND_ITS_DEPENDENCIES, pnpm, REPOSITORY_ROOT, run } from "./build.mjs";

const CLI_WORKSPACE = join(REPOSITORY_ROOT, "apps", "zcode-cli");
const PNPM_AS_NODE_SCRIPT = fileURLToPath(new URL("pnpm-as-node-script.mjs", import.meta.url));
/** What the formatters read; any other kind of file the fork owns needs a check of its own. */
const FORMATTED_EXTENSIONS = new Set([".ts", ".tsx", ".mjs", ".js", ".json", ".md"]);
/** The fork's Python fixtures, which no tool in the workspace lints or formats. */
const PYTHON_EXTENSION = ".py";

/** Repository-relative paths of the files the fork owns, committed or not. */
function forkOwnedFiles() {
  const listing = execFileSync(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      "fork",
      "**/src/fork/**",
    ],
    { cwd: REPOSITORY_ROOT, encoding: "utf8" },
  );
  return listing.split("\0").filter((path) => path !== "");
}

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
// fork(zai-silence): exercise Node's request and connection argument forms
pnpm(["--filter", "@zcode/cli", "exec", "tsx", "--test", "tests/zai-request-guard.test.ts"]);
pnpm(["--filter", CLI_AND_ITS_DEPENDENCIES, "typecheck"]);

const packages = cliPackageDirectories();
const insideCliWorkspace = (path) => join(REPOSITORY_ROOT, path).startsWith(CLI_WORKSPACE + sep);

// The types and lint below reach a package's `src/fork/` only when the package is one
// the command line is built from.
const owned = forkOwnedFiles();
const outsideTheBuild = owned.filter(
  (path) =>
    !path.startsWith(`fork/`) && !packages.some((directory) => path.startsWith(directory + sep)),
);
const unchecked = owned.filter((path) => {
  const extension = extname(path);
  return !FORMATTED_EXTENSIONS.has(extension) && extension !== PYTHON_EXTENSION;
});
if (outsideTheBuild.length > 0 || unchecked.length > 0) {
  for (const path of outsideTheBuild) console.error(`${path}: in no package the CLI builds from.`);
  for (const path of unchecked) console.error(`${path}: no check reads this kind of file.`);
  process.exit(1);
}

// Upstream lints the CLI workspace package by package, and accepts the line counts of
// the over-long files it ships unchanged. Its script starts pnpm as a Node script.
run(
  process.execPath,
  [join(REPOSITORY_ROOT, "scripts", "run-cli-lint.mjs"), ...packages.filter(insideCliWorkspace)],
  { cwd: CLI_WORKSPACE, env: { npm_execpath: PNPM_AS_NODE_SCRIPT } },
);
// The packages outside that workspace, and the fork's own directory, take the root lint.
pnpm(["exec", "oxlint", "fork", ...packages.filter((directory) => !insideCliWorkspace(directory))]);

// Formatting is held only for files the fork owns; upstream's files keep upstream's.
// The CLI workspace has a formatter and settings of its own, and the root's ignores
// that workspace, so each file is checked by the formatter of the workspace it is in.
const formatted = owned.filter((path) => FORMATTED_EXTENSIONS.has(extname(path)));
const inCliWorkspace = formatted.filter(insideCliWorkspace);
const atRoot = formatted.filter((path) => !insideCliWorkspace(path));
pnpm(["exec", "oxfmt", "--check", ...atRoot]);
if (inCliWorkspace.length > 0) {
  run(
    "pnpm",
    [
      "exec",
      "oxfmt",
      "--check",
      ...inCliWorkspace.map((path) => relative(CLI_WORKSPACE, join(REPOSITORY_ROOT, path))),
    ],
    { cwd: CLI_WORKSPACE, env: { HUSKY: "0" } },
  );
}

// A Python fixture is at least read as Python, so one that cannot run fails here.
const python = owned.filter((path) => extname(path) === PYTHON_EXTENSION);
if (python.length > 0) {
  run("python3", [
    "-I",
    "-c",
    "import ast, sys\nfor path in sys.argv[1:]:\n    ast.parse(open(path, 'rb').read(), path)",
    ...python,
  ]);
}
