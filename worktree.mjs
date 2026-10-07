#!/usr/bin/env node
// A checkout of one's own per task, so several coding agents can work on the same repo at once
// without seeing each other's half-finished edits: its own files, branch, installed dependencies
// and caches.
//
//   npx agent-worktree add <name>      <repoRoot>/.agents/<name> on branch agent-<name>, from the
//                                       commit the main checkout is on, installed and ready
//   npx agent-worktree setup           in a worktree made some other way: install, copy local files
//   npx agent-worktree list            each worktree, its branch, and what's uncommitted in it
//   npx agent-worktree remove <name> [--force]   takes it away once its work is merged
//
// What isn't in git doesn't come along by itself. Local files an agent still needs (an .env, a
// credentials file) are listed one per line in .agentinclude at the repo root and copied in; a
// worktree starts from the last commit, so uncommitted work in the checkout you run this from is
// NOT included — commit first. Dependencies are installed with INSTALL_CMD (env var, default
// `npm ci`); set it to `pnpm install --frozen-lockfile` or similar for other package managers, or
// to an empty string to skip installing altogether.
import { execFileSync, execSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const INSTALL_CMD = process.env.INSTALL_CMD ?? 'npm ci --no-audit --no-fund';
const INCLUDE_FILE = process.env.AGENT_INCLUDE_FILE ?? '.agentinclude';

const git = (args, cwd = process.cwd()) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

/** Every worktree of this repository, the main checkout first. */
function worktrees() {
  return git(['worktree', 'list', '--porcelain']).split(/\r?\n\r?\n/).filter(Boolean).map((block) => {
    const get = (key) => (block.split(/\r?\n/).find((l) => l.startsWith(key + ' ')) ?? '').slice(key.length + 1);
    return { path: resolve(get('worktree')), branch: get('branch').replace('refs/heads/', '') };
  });
}

const MAIN = worktrees()[0].path;
const HOME = join(MAIN, '.agents');

function setup(dir) {
  const include = existsSync(join(MAIN, INCLUDE_FILE)) ? readFileSync(join(MAIN, INCLUDE_FILE), 'utf8').split(/\r?\n/) : [];
  for (const line of include) {
    const rel = line.trim().replace(/\/$/, '');
    if (!rel || rel.startsWith('#') || !existsSync(join(MAIN, rel)) || existsSync(join(dir, rel))) continue;
    cpSync(join(MAIN, rel), join(dir, rel), { recursive: true });
    console.log(`copied ${rel}`);
  }
  if (INSTALL_CMD && !existsSync(join(dir, 'node_modules'))) {
    console.log(`installing dependencies (${INSTALL_CMD})...`);
    const env = { ...process.env, PATH: `${dirname(process.execPath)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}` };
    execSync(INSTALL_CMD, { cwd: dir, env, stdio: ['ignore', 'ignore', 'inherit'] });
  }
}

const [cmd, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((a) => a.startsWith('--')));
const name = rest.find((a) => !a.startsWith('--'));
const named = () => {
  if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) fail(`a name in lower case, digits and hyphens: agent-worktree ${cmd} <name>`);
  return join(HOME, name);
};

if (cmd === 'add') {
  const dir = named();
  if (existsSync(dir)) fail(`${dir} is already there`);
  const dirty = git(['status', '--porcelain']).split('\n').filter(Boolean).length;
  git(['worktree', 'add', '--quiet', '-b', `agent-${name}`, dir, 'HEAD']);
  setup(dir);
  console.log(`\n${dir}\non branch agent-${name}, from ${git(['log', '-1', '--format=%h %s'])}`);
  if (dirty) console.log(`NOTE: ${dirty} uncommitted change(s) in ${process.cwd()} are not in it (a worktree starts from the last commit).`);
} else if (cmd === 'setup') {
  setup(process.cwd());
} else if (cmd === 'list') {
  for (const w of worktrees()) {
    const dirty = tryGit(['status', '--porcelain'], w.path)?.split('\n').filter(Boolean).length ?? '?';
    console.log(`${w.path}  [${w.branch}]  ${dirty === 0 ? 'clean' : `${dirty} uncommitted`}`);
  }
} else if (cmd === 'remove') {
  const dir = named();
  if (!existsSync(dir)) fail(`${dir} does not exist`);
  git(['worktree', 'remove', dir, ...(flags.has('--force') ? ['--force'] : [])]);
  console.log(`removed ${dir}`);
} else {
  fail('usage: agent-worktree <add|setup|list|remove> [name] [--force]');
}

function tryGit(args, cwd) {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}
