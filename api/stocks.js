// GET /api/stocks — rows from the stocks table, newest first.
// Query: ?symbol=RELIANCE  &limit=500  &since=2026-10-21T00:00:00Z
import { driverName, readTable } from '../lib/db.js';
import { STOCKS_TABLE } from '../lib/stocks.js';
import { cors, sendError } from '../lib/http.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Use GET' });
  }

  try {
    const { symbol, since } = req.query || {};
    const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || 1000, 1), 5000);

    let rows = await readTable(STOCKS_TABLE);
    const total = rows.length;
    if (symbol) {
      const s = String(symbol).toUpperCase();
      rows = rows.filter((r) => r.StockSymbol === s);
    }
    if (since) {
      const t = new Date(since).getTime();
      if (!Number.isNaN(t)) rows = rows.filter((r) => new Date(r.HitTime).getTime() >= t);
    }
    rows = rows
      .slice()
      .sort((a, b) => new Date(b.HitTime) - new Date(a.HitTime))
      .slice(0, limit);

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      ok: true,
      storage: driverName(),
      secretRequired: Boolean(process.env.WEBHOOK_SECRET),
      total,
      count: rows.length,
      rows,
    });
  } catch (err) {
    return sendError(res, err);
  }
}
