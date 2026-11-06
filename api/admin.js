// /api/admin — storage tools. Admin only: signed in, or WEBHOOK_SECRET (never CRON_SECRET).
//
// GET ?action=db-status                 which storage is in use; row counts in Blob and Postgres
// GET ?action=db-copy&confirm=yes       copy every Blob table into Postgres (one time).
//                                       Tables that already have rows in Postgres are skipped,
//                                       unless &overwrite=yes (refused once DB_DRIVER=postgres).
//
// Both are plain GETs so they can be opened in the browser while signed in.
import { databaseUrl, driverName, hasBlobCredentials, pg, readAllBlobTables } from '../lib/db.js';
import { HttpError, checkSecret, cors, sendError } from '../lib/http.js';

const CACHES = ['instruments_cache']; // rebuilt automatically, not worth copying

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  res.setHeader('Cache-Control', 'no-store');
  try {
    checkSecret(req); // admin: no { cron: true }
    if (req.method !== 'GET') throw new HttpError(405, 'Use GET');
    const action = req.query?.action;
    if (action === 'db-status') return res.json({ ok: true, ...(await status()) });
    if (action === 'db-copy') return res.json({ ok: true, ...(await copy(req.query)) });
    throw new HttpError(400, 'Use ?action=db-status or ?action=db-copy&confirm=yes');
  } catch (err) {
    return sendError(res, err);
  }
}

async function status() {
  const out = { inUse: driverName(), blobConnected: hasBlobCredentials(), postgresConnected: Boolean(databaseUrl()), tables: {} };
  const add = (name, key, value) => ((out.tables[name] ||= {})[key] = value);
  if (out.blobConnected) {
    for (const t of await readAllBlobTables({ skip: CACHES })) add(t.name, 'blob', t.error ? `error: ${t.error}` : t.rows.length);
  }
  if (out.postgresConnected) {
    try {
      for (const t of await pg.tables()) {
        add(t.name, 'postgres', Number(t.count));
        add(t.name, 'postgresUpdated', t.updated_at);
      }
    } catch (err) {
      out.postgresError = err.message;
    }
  }
  if (out.blobConnected && out.postgresConnected) {
    for (const t of Object.values(out.tables)) t.match = (t.blob ?? 0) === (t.postgres ?? 0);
    out.allMatch = Object.values(out.tables).every((t) => t.match);
  }
  out.next =
    out.inUse === 'postgres'
      ? 'Postgres is in use. Blob is no longer read or written.'
      : !out.postgresConnected
        ? 'Connect a Neon database to this project in Vercel (Storage), then redeploy.'
        : out.allMatch
          ? 'Counts match. Set DB_DRIVER=postgres in Vercel and redeploy to switch.'
          : 'Run ?action=db-copy&confirm=yes to copy Blob into Postgres.';
  return out;
}

async function copy(q) {
  if (q.confirm !== 'yes') throw new HttpError(400, 'Add &confirm=yes to copy every Blob table into Postgres.');
  if (!hasBlobCredentials()) throw new HttpError(400, 'No Blob store is connected, so there is nothing to copy.');
  if (!databaseUrl()) throw new HttpError(400, 'No DATABASE_URL: connect a Neon database to this project in Vercel first, then redeploy.');
  const overwrite = q.overwrite === 'yes';
  if (overwrite && driverName() === 'postgres') {
    throw new HttpError(400, 'Postgres is already in use, so its data is newer than Blob. Overwriting is refused to avoid losing it.');
  }
  const existing = new Map((await pg.tables()).map((t) => [t.name, Number(t.count)]));
  const result = [];
  for (const t of await readAllBlobTables({ skip: CACHES })) {
    if (t.error) {
      result.push({ table: t.name, status: 'error', error: t.error });
      continue;
    }
    if (existing.has(t.name) && !overwrite) {
      result.push({ table: t.name, status: 'skipped (already in Postgres)', blob: t.rows.length, postgres: existing.get(t.name) });
      continue;
    }
    await pg.replace(t.name, t.rows);
    result.push({ table: t.name, status: 'copied', rows: t.rows.length });
  }
  return { copied: result.filter((r) => r.status === 'copied').length, result, next: 'Check ?action=db-status, then set DB_DRIVER=postgres in Vercel and redeploy.' };
}
