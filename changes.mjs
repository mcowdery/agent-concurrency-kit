#!/usr/bin/env node
// Remembers which files each Claude Code session edited, so that in a checkout several agents share,
// an agent commits its own work without sorting it out of everyone else's.
//
//   npx agent-changes setup [--remove]   add (or remove) the hooks in ~/.claude/settings.json
//   npx agent-changes list [--all]       this session's files that are still uncommitted; --all shows every session
//   npx agent-changes add <path>...      record files a Bash command changed (hooks only see Edit/Write)
//   npx agent-changes commit -m <msg> [--push] [--shared]
//                                        commit this session's files and nothing else, leaving the rest
//                                        of the working tree (and anything others staged) alone
//
// A PostToolUse hook logs the path of every Edit / Write / MultiEdit / NotebookEdit under the session's
// id; a SessionStart hook exports that id as AGENT_SESSION_ID so the commands below can find "this
// session". Without it, the commands fall back to the only session that has uncommitted files, and ask
// for --session <id> when there is more than one.
//
// Tracking is per file, not per line: when two sessions edited the same file, `commit` leaves it out and
// says so (--shared commits it, other session's lines included). For work that overlaps like that, give
// each agent its own checkout with `agent-worktree`.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const SETTINGS = process.env.AGENT_CHANGES_SETTINGS ?? join(homedir(), '.claude', 'settings.json');
const STATE = process.env.AGENT_CHANGES_DIR ?? join(homedir(), '.agent-changes');
const EDIT_TOOLS = 'Edit|Write|MultiEdit|NotebookEdit';

const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};
const git = (args, cwd = process.cwd()) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const safeId = (s) => String(s ?? '').replace(/[^\w-]/g, '');

/** The top of the working tree that `cwd` is in (a worktree has its own), or null outside git. */
function topOf(cwd) {
  try {
    return resolve(git(['rev-parse', '--show-toplevel'], cwd).trim());
  } catch {
    return null;
  }
}

// One log per working tree, one file per session in it: lines of {"p": "<path relative to the tree top>"}.
const dirFor = (top) => join(STATE, createHash('sha1').update(top.toLowerCase()).digest('hex').slice(0, 12));
const fileFor = (top, session) => join(dirFor(top), `${safeId(session)}.ndjson`);

function record(top, session, paths) {
  mkdirSync(dirFor(top), { recursive: true });
  const rels = paths.map((p) => relative(top, resolve(top, p)).replace(/\\/g, '/')).filter((r) => r && !r.startsWith('..'));
  if (rels.length) appendFileSync(fileFor(top, session), rels.map((p) => JSON.stringify({ p })).join('\n') + '\n');
  return rels;
}

function recorded(top, session) {
  try {
    return new Set(readFileSync(fileFor(top, session), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).p));
  } catch {
    return new Set();
  }
}

/** Paths git says differ from HEAD right now (modified, added, deleted, untracked), relative to `top`. */
function dirtyPaths(top) {
  const out = git(['status', '--porcelain', '-z', '--untracked-files=all'], top).split('\0').filter(Boolean);
  const paths = new Set();
  for (let i = 0; i < out.length; i++) {
    const [x] = out[i];
    paths.add(out[i].slice(3));
    if (x === 'R' || x === 'C') i++; // a rename carries its old name as the next entry
  }
  return paths;
}

/** Every session with a log in this tree, mapped to the files it touched that are still dirty. */
function pending(top) {
  const dirty = dirtyPaths(top);
  const dir = dirFor(top);
  const sessions = new Map();
  if (!existsSync(dir)) return sessions;
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.ndjson'))) {
    const id = f.slice(0, -'.ndjson'.length);
    const mine = [...recorded(top, id)].filter((p) => dirty.has(p));
    if (mine.length) sessions.set(id, mine.sort());
  }
  return sessions;
}

function whichSession(top, given, sessions) {
  const id = safeId(given ?? process.env.AGENT_SESSION_ID);
  if (id) return id;
  if (sessions.size === 1) return [...sessions.keys()][0];
  if (!sessions.size) return null;
  fail(`more than one session has uncommitted files here (${[...sessions.keys()].join(', ')}); pass --session <id>`);
}

// ---- the hooks ----

async function hook() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return; // a hook must never get in the agent's way
  }
  const session = safeId(input.session_id);
  if (!session) return;

  if (input.hook_event_name === 'SessionStart') {
    // Claude Code runs the file named here as a script before each Bash call, so the id reaches commands.
    if (process.env.CLAUDE_ENV_FILE) appendFileSync(process.env.CLAUDE_ENV_FILE, `export AGENT_SESSION_ID=${session}\n`);
    return;
  }
  const file = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  if (input.hook_event_name !== 'PostToolUse' || !file || input.tool_response?.success === false) return;
  const abs = isAbsolute(file) ? file : resolve(input.cwd ?? process.cwd(), file);
  const top = topOf(dirname(abs)) ?? topOf(input.cwd ?? process.cwd());
  if (top) record(top, session, [abs]);
}

// ---- commands ----

function list({ all, session }) {
  const top = topOf(process.cwd()) ?? fail('not inside a git repository');
  const sessions = pending(top);
  if (all) {
    if (!sessions.size) return console.log('no session has uncommitted files here');
    for (const [id, files] of sessions) console.log(`${id}\n${files.map((f) => `  ${f}`).join('\n')}`);
    return;
  }
  const id = whichSession(top, session, sessions);
  const files = (id && sessions.get(id)) || [];
  if (!files.length) return console.log('nothing recorded for this session is uncommitted');
  console.log(files.join('\n'));
}

function commit({ message, push, shared, session }) {
  if (!message) fail('a message is needed: agent-changes commit -m "..."');
  const top = topOf(process.cwd()) ?? fail('not inside a git repository');
  const sessions = pending(top);
  const id = whichSession(top, session, sessions);
  const mine = (id && sessions.get(id)) || [];
  if (!mine.length) fail('nothing recorded for this session is uncommitted (use `agent-changes add <path>` for changes made by a command)');

  const others = new Map();
  for (const [other, files] of sessions) if (other !== id) for (const f of files) others.set(f, [...(others.get(f) ?? []), other]);
  const clash = mine.filter((f) => others.has(f));
  const take = shared ? mine : mine.filter((f) => !others.has(f));
  for (const f of clash) console.error(`${shared ? 'including' : 'leaving out'} ${f}: also edited by ${others.get(f).join(', ')}`);
  if (!take.length) fail('every recorded file was also edited by another session; use --shared to commit them anyway');

  // Stage only these paths (-A picks up deletions), then commit only these paths, so whatever another
  // agent has staged in the shared index stays staged and out of this commit.
  git(['add', '-A', '--', ...take], top);
  const quiet = (args) => execFileSync('git', args, { cwd: top, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  console.log(quiet(['commit', '-m', message, '--only', '--', ...take]).trim());

  const keep = [...recorded(top, id)].filter((p) => !take.includes(p));
  writeFileSync(fileFor(top, id), keep.map((p) => JSON.stringify({ p })).join('\n') + (keep.length ? '\n' : ''));
  if (!keep.length) rmSync(fileFor(top, id), { force: true });
  if (push) console.log(quiet(['push']).trim() || 'pushed');
}

// ---- setup ----

const isOurs = (h) => typeof h.command === 'string' && h.command.includes('changes.mjs') && / hook$/.test(h.command);

function setup({ remove }) {
  let settings = {};
  try {
    settings = JSON.parse(readFileSync(SETTINGS, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') fail(`${SETTINGS} could not be read as JSON; fix it first`);
  }
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) fail(`${SETTINGS} is not a JSON object; fix it first`);
  const command = `node "${SELF.replace(/\\/g, '/')}" hook`;
  settings.hooks ??= {};
  for (const [event, matcher] of [['SessionStart'], ['PostToolUse', EDIT_TOOLS]]) {
    const kept = (settings.hooks[event] ?? []).filter((g) => !(g.hooks ?? []).some(isOurs));
    if (!remove) kept.push({ ...(matcher && { matcher }), hooks: [{ type: 'command', command, timeout: 10 }] });
    if (kept.length) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  mkdirSync(dirname(SETTINGS), { recursive: true });
  writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
  console.log(remove ? `removed the hooks from ${SETTINGS}` : `hooks installed in ${SETTINGS} (new Claude Code sessions pick them up)`);
}

// ---- main ----

function parseArgs(argv) {
  const out = { rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-m' || a === '--message') out.message = argv[++i];
    else if (a === '--session') out.session = argv[++i];
    else if (a.startsWith('--')) out[a.slice(2)] = true;
    else out.rest.push(a);
  }
  return out;
}

const [cmd, ...argv] = process.argv.slice(2);
const args = parseArgs(argv);

if (cmd === 'hook') await hook();
else if (cmd === 'setup') setup({ remove: args.remove });
else if (cmd === 'list') list(args);
else if (cmd === 'commit') commit(args);
else if (cmd === 'add') {
  const top = topOf(process.cwd()) ?? fail('not inside a git repository');
  const id = safeId(args.session ?? process.env.AGENT_SESSION_ID) || fail('no session: AGENT_SESSION_ID is not set; pass --session <id>');
  if (!args.rest.length) fail('usage: agent-changes add <path>...');
  console.log(`recorded ${record(top, id, args.rest).join(', ') || 'nothing (outside this repository)'}`);
} else fail('usage: agent-changes <setup|list|add|commit> ...');
