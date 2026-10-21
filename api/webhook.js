// POST /api/webhook — endpoint for third-party applications.
//
// 1) Chartink alerts are detected automatically (see lib/chartink.js).
//    Webhook URL for Chartink:  https://YOUR-APP.vercel.app/api/webhook?secret=XXX&target=5
//
// 2) Any other app can send one record, an array, or { "records": [...] }:
//   {
//     "StockSymbol": "RELIANCE",          required
//     "PotentialProfit": 125.5,           required, number
//     "HitTime": "2026-10-21T09:15:00Z",  optional, defaults to now
//     "StockID": "abc-123"                optional, generated if missing
//   }
import { updateTable } from '../lib/db.js';
import { STOCKS_TABLE, extractRecords, toStockRow } from '../lib/stocks.js';
import { chartinkToRecords, isChartinkPayload, resolveTargetPct } from '../lib/chartink.js';
import { HttpError, checkSecret, cors, parseBody, sendError } from '../lib/http.js';

const MAX_RECORDS = 500;
const LOG_TABLE = 'webhook_log';
const LOG_KEEP = 200;

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      message: 'Webhook is live. Send a POST with JSON to add stock hits. Chartink alerts are detected automatically.',
      example: { StockSymbol: 'RELIANCE', PotentialProfit: 125.5, HitTime: new Date().toISOString() },
      secretRequired: Boolean(process.env.WEBHOOK_SECRET),
    });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Use POST' });
  }

  try {
    checkSecret(req);

    const body = parseBody(req);
    const chartink = isChartinkPayload(body);
    const records = chartink
      ? chartinkToRecords(body, { targetPct: resolveTargetPct(req) })
      : extractRecords(body);

    if (chartink) await logPayload(body).catch((e) => console.error('webhook_log:', e.message));

    if (!records || records.length === 0) throw new HttpError(400, 'No records in request body');
    if (records.length > MAX_RECORDS) throw new HttpError(413, `At most ${MAX_RECORDS} records per request`);

    const parsed = records.map(toStockRow);
    const invalid = parsed
      .map((p, index) => (p.errors ? { index, symbol: records[index]?.StockSymbol, errors: p.errors } : null))
      .filter(Boolean);

    // Generic senders: reject the whole request so they can fix and resend.
    // Chartink can't fix anything, so keep the good stocks and skip bad ones.
    if (invalid.length && !chartink) throw new HttpError(422, 'Validation failed', { invalid });
    if (invalid.length) console.warn('Chartink: skipped invalid stocks', JSON.stringify(invalid));
    const good = parsed.filter((p) => !p.errors);

    const result = await updateTable(STOCKS_TABLE, (rows) => {
      const inserted = [];
      const duplicates = [];
      // Retries from the sender (same StockID + HitTime) are not stored twice.
      const seen = new Set(rows.map((r) => `${r.StockID}|${r.HitTime}`));
      for (const { row, idempotent } of good) {
        const key = `${row.StockID}|${row.HitTime}`;
        if ((idempotent || chartink) && seen.has(key)) {
          duplicates.push(row);
          continue;
        }
        seen.add(key);
        rows.push(row);
        inserted.push(row);
      }
      return { inserted, duplicates };
    });

    return res.status(result.inserted.length ? 201 : 200).json({
      ok: true,
      source: chartink ? 'chartink' : 'generic',
      inserted: result.inserted.length,
      duplicates: result.duplicates.length,
      skipped: invalid,
      records: result.inserted,
    });
  } catch (err) {
    return sendError(res, err);
  }
}

// Keep the last few raw Chartink payloads, so you can see exactly what
// Chartink sent (e.g. after adding result columns to the alert).
async function logPayload(body) {
  const { webhook_url, ...safe } = body; // the URL contains your secret
  await updateTable(LOG_TABLE, (rows) => {
    rows.push({ receivedAt: new Date().toISOString(), body: safe });
    if (rows.length > LOG_KEEP) rows.splice(0, rows.length - LOG_KEEP);
  });
}
