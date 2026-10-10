/**
 * Persistent store: the file backend always; the Postgres backend when
 * TEST_DATABASE_URL points at a database it may freely write to, e.g.
 *
 *   TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/trade101_test npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initStore, closeStore, readDoc, writeDoc, storeStatus } from '../server/services/store.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'trade101-store-'));
const ENV_KEYS = ['DATABASE_URL', 'DATA_ENCRYPTION_KEY', 'TRADE101_DATA_DIR', 'RENDER', 'EPHEMERAL_DISK'];
const saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
const restoreEnv = () => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } };

test.afterEach(async () => { await closeStore(); restoreEnv(); });

// ---------- file backend ----------

test('file backend round-trips documents with owner-only permissions', async () => {
  process.env.TRADE101_DATA_DIR = tmp();
  delete process.env.DATABASE_URL;
  await initStore();
  await writeDoc('kite', { users: { a: { apiKey: 'k', apiSecret: 's' } } });
  assert.deepEqual(readDoc('kite').users.a, { apiKey: 'k', apiSecret: 's' });
  const mode = fs.statSync(path.join(process.env.TRADE101_DATA_DIR, 'kite.json')).mode & 0o777;
  if (process.platform !== 'win32') assert.equal(mode, 0o600);
});

test('readDoc returns a copy, so callers cannot change state behind the store', async () => {
  process.env.TRADE101_DATA_DIR = tmp();
  await initStore();
  await writeDoc('users', [{ username: 'a' }]);
  const u = readDoc('users');
  u.push({ username: 'intruder' });
  assert.equal(readDoc('users').length, 1);
});

test('absent documents read as empty', async () => {
  process.env.TRADE101_DATA_DIR = tmp();
  await initStore();
  assert.deepEqual(readDoc('users'), []);
  assert.deepEqual(readDoc('kite'), {});
});

test('the file backend is reported as not durable on a host that wipes its disk', async () => {
  process.env.TRADE101_DATA_DIR = tmp();
  process.env.RENDER = 'true';
  await initStore();
  assert.deepEqual([storeStatus().backend, storeStatus().durable], ['file', false]);
});

test('unknown documents are rejected', () => {
  assert.throws(() => readDoc('passwords'), /Unknown document/);
});

// ---------- postgres backend ----------

const PG = process.env.TEST_DATABASE_URL;
const pgTest = PG ? test : test.skip;

async function resetDb() {
  const { default: pg } = await import('pg');
  const c = new pg.Client({ connectionString: PG });
  await c.connect();
  await c.query('DROP TABLE IF EXISTS trade101_state, trade101_migrations');
  await c.end();
}
async function rawRows() {
  const { default: pg } = await import('pg');
  const c = new pg.Client({ connectionString: PG });
  await c.connect();
  const { rows } = await c.query('SELECT key, value FROM trade101_state ORDER BY key');
  await c.end();
  return rows;
}

pgTest('a wiped local disk loses nothing: data comes back from the database', async () => {
  await resetDb();
  Object.assign(process.env, { DATABASE_URL: PG, DATA_ENCRYPTION_KEY: 'k1', TRADE101_DATA_DIR: tmp(), RENDER: 'true' });
  await initStore();
  await writeDoc('users', [{ username: 'shibi', hash: 'h' }]);
  await writeDoc('kite', { users: { shibi: { apiKey: 'key1', apiSecret: 'secret1' } } });
  await closeStore();

  process.env.TRADE101_DATA_DIR = tmp(); // a fresh, empty disk — what a redeploy leaves
  const status = await initStore();
  assert.deepEqual([status.backend, status.durable, status.encrypted], ['postgres', true, true]);
  assert.equal(readDoc('users')[0].username, 'shibi');
  assert.equal(readDoc('kite').users.shibi.apiSecret, 'secret1');
});

pgTest('stored rows hold no readable secrets when a key is set', async () => {
  await resetDb();
  Object.assign(process.env, { DATABASE_URL: PG, DATA_ENCRYPTION_KEY: 'k1', TRADE101_DATA_DIR: tmp() });
  await initStore();
  await writeDoc('kite', { users: { shibi: { apiKey: 'visiblekey', apiSecret: 'visiblesecret' } } });
  const text = JSON.stringify(await rawRows());
  assert.ok(!/visiblekey|visiblesecret|shibi/.test(text));
});

pgTest('a wrong or missing key refuses to boot instead of starting empty', async () => {
  await resetDb();
  Object.assign(process.env, { DATABASE_URL: PG, DATA_ENCRYPTION_KEY: 'right', TRADE101_DATA_DIR: tmp() });
  await initStore();
  await writeDoc('users', [{ username: 'a' }]);
  await closeStore();
  process.env.DATA_ENCRYPTION_KEY = 'wrong';
  await assert.rejects(initStore({ retry: { attempts: 1 } }), /DATA_ENCRYPTION_KEY differs/);
  await closeStore();
  delete process.env.DATA_ENCRYPTION_KEY;
  await assert.rejects(initStore({ retry: { attempts: 1 } }), /DATA_ENCRYPTION_KEY is not set/);
});

pgTest('migration 001 imports local files into an empty database, once', async () => {
  await resetDb();
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify([{ username: 'fromfile' }]));
  Object.assign(process.env, { DATABASE_URL: PG, DATA_ENCRYPTION_KEY: 'k1', TRADE101_DATA_DIR: dir });
  const s1 = await initStore();
  assert.deepEqual(s1.migrations.find(m => m.id === '001-import-local-files')?.touched, ['users']);
  assert.equal(readDoc('users')[0].username, 'fromfile');
  await writeDoc('users', [{ username: 'changed-in-db' }]);
  await closeStore();
  // A stale local file must never overwrite what the database holds.
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify([{ username: 'stale' }]));
  await initStore();
  assert.equal(readDoc('users')[0].username, 'changed-in-db');
});

pgTest('migration 002 encrypts rows saved before a key was set', async () => {
  await resetDb();
  Object.assign(process.env, { DATABASE_URL: PG, TRADE101_DATA_DIR: tmp() });
  delete process.env.DATA_ENCRYPTION_KEY;
  await initStore();
  await writeDoc('kite', { users: { a: { apiKey: 'k', apiSecret: 'plainsecret' } } });
  await closeStore();
  assert.equal((await rawRows())[0].value.format, 'plain');

  process.env.DATA_ENCRYPTION_KEY = 'added-later';
  const s = await initStore();
  assert.deepEqual(s.migrations.find(m => m.id === '002-encrypt-at-rest')?.touched, ['kite']);
  assert.equal((await rawRows())[0].value.format, 'aes-256-gcm');
  assert.equal(readDoc('kite').users.a.apiSecret, 'plainsecret');
});
