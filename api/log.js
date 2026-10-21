// GET /api/log?secret=XXX — last raw Chartink payloads, newest first.
// Useful for checking exactly what Chartink sends.
import { readTable } from '../lib/db.js';
import { checkSecret, cors, sendError } from '../lib/http.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Use GET' });
  try {
    checkSecret(req);
    const rows = await readTable('webhook_log');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, count: rows.length, rows: rows.slice().reverse() });
  } catch (err) {
    return sendError(res, err);
  }
}
