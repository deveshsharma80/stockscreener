// Scanners: your own scans (Chartink style), saved in the app. They run on the Vultr server
// over the 1-minute history (server/history/history.mjs serve). Rules: src/scanner/engine.js.
import { randomUUID } from 'node:crypto';
import { readTable, updateTable } from './db.js';
import { HttpError } from './http.js';
import { checkScan } from '../src/scanner/engine.js';

export const SCANNERS_TABLE = 'scanners';
const MAX = 200;

export async function readScanners() {
  const rows = await readTable(SCANNERS_TABLE).catch(() => []);
  return [...rows].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

/** Keep only the fields a scan has (anything else in the request is dropped). */
function clean(s) {
  const term = (t) => {
    if (!t) return null;
    if (t.t === 'num') return { t: 'num', v: Number(t.v) };
    const base = { t: t.t === 'ind' ? 'ind' : 'price', tf: Number(t.tf), off: Math.max(0, Math.floor(Number(t.off) || 0)) };
    if (base.t === 'price') return { ...base, f: String(t.f) };
    return { ...base, ind: String(t.ind), n: Number(t.n) || 0, ...(String(t.ind).startsWith('bb') ? { k: Number(t.k) } : {}) };
  };
  const side = (x) => (x?.op && x.b ? { a: term(x.a), op: String(x.op), b: term(x.b) } : { a: term(x?.a) });
  return {
    name: String(s.name || '').trim().slice(0, 80),
    notes: String(s.notes || '').slice(0, 500),
    tf: Number(s.tf),
    at: s.at === 'window' ? 'window' : 'first',
    from: /^\d\d:\d\d$/.test(s.from) ? s.from : '09:15',
    to: /^\d\d:\d\d$/.test(s.to) ? s.to : '15:15',
    firstOnly: s.firstOnly !== false,
    conditions: (Array.isArray(s.conditions) ? s.conditions : []).slice(0, 30).map((c) => ({ left: side(c.left), cmp: String(c.cmp), right: side(c.right), ...(c.off ? { off: true } : {}) })),
  };
}

export async function saveScanner(input) {
  if (!input || typeof input !== 'object') throw new HttpError(400, 'No scan given');
  const scan = clean(input);
  const errs = checkScan(scan);
  if (errs.length) throw new HttpError(400, errs.join(' · '));
  const now = new Date().toISOString();
  return updateTable(SCANNERS_TABLE, (rows) => {
    const i = input.id ? rows.findIndex((r) => r.id === input.id) : -1;
    if (i >= 0) {
      rows[i] = { ...rows[i], ...scan, updatedAt: now };
      return rows[i];
    }
    if (rows.length >= MAX) throw new HttpError(400, `At most ${MAX} scans`);
    const row = { id: `scan-${randomUUID().slice(0, 8)}`, ...scan, createdAt: now, updatedAt: now };
    rows.push(row);
    return row;
  });
}

export async function deleteScanner(id) {
  await updateTable(SCANNERS_TABLE, (rows) => {
    const i = rows.findIndex((r) => r.id === id);
    if (i >= 0) rows.splice(i, 1);
  });
}
