#!/usr/bin/env node
// A lockfile queue for a resource only one agent should hammer at a time — a GPU, a port, a
// rate-limited API — so several coding agents running at once don't corrupt each other's results.
//
// Library:
//   import { withLock } from 'agent-concurrency-kit/resource-queue.mjs';
//   await withLock('gpu', 'exclusive', async () => { ...run the benchmark... });
//
// CLI, for wrapping any command:
//   npx agent-resource-queue <resource> <shared|exclusive> -- <command...>
//   npx agent-resource-queue gpu exclusive -- npm run benchmark
//
// Any number of 'shared' holders run at once; an 'exclusive' holder waits for every other holder
// (shared or exclusive) to finish, then blocks new ones until it's done. A holder's lock file
// (<pid>-<mode>.json> under the OS temp dir) is cleared automatically if its process has died, and
// nobody waits past WAIT_MS before going ahead anyway (slower, but never stuck).
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = join(tmpdir(), 'agent-concurrency-kit');
const WAIT_MS = Number(process.env.AGENT_QUEUE_WAIT_MS ?? 15 * 60e3);
const POLL_MS = Number(process.env.AGENT_QUEUE_POLL_MS ?? 500);

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

function holders(dir, selfPid) {
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const m = /^(\d+)-(shared|exclusive)\.json$/.exec(name);
    if (!m || Number(m[1]) === selfPid) continue;
    const pid = Number(m[1]);
    if (!alive(pid)) {
      try {
        unlinkSync(join(dir, name));
      } catch {}
      continue;
    }
    let info = {};
    try {
      info = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    } catch {}
    out.push({ pid, mode: m[2], since: info.since ?? 0, label: info.label ?? '?' });
  }
  return out;
}

/**
 * Waits for a turn on `resource`, runs `fn`, then releases — even if `fn` throws.
 * `mode` is 'shared' (any number run together) or 'exclusive' (has the resource alone).
 */
export async function withLock(resource, mode, fn, { label = `pid ${process.pid}` } = {}) {
  if (mode !== 'shared' && mode !== 'exclusive') throw new Error(`mode must be 'shared' or 'exclusive', got ${mode}`);
  const dir = join(ROOT, resource);
  mkdirSync(dir, { recursive: true });
  const since = Date.now();
  const file = join(dir, `${process.pid}-${mode}.json`);
  const take = () => writeFileSync(file, JSON.stringify({ label, since }));
  const drop = () => {
    try {
      unlinkSync(file);
    } catch {}
  };
  const ahead = (h) => (mode === 'shared' ? h.mode === 'exclusive' : h.mode === 'shared' || h.since < since || (h.since === since && h.pid < process.pid));

  if (mode === 'exclusive') take();
  const start = Date.now();
  let said = false;
  for (;;) {
    const before = holders(dir, process.pid).filter(ahead);
    if (!before.length) {
      if (mode === 'exclusive') break;
      take();
      if (!holders(dir, process.pid).some(ahead)) break;
      drop();
    } else if (Date.now() - start > WAIT_MS) {
      if (!said) {
        console.error(`${resource}: still busy after ${WAIT_MS / 60e3} min (${before.map((h) => h.label).join(', ')}); going ahead anyway`);
        said = true;
      }
      take();
      break;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  try {
    return await fn();
  } finally {
    drop();
  }
}

// --- CLI: `agent-resource-queue <resource> <mode> -- <command...>` ---
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const dashDash = args.indexOf('--');
  if (dashDash < 2 || dashDash === args.length - 1) {
    console.error('usage: agent-resource-queue <resource> <shared|exclusive> -- <command...>');
    process.exit(1);
  }
  const [resource, mode] = args;
  const command = args.slice(dashDash + 1);
  try {
    await withLock(resource, mode, () => {
      execFileSync(command[0], command.slice(1), { stdio: 'inherit' });
    }, { label: command.join(' ') });
  } catch (err) {
    process.exitCode = err.status ?? 1;
  }
}
