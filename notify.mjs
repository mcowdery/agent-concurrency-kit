#!/usr/bin/env node
// Tells you when a Claude Code session has finished or is stuck waiting on you, across every
// project and agent worktree at once, and keeps a one-glance board of what each session is doing.
//
//   npx agent-notify setup [--ntfy] [--remove]   add (or remove) the Claude Code hooks in
//                                                ~/.claude/settings.json; --ntfy also creates a
//                                                private phone-push topic and prints it
//   npx agent-notify status                      every live session: waiting / running / done
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
import { appendFileSync, mkdirSync, readdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const DIR = process.env.AGENT_NOTIFY_DIR ?? join(tmpdir(), 'agent-concurrency-kit', 'notify');
const CONFIG = process.env.AGENT_NOTIFY_CONFIG ?? join(homedir(), '.agent-notify.json');
const SETTINGS = process.env.AGENT_NOTIFY_SETTINGS ?? join(homedir(), '.claude', 'settings.json');
const EVENTS = ['UserPromptSubmit', 'Notification', 'Stop', 'SessionEnd'];
const STALE_MS = 12 * 3600e3;
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

function loadConfig() {
  const file = readJson(CONFIG, {});
  const env = process.env;
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
  const label = labelFor(root(input.cwd));

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
      label,
      state,
      since: prev?.state === state ? prev.since : now,
      turnStart: event === 'UserPromptSubmit' ? now : prev?.turnStart,
      updated: now,
      message: state === 'waiting' ? input.message : undefined,
      notified: channels.length ? { state: ev.state, at: now } : prev?.notified,
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

function status() {
  const now = Date.now();
  const rows = [];
  let names = [];
  try {
    names = readdirSync(DIR);
  } catch {}
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    const s = readJson(join(DIR, name), null);
    if (!s || now - s.updated > STALE_MS) {
      drop(join(DIR, name));
      continue;
    }
    rows.push(s);
  }
  if (!rows.length) return console.log('no Claude Code sessions reporting yet (run: agent-notify setup)');
  const order = { waiting: 0, running: 1, done: 2 };
  rows.sort((a, b) => order[a.state] - order[b.state] || a.since - b.since);
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

function mute(arg) {
  const file = join(DIR, 'mute');
  if (arg === 'off') {
    drop(file);
    return console.log('unmuted');
  }
  if (arg) {
    const m = /^(\d+)([smhd])?$/.exec(arg);
    if (!m) fail('usage: agent-notify mute <30m|2h|1d|off>');
    const until = Date.now() + Number(m[1]) * { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 }[m[2] ?? 'm'];
    mkdirSync(DIR, { recursive: true });
    writeFileSync(file, JSON.stringify({ until }));
  }
  const until = muteUntil();
  console.log(until > Date.now() ? `muted until ${new Date(until).toLocaleString()}` : 'not muted');
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
  } else if (cmd === 'setup') {
    setup({ remove: flags.has('--remove'), ntfy: flags.has('--ntfy') });
  } else if (cmd === 'mute') {
    mute(rest[0]);
  } else if (cmd === 'test') {
    await test();
  } else {
    fail('usage: agent-notify <setup [--ntfy] [--remove] | status | mute [duration|off] | test>');
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(SELF)) await main();
