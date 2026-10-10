/**
 * Persistent state — the one place for data that must outlive the process.
 *
 * Two documents live here: `users` (logins, password hashes, 2FA secrets) and
 * `kite` (each user's saved Kite API key and secret). They used to be plain
 * files under data/. That works on a machine with a disk; on hosts with an
 * ephemeral filesystem — Render's free plan among them — every deploy, restart
 * and wake from sleep starts from an empty disk, and the files are gone.
 *
 * Backends:
 *   - file (default): data/<doc>.json, as before. Right for local use and any
 *     host with a persistent disk.
 *   - postgres: chosen when DATABASE_URL is set. Survives anything the app
 *     host does. A free Neon database is enough; Render's own free Postgres is
 *     deleted after 30 days, so it is not.
 *
 * Reads are synchronous, from an in-memory copy loaded at boot, so the many
 * existing read sites stay as they are. Writes are asynchronous and commit to
 * the backend *before* the in-memory copy changes: if the database refuses a
 * write, the caller gets an error rather than a "saved" that silently vanishes
 * on the next restart.
 *
 * At rest in Postgres each document is encrypted (AES-256-GCM) when
 * DATA_ENCRYPTION_KEY is set — the database then holds no readable API secrets
 * or 2FA seeds. Without the key documents are stored as plain JSON and a
 * warning is logged; adding the key later encrypts them on the next boot.
 *
 * On every boot, before the server accepts requests, initStore() loads the
 * documents and runs any pending migrations (see MIGRATIONS). Each migration
 * is idempotent, because on an ephemeral host the file backend forgets which
 * ones ran.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The documents this store manages, and what an absent one reads as. */
export const DOCS = {
  users: { empty: () => [] },
  kite: { empty: () => ({}) },
};

const TABLE = 'trade101_state';
const MIGRATIONS_TABLE = 'trade101_migrations';

const dataDir = () => process.env.TRADE101_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const fileFor = name => path.join(dataDir(), `${name}.json`);

let state = null;  // { backend, cache: Map, status }

// ---------- encryption at rest ----------

function encryptionKey() {
  const raw = process.env.DATA_ENCRYPTION_KEY;
  // Hashed so any length of secret yields a valid 256-bit key.
  return raw ? crypto.createHash('sha256').update(raw).digest() : null;
}

function seal(doc, key) {
  if (!key) return { format: 'plain', doc };
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(doc), 'utf8'), cipher.final()]);
  return {
    format: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

function unseal(stored, key, name) {
  if (stored?.format === 'plain') return stored.doc;
  if (stored?.format !== 'aes-256-gcm') throw new StoreError(`Unrecognised stored format for "${name}"`);
  if (!key) {
    throw new StoreError(`"${name}" is encrypted but DATA_ENCRYPTION_KEY is not set. Restore the key that was used to save it.`);
  }
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(stored.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(stored.tag, 'base64'));
    const out = Buffer.concat([decipher.update(Buffer.from(stored.data, 'base64')), decipher.final()]);
    return JSON.parse(out.toString('utf8'));
  } catch {
    // Never fall through to an empty document here: the next write would
    // overwrite the real data with it.
    throw new StoreError(`Cannot decrypt "${name}" — DATA_ENCRYPTION_KEY differs from the one it was saved with.`);
  }
}

export class StoreError extends Error {}

// ---------- backends ----------

class FileBackend {
  get kind() { return 'file'; }
  async init() {}
  async loadAll() {
    const out = {};
    for (const name of Object.keys(DOCS)) {
      try { out[name] = JSON.parse(fs.readFileSync(fileFor(name), 'utf8')); } catch { /* absent or unreadable */ }
    }
    return { docs: out, plain: [] };
  }
  async put(name, doc) {
    fs.mkdirSync(dataDir(), { recursive: true });
    // 0600: these files hold password hashes, 2FA seeds and API secrets.
    fs.writeFileSync(fileFor(name), JSON.stringify(doc, null, 2), { mode: 0o600 });
    try { fs.chmodSync(fileFor(name), 0o600); } catch { /* best effort, e.g. Windows */ }
  }
  async appliedMigrations() {
    try { return new Set(JSON.parse(fs.readFileSync(fileFor('migrations'), 'utf8'))); } catch { return new Set(); }
  }
  async markApplied(id) {
    const done = await this.appliedMigrations();
    done.add(id);
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(fileFor('migrations'), JSON.stringify([...done], null, 2));
  }
  async close() {}
}

class PostgresBackend {
  constructor(url) {
    this.url = url;
    this.key = encryptionKey();
  }
  get kind() { return 'postgres'; }
  async init() {
    const { default: pg } = await import('pg');
    // Small pool: a handful of writes a day, and free database tiers cap connections.
    this.pool = new pg.Pool({ connectionString: this.url, max: 3, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 });
    // An idle-client error (e.g. the database suspending) must not crash the app.
    this.pool.on('error', err => console.warn('⚠ Storage connection dropped:', err.message));
    await this.pool.query(`CREATE TABLE IF NOT EXISTS ${TABLE} (
      key text PRIMARY KEY,
      value jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now())`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now())`);
  }
  async loadAll() {
    const { rows } = await this.pool.query(`SELECT key, value FROM ${TABLE}`);
    const docs = {};
    const plain = [];
    for (const r of rows) {
      if (!(r.key in DOCS)) continue;
      docs[r.key] = unseal(r.value, this.key, r.key);
      if (r.value.format === 'plain') plain.push(r.key);
    }
    return { docs, plain };
  }
  async put(name, doc) {
    await this.pool.query(
      `INSERT INTO ${TABLE} (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [name, seal(doc, this.key)],
    );
  }
  async appliedMigrations() {
    const { rows } = await this.pool.query(`SELECT id FROM ${MIGRATIONS_TABLE}`);
    return new Set(rows.map(r => r.id));
  }
  async markApplied(id) {
    await this.pool.query(`INSERT INTO ${MIGRATIONS_TABLE} (id) VALUES ($1) ON CONFLICT DO NOTHING`, [id]);
  }
  async close() { await this.pool?.end(); }
}

// ---------- migrations ----------

/**
 * Run in order on every boot; each is skipped once recorded as applied, and
 * each is safe to run again regardless, since an ephemeral file backend
 * forgets the record. `ctx.local` holds whatever data/*.json files exist on
 * this machine, read before any migration runs.
 */
export const MIGRATIONS = [
  {
    id: '001-import-local-files',
    description: 'Copy existing data/*.json into the database the first time it is used',
    // Only fills documents the database does not have: once a database is in
    // use, it — not a stray local file — is the source of truth.
    async run(ctx) {
      if (ctx.backend.kind === 'file') return [];
      const imported = [];
      for (const name of Object.keys(DOCS)) {
        if (ctx.docs[name] === undefined && ctx.local[name] !== undefined) {
          await ctx.write(name, ctx.local[name]);
          imported.push(name);
        }
      }
      return imported;
    },
  },
  {
    id: '002-encrypt-at-rest',
    description: 'Re-save plain documents encrypted, once DATA_ENCRYPTION_KEY is set',
    // Not recorded as applied: the key may be added at any later deploy.
    repeat: true,
    async run(ctx) {
      if (ctx.backend.kind !== 'postgres' || !encryptionKey()) return [];
      for (const name of ctx.plain) await ctx.write(name, ctx.docs[name]);
      return [...ctx.plain];
    },
  },
];

// ---------- lifecycle ----------

function chooseBackend() {
  return process.env.DATABASE_URL ? new PostgresBackend(process.env.DATABASE_URL) : new FileBackend();
}

/**
 * Whether this host is known to wipe its disk. Render sets RENDER=true in every
 * service; set EPHEMERAL_DISK=true for other such hosts.
 */
export function hostDiskIsEphemeral() {
  return process.env.RENDER === 'true' || process.env.EPHEMERAL_DISK === 'true';
}

async function withRetry(fn, { attempts = 6, delayMs = 1000, label }) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try { return await fn(); } catch (err) {
      // A decryption failure will not fix itself; retrying only delays the error.
      if (err instanceof StoreError) throw err;
      last = err;
      if (i < attempts) {
        console.warn(`⏳ ${label} failed (attempt ${i}/${attempts}): ${err.message}`);
        await new Promise(r => setTimeout(r, delayMs * i));
      }
    }
  }
  throw last;
}

/**
 * Load state and run migrations. Call once at boot, before serving requests.
 *
 * A database that cannot be reached is retried for about 20 seconds — free
 * tiers suspend when idle and take a moment to wake — and then fails the boot.
 * Starting with empty data instead would be worse: the first save would
 * overwrite everything stored.
 */
export async function initStore({ backend = chooseBackend(), retry = {} } = {}) {
  await withRetry(() => backend.init(), { label: 'Connecting to storage', ...retry });
  const loaded = await withRetry(() => backend.loadAll(), { label: 'Loading stored data', ...retry });

  const cache = new Map(Object.entries(loaded.docs));
  const local = (await new FileBackend().loadAll()).docs;
  const ran = [];
  const ctx = {
    backend,
    docs: loaded.docs,
    plain: loaded.plain,
    local,
    async write(name, doc) {
      await backend.put(name, doc);
      cache.set(name, doc);
    },
  };
  const applied = await backend.appliedMigrations();
  for (const m of MIGRATIONS) {
    if (!m.repeat && applied.has(m.id)) continue;
    const touched = await m.run(ctx);
    if (!m.repeat) await backend.markApplied(m.id);
    if (touched.length) ran.push({ id: m.id, touched });
  }

  if (backend.kind === 'postgres' && !encryptionKey()) {
    console.warn('⚠ DATA_ENCRYPTION_KEY is not set: stored data is kept in the database as plain JSON.');
  }
  state = {
    backend,
    cache,
    status: {
      backend: backend.kind,
      durable: backend.kind === 'postgres' || !hostDiskIsEphemeral(),
      encrypted: backend.kind === 'postgres' && Boolean(encryptionKey()),
      migrations: ran,
    },
  };
  return state.status;
}

/** Close backend connections, for scripts and tests. */
export async function closeStore() {
  if (state) await state.backend.close();
  state = null;
}

/**
 * A stored document. A copy, so a caller mutating it cannot change state
 * without going through writeDoc().
 *
 * Before initStore() — in scripts or tests that never call it — this falls
 * back to reading the local file directly, which is what the app always did.
 */
export function readDoc(name) {
  if (!(name in DOCS)) throw new Error(`Unknown document: ${name}`);
  if (!state) {
    try { return JSON.parse(fs.readFileSync(fileFor(name), 'utf8')); } catch { return DOCS[name].empty(); }
  }
  const doc = state.cache.get(name);
  return doc === undefined ? DOCS[name].empty() : structuredClone(doc);
}

/** Durably save a document; resolves only once the backend has it. */
export async function writeDoc(name, doc) {
  if (!(name in DOCS)) throw new Error(`Unknown document: ${name}`);
  const backend = state?.backend ?? new FileBackend();
  await backend.put(name, doc);
  if (state) state.cache.set(name, structuredClone(doc));
}

/** Where data is kept and whether it survives a restart — shown in the UI. */
export function storeStatus() {
  return state?.status ?? {
    backend: 'file', durable: !hostDiskIsEphemeral(), encrypted: false, migrations: [],
  };
}
