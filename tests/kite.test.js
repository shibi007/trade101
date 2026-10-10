/**
 * Kite credential handling and the login exchange.
 *
 * Network calls are stubbed: these check what the app would send to Kite and
 * how it reads Kite's answer, not Kite itself.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trade101-kite-'));
process.env.TRADE101_DATA_DIR = dir;

const { createSession } = await import('../server/services/authService.js');
const kite = await import('../server/services/kiteService.js');
const { writeDoc } = await import('../server/services/store.js');

let n = 0;
const fresh = () => createSession(`tester${++n}`);
const clearEnv = () => { delete process.env.KITE_API_KEY; delete process.env.KITE_API_SECRET; };

test.beforeEach(async () => {
  clearEnv();
  await writeDoc('kite', {});
});
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('a saved key and secret are used together', async () => {
  const t = fresh();
  await kite.setCredentials(t, 'savedkey00000001', 'savedsecret0000000000000000000001', true);
  process.env.KITE_API_KEY = 'envkey0000000002';
  process.env.KITE_API_SECRET = 'envsecret00000000000000000000002';
  const t2 = createSession(`tester${n}`);        // same user, fresh session: re-hydrates from storage
  const st = kite.getStatus(t2);
  assert.equal(st.source, 'saved');
  assert.equal(st.apiKeyMasked, 'save••••');
});

test('a key from one place is never paired with a secret from another', async () => {
  // The legacy shared slot has only a key; the environment has a full pair.
  // The old code took the shared key and the environment's secret — a pair
  // Kite rejects with "Invalid checksum". Now the environment pair wins whole.
  await writeDoc('kite', { apiKey: 'sharedkeyonly001' });
  process.env.KITE_API_KEY = 'envkey0000000003';
  process.env.KITE_API_SECRET = 'envsecret00000000000000000000003';
  const st = kite.getStatus(fresh());
  assert.equal(st.source, 'env');
  assert.equal(st.apiKeyMasked, 'envk••••');
});

test('environment values are trimmed', async () => {
  process.env.KITE_API_KEY = '  envkey0000000004\n';
  process.env.KITE_API_SECRET = 'envsecret00000000000000000000004 \r\n';
  const t = fresh();
  const sent = await captureExchange(t, 'reqtoken4');
  assert.equal(sent.api_key, 'envkey0000000004');
  assert.equal(sent.checksum, sha256('envkey0000000004' + 'reqtoken4' + 'envsecret00000000000000000000004'));
});

test('the checksum is SHA-256 of api_key + request_token + api_secret', async () => {
  const t = fresh();
  await kite.setCredentials(t, 'abcd1234efgh5678', 'secretsecretsecretsecretsecret12', false);
  const sent = await captureExchange(t, 'RqTk-9');
  assert.equal(sent.checksum, sha256('abcd1234efgh5678' + 'RqTk-9' + 'secretsecretsecretsecretsecret12'));
  assert.equal(sent.request_token, 'RqTk-9');
});

test('a secret with spaces, line breaks or quotes is refused when saved', async () => {
  const t = fresh();
  for (const bad of ['secret with space', 'secret\nnewline', '"quoted"']) {
    await assert.rejects(kite.setCredentials(t, 'abcd1234efgh5678', bad, false), /copy it again/);
  }
  await assert.rejects(kite.setCredentials(t, 'abcd1234efgh5678', '   ', false), /required/);
});

test('"Invalid checksum" is explained with the key and where it came from', async () => {
  process.env.KITE_API_KEY = 'zxcv000000000005';
  process.env.KITE_API_SECRET = 'wrongsecret000000000000000000005';
  const t = fresh();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ status: 'error', message: 'Invalid `checksum`.', error_type: 'TokenException' }), { status: 403 });
  try {
    await assert.rejects(kite.completeSession(t, 'rt'), err => {
      assert.match(err.message, /does not match API key zxcv••••/);
      assert.match(err.message, /environment variables/);
      assert.match(err.message, /developers\.kite\.trade/);
      return true;
    });
    assert.match(kite.getStatus(t).lastError, /does not match/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('an expired or reused login link is explained', () => {
  assert.match(kite.explainSessionError('Token is invalid or has expired.', {}), /expired or was already used/);
  assert.equal(kite.explainSessionError('Something else', {}), 'Something else');
});

test('the callback page escapes the error text', async () => {
  const { default: router } = await import('../server/routes/kite.js');
  const layer = router.stack.find(l => l.route?.path === '/callback');
  const handler = layer.route.stack[0].handle;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ status: 'error', message: '<img src=x onerror=alert(1)>' }), { status: 400 });
  process.env.KITE_API_KEY = 'abcd000000000006';
  process.env.KITE_API_SECRET = 'secret0000000000000000000000006';
  const t = fresh();
  let html = '';
  try {
    await handler({ query: { request_token: 'r', status: 'success' }, headers: { cookie: `t101_session=${t}` } },
      { send: h => { html = h; } });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.ok(html.includes('&lt;img'), 'escaped');
  assert.ok(!html.includes('<img src=x'), 'not raw');
});

// ---------- helpers ----------

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

/** Run the session exchange against a stub and return the form fields sent. */
async function captureExchange(token, requestToken) {
  const realFetch = globalThis.fetch;
  let sent = null;
  globalThis.fetch = async (url, opts) => {
    sent = Object.fromEntries(new URLSearchParams(opts.body.toString()));
    return new Response(JSON.stringify({ status: 'success', data: { access_token: 'at', user_id: 'AB1234', user_name: 'Test' } }));
  };
  try {
    await kite.completeSession(token, requestToken);
  } finally {
    globalThis.fetch = realFetch;
  }
  return sent;
}
