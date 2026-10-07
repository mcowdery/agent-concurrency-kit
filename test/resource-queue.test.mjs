import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const FIXTURE = fileURLToPath(new URL('./fixtures/hold.mjs', import.meta.url));

function hold(resource, mode, ms, logFile) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [FIXTURE, resource, mode, String(ms), logFile], {
      stdio: 'inherit',
      env: { ...process.env, AGENT_QUEUE_POLL_MS: '30' },
    });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`fixture exited ${code}`))));
  });
}

function events(logFile) {
  return readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function intervals(evts) {
  const byPid = new Map();
  for (const e of evts) {
    const i = byPid.get(e.pid) ?? {};
    i[e.event] = e.t;
    byPid.set(e.pid, i);
  }
  return [...byPid.values()];
}

test('exclusive holders never overlap', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ack-test-'));
  const logFile = join(dir, 'log.ndjson');
  const resource = `test-exclusive-${Date.now()}`;

  await Promise.all([hold(resource, 'exclusive', 200, logFile), hold(resource, 'exclusive', 200, logFile)]);

  const [a, b] = intervals(events(logFile));
  const overlap = a.start < b.end && b.start < a.end;
  assert.equal(overlap, false, `exclusive holders overlapped: ${JSON.stringify({ a, b })}`);
});

test('shared holders run concurrently', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ack-test-'));
  const logFile = join(dir, 'log.ndjson');
  const resource = `test-shared-${Date.now()}`;

  await Promise.all([hold(resource, 'shared', 200, logFile), hold(resource, 'shared', 200, logFile)]);

  const [a, b] = intervals(events(logFile));
  const overlap = a.start < b.end && b.start < a.end;
  assert.equal(overlap, true, `shared holders should have overlapped: ${JSON.stringify({ a, b })}`);
});

test('an exclusive holder waits out a shared one already running', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ack-test-'));
  const logFile = join(dir, 'log.ndjson');
  const resource = `test-mixed-${Date.now()}`;

  await Promise.all([hold(resource, 'shared', 250, logFile), hold(resource, 'exclusive', 50, logFile)]);

  const evts = events(logFile);
  const sharedEnd = evts.find((e) => e.mode === 'shared' && e.event === 'end').t;
  const exclusiveStart = evts.find((e) => e.mode === 'exclusive' && e.event === 'start').t;
  assert.ok(exclusiveStart >= sharedEnd, `exclusive started (${exclusiveStart}) before shared ended (${sharedEnd})`);
});
