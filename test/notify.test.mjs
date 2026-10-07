import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { inQuietHours, labelFor } from '../notify.mjs';

const RECORDER = fileURLToPath(new URL('./fixtures/record.mjs', import.meta.url)).split('\\').join('/');
const SCRIPT = fileURLToPath(new URL('../notify.mjs', import.meta.url));

// An isolated board, config and settings file per test; the `command` channel appends to a log
// so the test can see exactly what would have been sent.
function sandbox(extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ack-notify-'));
  const log = join(dir, 'sent.log');
  const env = {
    ...process.env,
    AGENT_NOTIFY_DIR: join(dir, 'board'),
    AGENT_NOTIFY_CONFIG: join(dir, 'config.json'),
    AGENT_NOTIFY_SETTINGS: join(dir, 'settings.json'),
    AGENT_NOTIFY_CHANNELS: 'command',
    AGENT_NOTIFY_COMMAND: `node "${RECORDER}"`,
    AGENT_NOTIFY_TEST_LOG: log,
    AGENT_NOTIFY_MIN_SECONDS: '0',
    ...extraEnv,
  };
  const cli = (args, input) => spawnSync(process.execPath, [SCRIPT, ...args], { env, input, encoding: 'utf8' });
  const fire = (event, extra = {}) => cli(['hook'], JSON.stringify({ hook_event_name: event, session_id: 's1', cwd: dir, ...extra }));
  const sent = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []);
  return { dir, env, cli, fire, sent };
}

test('labels a worktree as project/name and anything else by folder', () => {
  assert.equal(labelFor(['C:', 'code', 'acme', '.agents', 'refactor-auth'].join(String.fromCharCode(92))), 'acme/refactor-auth');
  assert.equal(labelFor('/home/me/acme/.agents/docs/src'), 'acme/docs');
  assert.equal(labelFor('/home/me/acme'), 'acme');
});

test('finishing a turn sends one notification and the board shows it done', () => {
  const s = sandbox();
  s.fire('UserPromptSubmit');
  assert.match(s.cli(['status']).stdout, /running/);
  s.fire('Stop');
  assert.equal(s.sent().length, 1);
  assert.match(s.sent()[0], /^done\|.*\|finished/);
  assert.match(s.cli(['status']).stdout, /done/);
});

test('a short turn is not announced but is still recorded', () => {
  const s = sandbox({ AGENT_NOTIFY_MIN_SECONDS: '600' });
  s.fire('UserPromptSubmit');
  s.fire('Stop');
  assert.deepEqual(s.sent(), []);
  assert.match(s.cli(['status']).stdout, /done/);
});

test('needing you notifies, but the idle reminder after a finish does not', () => {
  const s = sandbox();
  s.fire('UserPromptSubmit');
  s.fire('Notification', { message: 'Claude needs your permission to use Bash' });
  assert.equal(s.sent().length, 1);
  assert.match(s.sent()[0], /^waiting\|.*\|Claude needs your permission/);
  assert.match(s.cli(['status']).stdout, /waiting/);

  s.fire('Stop');
  s.fire('Notification', { message: 'Claude is waiting for your input' });
  assert.equal(s.sent().length, 2); // permission + finished, nothing for the idle ping
  assert.match(s.cli(['status']).stdout, /done/);
});

test('a session that ends leaves the board', () => {
  const s = sandbox();
  s.fire('UserPromptSubmit');
  s.fire('SessionEnd');
  assert.match(s.cli(['status']).stdout, /no Claude Code sessions/);
});

test('setup adds the hooks once, keeps the rest of settings, and removes cleanly', () => {
  const s = sandbox();
  const settings = join(s.dir, 'settings.json');
  writeFileSync(settings, JSON.stringify({ model: 'x', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } }));
  s.cli(['setup']);
  s.cli(['setup']);
  const added = JSON.parse(readFileSync(settings, 'utf8'));
  assert.equal(added.model, 'x');
  assert.equal(added.hooks.Stop.length, 2);
  assert.equal(added.hooks.Notification.length, 1);

  s.cli(['setup', '--remove']);
  const removed = JSON.parse(readFileSync(settings, 'utf8'));
  assert.deepEqual(removed.hooks.Stop, [{ hooks: [{ type: 'command', command: 'echo mine' }] }]);
  assert.equal(removed.hooks.Notification, undefined);
});

test('setup refuses to overwrite a settings file it cannot parse', () => {
  const s = sandbox();
  const settings = join(s.dir, 'settings.json');
  writeFileSync(settings, '{ not json');
  assert.notEqual(s.cli(['setup']).status, 0);
  assert.equal(readFileSync(settings, 'utf8'), '{ not json');
});

test('setup --ntfy makes a private topic and keeps it on rerun', () => {
  const s = sandbox();
  s.cli(['setup', '--ntfy']);
  const topic = JSON.parse(readFileSync(join(s.dir, 'config.json'), 'utf8')).ntfy.topic;
  assert.match(topic, /^claude-[a-z0-9]{12,}$/);
  s.cli(['setup', '--ntfy']);
  assert.equal(JSON.parse(readFileSync(join(s.dir, 'config.json'), 'utf8')).ntfy.topic, topic);
});

const at = (h, m = 0) => new Date(2026, 0, 1, h, m);

test('quiet hours handle windows that cross midnight', () => {
  const night = { start: '22:00', end: '07:00' };
  assert.equal(inQuietHours(at(23), night), true);
  assert.equal(inQuietHours(at(3), night), true);
  assert.equal(inQuietHours(at(7), night), false);
  assert.equal(inQuietHours(at(12), night), false);
  assert.equal(inQuietHours(at(13), { start: '12:00', end: '14:00' }), true);
  assert.equal(inQuietHours(at(15), { start: '12:00', end: '14:00' }), false);
  assert.equal(inQuietHours(at(12), { start: '09:00' }), false);
  assert.equal(inQuietHours(at(12), { start: '09:00', end: '09:00' }), false);
});

// A window that surrounds the moment the test runs, wherever midnight falls.
function windowAroundNow(extra = {}) {
  const hhmm = (offsetMin) => {
    const d = new Date(Date.now() + offsetMin * 60e3);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  return { start: hhmm(-60), end: hhmm(60), ...extra };
}

test('quiet hours hold back "finished" but let "needs you" through', () => {
  const s = sandbox();
  writeFileSync(join(s.dir, 'config.json'), JSON.stringify({ quietHours: windowAroundNow() }));
  s.fire('UserPromptSubmit');
  s.fire('Stop');
  assert.deepEqual(s.sent(), []);
  assert.match(s.cli(['status']).stdout, /done/);

  s.fire('UserPromptSubmit');
  s.fire('Notification', { message: 'Claude needs your permission to use Bash' });
  assert.equal(s.sent().length, 1);
  assert.match(s.sent()[0], /^waiting\|/);
});

test('quiet hours can be limited to some channels', () => {
  const s = sandbox();
  writeFileSync(join(s.dir, 'config.json'), JSON.stringify({ quietHours: windowAroundNow({ channels: ['ntfy'] }) }));
  s.fire('UserPromptSubmit');
  s.fire('Stop');
  assert.equal(s.sent().length, 1); // the command channel is not in the quiet list
});

test('mute silences every channel until it is lifted, and the board keeps updating', () => {
  const s = sandbox();
  assert.match(s.cli(['mute', '2h']).stdout, /muted until/);
  s.fire('UserPromptSubmit');
  s.fire('Notification', { message: 'Claude needs your permission to use Bash' });
  s.fire('Stop');
  assert.deepEqual(s.sent(), []);
  assert.match(s.cli(['status']).stdout, /done[\s\S]*muted until/);

  assert.match(s.cli(['mute', 'off']).stdout, /unmuted/);
  s.fire('UserPromptSubmit');
  s.fire('Stop');
  assert.equal(s.sent().length, 1);
});

test('mute rejects a duration it cannot read', () => {
  assert.notEqual(sandbox().cli(['mute', 'soon']).status, 0);
});
