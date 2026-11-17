// GET /api/stocks — rows from the stocks table, newest first.
// Query: ?symbol=RELIANCE  &limit=500  &since=2026-10-21T00:00:00Z
//        ?setups=1&day=YYYY-MM-DD   saved EMA-rejection setups (default today)
import { driverName, readTable } from '../lib/db.js';
import { STOCKS_TABLE } from '../lib/stocks.js';
import { checkViewer, cors, sendError } from '../lib/http.js';
import { readEmaSetups } from '../lib/emasetup.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Use GET' });
  }

  try {
    checkViewer(req); // sign-in required once APP_PASSWORD is set
    res.setHeader('Cache-Control', 'private, no-store');
    // ?setups=1[&day=2026-11-17] — Signals → EMA Rejection (gap-down EMA-rejection setups)
    if (req.query?.setups) {
      const day = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.day || '')) ? String(req.query.day) : undefined;
      return res.status(200).json({ ok: true, ...(await readEmaSetups(day)) });
    }
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
