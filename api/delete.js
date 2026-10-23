// POST /api/delete — delete rows from the stocks table. Secret required.
//
// Body (JSON):
//   { "mode": "all" }                                         delete everything
//   { "mode": "range", "from": "2026-10-21", "to": "2026-10-22" }
//       deletes hits from the start of `from` to the end of `to` (both
//       inclusive), in Indian time (IST), using each row's HitTime.
//
// Send the secret like the webhook: ?secret=..., X-Webhook-Secret or Bearer.
import { updateTable } from '../lib/db.js';
import { STOCKS_TABLE } from '../lib/stocks.js';
import { HttpError, checkSecret, cors, parseBody, sendError } from '../lib/http.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

// "2026-10-21" → milliseconds at 00:00 IST that day
function istDayStart(date) {
  const t = Date.parse(`${date}T00:00:00+05:30`);
  if (!DATE_RE.test(date) || Number.isNaN(t)) throw new HttpError(400, `"${date}" is not a date like 2026-10-21`);
  return t;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Use POST' });
  }

  try {
    // Never allow an unprotected delete on Vercel.
    if (process.env.VERCEL && !String(process.env.WEBHOOK_SECRET || '').trim()) {
      throw new HttpError(403, 'Deleting is disabled until WEBHOOK_SECRET is set in Vercel.');
    }
    checkSecret(req);

    const body = parseBody(req) || {};
    let match;
    let description;

    if (body.mode === 'all') {
      match = () => true;
      description = 'all rows';
    } else if (body.mode === 'range') {
      if (!body.from || !body.to) throw new HttpError(400, 'Give both "from" and "to" dates');
      const from = istDayStart(String(body.from));
      const toExclusive = istDayStart(String(body.to)) + DAY_MS;
      if (toExclusive <= from) throw new HttpError(400, '"from" must be on or before "to"');
      match = (r) => {
        const t = new Date(r.HitTime).getTime();
        return t >= from && t < toExclusive;
      };
      description = `${body.from} to ${body.to} (IST)`;
    } else {
      throw new HttpError(400, 'Set "mode" to "all" or "range"');
    }

    const result = await updateTable(STOCKS_TABLE, (rows) => {
      const keep = rows.filter((r) => !match(r));
      const deleted = rows.length - keep.length;
      rows.length = 0;
      rows.push(...keep);
      return { deleted, remaining: keep.length };
    });

    console.log(`Deleted ${result.deleted} rows: ${description}`);
    return res.status(200).json({ ok: true, ...result, range: description });
  } catch (err) {
    return sendError(res, err);
  }
}
