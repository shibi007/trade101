/**
 * Audit log — a record of what the app did and why things failed, readable
 * from the Activity tab.
 *
 * Events are kept two ways:
 *   - in memory, the most recent RING_SIZE of every level including `debug`
 *     (routine detail such as each 60-second refresh), lost on restart;
 *   - in the database, when DATABASE_URL is set, every `info`, `warn` and
 *     `error` event, for RETENTION_DAYS — so the log survives deploys and the
 *     free plan's restarts. Without a database only the memory copy exists.
 *
 * Rules that keep it safe to leave on:
 *   - It never throws and never blocks the caller. A database outage drops the
 *     stored copy of an event, not the request that produced it.
 *   - Secrets never reach it: any detail whose key looks like a password,
 *     secret, token, checksum or OTP is redacted, and long values are cut.
 *   - Repeats are folded: the same event within REPEAT_WINDOW_MS becomes one
 *     entry with a count, so an error hit on every refresh does not bury
 *     everything else.
 */
import { sqlPool } from './store.js';

export const LEVELS = ['debug', 'info', 'warn', 'error'];
const RING_SIZE = 2000;
const RETENTION_DAYS = 30;
const REPEAT_WINDOW_MS = 10 * 60 * 1000;
const TABLE = 'trade101_audit';

let ring = [];
let seq = 0;
let pool = null;
let dbWarned = false;
const lastByKey = new Map();   // repeat-folding: key -> entry

const SECRET_KEY = /secret|password|passwd|token|checksum|otp|totp|authorization|cookie|session/i;

/** Copy of `value` safe to store: secrets redacted, size bounded. */
export function sanitize(value, depth = 0) {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > 500 ? value.slice(0, 500) + '…' : value;
  if (value instanceof Error) return sanitize(value.message, depth);
  if (depth >= 4) return '[nested]';
  if (Array.isArray(value)) return value.slice(0, 50).map(v => sanitize(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 40)) {
      out[k] = SECRET_KEY.test(k) ? '[redacted]' : sanitize(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

/**
 * Connect to the database table when one is in use. Call after initStore().
 * Also prunes entries past the retention period.
 */
export async function initAuditLog() {
  pool = sqlPool();
  if (!pool) return { persisted: false };
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS ${TABLE} (
      id bigserial PRIMARY KEY,
      at timestamptz NOT NULL,
      level text NOT NULL,
      category text NOT NULL,
      action text NOT NULL,
      username text,
      message text NOT NULL,
      details jsonb)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS ${TABLE}_at_idx ON ${TABLE} (at DESC)`);
    await pool.query(`DELETE FROM ${TABLE} WHERE at < now() - interval '${RETENTION_DAYS} days'`);
    return { persisted: true };
  } catch (err) {
    console.warn(`⚠ Audit log will be memory-only: ${err.message}`);
    pool = null;
    return { persisted: false };
  }
}

/**
 * Record an event. Returns the entry. Never throws.
 *
 *   audit({ level: 'warn', category: 'kite', action: 'api.error',
 *           user: 'shibi', message: 'Too many requests', details: { path } })
 */
export function audit({ level = 'info', category = 'system', action, user = null, message, details = null }) {
  try {
    if (!LEVELS.includes(level)) level = 'info';
    const entry = {
      id: ++seq,
      at: new Date().toISOString(),
      level, category,
      action: String(action || 'event'),
      user: user ?? null,
      message: sanitize(String(message ?? '')),
      details: details == null ? null : sanitize(details),
      repeats: 0,
    };

    // Fold a repeat of a recent identical event into it instead.
    const key = `${level}|${category}|${entry.action}|${entry.user}|${entry.message}`;
    const prev = lastByKey.get(key);
    if (prev && Date.now() - Date.parse(prev.lastAt || prev.at) < REPEAT_WINDOW_MS) {
      prev.repeats += 1;
      prev.lastAt = entry.at;
      if (entry.details) prev.details = entry.details;
      return prev;
    }
    lastByKey.set(key, entry);
    if (lastByKey.size > 500) lastByKey.delete(lastByKey.keys().next().value);

    ring.push(entry);
    if (ring.length > RING_SIZE) ring = ring.slice(-RING_SIZE);

    // Problems also go to the host's log, where they are visible even if the
    // app's own page cannot load.
    if (level === 'warn' || level === 'error') {
      console[level === 'error' ? 'error' : 'warn'](`[audit] ${level} ${category}/${entry.action}${entry.user ? ` (${entry.user})` : ''}: ${entry.message}`);
    }

    if (pool && level !== 'debug') {
      pool.query(
        `INSERT INTO ${TABLE} (at, level, category, action, username, message, details) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [entry.at, level, category, entry.action, entry.user, entry.message, entry.details],
      ).catch(err => {
        if (!dbWarned) { dbWarned = true; console.warn(`⚠ Audit log could not write to the database: ${err.message}`); }
      });
    }
    return entry;
  } catch {
    return null;   // the audit log must never take the app down with it
  }
}

/**
 * Read events, newest first.
 *
 *   user      restrict to this user's events (plus system events) — for non-admins
 *   category  one category, or all
 *   minLevel  'debug' | 'info' | 'warn' | 'error' (default 'info')
 *   before    ISO time: only events older than this (for paging)
 *   limit     at most this many (default 100, cap 500)
 *
 * Debug events exist only in memory, so a query that includes them reads the
 * memory copy; otherwise the database is used when there is one, which reaches
 * back past the last restart.
 */
export async function queryAudit({ user = null, category = null, minLevel = 'info', before = null, limit = 100 } = {}) {
  const min = Math.max(0, LEVELS.indexOf(minLevel));
  const wanted = LEVELS.slice(min);
  limit = Math.max(1, Math.min(500, Number(limit) || 100));

  if (pool && min > 0) {
    const where = ['level = ANY($1)'];
    const args = [wanted];
    if (category) { args.push(category); where.push(`category = $${args.length}`); }
    if (user) { args.push(user); where.push(`(username = $${args.length} OR username IS NULL)`); }
    if (before) { args.push(before); where.push(`at < $${args.length}`); }
    args.push(limit);
    try {
      const { rows } = await pool.query(
        `SELECT id, at, level, category, action, username, message, details FROM ${TABLE}
         WHERE ${where.join(' AND ')} ORDER BY at DESC, id DESC LIMIT $${args.length}`, args);
      // Repeat counts live in memory; attach them where the entry is still there.
      const live = new Map(ring.map(e => [`${e.at}|${e.action}|${e.message}`, e]));
      return {
        source: 'database',
        events: rows.map(r => {
          const at = new Date(r.at).toISOString();
          const m = live.get(`${at}|${r.action}|${r.message}`);
          return { id: `db${r.id}`, at, level: r.level, category: r.category, action: r.action, user: r.username,
            message: r.message, details: r.details, repeats: m?.repeats ?? 0, lastAt: m?.lastAt ?? null };
        }),
      };
    } catch {
      // Fall through to memory.
    }
  }
  const events = ring
    .filter(e => wanted.includes(e.level)
      && (!category || e.category === category)
      && (!user || e.user === user || e.user == null)
      && (!before || e.at < before))
    .slice(-limit)
    .reverse();
  return { source: 'memory', events };
}

/** For tests: forget everything held in memory. */
export function resetAuditLog() {
  ring = [];
  lastByKey.clear();
  seq = 0;
  pool = null;
  dbWarned = false;
}
