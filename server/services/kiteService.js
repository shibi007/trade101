/**
 * Zerodha Kite Connect integration — per-user, stored in auth session.
 *
 * Flow:
 *  1. User saves their API key + secret from the UI (kept in the auth session,
 *     never written to disk, secret never echoed back).
 *  2. UI opens the Kite login URL; after login Zerodha redirects to our
 *     callback with a request_token.
 *  3. We exchange request_token for an access_token using
 *     SHA-256(api_key + request_token + api_secret).
 *  4. Live quotes are then fetched from api.kite.trade.
 *
 * Docs: https://kite.trade/docs/connect/v3/
 */
import crypto from 'crypto';
import { getSession } from './authService.js';

const KITE_BASE = 'https://api.kite.trade';
const KITE_VERSION = '3';

function getKiteSession(token) {
  const session = getSession(token);
  if (!session) return null;
  if (!session.kite) {
    session.kite = { apiKey: null, apiSecret: null, accessToken: null, userId: null, userName: null, connectedAt: null, lastError: null };
  }
  return session.kite;
}

export function setCredentials(token, apiKey, apiSecret) {
  const kite = getKiteSession(token);
  if (!kite) throw new Error('Session expired');
  kite.apiKey = apiKey?.trim() || null;
  kite.apiSecret = apiSecret?.trim() || null;
  kite.accessToken = null;
  kite.lastError = null;
}

export function getStatus(token) {
  const kite = getKiteSession(token);
  if (!kite) return null;
  return {
    configured: Boolean(kite.apiKey && kite.apiSecret),
    connected: Boolean(kite.accessToken),
    apiKeyMasked: kite.apiKey ? kite.apiKey.slice(0, 4) + '••••' : null,
    userId: kite.userId,
    userName: kite.userName,
    connectedAt: kite.connectedAt,
    lastError: kite.lastError,
  };
}

export function getLoginUrl(token) {
  const kite = getKiteSession(token);
  if (!kite?.apiKey) return null;
  return `https://kite.zerodha.com/connect/login?v=${KITE_VERSION}&api_key=${encodeURIComponent(kite.apiKey)}`;
}

export async function completeSession(token, requestToken) {
  const kite = getKiteSession(token);
  if (!kite) throw new Error('Session expired');
  if (!kite.apiKey || !kite.apiSecret) {
    throw new Error('Kite API key/secret not configured');
  }

  const checksum = crypto
    .createHash('sha256')
    .update(kite.apiKey + requestToken + kite.apiSecret)
    .digest('hex');

  try {
    const body = new URLSearchParams({
      api_key: kite.apiKey,
      request_token: requestToken,
      checksum,
    });

    const res = await fetch(`${KITE_BASE}/session/token`, {
      method: 'POST',
      headers: {
        'X-Kite-Version': KITE_VERSION,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
      timeout: 5000,
    });

    const json = await res.json();
    if (!res.ok || json.status !== 'success') {
      const msg = json.message || `Kite session exchange failed (HTTP ${res.status})`;
      kite.lastError = msg;
      throw new Error(msg);
    }

    kite.accessToken = json.data.access_token;
    kite.userId = json.data.user_id;
    kite.userName = json.data.user_name;
    kite.connectedAt = new Date().toISOString();
    kite.lastError = null;
    return getStatus(token);
  } catch (err) {
    kite.lastError = err.message;
    throw err;
  }
}

export function disconnect(token) {
  const kite = getKiteSession(token);
  if (kite) {
    kite.accessToken = null;
    kite.userId = null;
    kite.userName = null;
    kite.connectedAt = null;
  }
}

async function kiteGet(token, path) {
  const kite = getKiteSession(token);
  if (!kite?.accessToken) throw new Error('Not connected to Kite');

  try {
    const res = await fetch(`${KITE_BASE}${path}`, {
      headers: {
        'X-Kite-Version': KITE_VERSION,
        Authorization: `token ${kite.apiKey}:${kite.accessToken}`,
      },
      timeout: 5000,
    });

    const json = await res.json();
    if (!res.ok || json.status !== 'success') {
      if (res.status === 403) disconnect(token);
      throw new Error(json.message || `Kite API error (HTTP ${res.status})`);
    }
    return json.data;
  } catch (err) {
    kite.lastError = err.message;
    throw err;
  }
}

/** Fetch full quotes for instruments like ["NSE:INFY", "NSE:TCS"] */
export async function getQuotes(token, instruments) {
  const qs = instruments.map(i => `i=${encodeURIComponent(i)}`).join('&');
  return kiteGet(token, `/quote?${qs}`);
}

/** Live quotes for the insights universe; null when not connected. */
export async function getUniverseQuotes(token, symbols) {
  const kite = getKiteSession(token);
  if (!kite?.accessToken) return null;
  try {
    return await getQuotes(token, symbols.map(s => `NSE:${s}`));
  } catch (err) {
    return null; // fail silently, fall back to simulated data
  }
}

export function isConnected(token) {
  const kite = getKiteSession(token);
  return Boolean(kite?.accessToken);
}
