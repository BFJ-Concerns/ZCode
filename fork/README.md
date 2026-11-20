# The fork

This checkout is ZCode as upstream ships it, plus a small number of differences. The
fork builds, runs and proves only the terminal UI and the command line: `@zcode/cli`
under `apps/zcode-cli`, the workspace packages it depends on, and its bundled
plugins. The desktop app, the browser interface and the mobile app stay in the tree
exactly as upstream ships them and are never built here.

This directory holds everything about the fork that is not a difference itself: these
rules, the build, the two commands that gate a change, the harness the proofs run on,
and the proofs.

## Build and run

```sh
node fork/build.mjs
```

installs the dependencies of `@zcode/cli` from the lockfile and builds it with the
packages it depends on. It also builds the document viewers, Browser Use's client and
shared Node REPL host, and the Android and iOS simulator servers. Content-only plugins
seed directly from the checkout. The build needs pnpm at the version in `mise.toml`, a
Node that provides `node:ffi` (26.12.1, say), and the npm registry (or a pnpm store that
already has the packages) the first time. The Node 24.14.0 that upstream's `mise.toml`
pins builds the fork but has no `node:ffi`, so on it the terminal-node-ffi start-up rung
cannot exercise its behaviour and skips, and a skipped rung fails its file: `node
fork/rungs.mjs` cannot pass there.

Every entry in the bundled catalogue seeds a complete local cache in a fresh CLI home.

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
  does at that point, in the file's own comment syntax. A conflict names the difference
  it belongs to. To list the marked joins, run:

  ```sh
  git grep -nE 'fork\([a-z0-9-]+\): ' -- . ':(exclude)fork/README.md'
  ```

  A file format with no comments (JSON) takes the edit unmarked.

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
import { runModelsCommand } from "./fork/model-listings/index.js";
...
    case "commands":
      return await runCommandsCommand(ctx, options, commandDeps, parsed.positionals.slice(1));
    // fork(model-listings): prints every usable model as JSON
    case "models":
      return await runModelsCommand(ctx, commandDeps, parsed.positionals.slice(1));
```

### What upstream's guidance still means here

`AGENTS.md` and the files it links are upstream's instructions for its own repository.
Follow what they say about the code where fork code meets it: logging, error handling,
which layer may do I/O, the dependency direction between packages. Their process does
not apply to fork work: no specification under `docs/` first, no
`pnpm architecture:adopt`, no root `pnpm typecheck` or `pnpm lint`, no pre-push hook, no
comments in Chinese. A difference is specified by the contract in the annexe (the
`ZCode-Annexe` repository, checked out beside this one), proved by its rungs and gated by
the two commands below. Comments and messages the fork writes are
in English.

## Proof

Each difference is proved by **rungs**: checks that drive the built `zcode` from outside
and observe what arrives at a receiver. The annexe's `VERIFICATION.md` says what each
rung must observe; this section says how one is written and run.

```sh
node fork/rungs.mjs                    # build, then every rung
node fork/rungs.mjs model-listings     # only rung files whose path contains the text
node fork/rungs.mjs --no-build base    # against the build already in place
```

A rung file is `fork/rungs/<difference>/<subject>.rung.mjs`: plain JavaScript using
`node:test`, importing nothing but Node and `fork/harness/`. Fixtures that only one
difference needs (a listing in some provider's shape, say) sit beside its rungs.
`fork/rungs/base/bundled-plugins.rung.mjs` is the one exception: it also reads
upstream's release recipe, `apps/zcode-cli/packages/cli/scripts/sea-official-plugin-assets.mjs`,
for the files each bundled plugin must carry, so that a plugin a release adds is held
to what upstream says of it.
`fork/rungs/base/receivers.rung.mjs` is the one to copy, and
`fork/rungs/base/terminal-ui.rung.mjs` the one for a rung that drives the terminal UI.

### Where a rung runs

`fork/rungs.mjs` runs each rung file in a sealed sandbox of its own, built from Linux
namespaces:

- The network is a loopback interface and nothing else. The stand-ins a rung starts are
  the only hosts there are; no packet can leave the machine.
- Everything that tries to leave is refused at once and recorded, whichever process
  tried: `zcode`, a command the agent ran, or the rung. Host names are recorded when they
  are looked up, and every TCP or UDP destination outside loopback, IPv4 or IPv6, when a
  packet is sent. A name keeps the address it was given for the whole file, so a
  connection is recorded under the name that was looked up for it, even when it is made
  after the record was forgotten.
- `/tmp` and `/run` are empty and private, so the homes a rung creates there vanish
  with the sandbox. The rest of the host filesystem remains readable wherever
  your user has access, including your real home directory. A Unix socket outside
  `/tmp` and `/run` can still be reached: the sandbox seals the network, not the
  filesystem.
- The rung and every `zcode` it launches run as you, not as root, and every process
  left running dies when the file finishes.

Rung files run side by side, so a file cannot see another file's stand-ins, homes or
record. Tests within a file run one after another and share its sandbox.

### The harness

| Module                        | What a rung gets from it                                                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `harness/owner-home.mjs`      | A fresh home directory holding the owner's configuration files, and the environment that makes `zcode` use it.                                    |
| `harness/model-provider.mjs`  | A stand-in provider: serves a model listing, answers model requests from a script (`say`, `callTool`, `fail`, `hang`), records every request.     |
| `harness/searxng.mjs`         | A stand-in SearXNG instance with JSON enabled: answers a search in JSON only when it asks for `format=json`, records every query.                 |
| `harness/http-proxy.mjs`      | A stand-in HTTP proxy: records every destination it is asked to reach, reaches none.                                                              |
| `harness/launcher.mjs`        | Runs `zcode` as Ensemble's command-line engine runs a worker: prompt as one argument, stdout apart from stderr, exit status, a signal to stop it. |
| `harness/terminal-ui.mjs`     | Runs the terminal UI in a terminal of its own: types and submits prompts, waits for text to be on the screen, leaves with Ctrl-C from any screen. |
| `harness/network-sandbox.mjs` | The sandbox's record of attempts to leave, and names pointed at a stand-in.                                                                       |

`harness/zcode-processes.mjs` is the harness's own: it keeps track of every `zcode` the
launcher and the terminal UI start, so that removing a home first ends every `zcode`
started in it, with everything that `zcode` started, and so that a wait on the provider
stand-in knows when no `zcode` is left to call it.

### Writing a rung

- One `test` for each observation `VERIFICATION.md` asks for, named for what is
  observed, so a failure reads as the broken promise.
- Observe at the receiver: the requests the provider recorded, the queries SearXNG
  recorded, the sandbox's attempts, the run's output and exit status. A rung never
  imports the fork's source, and looks inside the home only when the promise is about
  what is stored there.
- Wait for the thing itself: `run.event(...)` for a line `zcode` prints,
  `provider.request(...)` for a request to arrive, `ui.shows(...)` for text on the
  terminal UI's screen, `run.outcome` for the exit. Each of these fails at once, with what
  `zcode` printed or showed, when `zcode` ends or cannot start before the thing arrives.
  Never sleep and never poll with a time limit of your own; a test that has not finished
  in two minutes is failed by the runner.
- A rung that drives the terminal UI scripts the provider's replies with a function, not
  a list: the UI asks the model for a session title beside the first turn, and either
  request can come first. `asksForSessionTitle(request)` tells the two apart.
- A rung that cannot exercise its behaviour where it runs, on the Node running it say,
  calls `t.skip(reason)`. The runner prints the reason and counts the file as failed: a
  skipped or to-do test has not passed.
- Each test creates its own home and stand-ins and hands them to `t.after`. Removing a
  home ends every `zcode` started in it, so the order of the `t.after` calls does not
  matter. A file whose tests read the sandbox's record starts each test with
  `beforeEach(forgetAttempts)`, which also forgets the names pointed at stand-ins.
- When a rung needs something of the harness that any difference could use (another
  kind of reply, a driver for the interactive terminal UI), it goes into the harness
  module it belongs to, in the commit of the difference that first needs it.

### Z.ai silence

The official marketplace list reports a bundled source and counts the entries in the
catalogue that ships with the build. The base bundled-plugins rung checks the files in
the cache of every entry that the CLI offers. An explicit install from that catalogue
reports a plugin it does not carry as unavailable in this build.

An unnamed marketplace refresh updates the owner's known catalogues and omits the bundled
official catalogue from both its work and its diagnostics. An explicit request to refresh
that catalogue explains that it is bundled. The CLI's connection guard checks the Node
destination, including request options merged with a URL and requests through the owner's
proxy. Document setup without a named font mirror uses installed fonts and reports what it
finds.

## The gates

Two commands gate every change to the fork and every upstream release brought in. Each
works in a fresh worktree and installs and builds what it needs.

| Command               | What it runs                                                                                                                                                                                                                                                                                                                            | What it needs installed                                                                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node fork/check.mjs` | The build; the type check and upstream's lint of `@zcode/cli` and the packages it depends on; lint and format of every file the fork owns, everything under `fork/` and in a `src/fork/` directory, each by the formatter of the workspace it is in, with its Python read as Python. A file the fork owns that no check reads fails it. | pnpm as in `mise.toml`, a Node with `node:ffi` (see [Build and run](#build-and-run)), and `python3`; the npm registry or a warm pnpm store.               |
| `node fork/rungs.mjs` | The build, then every rung.                                                                                                                                                                                                                                                                                                             | The same, on Linux with unprivileged user namespaces allowed, and `unshare` and `mount` (util-linux), `ip` (iproute2) and `nft` (nftables) on the `PATH`. |

Upstream's own unit tests, architecture checks and whole-repository `typecheck` are not
gates here: they cover surfaces the fork does not build and a process it does not
follow.

## Bringing in an upstream release

`main` holds upstream's releases exactly as published, and `fork` is the release it is
built on plus the commits of its differences. To bring in a newer release, run this
from a checkout of the fork:

```sh
node fork/bring-in-release.mjs v3.19.0        # a tag, or the release's commit on main
```

The process makes a worktree at `<repository>-Worktrees/bring-in-<release>` beside the
repository, on a branch of the same name cut from the release. It replays the fork's
differences there one at a time, in the fork's order, and runs both gates after each
one. The first difference that conflicts with the release or fails a gate is therefore
the one the release broke.

- **Every difference replayed and proven:** `fork` moves to the result, and the worktree
  and its branch are removed. Where `fork` is checked out, its checkout moves with it,
  keeping changes no commit holds in files the release leaves alone.
- **Proven, but `fork` cannot move:** the result waits on the branch, and the account
  gives the command that finishes the job. If `fork`'s checkout holds changes the move
  would overwrite, put them aside and run the same command again; it moves `fork`
  without gating again. If `fork` moved while the release was being brought in, it is
  left as it is, because the replay lacks its new commits, and the account gives the
  command that starts again from it.
- **A difference broken:** the process stops there. `fork` stays where it was, and the
  worktree holds the replay as far as it got. A conflicting difference is left mid
  cherry-pick; a difference that failed a gate is the branch's last commit, and the
  gates' output is in the log the account names. Files the gates left in the worktree
  are named in the account and cleared away.

The process exits 0 when it moved `fork`, 1 when the replay stopped at a difference,
2 when it refused to start or resume, and 3 when the proven result waits on its branch
for the owner. Both a checked-out and an unchecked branch must still point to the
commit the replay started from when Git locks the reference for the move.

The process prints an account of the release for the owner: what it did to
each difference, including which of its changes the release already makes, what was
proven at each step, what it changed in the packages the command line builds from, and
which changed packages hold none of the fork's code or joins. `--account <file>` also writes the account to a file.

The process tells differences apart by their names (see [Differences](#differences)).
A later commit that carries only names an earlier difference holds is a repair of that
difference, and is folded into its commit as the release is brought in. A repair made on
top of a later difference does not apply without it, so it is replayed as a step of its
own directly after that difference, and the account names it after both and lists it
among the repairs that keep the fork from being one commit for each difference. Until
the owner folds each into its difference's commit, `fork` does not move: the result
waits on the branch, and the account gives the command that starts again once the
repairs are folded, and the one that moves `fork` with them as they are
(`--keep-separate-repairs`). A repair to
`base` that changes a harness file or README lines a difference brought is one of these.
A commit that carries no name belongs to `base`. A commit is the unit of a difference, so one that
brings in several new names is one difference carrying them all, and the account
labels it with each. A later commit that changes two differences together cannot be
attributed to either, so the process stops before replaying anything and names the
commit. Only markers in files upstream ships count: text in `fork/` or a `src/fork/`
directory is never read as a join.

To rework a broken difference, fix it in the worktree: resolve the conflict and
`git cherry-pick --continue`, or amend the commit. Then run the same command again. Only
committed rework counts: the process refuses to go on while the worktree holds changes
no commit holds. It gates the reworked step and carries on with the next difference. Rework may change how
a difference is done but not what it promises, and it may not weaken its rungs; a change
to either goes to the owner. When upstream comes to provide what a difference added, the
difference keeps its rungs and loses its code.

The process never pushes. Moving `fork` rewrites its history, so it is published with a
push that replaces `fork` on origin only if origin still holds the fork the release
was brought into; the account gives the command.
