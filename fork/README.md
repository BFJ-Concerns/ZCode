# The fork

This checkout is ZCode as upstream ships it, plus a small number of differences. The
fork builds, runs and proves only the terminal UI and the command line: `@zcode/cli`
under `apps/zcode-cli` and the workspace packages it depends on. The desktop app, the
browser interface and the mobile app stay in the tree exactly as upstream ships them
and are never built here.

This directory holds everything about the fork that is not a difference itself: these
rules, the build, the two commands that gate a change, the harness the proofs run on,
and the proofs.

## Build and run

```sh
node fork/build.mjs
```

installs the dependencies of `@zcode/cli` from the lockfile and builds it with the
packages it depends on. It needs Node and pnpm at the versions in `mise.toml`, and the
npm registry (or a pnpm store that already has the packages) the first time.

The result runs in place and is executable:

```sh
apps/zcode-cli/packages/cli/dist/zcode.cjs                  # the terminal UI
apps/zcode-cli/packages/cli/dist/zcode.cjs --prompt "..."   # one non-interactive run
```

A symlink named `zcode` on `PATH` is all an installation is. The terminal UI is loaded
from the checkout at run time, so the checkout has to stay where the link points.

Do not use upstream's `pnpm bootstrap`, `pnpm build` or `pnpm dev:*`: they install for
and build the other surfaces. Do not run a build you are testing by hand, either: it
contacts whatever its code and your own configuration tell it to. The rungs run it
where it can reach nothing.

## Differences

A **difference** is one thing the fork does that upstream does not, small enough to be
withdrawn on its own. It is one commit on the `fork` branch, holding its code, its
joins and its proof together, and it has one name: lower case, hyphenated, saying what
the fork does differently (`model-listings`, not `provider-changes`). The name is used
in three places, spelt the same in each.

| What                          | Where                              |
| ----------------------------- | ---------------------------------- |
| Code the difference adds      | `<package>/src/fork/<difference>/` |
| Its edits to upstream's files | marked `fork(<difference>): ...`   |
| Its proof                     | `fork/rungs/<difference>/`         |

The fork's own ground (this directory, and the pointer at the top of `AGENTS.md`) uses
the name `base`.

### Code the fork owns

New code goes in a `fork/<difference>/` directory inside the `src` of the package whose
layer it belongs to: a tool in `apps/zcode-cli/packages/core/src/fork/<difference>/`,
a command in `apps/zcode-cli/packages/cli/src/fork/<difference>/`, and so on. A
difference that reaches into several packages has a directory in each. The directory's
`index.ts` is the only file anything outside it imports.

A difference never imports from another difference's directory and never edits its
files. When two differences need the same code, it belongs to the one that lands first
and the other imports it through that `index.ts`; the later commit then cannot be
replayed without the earlier one, so its message says which it stands on. Two builders
who find the same need while both are still building raise it with the lead before
either writes it.

### Joins

A **join** is an edit to a file upstream ships. Each one is a place where a new
upstream release can conflict with the fork, so:

- A join imports from the difference's directory and calls it, and does nothing else.
  Logic, constants and messages live in the difference's directory, not in upstream's
  file.
- The line above a join is a comment `fork(<difference>): ` followed by what the fork
  does at that point, in the file's own comment syntax. `git grep -n "fork("` then lists
  every join, and a conflict names the difference it belongs to. A file format with no
  comments (JSON) takes the edit unmarked.
- A join sits beside the upstream line it relates to: a new option next to the option
  it resembles, a new command next to its neighbour in the `switch`. Do not append to the
  end of a list because the entry is new. Differences built at the same time then edit
  different lines of the files they share.
- To remove something upstream ships, cut it off where it is reached (its registration,
  its route, its menu entry) and leave a `fork(<difference>): ` comment in place of the
  line. The files that implemented it stay as upstream ships them; deleting them turns
  every later upstream change to them into a conflict.
- Change an upstream test, specification or document only when the build or
  `fork/check.mjs` fails without the change. Then make the smallest edit, or delete the
  test file when what it tested is gone.

In TypeScript a join looks like this:

```ts
import { runModelsCommand } from "./fork/models-command/index.js";
...
    case "doctor":
      return runDoctor(ctx, options, workingDirectory);
    // fork(models-command): prints every usable model as JSON
    case "models":
      return await runModelsCommand(ctx, options, commandDeps);
```

### What upstream's guidance still means here

`AGENTS.md` and the files it links are upstream's instructions for its own repository.
Follow what they say about the code where fork code meets it: logging, error handling,
which layer may do I/O, the dependency direction between packages. Their process does
not apply to fork work: no specification under `docs/` first, no
`pnpm architecture:adopt`, no root `pnpm typecheck` or `pnpm lint`, no pre-push hook, no
comments in Chinese. A difference is specified by the contract in the annexe, proved by
its rungs and gated by the two commands below. Comments and messages the fork writes are
in English.
