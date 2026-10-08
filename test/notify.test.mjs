import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { applySettings, inQuietHours, labelFor } from '../notify.mjs';

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

// Starts `agent-notify dashboard` on a free port and resolves to its base url and a stop function.
function startDashboard(s) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [SCRIPT, 'dashboard'], { env: { ...s.env, AGENT_NOTIFY_PORT: '0' }, stdio: ['ignore', 'pipe', 'inherit'] });
    p.on('error', reject);
    p.stdout.on('data', (chunk) => {
      const m = /(http:\/\/localhost:\d+)/.exec(String(chunk));
      if (m) resolve({ url: m[1], stop: () => p.kill() });
    });
  });
}

test('the dashboard serves the board and what was announced', async () => {
  const s = sandbox();
  s.fire('UserPromptSubmit');
  s.fire('Notification', { message: 'Claude needs your permission to use Bash' });
  const { url, stop } = await startDashboard(s);
  try {
    const data = await (await fetch(`${url}/api/status`)).json();
    assert.equal(data.sessions.length, 1);
    assert.equal(data.sessions[0].state, 'waiting');
    assert.equal(data.sessions[0].notified.state, 'waiting');
    assert.match(data.sessions[0].notified.body, /permission/);
    assert.equal(data.mutedUntil, 0);
    assert.match(await (await fetch(url)).text(), /<h1>Sessions<[/]h1>/);
    assert.equal((await fetch(`${url}/nope`)).status, 404);
    // the background picture is optional: a 404 (not a crash) when no dashboard-bg.jpg sits beside the script
    assert.ok([200, 404].includes((await fetch(`${url}/background.jpg`)).status));
  } finally {
    stop();
  }
});

test('the dashboard refuses requests that name some other host', async () => {
  const s = sandbox();
  const { url, stop } = await startDashboard(s);
  try {
    const port = new URL(url).port;
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/status', headers: { host: 'evil.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 403);
  } finally {
    stop();
  }
});

test('settings are validated and unrelated config is kept', () => {
  const file = { ntfy: { topic: 'abc' }, somethingElse: 1 };
  const next = applySettings(file, { channels: ['dashboard', 'ntfy'], minSeconds: '5', webhook: '', quietHours: { start: '22:00', end: '07:00', allow: ['waiting'], channels: ['ntfy'] } });
  assert.deepEqual(next.channels, ['dashboard', 'ntfy']);
  assert.equal(next.minSeconds, 5);
  assert.equal(next.somethingElse, 1);
  assert.deepEqual(next.quietHours, { start: '22:00', end: '07:00', allow: ['waiting'], channels: ['ntfy'] });
  assert.equal(applySettings(next, { quietHours: null }).quietHours, undefined);

  assert.throws(() => applySettings({}, { channels: ['carrier-pigeon'] }), /unknown channel/);
  assert.throws(() => applySettings({}, { channels: ['ntfy'] }), /nothing to send to/);
  assert.throws(() => applySettings({}, { channels: ['command'] }), /nothing to send to/);
  assert.throws(() => applySettings({}, { webhook: 'javascript:alert(1)' }), /http/);
  assert.throws(() => applySettings({}, { ntfy: { topic: 'has spaces!' } }), /topic/);
  assert.throws(() => applySettings({}, { minSeconds: -3 }), /seconds/);
  assert.throws(() => applySettings({}, { quietHours: { start: 'late', end: '07:00' } }), /quiet hours/);
});

const post = (url, path, body, headers = {}) =>
  fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Notify': '1', ...headers }, body: JSON.stringify(body) });

test('the dashboard saves settings, and refuses writes that do not come from its own page', async () => {
  const s = sandbox();
  const { url, stop } = await startDashboard(s);
  try {
    const saved = await (await post(url, '/api/config', { channels: ['dashboard'], minSeconds: 7 })).json();
    assert.deepEqual(saved.channels, ['dashboard']);
    const onDisk = JSON.parse(readFileSync(join(s.dir, 'config.json'), 'utf8'));
    assert.deepEqual(onDisk.channels, ['dashboard']);
    assert.equal(onDisk.minSeconds, 7);

    // a bad value is a 400 with a readable message, and changes nothing
    const bad = await post(url, '/api/config', { channels: ['ntfy'] });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /nothing to send to/);
    assert.deepEqual(JSON.parse(readFileSync(join(s.dir, 'config.json'), 'utf8')).channels, ['dashboard']);

    // another site cannot do it: no custom header, wrong content type, or a foreign Origin
    const attempts = [
      fetch(url + '/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"command":"calc"}' }),
      fetch(url + '/api/config', { method: 'POST', headers: { 'X-Agent-Notify': '1', 'Content-Type': 'text/plain' }, body: '{"command":"calc"}' }),
      post(url, '/api/config', { command: 'calc' }, { Origin: 'https://evil.example' }),
    ];
    for (const r of await Promise.all(attempts)) assert.equal(r.status, 403);
    assert.equal(JSON.parse(readFileSync(join(s.dir, 'config.json'), 'utf8')).command, undefined);

    const muted = await (await post(url, '/api/mute', { duration: '1h' })).json();
    assert.ok(muted.mutedUntil > Date.now());
    assert.equal((await (await post(url, '/api/mute', { duration: 'off' })).json()).mutedUntil, 0);
    assert.equal((await post(url, '/api/mute', { duration: 'soon' })).status, 400);
  } finally {
    stop();
  }
});

// The page's sorting runs in the browser, so lift its sort code out of dashboard.html and run it here.
test('the page sorts sessions by status, name, time in state and last activity, both ways', () => {
  const html = readFileSync(fileURLToPath(new URL('../dashboard.html', import.meta.url)), 'utf8');
  const src = html.slice(html.indexOf('const STATE_RANK'), html.indexOf('function syncSortControls'));
  const sorter = new Function('pref', `${src}; return { sortRows, set(k, asc) { sortKey = k; sortAsc = asc; } };`)(() => null);
  const rows = [
    { label: 'beta', state: 'done', since: 100, updated: 300 },
    { label: 'alpha', state: 'running', since: 200, updated: 100 },
    { label: 'gamma', state: 'waiting', since: 300, updated: 200 },
    { label: 'Alpha2', state: 'done', since: 50, updated: 400 },
  ];
  // with nothing chosen yet, the most recently active session is on top: no scrolling to find it
  assert.equal(sorter.sortRows(rows).map((r) => r.label).join(','), 'Alpha2,beta,gamma,alpha');
  const order = (key, asc) => {
    sorter.set(key, asc);
    return sorter.sortRows(rows).map((r) => r.label).join(',');
  };
  assert.equal(order('status', true), 'gamma,alpha,beta,Alpha2'); // needs you, running, then done, the newest of each first
  assert.equal(order('status', false), 'Alpha2,beta,alpha,gamma');
  assert.equal(order('name', true), 'alpha,Alpha2,beta,gamma');
  assert.equal(order('name', false), 'gamma,beta,Alpha2,alpha');
  assert.equal(order('time', true), 'gamma,alpha,beta,Alpha2'); // shortest time in state first
  assert.equal(order('time', false), 'Alpha2,beta,alpha,gamma');
  assert.equal(order('activity', true), 'alpha,gamma,beta,Alpha2'); // least recently active first
  assert.equal(order('activity', false), 'Alpha2,beta,gamma,alpha');
  assert.equal(rows[0].label, 'beta'); // sorting works on a copy
});

test('sessions whose Claude Code process is gone, or that look cut off, leave the board', () => {
  const s = sandbox();
  const board = join(s.dir, 'board');
  mkdirSync(board, { recursive: true });
  const now = Date.now();
  const hoursAgo = (h) => now - h * 3600e3;
  const put = (id, rec) => writeFileSync(join(board, `${id}.json`), JSON.stringify({ session: id, since: rec.updated, ...rec }));
  const deadPid = spawnSync(process.execPath, ['-e', '']).pid; // a process that has already exited

  put('dead-process', { label: 'p-dead', state: 'running', updated: now - 60e3, pid: deadPid });
  put('live-process', { label: 'p-live', state: 'running', updated: hoursAgo(5), pid: process.pid }); // quiet for hours, but still alive
  put('stuck-legacy', { label: 'p-stuck', state: 'running', updated: hoursAgo(4) }); // no pid recorded, cut off
  put('long-wait', { label: 'p-wait', state: 'waiting', updated: hoursAgo(4) }); // a blocked agent is not dropped on age alone
  put('recent-done', { label: 'p-done', state: 'done', updated: hoursAgo(1) });

  const shown = s.cli(['status']).stdout;
  assert.doesNotMatch(shown, /p-dead/);
  assert.doesNotMatch(shown, /p-stuck/);
  assert.match(shown, /p-live/);
  assert.match(shown, /p-wait/);
  assert.match(shown, /p-done/);
});

test('the hook records the Claude Code process id', () => {
  const s = sandbox({ CLAUDE_PID: String(process.pid) });
  s.fire('UserPromptSubmit');
  const file = readdirSync(join(s.dir, 'board')).find((n) => n.endsWith('.json'));
  assert.equal(JSON.parse(readFileSync(join(s.dir, 'board', file), 'utf8')).pid, process.pid);
});
