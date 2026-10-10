// A stand-in resource for the tests: a state kept in a file, with status / start / stop commands. A <file>.activity file of JSON is reported as who is using it.
//   node fakeres.mjs status <file>   prints the one line of JSON a status command should
//   node fakeres.mjs start <file>    "starting" now, "running" half a second later
//   node fakeres.mjs stop <file>
//   node fakeres.mjs broken          exits 3 with a message, like a status command that failed
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const [, , cmd, file] = process.argv;
const state = () => (existsSync(file) ? readFileSync(file, 'utf8').trim() : 'stopped');

if (cmd === 'status') {
  const st = state();
  console.log('noise before the answer is ignored');
  console.log(JSON.stringify({ state: st, title: 'Fake box', note: 'a test box', fields: [{ label: 'Cost', value: '$0.27/hr' }], actions: st === 'running' ? ['stop'] : st === 'stopped' ? ['start'] : [], ...(existsSync(file + '.activity') ? { activity: JSON.parse(readFileSync(file + '.activity', 'utf8')) } : {}) }));
} else if (cmd === 'start') {
  writeFileSync(file, 'starting');
  console.log('booting');
  await new Promise((resolve) => setTimeout(resolve, 500));
  writeFileSync(file, 'running');
  console.log('up');
} else if (cmd === 'stop') {
  writeFileSync(file, 'stopped');
  console.log('down');
} else if (cmd === 'broken') {
  console.error('the box is on fire');
  process.exit(3);
}
