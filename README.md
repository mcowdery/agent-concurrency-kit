# agent-concurrency-kit

Two small, dependency-free scripts for running several AI coding agents against one codebase at
once without them tripping over each other. No framework, no daemon, no config service — just git
worktrees and lockfiles, which is all this problem actually needs.

## The problem

Run two or more agents (Claude Code, Copilot, whatever) against the same checkout and you get, in
roughly this order:

- Two agents editing the same files, each unaware of the other's half-finished change.
- A long-running benchmark or GPU job whose timings get wrecked because a second agent kicked off
  another GPU-heavy process at the same moment.
- A dev server an agent is testing against getting reloaded mid-test because another agent saved an
  unrelated file.

None of this needs a platform. It needs isolation (each agent gets its own checkout) and a queue
(only one thing touches the contended resource at a time).

## `agent-worktree` — isolated checkouts per agent

```
npx agent-worktree add refactor-auth     # <repo>/.agents/refactor-auth, branch agent-refactor-auth,
                                          # dependencies installed, ready to hand to an agent
npx agent-worktree list                  # every worktree, its branch, what's uncommitted
npx agent-worktree remove refactor-auth  # once its work is merged back
```

Each worktree is a real, separate checkout: its own files, its own branch, its own
`node_modules`. An agent working in one never sees another agent's uncommitted edits, because
they're in different directories entirely. Local files that aren't in git (a `.env`, a credentials
file) are copied in automatically if you list them, one path per line, in an `.agentinclude` file at
your repo root. The install command defaults to `npm ci`; override it with the `INSTALL_CMD` env var
for pnpm, yarn, pip, or anything else — or set it to an empty string to skip installing.

The work comes back as ordinary commits on the worktree's branch — merge it from your main checkout
whenever you're ready.

## `agent-resource-queue` — one resource, no collisions

```
npx agent-resource-queue gpu exclusive -- npm run benchmark
```

Wraps a command so it waits its turn for the named resource before running. Any number of `shared`
holders run together; an `exclusive` holder waits for every other holder — shared or exclusive — to
finish, then blocks new ones until it's done. Nobody waits forever: if the resource is still busy
after 15 minutes (configurable via `AGENT_QUEUE_WAIT_MS`), the run goes ahead anyway rather than
hanging, and says so.

Use it as a library if you'd rather call it inline:

```js
import { withLock } from 'agent-concurrency-kit/resource-queue.mjs';

await withLock('gpu', 'exclusive', async () => {
  // only one exclusive holder of 'gpu' runs this at a time
});
```

A holder's lock is a file in the OS temp directory, named by its process id — if that process dies,
the next check clears the lock automatically, so a crashed run can't jam the queue.

## Install

Not yet published to npm. Use directly from GitHub:

```
npm install github:mcowdery/agent-concurrency-kit
```

or clone it and run the two scripts with `node` directly — there's nothing else to build.

## Tests

`npm test` runs the resource-queue behavior (exclusive holders never overlap, shared holders run
concurrently, an exclusive holder waits out a shared one already in flight) against real concurrent
child processes — `node --test test/*.test.mjs`.
