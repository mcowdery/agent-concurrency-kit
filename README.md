# agent-concurrency-kit

Three small, dependency-free scripts for running several AI coding agents against one codebase at
once without them tripping over each other. No framework, no config service — just git worktrees,
lockfiles and a few Claude Code hooks, which is all this problem actually needs.

## The problem

Run two or more agents (Claude Code, Copilot, whatever) against the same checkout and you get, in
roughly this order:

- Two agents editing the same files, each unaware of the other's half-finished change.
- A long-running benchmark or GPU job whose timings get wrecked because a second agent kicked off
  another GPU-heavy process at the same moment.
- A dev server an agent is testing against getting reloaded mid-test because another agent saved an
  unrelated file.
- Five sessions running, and no way to know which one finished an hour ago or has been waiting on a
  permission prompt since lunch, short of clicking through every terminal.

None of this needs a platform. It needs isolation (each agent gets its own checkout), a queue (only
one thing touches the contended resource at a time), and a way to hear from them (a notification
when one finishes or needs you).

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

## `agent-notify` — hear from your agents instead of checking on them

```
npx agent-notify setup          # one-time: adds the hooks to Claude Code
npx agent-notify dashboard      # a live page of every session, at http://localhost:7878
npx agent-notify status         # the same board in the terminal
npx agent-notify autostart on   # start the dashboard at login (Windows; `off` undoes it)
npx agent-notify mute 2h        # silence alerts for a while (30m, 1d, off)
npx agent-notify test           # send a sample to each channel, to check it reaches you
```

`setup` adds Claude Code hooks to `~/.claude/settings.json` (your other settings and hooks are
left alone; `setup --remove` takes them back out), so every project and every `agent-worktree`
checkout is covered without per-repo configuration. Sessions in a worktree are named
`<project>/<worktree>`. You are alerted when a session **finishes** and when it **needs you** (a
permission prompt, a question). Not when it starts, and not for the "still waiting for your input"
reminder Claude Code repeats after a finish. Turns shorter than 20 seconds are not announced as
finished (you were watching).

### The dashboard

`npx agent-notify dashboard` serves a page on `localhost:7878` (`--open` opens it; `AGENT_NOTIFY_PORT`
changes the port). Pin the tab.

- **Every session at a glance**, with a status icon (needs you, running, finished), how long it has
  been in that state, Claude's message when it is waiting on you, and a link that opens the folder
  in VS Code. The tab title shows how many are waiting on you, and its icon changes colour.
- **Sorted the way you need:** newest activity first by default. Icon buttons sort by last
  activity, status, name, or time in state; click the active one (or the arrow) to reverse. Switch
  between a compact list and cards. Both choices are remembered by the browser.
- **Browser notifications** (click the bell once to allow): a finished or blocked session raises a
  notification, and clicking it brings the tab forward. Optional sound.
- **A settings page** (the sliders icon): switch each channel on or off and send a test to it,
  edit the ntfy topic, webhook and command, set the minimum turn length and quiet hours, and mute.
  Changes are saved to the config file and apply to the next alert.
- **Safe to leave running:** it listens on this machine only, refuses requests that name any other
  host, and only accepts settings changes from its own page, since a setting can make this machine
  run a command.
- **A background picture is optional:** put a `dashboard-bg.jpg` (or `.png`, `.webp`) next to
  `notify.mjs` and the page uses it behind a dark overlay. It is git-ignored, so yours is never
  committed by accident.

The dashboard only runs while its command does. On Windows, `npx agent-notify autostart on` puts a
shortcut in your Startup folder so it comes back at every login, with no console window;
`autostart off` removes it. Elsewhere, start `node notify.mjs dashboard` from your login items or a
systemd user service.

### Channels

| Channel | What it is | Setup |
|---|---|---|
| `dashboard` | Browser notifications from the dashboard tab (the tab must stay open) | Click the bell on the page |
| `toast` | Desktop notification: Windows 10/11, macOS, or Linux (`notify-send`) | On by default |
| `ntfy` | Phone push through the free [ntfy](https://ntfy.sh) app; "needs you" arrives at higher priority | `setup --ntfy`, then subscribe to the printed topic in the app |
| `webhook` | Discord or Slack channel message | `"webhook": "<url>"` |
| `command` | Anything else: runs your command with `AGENT_NOTIFY_TITLE`, `_BODY`, `_STATE`, `_LABEL` set | `"command": "..."` |

Two honest limits of the desktop toast: on Windows, clicking it does nothing (Windows does not
deliver clicks to toasts from a plain script, however it is registered; this was tried several ways),
and Do Not Disturb hides it. That is why the dashboard exists: its browser notifications are
clickable and its page does not depend on either. The phone push is an optional extra, not the
main route.

Configuration is `~/.agent-notify.json` (each key also has an `AGENT_NOTIFY_*` env var; see the top
of `notify.mjs`), and the settings page edits it for you. ntfy and webhook turn on once configured;
set `"channels": [...]` to choose explicitly. Messages carry only the project name and Claude Code's
own status text, never code or output. For ntfy.sh the topic name is the only secret, which is why
`setup --ntfy` generates a random one; or point `ntfy.server` at one you host yourself.

### Quiet hours and mute

`npx agent-notify mute 2h` (or the buttons on the settings page) silences every channel for a
while, say for a meeting. For a nightly schedule add this to the config, or use the settings page:

```json
{ "quietHours": { "start": "22:00", "end": "07:00", "allow": ["waiting"], "channels": ["ntfy"] } }
```

Local time, and the window may cross midnight. `allow` lists what still gets through (default
`"waiting"`: a blocked agent matters more than a finished one; `[]` silences everything);
`channels` limits which channels go quiet, e.g. only the phone (default: all). Muted or held-back
events still update the board, so it shows what finished overnight.

### How the board stays honest

The board is a small file per session under the OS temp dir. A session leaves it when Claude Code
reports the session ended, when the Claude Code process that owned it has exited, or, for a session
recorded without a process id, after 3 hours of "running" with no event at all. (Claude Code sends
no "finished" when you interrupt a turn with Esc, so without this a cut-off turn would show as
running for hours.)

"Running" is set by a prompt, and also by tool use: a turn that no prompt started (a scheduled
wake-up, a queued command, a finished background task) shows as running as soon as the agent uses
a tool, and a session that was waiting on you returns to running when its tool call completes.
These tool events only update the board, never alert, and cost about 10 ms over a bare Node start
because a session already running is not rewritten more than every 15 seconds. A session that is
quietly thinking with no tool call yet can still read as "done" for a moment. A channel that fails
never interrupts the session; errors are appended to `errors.log` next to the board.

## Install

Not yet published to npm. Use directly from GitHub:

```
npm install github:mcowdery/agent-concurrency-kit
```

or clone it and run the scripts with `node` directly — there's nothing else to build.

## Tests

`npm test` runs `node --test test/*.test.mjs`. The resource-queue tests (exclusive holders never
overlap, shared holders run concurrently, an exclusive holder waits out a shared one already in
flight) use real concurrent child processes. The notify tests drive the real hook with Claude Code's
JSON and check what would be sent, the board and its clean-up, mute and quiet hours, the dashboard's
API (including that a foreign page cannot change your settings), the page's sorting, and that
`setup` edits settings safely.
