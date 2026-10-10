/**
 * The running build's version, for the UI and /api/health.
 *
 * Read from version.json, written at install time by scripts/write-version.js.
 * Without it (a checkout where install was skipped) the same information is
 * worked out now, so a local run still shows a sensible version.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildVersionInfo } from '../../scripts/write-version.js';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'version.json');

let cached = null;

export function getVersion() {
  if (cached) return cached;
  let info;
  try {
    info = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    info = { ...buildVersionInfo(), basis: 'runtime' };
  }
  cached = {
    version: info.version,
    basis: info.basis,
    commit: info.commit ? info.commit.slice(0, 7) : null,
    commitAt: info.commitAt ?? null,
    builtAt: info.builtAt ?? null,
    startedAt: new Date().toISOString(),
  };
  return cached;
}
