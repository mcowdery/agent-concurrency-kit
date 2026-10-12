import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../changes.mjs', import.meta.url));

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'ack-changes-'));
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  writeFileSync(join(repo, 'b.txt'), 'b\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  const env = { ...process.env, AGENT_CHANGES_DIR: join(dir, 'state'), AGENT_SESSION_ID: '' };
  const run = (args, extra = {}, input) =>
    spawnSync(process.execPath, [CLI, ...args], { cwd: repo, env: { ...env, ...extra }, encoding: 'utf8', input });
  const edit = (session, file, text) => {
    writeFileSync(join(repo, file), text);
    run(['hook'], {}, JSON.stringify({ hook_event_name: 'PostToolUse', session_id: session, cwd: repo, tool_input: { file_path: join(repo, file) } }));
  };
  return { repo, git, run, edit };
}

test('commit takes only this session\'s files and leaves the others dirty', () => {
  const { git, run, edit } = setup();
  edit('s1', 'a.txt', 'a1\n');
  edit('s2', 'b.txt', 'b2\n');
  edit('s1', 'new.txt', 'n\n');

  assert.equal(run(['list'], { AGENT_SESSION_ID: 's1' }).stdout.trim(), 'a.txt\nnew.txt');
  const r = run(['commit', '-m', 's1 work'], { AGENT_SESSION_ID: 's1' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(git('show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort(), ['a.txt', 'new.txt']);
  assert.match(git('status', '--porcelain'), /^ M b\.txt/m);
  assert.equal(run(['list'], { AGENT_SESSION_ID: 's1' }).stdout.includes('nothing'), true);
});

test('a file two sessions edited is left out unless --shared', () => {
  const { git, run, edit } = setup();
  edit('s1', 'a.txt', 'a1\n');
  edit('s2', 'a.txt', 'a2\n');
  edit('s1', 'b.txt', 'b1\n');

  const r = run(['commit', '-m', 'x'], { AGENT_SESSION_ID: 's1' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /leaving out a\.txt/);
  assert.equal(git('show', '--name-only', '--format=', 'HEAD').trim(), 'b.txt');

  const s = run(['commit', '-m', 'y', '--shared'], { AGENT_SESSION_ID: 's1' });
  assert.equal(s.status, 0, s.stderr);
  assert.equal(git('show', '--name-only', '--format=', 'HEAD').trim(), 'a.txt');
});

test('files another agent staged stay out of the commit', () => {
  const { git, run, edit } = setup();
  edit('s1', 'a.txt', 'a1\n');
  edit('s2', 'b.txt', 'b2\n');
  git('add', 'b.txt');
  run(['commit', '-m', 'only a'], { AGENT_SESSION_ID: 's1' });
  assert.equal(git('show', '--name-only', '--format=', 'HEAD').trim(), 'a.txt');
  assert.match(git('status', '--porcelain'), /^M  b\.txt/m);
});

test('with no session id, the only session with changes is used; two need --session', () => {
  const { run, edit } = setup();
  edit('s1', 'a.txt', 'a1\n');
  assert.equal(run(['list']).stdout.trim(), 'a.txt');
  edit('s2', 'b.txt', 'b2\n');
  assert.notEqual(run(['list']).status, 0);
  assert.equal(run(['list', '--session', 's2']).stdout.trim(), 'b.txt');
});
