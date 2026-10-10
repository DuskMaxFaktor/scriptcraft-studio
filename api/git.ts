import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

// Git for a project folder: status, diff, commit, discard, history, remote, push/pull.
// git runs without a shell (arguments as an array) in the project's folder only.

const PROJECT_ID = /^[a-zA-Z0-9_-]{1,80}$/;
/** Studio service files that never belong in the repository. */
const GITIGNORE_ENTRIES = ['.scriptcraft.json', '.scriptcraft-chat.json', '.env', '.history/', '.packages/', 'node_modules/', '__pycache__/'];

class GitError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function projectDir(id: string): string {
  if (!PROJECT_ID.test(id)) throw new GitError(400, 'Invalid project id');
  const dir = path.join(process.cwd(), 'projects', id);
  if (!fs.existsSync(path.join(dir, '.scriptcraft.json'))) throw new GitError(404, 'Project not found');
  return dir;
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

function git(cwd: string, args: string[], timeoutMs = 30_000): Promise<GitResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('git', ['-c', 'core.quotepath=off', '-c', 'color.ui=false', ...args], {
        cwd,
        windowsHide: true,
        // Never wait for a password in an invisible console (Git Credential Manager may still show its window)
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C.UTF-8' },
      });
    } catch (err: any) {
      return resolve({ code: -1, stdout: '', stderr: err.message });
    }
    const out: Buffer[] = [];
    const errOut: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => errOut.push(d));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('error', (err: Error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: '', stderr: err.message });
    });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: Buffer.concat(out).toString('utf-8'), stderr: Buffer.concat(errOut).toString('utf-8') });
    });
  });
}

async function gitOk(cwd: string, args: string[], timeoutMs?: number): Promise<string> {
  const r = await git(cwd, args, timeoutMs);
  if (r.code !== 0) throw new GitError(400, (r.stderr || r.stdout).trim() || `git ${args[0]} failed`);
  return r.stdout;
}

let gitAvailable: boolean | null = null;
async function hasGit(): Promise<boolean> {
  if (gitAvailable === null) gitAvailable = (await git(process.cwd(), ['--version'])).code === 0;
  return gitAvailable;
}

const isRepo = (dir: string) => fs.existsSync(path.join(dir, '.git'));

/** A path inside the project given by the client: relative, no "..", not inside .git. */
function safePath(dir: string, p: unknown): string {
  if (typeof p !== 'string' || !p || p.length > 500) throw new GitError(400, 'Invalid path');
  const rel = p.replace(/\\/g, '/');
  // ".GIT" is the same folder on Windows: compare without case
  if (rel.startsWith('/') || /^[a-zA-Z]:/.test(rel) || rel.split('/').some((s) => s === '..' || s.toLowerCase() === '.git')) {
    throw new GitError(400, 'Invalid path');
  }
  const abs = path.resolve(dir, rel);
  if (!abs.startsWith(path.resolve(dir) + path.sep)) throw new GitError(400, 'Invalid path');
  return rel;
}

export interface GitFileStatus {
  path: string;
  /** M modified, A added, D deleted, R renamed, ? untracked, U conflict */
  status: string;
}

function parseStatus(raw: string) {
  const entries = raw.split('\0');
  let branch = '';
  let upstream = '';
  let ahead = 0;
  let behind = 0;
  const files: GitFileStatus[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e) continue;
    if (e.startsWith('## ')) {
      let head = e.slice(3).replace(/^(No commits yet on |Initial commit on )/, '');
      const bracket = head.indexOf(' [');
      const info = bracket >= 0 ? head.slice(bracket + 2, -1) : '';
      if (bracket >= 0) head = head.slice(0, bracket);
      [branch, upstream = ''] = head.split('...');
      ahead = Number(/ahead (\d+)/.exec(info)?.[1] || 0);
      behind = Number(/behind (\d+)/.exec(info)?.[1] || 0);
      continue;
    }
    const x = e[0];
    const y = e[1];
    const file = e.slice(3);
    let status = 'M';
    if (x === '?' && y === '?') status = '?';
    else if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) status = 'U';
    else if (x === 'R' || y === 'R') status = 'R';
    else if (x === 'A') status = 'A';
    else if (x === 'D' || y === 'D') status = 'D';
    if (x === 'R' || x === 'C') i++; // the next entry is the original path
    files.push({ path: file, status });
  }
  return { branch, upstream, ahead, behind, files };
}

async function readStatus(dir: string) {
  if (!(await hasGit())) return { available: false, repo: false };
  if (!isRepo(dir)) return { available: true, repo: false };
  const raw = await gitOk(dir, ['status', '--porcelain=v1', '-b', '-z', '--untracked-files=all']);
  const remote = (await git(dir, ['remote', 'get-url', 'origin'])).stdout.trim() || null;
  const name = (await git(dir, ['config', 'user.name'])).stdout.trim();
  const email = (await git(dir, ['config', 'user.email'])).stdout.trim();
  const hasCommits = (await git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD'])).code === 0;
  // An unfinished merge (conflicts to resolve): which branch is being merged in
  const merging = fs.existsSync(path.join(dir, '.git', 'MERGE_HEAD'));
  let mergeBranch: string | null = null;
  if (merging) {
    try {
      mergeBranch = /Merge branch '([^']+)'/.exec(fs.readFileSync(path.join(dir, '.git', 'MERGE_MSG'), 'utf-8'))?.[1] || null;
    } catch {
      // no message file
    }
  }
  return { available: true, repo: true, ...parseStatus(raw), remote, identity: !!(name && email), hasCommits, merging, mergeBranch };
}

const wrap =
  (fn: (req: any) => Promise<unknown>) =>
  async (req: any, res: any) => {
    try {
      res.json(await fn(req));
    } catch (err: any) {
      const status = err instanceof GitError ? err.status : 500;
      if (status === 500) console.error('Git API error:', err);
      res.status(status).json({ error: err.message || 'Git error' });
    }
  };

export const gitRouter = Router();

gitRouter.get('/:id/status', wrap(async (req) => readStatus(projectDir(req.params.id))));

/** Create the repository (if needed) and keep the studio's service files out of it. */
async function initRepo(dir: string) {
  if (!(await hasGit())) throw new GitError(400, 'Git is not installed (https://git-scm.com)');
  {
    if (!isRepo(dir)) {
      if ((await git(dir, ['init', '-b', 'main'])).code !== 0) await gitOk(dir, ['init']);
      // The studio always writes LF; a global core.autocrlf=true would turn files into CRLF on checkout
      // (and break bash scripts), so this repository keeps files exactly as they are
      await gitOk(dir, ['config', 'core.autocrlf', 'false']);
    }
    // Keep studio service files out of the repository
    const ignoreFile = path.join(dir, '.gitignore');
    const existing = fs.existsSync(ignoreFile) ? fs.readFileSync(ignoreFile, 'utf-8') : '';
    const lines = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
    const missing = GITIGNORE_ENTRIES.filter((e) => !lines.has(e));
    if (missing.length) {
      const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
      fs.writeFileSync(ignoreFile, existing + prefix + '# ScriptCraft Studio\n' + missing.join('\n') + '\n', 'utf-8');
    }
  }
}

gitRouter.post(
  '/:id/init',
  wrap(async (req) => {
    const dir = projectDir(req.params.id);
    await initRepo(dir);
    return readStatus(dir);
  })
);

/** HEAD version and the current file, for the diff view. */
gitRouter.get(
  '/:id/diff',
  wrap(async (req) => {
    const dir = projectDir(req.params.id);
    const rel = safePath(dir, req.query.path);
    const head = await git(dir, ['show', `HEAD:${rel}`]);
    const abs = path.join(dir, rel);
    const current = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf-8') : '';
    return { path: rel, original: head.code === 0 ? head.stdout : '', modified: current };
  })
);

gitRouter.post(
  '/:id/commit',
  wrap(async (req) => {
    const dir = projectDir(req.params.id);
    const message = String(req.body?.message || '').trim();
    if (!message) throw new GitError(400, 'Commit message is empty');
    if (message.length > 5000) throw new GitError(400, 'Commit message is too long');
    const paths: string[] | undefined = Array.isArray(req.body?.paths) ? req.body.paths.map((p: unknown) => safePath(dir, p)) : undefined;
    if (paths && paths.length === 0) throw new GitError(400, 'No files selected');
    await gitOk(dir, ['add', '-A', '--', ...(paths || ['.'])]);
    await gitOk(dir, ['commit', '-m', message, ...(paths ? ['--', ...paths] : [])]);
    return readStatus(dir);
  })
);

/** Throw away the changes of a file: back to the last commit (an untracked file is deleted). */
gitRouter.post(
  '/:id/discard',
  wrap(async (req) => {
    const dir = projectDir(req.params.id);
    const rel = safePath(dir, req.body?.path);
    const tracked = (await git(dir, ['ls-files', '--error-unmatch', '--', rel])).code === 0;
    const inHead = (await git(dir, ['cat-file', '-e', `HEAD:${rel}`])).code === 0;
    if (inHead) {
      await gitOk(dir, ['checkout', 'HEAD', '--', rel]);
    } else {
      if (tracked) await gitOk(dir, ['rm', '--cached', '--quiet', '--', rel]);
      fs.rmSync(path.join(dir, rel), { force: true });
    }
    return readStatus(dir);
  })
);

gitRouter.get(
  '/:id/log',
  wrap(async (req) => {
    const dir = projectDir(req.params.id);
    if (!isRepo(dir) || (await git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD'])).code !== 0) return { commits: [] };
    const raw = await gitOk(dir, ['log', '-n', '100', '--pretty=format:%H%x1f%h%x1f%an%x1f%at%x1f%s%x1e']);
    const commits = raw
      .split('\x1e')
      .map((r) => r.trim())
      .filter(Boolean)
      .map((r) => {
        const [hash, short, author, at, subject] = r.split('\x1f');
        return { hash, short, author, date: Number(at) * 1000, subject };
      });
    return { commits };
  })
);

// ---------- branches ----------

/** A branch name git accepts (and nothing that could be read as an option). */
async function checkBranchName(dir: string, name: unknown): Promise<string> {
  const n = String(name ?? '').trim();
  if (!n || n.startsWith('-') || n.length > 120 || (await git(dir, ['check-ref-format', '--branch', n])).code !== 0) {
    throw new GitError(400, 'Invalid branch name');
  }
  return n;
}

async function hasCommits(dir: string) {
  return (await git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD'])).code === 0;
}

gitRouter.get(
  '/:id/branches',
  wrap(async (req) => {
    const dir = projectDir(req.params.id);
    if (!isRepo(dir) || !(await hasCommits(dir))) return { current: null, branches: [] };
    const raw = await gitOk(dir, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)%1f%(HEAD)%1f%(committerdate:unix)%1f%(subject)', 'refs/heads']);
    const branches = raw
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [name, head, at, subject] = l.split('\x1f');
        return { name, current: head === '*', date: Number(at) * 1000, subject };
      });
    return { current: branches.find((b) => b.current)?.name || null, branches };
  })
);

/** Create a branch from the current commit and switch to it (uncommitted changes come along). */
gitRouter.post(
  '/:id/branches',
  wrap(async (req) => {
    const dir = projectDir(req.params.id);
    if (!isRepo(dir)) throw new GitError(409, 'Not a git repository');
    if (!(await hasCommits(dir))) throw new GitError(409, 'Make the first commit before creating branches');
    const name = await checkBranchName(dir, req.body?.name);
    const r = await git(dir, ['switch', '-c', name]);
    if (r.code !== 0) throw new GitError(409, r.stderr.trim() || 'Cannot create the branch');
    return readStatus(dir);
  })
);

/** Switch to another branch. Refused while there are uncommitted changes, so nothing is lost or mixed. */
gitRouter.post(
  '/:id/switch',
  wrap(async (req) => {
    const dir = projectDir(req.params.id);
    if (!isRepo(dir)) throw new GitError(409, 'Not a git repository');
    const name = await checkBranchName(dir, req.body?.name);
    const st = await readStatus(dir);
    if ('files' in st && st.files && st.files.length > 0) {
      throw new GitError(409, 'Commit or discard your changes before switching branches');
    }
    const r = await git(dir, ['switch', name]);
    if (r.code !== 0) throw new GitError(409, r.stderr.trim() || 'Cannot switch to the branch');
    return readStatus(dir);
  })
);

/** Delete a branch — only one that is fully merged (git branch -d), never the current one. */
gitRouter.post(
  '/:id/branches/delete',
  wrap(async (req) => {
    const dir = projectDir(req.params.id);
    if (!isRepo(dir)) throw new GitError(409, 'Not a git repository');
    const name = await checkBranchName(dir, req.body?.name);
    const current = (await git(dir, ['branch', '--show-current'])).stdout.trim();
    if (name === current) throw new GitError(409, 'Cannot delete the branch you are on');
    const r = await git(dir, ['branch', '-d', name]);
    if (r.code !== 0) {
      const unmerged = /not fully merged/i.test(r.stderr);
      throw new GitError(409, unmerged ? `Branch "${name}" has commits that are not merged anywhere — merge it first` : r.stderr.trim() || 'Cannot delete the branch');
    }
    return { ok: true };
  })
);

// ---------- merging ----------

/**
 * Merge another branch into the current one. Refused with uncommitted changes. On conflicts the merge
 * stays open (status.merging): resolve each file, then commit — or abort.
 */
gitRouter.post(
  '/:id/merge',
  wrap(async (req) => {
    const dir = projectDir(req.params.id);
    if (!isRepo(dir)) throw new GitError(409, 'Not a git repository');
    const name = await checkBranchName(dir, req.body?.name);
    const current = (await git(dir, ['branch', '--show-current'])).stdout.trim();
    if (name === current) throw new GitError(400, 'A branch cannot be merged into itself');
    const before = await readStatus(dir);
    if ('merging' in before && before.merging) throw new GitError(409, 'Another merge is not finished yet');
    if ('files' in before && before.files && before.files.length > 0) throw new GitError(409, 'Commit or discard your changes before merging');
    const r = await git(dir, ['merge', '--no-edit', name]);
    const status = await readStatus(dir);
    if (r.code === 0) return { ...status, merged: true, upToDate: /Already up to date/i.test(r.stdout) };
    if ('merging' in status && status.merging) return { ...status, merged: false, conflicts: (status.files || []).filter((f) => f.status === 'U').map((f) => f.path) };
    throw new GitError(409, r.stderr.trim() || r.stdout.trim() || 'Merge failed');
  })
);

gitRouter.post(
  '/:id/merge/abort',
  wrap(async (req) => {
    const dir = projectDir(req.params.id);
    if (!fs.existsSync(path.join(dir, '.git', 'MERGE_HEAD'))) throw new GitError(409, 'No merge in progress');
    await gitOk(dir, ['merge', '--abort']);
    return readStatus(dir);
  })
);

/** Both sides of a conflicted file: "mine" (the current branch) and "theirs" (the branch being merged). */
gitRouter.get(
  '/:id/conflict',
  wrap(async (req) => {
    const dir = projectDir(req.params.id);
    const file = safePath(dir, req.query.path);
    const side = async (n: 2 | 3) => {
      const r = await git(dir, ['show', `:${n}:${file}`]);
      return r.code === 0 ? r.stdout : null; // null: the file was deleted on that side
    };
    return { path: file, ours: await side(2), theirs: await side(3) };
  })
);

/**
 * Resolve one conflicted file: keep mine, take theirs, or mark my manual edit as resolved
 * (refused while conflict markers are still in the file).
 */
gitRouter.post(
  '/:id/conflict/resolve',
  wrap(async (req) => {
    const dir = projectDir(req.params.id);
    const file = safePath(dir, req.body?.path);
    const take = String(req.body?.take || '');
    if (!['ours', 'theirs', 'edited'].includes(take)) throw new GitError(400, 'Choose ours, theirs or edited');
    if (take === 'edited') {
      const abs = path.join(dir, file);
      if (fs.existsSync(abs) && /^(<{7}|>{7}|={7})( |$)/m.test(fs.readFileSync(abs, 'utf-8'))) {
        throw new GitError(409, 'The file still has conflict markers (<<<<<<< ======= >>>>>>>)');
      }
      await gitOk(dir, ['add', '--', file]);
      return readStatus(dir);
    }
    // The chosen side may have deleted the file: then resolving means deleting it
    const exists = (await git(dir, ['show', `:${take === 'ours' ? 2 : 3}:${file}`])).code === 0;
    if (exists) {
      await gitOk(dir, ['checkout', `--${take}`, '--', file]);
      await gitOk(dir, ['add', '--', file]);
    } else {
      await gitOk(dir, ['rm', '--quiet', '--', file]);
    }
    return readStatus(dir);
  })
);

// ---------- one file's history ----------

/** Commits that changed a file (following renames). */
gitRouter.get(
  '/:id/file-log',
  wrap(async (req) => {
    const dir = projectDir(req.params.id);
    const file = safePath(dir, req.query.path);
    if (!isRepo(dir) || !(await hasCommits(dir))) return { commits: [] };
    const raw = await gitOk(dir, ['log', '--follow', '-n', '100', '--pretty=format:%H%x1f%h%x1f%an%x1f%at%x1f%s%x1e', '--', file]);
    const commits = raw
      .split('\x1e')
      .map((r) => r.trim())
      .filter(Boolean)
      .map((r) => {
        const [hash, short, author, at, subject] = r.split('\x1f');
        return { hash, short, author, date: Number(at) * 1000, subject };
      });
    return { commits };
  })
);

/** A file before and after one commit, for the diff view. */
gitRouter.get(
  '/:id/file-at',
  wrap(async (req) => {
    const dir = projectDir(req.params.id);
    const file = safePath(dir, req.query.path);
    const hash = String(req.query.hash || '');
    if (!/^[0-9a-f]{4,40}$/i.test(hash)) throw new GitError(400, 'Invalid commit');
    const show = async (rev: string) => {
      const r = await git(dir, ['show', `${rev}:${file}`]);
      return r.code === 0 ? r.stdout : '';
    };
    const hasParent = (await git(dir, ['rev-parse', '--verify', '--quiet', `${hash}^`])).code === 0;
    return { path: file, original: hasParent ? await show(`${hash}^`) : '', modified: await show(hash) };
  })
);

/** Files changed by one commit. */
gitRouter.get(
  '/:id/commit/:hash',
  wrap(async (req) => {
    const dir = projectDir(req.params.id);
    const hash = String(req.params.hash);
    if (!/^[0-9a-f]{4,40}$/i.test(hash)) throw new GitError(400, 'Invalid commit');
    const raw = await gitOk(dir, ['show', '--name-status', '--format=', '-z', hash]);
    const parts = raw.split('\0').filter(Boolean);
    const files: GitFileStatus[] = [];
    for (let i = 0; i < parts.length; i++) {
      const s = parts[i];
      if (/^[RC]\d*$/.test(s)) {
        files.push({ status: 'R', path: parts[i + 2] });
        i += 2;
      } else {
        files.push({ status: s[0], path: parts[i + 1] });
        i += 1;
      }
    }
    return { files };
  })
);

gitRouter.post(
  '/:id/identity',
  wrap(async (req) => {
    const dir = projectDir(req.params.id);
    const name = String(req.body?.name || '').trim();
    const email = String(req.body?.email || '').trim();
    if (!name || name.length > 100 || !/^[^\s@]+@[^\s@]+$/.test(email) || email.length > 200) {
      throw new GitError(400, 'Enter a name and a valid e-mail');
    }
    await gitOk(dir, ['config', 'user.name', name]);
    await gitOk(dir, ['config', 'user.email', email]);
    return readStatus(dir);
  })
);

gitRouter.post(
  '/:id/remote',
  wrap(async (req) => {
    const dir = projectDir(req.params.id);
    const url = String(req.body?.url || '').trim();
    // Only network remotes: no local paths or helper protocols ("ext::" can run commands)
    if (!/^(https:\/\/[^\s]+|git@[\w.-]+:[^\s]+|ssh:\/\/[^\s]+)$/.test(url) || url.length > 500) {
      throw new GitError(400, 'Use an https://, ssh:// or git@host:owner/repo address');
    }
    const has = (await git(dir, ['remote', 'get-url', 'origin'])).code === 0;
    await gitOk(dir, has ? ['remote', 'set-url', 'origin', url] : ['remote', 'add', 'origin', url]);
    return readStatus(dir);
  })
);

gitRouter.post(
  '/:id/push',
  wrap(async (req) => {
    const dir = projectDir(req.params.id);
    const r = await git(dir, ['push', '-u', 'origin', 'HEAD'], 180_000);
    if (r.code !== 0) throw new GitError(400, (r.stderr || r.stdout).trim() || 'git push failed');
    return { ...(await readStatus(dir)), output: (r.stderr + r.stdout).trim() };
  })
);

gitRouter.post(
  '/:id/pull',
  wrap(async (req) => {
    const dir = projectDir(req.params.id);
    const { branch, upstream } = parseStatus(await gitOk(dir, ['status', '--porcelain=v1', '-b', '-z']));
    const r = await git(dir, upstream ? ['pull', '--ff-only'] : ['pull', '--ff-only', 'origin', branch], 180_000);
    if (r.code !== 0) throw new GitError(400, (r.stderr || r.stdout).trim() || 'git pull failed');
    return { ...(await readStatus(dir)), output: (r.stderr + r.stdout).trim() };
  })
);

// ---------- publish to GitHub (official GitHub CLI "gh": its own browser sign-in, no tokens in the studio) ----------

/** gh command; tests point SCRIPTCRAFT_GH_SCRIPT to a fake gh (a Node script), so they never touch a real account. */
function ghCommand(args: string[]): { cmd: string; args: string[] } {
  const fake = process.env.SCRIPTCRAFT_GH_SCRIPT;
  return fake ? { cmd: process.execPath, args: [fake, ...args] } : { cmd: 'gh', args };
}

function gh(cwd: string, args: string[], timeoutMs = 60_000): Promise<GitResult> {
  return new Promise((resolve) => {
    const c = ghCommand(args);
    let child;
    try {
      child = spawn(c.cmd, c.args, { cwd, windowsHide: true, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } });
    } catch (err: any) {
      return resolve({ code: -1, stdout: '', stderr: err.message });
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('error', (e: Error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: '', stderr: e.message });
    });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: Buffer.concat(out).toString('utf-8'), stderr: Buffer.concat(err).toString('utf-8') });
    });
  });
}

/** Is gh installed, and which GitHub account is signed in. */
async function ghStatus(): Promise<{ installed: boolean; account: string | null }> {
  const v = await gh(process.cwd(), ['--version'], 15_000);
  if (v.code !== 0) return { installed: false, account: null };
  const s = await gh(process.cwd(), ['auth', 'status', '--hostname', 'github.com'], 20_000);
  const m = /account\s+([A-Za-z0-9-]+)/.exec(s.stdout + s.stderr) || /as\s+([A-Za-z0-9-]+)/.exec(s.stdout + s.stderr);
  return { installed: true, account: s.code === 0 && m ? m[1] : null };
}

const isGithubUrl = (url: string | null) => !!url && /github\.com[/:]/i.test(url);
const webUrl = (url: string) => url.replace(/^git@github\.com:/i, 'https://github.com/').replace(/\.git$/, '');

gitRouter.get(
  '/:id/github',
  wrap(async (req) => {
    const dir = projectDir(req.params.id);
    const status = await ghStatus();
    const remote = isRepo(dir) ? (await git(dir, ['remote', 'get-url', 'origin'])).stdout.trim() || null : null;
    return { ...status, remote, repoUrl: isGithubUrl(remote) ? webUrl(remote!) : null };
  })
);

/** Sign in in gh's own window (it opens the browser with a one-time code). */
gitRouter.post(
  '/:id/github/login',
  wrap(async (req) => {
    projectDir(req.params.id);
    if (process.platform !== 'win32') throw new GitError(400, 'Run "gh auth login" in a terminal');
    const c = ghCommand(['auth', 'login', '--web', '--git-protocol', 'https', '--hostname', 'github.com']);
    const quoted = [c.cmd, ...c.args].map((a) => (/[\s"]/.test(a) ? `"${a}"` : a)).join(' ');
    // cmd /k strips the outer quotes of its command, so it gets one more pair
    spawn('cmd.exe', ['/c', 'start', '"GitHub"', 'cmd.exe', '/k', `"${quoted}"`], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
    return { ok: true };
  })
);

/** Create a GitHub repository for the project and push it (a first commit is made if there is none). */
gitRouter.post(
  '/:id/github/publish',
  wrap(async (req) => {
    const dir = projectDir(req.params.id);
    const name = String(req.body?.name || '').trim();
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(name) || /^\.+$/.test(name)) throw new GitError(400, 'Repository name: Latin letters, digits, "-", "_" and "." only');
    const visibility = req.body?.visibility === 'public' ? 'public' : 'private';
    const description = String(req.body?.description || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 350);

    const status = await ghStatus();
    if (!status.installed) throw new GitError(409, 'GitHub CLI is not installed: https://cli.github.com');
    if (!status.account) throw new GitError(409, 'Sign in to GitHub first');

    await initRepo(dir);
    const remote = (await git(dir, ['remote', 'get-url', 'origin'])).stdout.trim();
    if (remote) throw new GitError(409, `The project is already connected to ${remote}`);
    const name_ = (await git(dir, ['config', 'user.name'])).stdout.trim();
    const email = (await git(dir, ['config', 'user.email'])).stdout.trim();
    if (!name_ || !email) throw new GitError(409, 'Set the commit author first (Git panel)');
    // Everything that is not committed yet goes into the published version
    await gitOk(dir, ['add', '-A']);
    const pending = (await git(dir, ['diff', '--cached', '--quiet'])).code !== 0;
    const hasCommits = (await git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD'])).code === 0;
    if (pending || !hasCommits) await gitOk(dir, ['commit', '--allow-empty', '-m', hasCommits ? 'Update before publishing' : 'First version']);

    const args = ['repo', 'create', name, `--${visibility}`, '--source', dir, '--remote', 'origin', '--push'];
    if (description) args.push('--description', description);
    const r = await gh(dir, args, 180_000);
    if (r.code !== 0) throw new GitError(400, (r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ') || 'gh repo create failed');
    const url = /https:\/\/github\.com\/[^\s]+/.exec(r.stdout + r.stderr)?.[0]?.replace(/\.git$/, '') || null;
    const origin = (await git(dir, ['remote', 'get-url', 'origin'])).stdout.trim();
    return { url: url || (origin ? webUrl(origin) : null), visibility, ...(await readStatus(dir)) };
  })
);
