/**
 * Stamp the build with a timestamp version, written to version.json.
 *
 * Runs as `postinstall`, so every deploy that installs dependencies — Render's
 * build command is `npm install` — records which code it is running:
 *
 *   version   "2026.10.10-1433": the commit's time in IST, or the build time
 *             when git history is not available at build time
 *   commit    the deployed commit (RENDER_GIT_COMMIT on Render, else git)
 *   builtAt   when this build ran
 *
 * Stamped at build rather than computed at boot because a free Render instance
 * restarts whenever it wakes: a boot-time version would change without a deploy.
 *
 * Must never fail the install: every step is best effort.
 */
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const git = cmd => {
  try { return execSync(`git ${cmd}`, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null; } catch { return null; }
};

/** "2026.10.10-1433" in IST — sortable, and readable at a glance. */
export function formatVersion(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map(x => [x.type, x.value]));
  return `${p.year}.${p.month}.${p.day}-${p.hour}${p.minute}`;
}

export function buildVersionInfo(now = new Date()) {
  const commit = process.env.RENDER_GIT_COMMIT || git('rev-parse HEAD');
  const commitAtRaw = git('log -1 --format=%cI');
  const commitAt = commitAtRaw && !Number.isNaN(Date.parse(commitAtRaw)) ? new Date(commitAtRaw) : null;
  return {
    version: formatVersion(commitAt || now),
    basis: commitAt ? 'commit' : 'build',
    commit: commit || null,
    commitAt: commitAt ? commitAt.toISOString() : null,
    builtAt: now.toISOString(),
    branch: process.env.RENDER_GIT_BRANCH || git('rev-parse --abbrev-ref HEAD'),
  };
}

// Run only when executed directly (postinstall), not when imported by tests.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const info = buildVersionInfo();
    writeFileSync(path.join(root, 'version.json'), JSON.stringify(info, null, 2) + '\n');
    console.log(`🏷  Trade101 version ${info.version} (${info.basis} time${info.commit ? `, ${info.commit.slice(0, 7)}` : ''})`);
  } catch (err) {
    console.warn(`⚠ Could not write version.json: ${err.message}`);
  }
}
