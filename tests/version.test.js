import test from 'node:test';
import assert from 'node:assert/strict';

import { formatVersion, buildVersionInfo } from '../scripts/write-version.js';
import { getVersion } from '../server/services/version.js';

test('the version is the timestamp in IST, sortable', () => {
  assert.equal(formatVersion(new Date('2026-10-10T08:55:38Z')), '2026.10.10-1425');
  // 20:00 UTC is already the next day in India.
  assert.equal(formatVersion(new Date('2026-10-10T20:00:00Z')), '2026.10.11-0130');
  assert.ok(formatVersion(new Date('2026-01-02T00:00:00Z')) < formatVersion(new Date('2026-11-02T00:00:00Z')));
});

test('Render\'s commit variable takes precedence', () => {
  const prev = process.env.RENDER_GIT_COMMIT;
  process.env.RENDER_GIT_COMMIT = 'abc1234def5678';
  try {
    assert.equal(buildVersionInfo().commit, 'abc1234def5678');
  } finally {
    if (prev === undefined) delete process.env.RENDER_GIT_COMMIT; else process.env.RENDER_GIT_COMMIT = prev;
  }
});

test('the server reports a version, a short commit and when it started', () => {
  const v = getVersion();
  assert.match(v.version, /^\d{4}\.\d{2}\.\d{2}-\d{4}$/);
  if (v.commit) assert.equal(v.commit.length, 7);
  assert.ok(Date.parse(v.startedAt));
});
