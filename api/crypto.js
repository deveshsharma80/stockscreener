// /api/crypto — Crypto pages (Binance spot). Webhook secret required.
//
// GET  ?action=watchlist                      your coins
// POST {action:"add", symbol:"BTCUSDT"}       add a coin (USDT pair)
// POST {action:"remove", symbol:"BTCUSDT"}
// GET  ?action=binance&path=/api/v3/klines&q=<query>
//      fallback proxy for Binance public market data, used only if the
//      browser can't reach Binance directly. Binance blocks some US servers;
//      if this fails on Vercel, set the function region to Mumbai (bom1).
import { readTable, updateTable } from '../lib/db.js';
import { HttpError, checkSecret, cors, parseBody, sendError } from '../lib/http.js';

const TABLE = 'crypto_watchlist';
const MAX = 100;
const SYMBOL_RE = /^[A-Z0-9]{2,20}USDT$/;
const DEFAULT = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'];
const PROXY_PATHS = new Set(['/api/v3/klines', '/api/v3/ticker/24hr', '/api/v3/ticker/price', '/api/v3/exchangeInfo']);
const HOSTS = ['https://data-api.binance.vision', 'https://api.binance.com'];

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (process.env.VERCEL && !String(process.env.WEBHOOK_SECRET || '').trim()) {
      throw new HttpError(403, 'Set WEBHOOK_SECRET in Vercel to use the Crypto pages.');
    }
    checkSecret(req);
    const body = req.method === 'POST' ? parseBody(req) || {} : {};
    const action = req.method === 'POST' ? body.action : req.query?.action;

    switch (`${req.method} ${action}`) {
      case 'GET watchlist':
        return res.json({ ok: true, symbols: await watchlist() });
      case 'POST add': {
        const symbol = String(body.symbol || '').trim().toUpperCase();
        if (!SYMBOL_RE.test(symbol)) throw new HttpError(400, 'Pick a USDT pair, e.g. BTCUSDT');
        const symbols = await updateTable(TABLE, (rows) => {
          if (!rows.length) rows.push(...DEFAULT.map((s) => ({ symbol: s, addedAt: new Date().toISOString() })));
          if (!rows.some((r) => r.symbol === symbol)) {
            if (rows.length >= MAX) throw new HttpError(400, `At most ${MAX} coins`);
            rows.push({ symbol, addedAt: new Date().toISOString() });
          }
          return rows.map((r) => r.symbol);
        });
        return res.json({ ok: true, symbols });
      }
      case 'POST remove': {
        const symbol = String(body.symbol || '').trim().toUpperCase();
        const symbols = await updateTable(TABLE, (rows) => {
          if (!rows.length) rows.push(...DEFAULT.map((s) => ({ symbol: s, addedAt: new Date().toISOString() })));
          const keep = rows.filter((r) => r.symbol !== symbol);
          rows.length = 0;
          rows.push(...keep);
          return rows.map((r) => r.symbol);
        });
        return res.json({ ok: true, symbols });
      }
      case 'GET binance':
        return res.json({ ok: true, data: await proxy(String(req.query?.path || ''), String(req.query?.q || '')) });
      default:
        throw new HttpError(400, `Unknown action "${action}"`);
    }
  } catch (err) {
    return sendError(res, err);
  }
}

async function watchlist() {
  const rows = await readTable(TABLE).catch(() => []);
  return rows.length ? rows.map((r) => r.symbol) : DEFAULT; // starter list until you change it
}

async function proxy(path, q) {
  if (!PROXY_PATHS.has(path)) throw new HttpError(400, 'Not an allowed Binance endpoint');
  let last = '';
  for (const host of HOSTS) {
    try {
      const r = await fetch(`${host}${path}?${q}`, { headers: { accept: 'application/json' } });
      if (r.ok) return await r.json();
      last = `HTTP ${r.status}${r.status === 451 || r.status === 403 ? ' (Binance blocks this server location — set the Vercel function region to Mumbai, bom1)' : ''}`;
    } catch (e) {
      last = e.message;
    }
  }
  throw new HttpError(502, `Binance unreachable from the server: ${last}`);
}
