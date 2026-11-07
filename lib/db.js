// JSON-file database.
//
// Every table is one JSON file holding an array of rows:
//   - Local development: ./data/<table>.json on disk
//   - Vercel:            db/<table>.json in a private Vercel Blob store
//   - Postgres (Neon):   one row per table in "app_tables" (rows as jsonb),
//                        chosen with DB_DRIVER=postgres + DATABASE_URL
//
// Vercel's serverless filesystem is read-only and is thrown away after each
// request, so on Vercel the same JSON files live in Blob storage instead.
// Writes use ETag-conditional updates (optimistic locking), so two webhook
// hits arriving at the same moment cannot overwrite each other.

import fs from 'node:fs/promises';
import path from 'node:path';

const DATA_DIR = path.join(process.cwd(), 'data');
const BLOB_PREFIX = 'db/';
const MAX_RETRIES = 10;

export function driverName() {
  const forced = (process.env.DB_DRIVER || '').toLowerCase();
  if (forced === 'local' || forced === 'blob' || forced === 'postgres') return forced;
  const hasBlob = Boolean(process.env.BLOB_STORE_ID || process.env.BLOB_READ_WRITE_TOKEN);
  return hasBlob || process.env.VERCEL ? 'blob' : 'local';
}

function assertTableName(name) {
  if (!/^[a-z0-9_-]+$/i.test(name)) throw new Error(`Invalid table name: ${name}`);
}

// ---------------------------------------------------------------- local files

let localLock = Promise.resolve();

const local = {
  file(name) {
    return path.join(DATA_DIR, `${name}.json`);
  },

  async read(name) {
    try {
      const text = await fs.readFile(this.file(name), 'utf8');
      return { rows: parseRows(text, name), etag: null };
    } catch (err) {
      if (err.code === 'ENOENT') return { rows: [], etag: null };
      throw err;
    }
  },

  async update(name, mutate) {
    // Serialize writers inside this process, then write atomically.
    const run = localLock.then(async () => {
      const { rows } = await this.read(name);
      const result = await mutate(rows);
      await fs.mkdir(DATA_DIR, { recursive: true });
      const tmp = `${this.file(name)}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(rows, null, 2) + '\n');
      await fs.rename(tmp, this.file(name));
      return result;
    });
    localLock = run.catch(() => {});
    return run;
  },
};

// ---------------------------------------------------------------- vercel blob

const blob = {
  async sdk() {
    if (!process.env.BLOB_STORE_ID && !process.env.BLOB_READ_WRITE_TOKEN) {
      throw new DbConfigError(
        'No Vercel Blob store is connected. In Vercel open Storage → Create → Blob (Private), ' +
          'connect it to this project, then redeploy.'
      );
    }
    return import('@vercel/blob');
  },

  // The version tag for conditional writes must come from head() (the Blob
  // API's metadata). The ETag header on get() is the download's HTTP ETag,
  // which can differ (e.g. after compression), so it never matches ifMatch.
  async currentEtag(pathname) {
    const { head } = await this.sdk();
    try {
      return (await head(pathname)).etag || null;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  },

  async read(name) {
    const { get } = await this.sdk();
    const pathname = `${BLOB_PREFIX}${name}.json`;
    // Tag first, then contents: if someone writes in between, our contents
    // are newer than the tag, so the conditional write fails and retries.
    const etag = await this.currentEtag(pathname);
    if (!etag) return { rows: [], etag: null };
    const result = await get(pathname, { access: 'private', useCache: false });
    if (!result || !result.stream) return { rows: [], etag: null };
    const text = await new Response(result.stream).text();
    return { rows: parseRows(text, name), etag };
  },

  async update(name, mutate) {
    const { put } = await this.sdk();
    const pathname = `${BLOB_PREFIX}${name}.json`;
    const write = (rows, cond) =>
      put(pathname, JSON.stringify(rows, null, 2), {
        access: 'private',
        contentType: 'application/json',
        addRandomSuffix: false,
        cacheControlMaxAge: 60,
        ...cond,
      });

    let lastErr;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const { rows, etag } = await this.read(name);
      const result = await mutate(rows);
      try {
        // Existing file: only overwrite the exact version we read.
        // New file: creation fails if someone else created it first.
        await write(rows, etag ? { allowOverwrite: true, ifMatch: etag } : { allowOverwrite: false });
        return result;
      } catch (err) {
        if (!isWriteConflict(err)) throw err;
        lastErr = err;
        // Safety net: if the file is still at the version we read, nobody else
        // wrote it, so the check itself misfired. Save unconditionally rather
        // than failing every request.
        if (etag && (await this.currentEtag(pathname)) === etag) {
          console.warn(`db: ETag check misfired for "${name}", writing without it`);
          await write(rows, { allowOverwrite: true });
          return result;
        }
        await sleep(Math.min(800, 30 * 2 ** attempt) + Math.random() * 120);
      }
    }
    throw new Error(`Could not write table "${name}" after ${MAX_RETRIES} attempts: ${lastErr?.message}`);
  },
};

function isNotFound(err) {
  const name = err?.constructor?.name || err?.name || '';
  return name === 'BlobNotFoundError' || /not found|does not exist/i.test(String(err?.message || ''));
}

function isWriteConflict(err) {
  const name = err?.constructor?.name || err?.name || '';
  const msg = String(err?.message || '').toLowerCase();
  return (
    name === 'BlobPreconditionFailedError' ||
    msg.includes('precondition') ||
    msg.includes('already exists')
  );
}

// ---------------------------------------------------------------- postgres (Neon)
//
// Same model as the JSON files: one document per table, so nothing else in
// the app changes. A read is one query (Blob needed two trips); writes use a
// version number for optimistic locking, like Blob's ETag.

export const databaseUrl = () => String(process.env.DATABASE_URL || process.env.POSTGRES_URL || '').trim();

const CREATE_TABLES = [
  `CREATE TABLE IF NOT EXISTS app_tables (
     name text PRIMARY KEY,
     rows jsonb NOT NULL DEFAULT '[]'::jsonb,
     version bigint NOT NULL DEFAULT 1,
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS app_cache (
     name text PRIMARY KEY,
     value jsonb,
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,
];

export const pg = {
  client: null, // (text, params) => rows; tests can swap this out

  async query(text, params = []) {
    if (!this.client && globalThis.__pgTestClient) this.client = globalThis.__pgTestClient; // local tests only
    if (!this.client) {
      const url = databaseUrl();
      if (!url) {
        throw new DbConfigError(
          'DB_DRIVER is "postgres" but no DATABASE_URL is set. In Vercel open Storage → connect your Neon database to this project, then redeploy.'
        );
      }
      const { neon } = await import('@neondatabase/serverless');
      const sql = neon(url);
      this.client = (t, p) => sql.query(t, p);
    }
    try {
      return await this.client(text, params);
    } catch (err) {
      // First use of a fresh database: create the tables, then try once more
      if (err?.code !== '42P01') throw err;
      for (const ddl of CREATE_TABLES) await this.client(ddl, []);
      return this.client(text, params);
    }
  },

  async read(name) {
    const r = await this.query('SELECT rows, version FROM app_tables WHERE name = $1', [name]);
    if (!r.length) return { rows: [], etag: null };
    const rows = typeof r[0].rows === 'string' ? JSON.parse(r[0].rows) : r[0].rows;
    if (!Array.isArray(rows)) throw new Error(`Table "${name}" is not a JSON array`);
    return { rows, etag: String(r[0].version) };
  },

  async update(name, mutate) {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const { rows, etag } = await this.read(name);
      const result = await mutate(rows);
      const json = JSON.stringify(rows);
      const done = etag
        ? await this.query(
            'UPDATE app_tables SET rows = $2::jsonb, version = version + 1, updated_at = now() WHERE name = $1 AND version = $3 RETURNING version',
            [name, json, etag]
          )
        : await this.query(
            "INSERT INTO app_tables (name, rows) VALUES ($1, $2::jsonb) ON CONFLICT (name) DO NOTHING RETURNING version",
            [name, json]
          );
      if (done.length) return result;
      await sleep(Math.min(800, 30 * 2 ** attempt) + Math.random() * 120); // someone else wrote first
    }
    throw new Error(`Could not write table "${name}" after ${MAX_RETRIES} attempts`);
  },

  /** Replace a whole table (used by the one-time copy from Blob). */
  async replace(name, rows) {
    await this.query(
      `INSERT INTO app_tables (name, rows) VALUES ($1, $2::jsonb)
       ON CONFLICT (name) DO UPDATE SET rows = EXCLUDED.rows, version = app_tables.version + 1, updated_at = now()`,
      [name, JSON.stringify(rows)]
    );
  },

  async tables() {
    return this.query('SELECT name, jsonb_array_length(rows) AS count, updated_at FROM app_tables ORDER BY name');
  },
};

// ---------------------------------------------------------------- copy helpers (Blob → Postgres)

/** Every table stored in Blob, with its rows. Skips caches (rebuilt automatically). */
export async function readAllBlobTables({ skip = [] } = {}) {
  const { list } = await blob.sdk();
  const names = [];
  let cursor;
  do {
    const page = await list({ prefix: BLOB_PREFIX, cursor, limit: 1000 });
    for (const b of page.blobs) {
      const m = /^db\/([a-z0-9_-]+)\.json$/i.exec(b.pathname);
      if (m && !skip.includes(m[1])) names.push(m[1]);
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  const out = [];
  for (const name of names) {
    try {
      out.push({ name, rows: (await blob.read(name)).rows });
    } catch (err) {
      out.push({ name, error: err.message });
    }
  }
  return out;
}

export const hasBlobCredentials = () => Boolean(process.env.BLOB_STORE_ID || process.env.BLOB_READ_WRITE_TOKEN);

// ---------------------------------------------------------------- public API

export class DbConfigError extends Error {}

function driver() {
  const d = driverName();
  return d === 'postgres' ? pg : d === 'blob' ? blob : local;
}

/** Read every row in a table. */
export async function readTable(name) {
  assertTableName(name);
  const { rows } = await driver().read(name);
  return rows;
}

/**
 * Read-modify-write a table safely. `mutate(rows)` changes the array in place
 * and may return a value, which updateTable resolves with. It can run more
 * than once if another writer got there first, so keep it free of side effects.
 */
export async function updateTable(name, mutate) {
  assertTableName(name);
  return driver().update(name, mutate);
}

/**
 * Plain JSON documents for caches (e.g. the Dhan instrument list). No locking:
 * last write wins, so only use these for data that can be rebuilt.
 */
export async function readJson(name) {
  assertTableName(name);
  if (driverName() === 'postgres' && !hasBlobCredentials()) {
    const r = await pg.query('SELECT value FROM app_cache WHERE name = $1', [name]);
    return r.length ? r[0].value : null;
  }
  if (driverName() !== 'local') {
    const { get } = await blob.sdk();
    const result = await get(`${BLOB_PREFIX}${name}.json`, { access: 'private', useCache: false });
    if (!result || !result.stream) return null;
    return JSON.parse(await new Response(result.stream).text());
  }
  try {
    return JSON.parse(await fs.readFile(local.file(name), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function writeJson(name, value) {
  assertTableName(name);
  const text = JSON.stringify(value);
  if (driverName() === 'postgres' && !hasBlobCredentials()) {
    await pg.query(
      'INSERT INTO app_cache (name, value) VALUES ($1, $2::jsonb) ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = now()',
      [name, text]
    );
    return;
  }
  if (driverName() !== 'local') {
    const { put } = await blob.sdk();
    await put(`${BLOB_PREFIX}${name}.json`, text, {
      access: 'private',
      contentType: 'application/json',
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 60,
    });
    return;
  }
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${local.file(name)}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, text);
  await fs.rename(tmp, local.file(name));
}

function parseRows(text, name) {
  if (!text.trim()) return [];
  const data = JSON.parse(text);
  if (!Array.isArray(data)) throw new Error(`Table "${name}" is not a JSON array`);
  return data;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
