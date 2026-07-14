/**
 * Authentication service — username/password with scrypt hashing and
 * in-memory sessions. No external dependencies.
 *
 * Users are stored in data/users.json (gitignored). Passwords are never
 * stored — only scrypt hashes with per-user random salts.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
export const SESSION_COOKIE = 't101_session';

// token -> { username, expires }
const sessions = new Map();

// ---------- user storage ----------
function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveUsers(users) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

export function createUser(username, password) {
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) {
    throw new Error('Username must be 3-32 chars: letters, digits, _ . -');
  }
  if (typeof password !== 'string' || password.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }
  const users = loadUsers();
  const salt = crypto.randomBytes(16).toString('hex');
  const existing = users.findIndex(u => u.username.toLowerCase() === username.toLowerCase());
  const record = {
    username,
    salt,
    hash: hashPassword(password, salt),
    createdAt: new Date().toISOString(),
  };
  if (existing >= 0) users[existing] = record; // reset password
  else users.push(record);
  saveUsers(users);
  return { username, created: existing < 0 };
}

export function verifyUser(username, password) {
  const users = loadUsers();
  const user = users.find(u => u.username.toLowerCase() === String(username).toLowerCase());
  // Always run scrypt (dummy salt when user unknown) to keep timing uniform
  const salt = user ? user.salt : '0'.repeat(32);
  const candidate = Buffer.from(hashPassword(String(password), salt), 'hex');
  const stored = Buffer.from(user ? user.hash : '0'.repeat(128), 'hex');
  const ok = candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored);
  return ok && user ? { username: user.username } : null;
}

export function hasUsers() {
  return loadUsers().length > 0;
}

// ---------- sessions ----------
export function createSession(username) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { username, expires: Date.now() + SESSION_TTL_MS });
  return token;
}

export function getSession(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expires) {
    sessions.delete(token);
    return null;
  }
  return s;
}

export function destroySession(token) {
  sessions.delete(token);
}

// ---------- middleware ----------
export function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const pair of raw.split(';')) {
    const idx = pair.indexOf('=');
    if (idx > 0) out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  }
  return out;
}

export function requireAuth(req, res, next) {
  const session = getSession(parseCookies(req)[SESSION_COOKIE]);
  if (!session) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  req.user = { username: session.username };
  next();
}

// ---------- login rate limiting (per IP) ----------
const attempts = new Map(); // ip -> { count, resetAt }
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;

export function checkRateLimit(ip) {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || now > entry.resetAt) {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true };
  }
  entry.count++;
  if (entry.count > MAX_ATTEMPTS) {
    return { allowed: false, retryAfterMin: Math.ceil((entry.resetAt - now) / 60000) };
  }
  return { allowed: true };
}

export function clearRateLimit(ip) {
  attempts.delete(ip);
}
