// Fixture process for resource-queue.test.mjs: holds a lock for `ms` milliseconds, appending a
// start and an end event (each tagged with this process's pid) to `logFile` as it does.
import { appendFileSync } from 'node:fs';
import { withLock } from '../../resource-queue.mjs';

const [, , resource, mode, ms, logFile] = process.argv;
const line = (event) => appendFileSync(logFile, JSON.stringify({ pid: process.pid, mode, event, t: Date.now() }) + '\n');

await withLock(resource, mode, async () => {
  line('start');
  await new Promise((r) => setTimeout(r, Number(ms)));
  line('end');
});
