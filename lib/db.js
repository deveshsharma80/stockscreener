// JSON-file database.
//
// Every table is one JSON file holding an array of rows:
//   - Local development: ./data/<table>.json on disk
//   - Vercel:            db/<table>.json in a private Vercel Blob store
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
  if (forced === 'local' || forced === 'blob') return forced;
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

// ---------------------------------------------------------------- public API

export class DbConfigError extends Error {}

function driver() {
  return driverName() === 'blob' ? blob : local;
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

function parseRows(text, name) {
  if (!text.trim()) return [];
  const data = JSON.parse(text);
  if (!Array.isArray(data)) throw new Error(`Table "${name}" is not a JSON array`);
  return data;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
