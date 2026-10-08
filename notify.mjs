#!/usr/bin/env node
// Tells you when a Claude Code session has finished or is stuck waiting on you, across every
// project and agent worktree at once, and keeps a one-glance board of what each session is doing.
//
//   npx agent-notify setup [--ntfy] [--remove]   add (or remove) the Claude Code hooks in
//                                                ~/.claude/settings.json; --ntfy also creates a
//                                                private phone-push topic and prints it
//   npx agent-notify status                      every live session: waiting / running / done
//   npx agent-notify dashboard [--open]          the same board as a live page on http://localhost:7878,
//                                                with clickable browser notifications; pin the tab
//   npx agent-notify test                        send a sample to each configured channel
//   npx agent-notify mute <2h|30m|off>           silence every channel for a while (the board
//                                                still updates); `mute` alone says if you are muted
//
// `agent-notify hook` is what the installed hooks run: it reads Claude Code's hook JSON on stdin,
// updates the board, and sends a notification for "finished" and "needs you" (not for "started").
// Sessions in an `agent-worktree` checkout show up as <project>/<worktree-name>.
//
// Channels (config in ~/.agent-notify.json, each overridable by an env var):
//   toast    desktop notification — Windows 10/11, macOS or Linux (notify-send). On by default.
//   ntfy     phone push via ntfy.sh (or your own server): {"ntfy": {"topic": "...", "server": "..."}}
//            or AGENT_NOTIFY_NTFY_TOPIC. Turns on by itself once a topic is set.
//   webhook  JSON POST for Discord or Slack: {"webhook": "https://..."} or AGENT_NOTIFY_WEBHOOK.
//   command  run anything you like with AGENT_NOTIFY_TITLE / _BODY / _STATE / _LABEL in its
//            environment: {"command": "..."} or AGENT_NOTIFY_COMMAND.
// Set {"channels": ["toast", "ntfy"]} (or AGENT_NOTIFY_CHANNELS=toast,ntfy) to choose explicitly.
// {"quietHours": {"start": "22:00", "end": "07:00", "allow": ["waiting"], "channels": ["ntfy"]}}
// holds back notifications in that daily window (local time, may cross midnight). `allow` lists the
// states that still get through (default "waiting": a blocked agent beats a finished one; use []
// to silence everything); `channels` limits which channels go quiet (default: all of them).
// {"minSeconds": 20} (default) skips "finished" for turns shorter than that — you were watching.
//
// The board is one small file per session under the OS temp dir. "waiting" stays until the turn
// ends (Claude Code has no event for "you answered"), so read it as "needed you at some point".
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const DIR = process.env.AGENT_NOTIFY_DIR ?? join(tmpdir(), 'agent-concurrency-kit', 'notify');
const CONFIG = process.env.AGENT_NOTIFY_CONFIG ?? join(homedir(), '.agent-notify.json');
const SETTINGS = process.env.AGENT_NOTIFY_SETTINGS ?? join(homedir(), '.claude', 'settings.json');
const EVENTS = ['UserPromptSubmit', 'Notification', 'Stop', 'SessionEnd'];
const STALE_MS = 12 * 3600e3;
// A turn that has been "running" this long with no event at all was almost certainly cut off: Claude
// Code sends no "finished" when you press Esc, and none if the window closes mid-turn.
const STALE_RUNNING_MS = 3 * 3600e3;

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};
const DEBOUNCE_MS = 3000;

const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};
const readJson = (file, fallback) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};
const drop = (file) => {
  try {
    unlinkSync(file);
  } catch {}
};
const duration = (ms) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};

/** "<project>/<worktree>" for a checkout made by agent-worktree, else just the folder's name. */
export function labelFor(cwd) {
  const m = /^(.*?)[\\/]\.agents[\\/]([^\\/]+)/.exec(cwd ?? '');
  if (m) return `${basename(m[1])}/${m[2]}`;
  return basename(cwd ?? '') || 'claude';
}

// A session's cwd can be a subfolder; the repo root is what names the project.
function root(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return cwd;
  }
}

// `fileOnly` ignores AGENT_NOTIFY_* env vars: the settings page edits and tests what is saved in the file.
function loadConfig({ fileOnly = false } = {}) {
  const file = readJson(CONFIG, {});
  const env = fileOnly ? {} : process.env;
  const ntfy = { server: 'https://ntfy.sh', ...file.ntfy };
  if (env.AGENT_NOTIFY_NTFY_TOPIC) ntfy.topic = env.AGENT_NOTIFY_NTFY_TOPIC;
  if (env.AGENT_NOTIFY_NTFY_SERVER) ntfy.server = env.AGENT_NOTIFY_NTFY_SERVER;
  const webhook = env.AGENT_NOTIFY_WEBHOOK ?? file.webhook;
  const command = env.AGENT_NOTIFY_COMMAND ?? file.command;
  const channels =
    env.AGENT_NOTIFY_CHANNELS?.split(',').map((s) => s.trim()).filter(Boolean) ??
    file.channels ?? ['toast', ...(ntfy.topic ? ['ntfy'] : []), ...(webhook ? ['webhook'] : []), ...(command ? ['command'] : [])];
  const minSeconds = Number(env.AGENT_NOTIFY_MIN_SECONDS ?? file.minSeconds ?? 20);
  return { channels, ntfy, webhook, command, minSeconds, quietHours: file.quietHours, file };
}

const clock = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm ?? '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** True when `date` (local time) falls inside the daily window start..end, which may cross midnight. */
export function inQuietHours(date, { start, end } = {}) {
  const from = clock(start);
  const to = clock(end);
  if (from === null || to === null || from === to) return false;
  const now = date.getHours() * 60 + date.getMinutes();
  return from < to ? now >= from && now < to : now >= from || now < to;
}

const CHANNEL_NAMES = ['dashboard', 'toast', 'ntfy', 'webhook', 'command'];

const checkUrl = (value, what) => {
  try {
    if (!/^https?:$/.test(new URL(value).protocol)) throw new Error();
  } catch {
    throw new Error(`${what} must be an http(s) address`);
  }
};

/**
 * Returns the config file's contents with the settings form's `body` applied, or throws a message
 * fit to show the user. Only known keys are taken; anything else in the file is kept as it was.
 */
export function applySettings(file, body) {
  const out = { ...file };
  const has = (k) => body[k] !== undefined;
  if (has('channels')) {
    if (!Array.isArray(body.channels) || body.channels.some((c) => !CHANNEL_NAMES.includes(c))) throw new Error('unknown channel');
    out.channels = [...new Set(body.channels)];
  }
  if (has('ntfy')) {
    const topic = String(body.ntfy?.topic ?? '').trim();
    const server = String(body.ntfy?.server ?? '').trim() || 'https://ntfy.sh';
    if (topic && !/^[\w-]{1,64}$/.test(topic)) throw new Error('ntfy topic: letters, digits, - and _ only (64 at most)');
    checkUrl(server, 'ntfy server');
    out.ntfy = { ...file.ntfy, server };
    if (topic) out.ntfy.topic = topic;
    else delete out.ntfy.topic;
  }
  for (const key of ['webhook', 'command']) {
    if (!has(key)) continue;
    const value = String(body[key] ?? '').trim();
    if (key === 'webhook' && value) checkUrl(value, 'webhook');
    if (value) out[key] = value;
    else delete out[key];
  }
  if (has('minSeconds')) {
    const n = Number(body.minSeconds);
    if (!Number.isFinite(n) || n < 0) throw new Error('minimum turn length must be 0 or more seconds');
    out.minSeconds = n;
  }
  if (has('quietHours')) {
    const q = body.quietHours;
    if (q === null) {
      delete out.quietHours;
    } else {
      if (clock(q.start) === null || clock(q.end) === null) throw new Error('quiet hours need a start and end time');
      if (!Array.isArray(q.allow ?? []) || (q.allow ?? []).some((a) => a !== 'waiting' && a !== 'done')) throw new Error('quiet hours: unknown state to allow');
      if (!Array.isArray(q.channels ?? []) || (q.channels ?? []).some((c) => !CHANNEL_NAMES.includes(c))) throw new Error('quiet hours: unknown channel');
      out.quietHours = { start: q.start, end: q.end, allow: q.allow ?? ['waiting'] };
      if (q.channels?.length) out.quietHours.channels = q.channels;
    }
  }
  const needs = { ntfy: out.ntfy?.topic, webhook: out.webhook, command: out.command };
  for (const c of out.channels ?? []) {
    if (c in needs && !needs[c]) throw new Error(`${c} is switched on but has nothing to send to; fill it in first`);
  }
  return out;
}

const muteUntil = () => readJson(join(DIR, 'mute'), {}).until ?? 0;

/** The channels that should hear about `ev` right now, after mute and quiet hours. */
export function channelsFor(ev, cfg, now = Date.now()) {
  if (now < muteUntil()) return [];
  const q = cfg.quietHours;
  if (!q || !inQuietHours(new Date(now), q) || (q.allow ?? ['waiting']).includes(ev.state)) return cfg.channels;
  return q.channels ? cfg.channels.filter((c) => !q.channels.includes(c)) : [];
}

// ---- channels: each takes { label, state, body } and resolves, or throws if it could not send ----

function run(cmd, args, env = {}, { shell = false, timeout = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env: { ...process.env, ...env }, shell, stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => {
      p.kill();
      reject(new Error(`${cmd} timed out`));
    }, timeout);
    p.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    p.on('exit', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`));
    });
  });
}

const TOAST_PS = `
$ErrorActionPreference = 'Stop'
[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
$t = [Security.SecurityElement]::Escape($env:AGENT_NOTIFY_TITLE)
$b = [Security.SecurityElement]::Escape($env:AGENT_NOTIFY_BODY)
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml("<toast><visual><binding template='ToastGeneric'><text>$t</text><text>$b</text></binding></visual></toast>")
$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($xml))
`;

const CHANNELS = {
  toast(ev) {
    const env = { AGENT_NOTIFY_TITLE: ev.label, AGENT_NOTIFY_BODY: ev.body };
    if (process.platform === 'win32') {
      const encoded = Buffer.from(TOAST_PS, 'utf16le').toString('base64');
      return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], env);
    }
    if (process.platform === 'darwin') {
      return run('osascript', ['-e', 'display notification (system attribute "AGENT_NOTIFY_BODY") with title (system attribute "AGENT_NOTIFY_TITLE")'], env);
    }
    return run('notify-send', [ev.label, ev.body]);
  },

  async ntfy(ev, cfg) {
    if (!cfg.ntfy.topic) throw new Error('no ntfy topic set (run: agent-notify setup --ntfy)');
    const res = await fetch(cfg.ntfy.server, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: cfg.ntfy.topic,
        title: ev.label,
        message: ev.body,
        priority: ev.state === 'waiting' ? 4 : 3,
        tags: [ev.state === 'waiting' ? 'warning' : 'white_check_mark'],
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`ntfy answered ${res.status}`);
  },

  async webhook(ev, cfg) {
    if (!cfg.webhook) throw new Error('no webhook url set');
    const text = `${ev.state === 'waiting' ? '⚠️' : '✅'} ${ev.label}: ${ev.body}`;
    // Discord reads `content`, Slack reads `text`; each ignores the other.
    const res = await fetch(cfg.webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text, text }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`webhook answered ${res.status}`);
  },

  command(ev, cfg) {
    if (!cfg.command) throw new Error('no command set');
    return run(cfg.command, [], { AGENT_NOTIFY_TITLE: ev.label, AGENT_NOTIFY_BODY: ev.body, AGENT_NOTIFY_STATE: ev.state, AGENT_NOTIFY_LABEL: ev.label }, { shell: true });
  },

  // Nothing to send: the status page reads the board itself. It is a channel so that
  // {"channels": ["dashboard"]} counts events as announced without any toast or push.
  dashboard() {},
};

/** Sends to every configured channel at once; resolves to [{ channel, error? }]. */
async function send(ev, cfg) {
  const results = await Promise.all(
    cfg.channels.map(async (channel) => {
      try {
        if (!CHANNELS[channel]) throw new Error('unknown channel');
        await CHANNELS[channel](ev, cfg);
        return { channel };
      } catch (err) {
        return { channel, error: err.message };
      }
    }),
  );
  return results;
}

// ---- the hook ----

async function hook(input) {
  const event = input.hook_event_name;
  const id = String(input.session_id ?? 'unknown').replace(/[^\w-]/g, '');
  const file = join(DIR, `${id}.json`);
  if (event === 'SessionEnd') return drop(file);
  if (!EVENTS.includes(event)) return;

  mkdirSync(DIR, { recursive: true });
  const cfg = loadConfig();
  const prev = readJson(file, null);
  const now = Date.now();
  const top = root(input.cwd);
  const label = labelFor(top);

  let state;
  let ev = null;
  if (event === 'UserPromptSubmit') {
    state = 'running';
  } else if (event === 'Notification') {
    // Claude Code re-pings "waiting for your input" a minute after every Stop; that is not news.
    const idle = input.notification_type === 'idle_prompt' || /waiting for your input/i.test(input.message ?? '');
    if (idle && prev?.state === 'done') {
      state = 'done';
    } else {
      state = 'waiting';
      ev = { label, state, body: input.message || 'needs your attention' };
    }
  } else {
    state = 'done';
    const ms = prev?.turnStart ? now - prev.turnStart : Infinity;
    if (ms >= cfg.minSeconds * 1000) ev = { label, state, body: ms === Infinity ? 'finished' : `finished (${duration(ms)})` };
  }

  if (ev && prev?.notified?.state === ev.state && now - prev.notified.at < DEBOUNCE_MS) ev = null;
  // Held back by mute or quiet hours does not count as told, or the next real one would be dropped.
  const channels = ev ? channelsFor(ev, cfg, now) : [];

  writeFileSync(
    file,
    JSON.stringify({
      session: id,
      pid: Number(process.env.CLAUDE_PID) || prev?.pid,
      label,
      path: top,
      state,
      since: prev?.state === state ? prev.since : now,
      turnStart: event === 'UserPromptSubmit' ? now : prev?.turnStart,
      updated: now,
      message: state === 'waiting' ? input.message : undefined,
      notified: channels.length ? { state: ev.state, at: now, body: ev.body } : prev?.notified,
    }),
  );

  if (!channels.length) return;
  for (const r of await send(ev, { ...cfg, channels })) {
    if (r.error) appendFileSync(join(DIR, 'errors.log'), `${new Date().toISOString()} ${r.channel}: ${r.error}\n`);
  }
}

async function readStdin() {
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

// ---- status ----

/** Every live session, waiting ones first. Sessions silent for 12 hours are dropped. */
function board(now = Date.now()) {
  const rows = [];
  let names = [];
  try {
    names = readdirSync(DIR);
  } catch {}
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    const s = readJson(join(DIR, name), null);
    // Gone: too old, or the Claude Code process that owned it has exited. Sessions recorded before the
    // process id was kept have only the age to go on, and only a stuck "running" is dropped on that.
    const orphaned = s && (s.pid ? !alive(s.pid) : s.state === 'running' && now - s.updated > STALE_RUNNING_MS);
    if (!s || now - s.updated > STALE_MS || orphaned) {
      drop(join(DIR, name));
      continue;
    }
    rows.push(s);
  }
  const order = { waiting: 0, running: 1, done: 2 };
  return rows.sort((a, b) => order[a.state] - order[b.state] || a.since - b.since);
}

function status() {
  const now = Date.now();
  const rows = board(now);
  if (!rows.length) return console.log('no Claude Code sessions reporting yet (run: agent-notify setup)');
  const width = Math.max(...rows.map((r) => r.label.length));
  for (const r of rows) {
    const note = r.state === 'waiting' && r.message ? `  ${r.message}` : '';
    console.log(`${r.state.padEnd(8)} ${r.label.padEnd(width)}  ${duration(now - r.since).padStart(7)}${note}`);
  }
  const n = (state) => rows.filter((r) => r.state === state).length;
  console.log(`\n${n('waiting')} waiting on you, ${n('running')} running, ${n('done')} done`);
  const until = muteUntil();
  if (until > now) console.log(`muted until ${new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
}

// ---- dashboard: the same board as a page, for a pinned browser tab ----

const PAGE = join(dirname(SELF), 'dashboard.html');

const settingsView = () => {
  const cfg = loadConfig({ fileOnly: true });
  return {
    channels: cfg.channels,
    available: CHANNEL_NAMES,
    ntfy: { topic: cfg.ntfy.topic ?? '', server: cfg.ntfy.server },
    webhook: cfg.webhook ?? '',
    command: cfg.command ?? '',
    minSeconds: cfg.minSeconds,
    quietHours: cfg.quietHours ?? null,
    mutedUntil: muteUntil() > Date.now() ? muteUntil() : 0,
    configPath: CONFIG,
  };
};

async function readJsonBody(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 65536) throw new Error('request too large');
  }
  return text ? JSON.parse(text) : {};
}

function dashboard({ open }) {
  const wanted = Number(process.env.AGENT_NOTIFY_PORT ?? 7878);
  const server = createServer((req, res) => {
    // Only this machine may ask, and only under a local name: a web page elsewhere must not be able
    // to read your sessions by pointing a lookalike hostname at 127.0.0.1.
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    const json = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    // Changing settings can make this machine run a command, so a write must come from our own page:
    // a custom header plus a JSON body (which a foreign site cannot send without a CORS preflight we
    // never answer), and an Origin, when the browser sends one, that is us.
    const ownWrite = () =>
      req.headers['x-agent-notify'] === '1' &&
      /^application\/json/.test(req.headers['content-type'] ?? '') &&
      (!req.headers.origin || new URL(req.headers.origin).host === req.headers.host);
    if (host !== 'localhost' && host !== '127.0.0.1') {
      res.writeHead(403).end('forbidden');
    } else if (req.method === 'POST' && req.url?.startsWith('/api/')) {
      if (!ownWrite()) return json(403, { error: 'forbidden' });
      readJsonBody(req)
        .then(async (body) => {
          if (req.url === '/api/config') {
            const next = applySettings(readJson(CONFIG, {}), body);
            writeFileSync(CONFIG, JSON.stringify(next, null, 2) + '\n');
            return json(200, settingsView());
          }
          if (req.url === '/api/mute') {
            setMute(String(body.duration ?? ''));
            return json(200, settingsView());
          }
          if (req.url === '/api/test') {
            if (!CHANNEL_NAMES.includes(body.channel)) throw new Error('unknown channel');
            const [result] = await send({ label: 'agent-notify', state: 'done', body: 'test notification' }, { ...loadConfig({ fileOnly: true }), channels: [body.channel] });
            return json(200, result);
          }
          json(404, { error: 'not found' });
        })
        .catch((err) => json(400, { error: err.message }));
    } else if (req.url === '/api/config') {
      json(200, settingsView());
    } else if (req.url === '/api/status') {
      const until = muteUntil();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ now: Date.now(), mutedUntil: until > Date.now() ? until : 0, sessions: board() }));
    } else if (req.url === '/background.jpg') {
      // Optional: drop a picture named dashboard-bg.jpg (or .png / .webp) next to this file to use it as the page background.
      const found = [['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['png', 'image/png'], ['webp', 'image/webp']]
        .map(([ext, type]) => [join(dirname(SELF), `dashboard-bg.${ext}`), type])
        .find(([file]) => existsSync(file));
      if (found) {
        res.writeHead(200, { 'Content-Type': found[1], 'Cache-Control': 'no-cache' });
        res.end(readFileSync(found[0]));
      } else {
        res.writeHead(404).end('no background image');
      }
    } else if (req.url === '/' || req.url?.startsWith('/?')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(readFileSync(PAGE));
    } else {
      res.writeHead(404).end('not found');
    }
  });
  server.on('error', (err) => fail(err.code === 'EADDRINUSE' ? `port ${wanted} is taken, probably by a dashboard already running: http://localhost:${wanted}` : err.message));
  server.listen(wanted, '127.0.0.1', () => {
    const url = `http://localhost:${server.address().port}`;
    console.log(`agent-notify dashboard: ${url}  (Ctrl+C to stop)`);
    if (open) {
      const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
      spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
    }
  });
}

// ---- setup ----

const isOurs = (h) => typeof h.command === 'string' && h.command.includes('notify.mjs') && / hook$/.test(h.command);

function setup({ remove, ntfy }) {
  let settings = {};
  try {
    settings = JSON.parse(readFileSync(SETTINGS, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') fail(`${SETTINGS} could not be read as JSON; fix it first`);
  }
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) fail(`${SETTINGS} is not a JSON object; fix it first`);
  const command = `node "${SELF.replace(/\\/g, '/')}" hook`;
  settings.hooks ??= {};
  for (const event of EVENTS) {
    const kept = (settings.hooks[event] ?? []).filter((g) => !(g.hooks ?? []).some(isOurs));
    if (!remove) kept.push({ hooks: [{ type: 'command', command, timeout: 15 }] });
    if (kept.length) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  mkdirSync(dirname(SETTINGS), { recursive: true });
  writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
  console.log(remove ? `removed the hooks from ${SETTINGS}` : `hooks installed in ${SETTINGS} (new Claude Code sessions pick them up)`);

  if (ntfy && !remove) {
    const cfg = readJson(CONFIG, {});
    cfg.ntfy ??= {};
    cfg.ntfy.topic ??= `claude-${randomBytes(9).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
    writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n');
    console.log(`\nphone push: install the ntfy app and subscribe to the topic\n  ${cfg.ntfy.topic}\non ${cfg.ntfy.server ?? 'https://ntfy.sh'}. The topic name is the only secret; saved in ${CONFIG}.`);
  }
}

/** Sets, clears (`off`) or reads the mute; returns when it ends (0 if not muted). Throws on a bad duration. */
function setMute(arg) {
  const file = join(DIR, 'mute');
  if (arg === 'off') {
    drop(file);
  } else if (arg) {
    const m = /^(\d+)([smhd])?$/.exec(arg);
    if (!m) throw new Error('duration like 30m, 2h, 1d, or off');
    const until = Date.now() + Number(m[1]) * { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 }[m[2] ?? 'm'];
    mkdirSync(DIR, { recursive: true });
    writeFileSync(file, JSON.stringify({ until }));
  }
  const until = muteUntil();
  return until > Date.now() ? until : 0;
}

function mute(arg) {
  let until;
  try {
    until = setMute(arg);
  } catch (err) {
    fail(`usage: agent-notify mute <30m|2h|1d|off> (${err.message})`);
  }
  console.log(arg === 'off' ? 'unmuted' : until ? `muted until ${new Date(until).toLocaleString()}` : 'not muted');
}

async function test() {
  const cfg = loadConfig();
  console.log(`channels: ${cfg.channels.join(', ') || '(none)'}`);
  const results = await send({ label: 'agent-notify', state: 'done', body: 'test notification' }, cfg);
  for (const r of results) console.log(`${r.channel.padEnd(8)} ${r.error ? `FAILED: ${r.error}` : 'sent'}`);
  if (results.some((r) => r.error)) process.exitCode = 1;
}

// ---- cli ----

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = new Set(rest);
  if (cmd === 'hook') {
    if (process.stdin.isTTY) fail('agent-notify hook reads Claude Code hook JSON on stdin; install it with: agent-notify setup');
    // A notifier must never break the session it is watching.
    try {
      await hook(JSON.parse((await readStdin()) || '{}'));
    } catch (err) {
      try {
        mkdirSync(DIR, { recursive: true });
        appendFileSync(join(DIR, 'errors.log'), `${new Date().toISOString()} hook: ${err.message}\n`);
      } catch {}
    }
  } else if (cmd === 'status') {
    status();
  } else if (cmd === 'dashboard') {
    dashboard({ open: flags.has('--open') });
  } else if (cmd === 'setup') {
    setup({ remove: flags.has('--remove'), ntfy: flags.has('--ntfy') });
  } else if (cmd === 'mute') {
    mute(rest[0]);
  } else if (cmd === 'test') {
    await test();
  } else {
    fail('usage: agent-notify <setup [--ntfy] [--remove] | status | dashboard [--open] | mute [duration|off] | test>');
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(SELF)) await main();
