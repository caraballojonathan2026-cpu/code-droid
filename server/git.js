/*
 * git.js — commit integration ("like the GitHub commit button") for code-droid.
 *
 * All git invocations go through execFileSync with fixed argument arrays —
 * the commit message is passed as argv, never through a shell. Scope is the
 * current project folder (projects/<name>/).
 */
'use strict';

const { execFileSync } = require('child_process');

function git(args, cwd) {
  try {
    return { ok: true, out: execFileSync('git', args, { encoding: 'utf8', cwd, stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    return { ok: false, out: (`${e.stdout || ''}${e.stderr || ''}`).trim() || e.message };
  }
}

function status(repoRoot, project) {
  const probe = git(['rev-parse', '--is-inside-work-tree'], repoRoot);
  if (!probe.ok || !probe.out.trim().startsWith('true')) return { inRepo: false };
  const branch = (git(['branch', '--show-current'], repoRoot).out || '').trim() || 'main';
  const rel = 'projects/' + project;
  const raw = git(['status', '--porcelain', '--', rel], repoRoot).out || '';
  const changes = raw.split('\n').filter(Boolean).map((l) => ({
    status: (l.slice(0, 2).trim() || '?'),
    path: l.slice(3).trim().replace(/^"|"$/g, ''),
  }));
  return { inRepo: true, branch, changes };
}

function identityArgs(repoRoot) {
  const hasName = git(['config', 'user.name'], repoRoot);
  const hasEmail = git(['config', 'user.email'], repoRoot);
  if (hasName.ok && hasName.out.trim() && hasEmail.ok && hasEmail.out.trim()) return [];
  return ['-c', 'user.name=code-droid', '-c', 'user.email=dev@code-droid.local'];
}

function ensureRepo(repoRoot) {
  const probe = git(['rev-parse', '--is-inside-work-tree'], repoRoot);
  if (probe.ok && probe.out.trim().startsWith('true')) return { ok: true, created: false };
  const init = git(['init', '-b', 'main'], repoRoot);
  return init.ok ? { ok: true, created: true } : { ok: false, error: init.out };
}

function commit(repoRoot, project, message, description) {
  if (!message || !message.trim()) return { ok: false, error: 'Commit message is required.' };

  const repo = ensureRepo(repoRoot);
  if (!repo.ok) return { ok: false, error: 'git init failed: ' + repo.error };

  const rel = 'projects/' + project;
  const st = status(repoRoot, project);
  if (st.inRepo && st.changes.length === 0) {
    return { ok: false, error: 'Nothing to commit — working tree is clean for this project.' };
  }

  const add = git(['add', '-A', '--', rel], repoRoot);
  if (!add.ok) return { ok: false, error: 'git add failed: ' + add.out };

  const args = [...identityArgs(repoRoot), 'commit', '-m', message.trim()];
  if (description && description.trim()) args.push('-m', description.trim());
  const r = git(args, repoRoot);
  if (!r.ok) return { ok: false, error: r.out };

  const hash = (git(['rev-parse', '--short', 'HEAD'], repoRoot).out || '').trim();
  const branch = (git(['branch', '--show-current'], repoRoot).out || '').trim() || 'main';
  return { ok: true, hash, branch, repoCreated: repo.created };
}

module.exports = { status, commit };
