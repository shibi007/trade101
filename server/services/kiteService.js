/**
 * Zerodha Kite Connect integration.
 *
 * Flow:
 *  1. User saves their API key + secret from the UI (kept in server memory,
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

const KITE_BASE = 'https://api.kite.trade';
const KITE_VERSION = '3';

// In-memory session state (cleared on server restart, like a daily Kite session)
const state = {
  apiKey: process.env.KITE_API_KEY || null,
  apiSecret: process.env.KITE_API_SECRET || null,
  accessToken: null,
  userId: null,
  userName: null,
  connectedAt: null,
  lastError: null,
};

export function setCredentials(apiKey, apiSecret) {
  state.apiKey = apiKey?.trim() || null;
  state.apiSecret = apiSecret?.trim() || null;
  state.accessToken = null; // new creds invalidate old session
  state.lastError = null;
}

export function getStatus() {
  return {
    configured: Boolean(state.apiKey && state.apiSecret),
    connected: Boolean(state.accessToken),
    apiKeyMasked: state.apiKey ? state.apiKey.slice(0, 4) + '••••' : null,
    userId: state.userId,
    userName: state.userName,
    connectedAt: state.connectedAt,
    lastError: state.lastError,
  };
}

export function getLoginUrl() {
  if (!state.apiKey) return null;
  return `https://kite.zerodha.com/connect/login?v=${KITE_VERSION}&api_key=${encodeURIComponent(state.apiKey)}`;
}

export async function completeSession(requestToken) {
  if (!state.apiKey || !state.apiSecret) {
    throw new Error('Kite API key/secret not configured');
  }
  const checksum = crypto
    .createHash('sha256')
    .update(state.apiKey + requestToken + state.apiSecret)
    .digest('hex');

  const body = new URLSearchParams({
    api_key: state.apiKey,
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
  });

  const json = await res.json();
  if (!res.ok || json.status !== 'success') {
    state.lastError = json.message || `Kite session exchange failed (HTTP ${res.status})`;
    throw new Error(state.lastError);
  }

  state.accessToken = json.data.access_token;
  state.userId = json.data.user_id;
  state.userName = json.data.user_name;
  state.connectedAt = new Date().toISOString();
  state.lastError = null;
  return getStatus();
}

export function disconnect() {
  state.accessToken = null;
  state.userId = null;
  state.userName = null;
  state.connectedAt = null;
}

async function kiteGet(path) {
  if (!state.accessToken) throw new Error('Not connected to Kite');
  const res = await fetch(`${KITE_BASE}${path}`, {
    headers: {
      'X-Kite-Version': KITE_VERSION,
      Authorization: `token ${state.apiKey}:${state.accessToken}`,
    },
  });
  const json = await res.json();
  if (!res.ok || json.status !== 'success') {
    // Token expired → drop session so UI shows reconnect
    if (res.status === 403) disconnect();
    throw new Error(json.message || `Kite API error (HTTP ${res.status})`);
  }
  return json.data;
}

/** Fetch full quotes for instruments like ["NSE:INFY", "NSE:TCS"] */
export async function getQuotes(instruments) {
  const qs = instruments.map(i => `i=${encodeURIComponent(i)}`).join('&');
  return kiteGet(`/quote?${qs}`);
}

/** Live quotes for the insights universe; null when not connected. */
export async function getUniverseQuotes(symbols) {
  if (!state.accessToken) return null;
  try {
    return await getQuotes(symbols.map(s => `NSE:${s}`));
  } catch (err) {
    state.lastError = err.message;
    return null;
  }
}

export function isConnected() {
  return Boolean(state.accessToken);
}
