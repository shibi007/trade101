/**
 * Audit log: redaction, repeat folding, filtering, per-user scope, and the
 * database copy when TEST_DATABASE_URL is set (see store.test.js).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

import { audit, queryAudit, sanitize, initAuditLog, resetAuditLog } from '../server/services/auditLog.js';
import { initStore, closeStore } from '../server/services/store.js';
import { createUser, createSession, SESSION_COOKIE } from '../server/services/authService.js';
import auditRoutes from '../server/routes/audit.js';

const ENV_KEYS = ['DATABASE_URL', 'DATA_ENCRYPTION_KEY', 'TRADE101_DATA_DIR'];
const saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
const restoreEnv = () => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } };

// The log echoes warnings and errors to the console; keep test output clean.
const quiet = fn => async () => {
  const { warn, error } = console;
  console.warn = console.error = () => {};
  try { await fn(); } finally { console.warn = warn; console.error = error; }
};

test.beforeEach(() => resetAuditLog());
test.afterEach(async () => { await closeStore(); restoreEnv(); resetAuditLog(); });

// ---------- recording ----------

test('secrets are redacted at any depth, and long values are cut', () => {
  const out = sanitize({
    apiKey: 'abc', apiSecret: 's3cret', password: 'p', nested: { access_token: 't', checksum: 'c', ok: 1 },
    list: [{ totp: '123456' }], long: 'x'.repeat(900),
  });
  assert.equal(out.apiKey, 'abc');
  for (const v of [out.apiSecret, out.password, out.nested.access_token, out.nested.checksum, out.list[0].totp]) {
    assert.equal(v, '[redacted]');
  }
  assert.equal(out.nested.ok, 1);
  assert.ok(out.long.length <= 501);
  assert.equal(JSON.stringify(out).includes('s3cret'), false);
});

test('an event is recorded with defaults and never throws on odd input', () => {
  const e = audit({ action: 'thing', message: 'hello' });
  assert.deepEqual([e.level, e.category, e.user, e.repeats], ['info', 'system', null, 0]);
  assert.equal(audit({ level: 'nonsense', message: 'x' }).level, 'info');
  const circular = {}; circular.self = circular;
  assert.doesNotThrow(() => audit({ message: 'circular', details: circular }));
});

test('repeats of the same event are folded into one entry with a count', quiet(async () => {
  for (let i = 0; i < 5; i++) audit({ level: 'warn', category: 'kite', action: 'api.error', message: 'Too many requests' });
  audit({ level: 'warn', category: 'kite', action: 'api.error', message: 'Something else' });
  const { events } = await queryAudit({ minLevel: 'warn' });
  assert.equal(events.length, 2);
  const folded = events.find(e => e.message === 'Too many requests');
  assert.equal(folded.repeats, 4);
  assert.ok(folded.lastAt);
}));

// ---------- reading ----------

test('queries filter by level, category and time, newest first', quiet(async () => {
  audit({ level: 'debug', category: 'data', action: 'a', message: 'routine' });
  audit({ level: 'info', category: 'auth', action: 'b', message: 'signed in' });
  audit({ level: 'error', category: 'data', action: 'c', message: 'broke' });

  const info = await queryAudit();
  assert.equal(info.source, 'memory');
  assert.deepEqual(info.events.map(e => e.action), ['c', 'b'], 'debug hidden by default, newest first');
  assert.deepEqual((await queryAudit({ minLevel: 'debug' })).events.map(e => e.action), ['c', 'b', 'a']);
  assert.deepEqual((await queryAudit({ minLevel: 'error' })).events.map(e => e.action), ['c']);
  assert.deepEqual((await queryAudit({ category: 'auth' })).events.map(e => e.action), ['b']);
  assert.deepEqual((await queryAudit({ before: '2000-01-01T00:00:00.000Z' })).events, []);
  assert.equal((await queryAudit({ minLevel: 'debug', limit: 1 })).events.length, 1);
}));

test('a user sees their own events and the server\'s, never another user\'s', async () => {
  audit({ category: 'auth', action: 'login', user: 'alice', message: 'alice in' });
  audit({ category: 'auth', action: 'login', user: 'bob', message: 'bob in' });
  audit({ category: 'system', action: 'server.start', message: 'started' });
  const mine = (await queryAudit({ user: 'alice' })).events.map(e => e.message);
  assert.deepEqual(mine.sort(), ['alice in', 'started']);
  assert.equal((await queryAudit()).events.length, 3, 'no user filter sees everything');
});

// ---------- route ----------

async function withServer(fn) {
  const app = express();
  app.use('/api/audit', auditRoutes);
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}/api/audit`); }
  finally { server.close(); }
}

test('the route requires a session and scopes non-admins to their own events', async () => {
  process.env.TRADE101_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'trade101-audit-'));
  delete process.env.DATABASE_URL;
  await initStore();
  await createUser('admin1', 'correct horse battery', true);
  await createUser('carol', 'correct horse battery', false);
  audit({ category: 'auth', action: 'login', user: 'admin1', message: 'admin in' });
  audit({ category: 'auth', action: 'login', user: 'carol', message: 'carol in' });

  await withServer(async url => {
    assert.equal((await fetch(url)).status, 401);

    const asCarol = await (await fetch(url, { headers: { cookie: `${SESSION_COOKIE}=${createSession('carol')}` } })).json();
    assert.equal(asCarol.scope, 'own');
    assert.deepEqual(asCarol.events.map(e => e.message), ['carol in']);

    const asAdmin = await (await fetch(`${url}?category=auth`, { headers: { cookie: `${SESSION_COOKIE}=${createSession('admin1')}` } })).json();
    assert.equal(asAdmin.scope, 'all');
    assert.deepEqual(asAdmin.events.map(e => e.message), ['carol in', 'admin in']);
    assert.ok(asAdmin.categories.includes('kite'));
  });
});

// ---------- database copy ----------

const PG = process.env.TEST_DATABASE_URL;
const pgTest = PG ? test : test.skip;

pgTest('with a database, info and above survive a restart; debug stays in memory', async () => {
  const { default: pg } = await import('pg');
  const c = new pg.Client({ connectionString: PG });
  await c.connect();
  await c.query('DROP TABLE IF EXISTS trade101_state, trade101_migrations, trade101_audit');
  await c.end();

  process.env.DATABASE_URL = PG;
  process.env.DATA_ENCRYPTION_KEY = 'audit-test-key-0123456789abcdef';
  process.env.TRADE101_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'trade101-audit-'));
  await initStore();
  assert.deepEqual(await initAuditLog(), { persisted: true });
  audit({ level: 'debug', category: 'data', action: 'refresh', message: 'routine' });
  audit({ level: 'info', category: 'kite', action: 'login', user: 'dave', message: 'Kite connected', details: { apiSecret: 'nope' } });
  await new Promise(r => setTimeout(r, 200));   // inserts are fire-and-forget

  // Simulate a restart: memory is gone, the database is not.
  resetAuditLog();
  await initAuditLog();
  const out = await queryAudit({ user: 'dave' });
  assert.equal(out.source, 'database');
  assert.deepEqual(out.events.map(e => e.message), ['Kite connected']);
  assert.equal(out.events[0].details.apiSecret, '[redacted]');
  assert.deepEqual((await queryAudit({ minLevel: 'debug' })).events, [], 'debug is memory-only');
});
