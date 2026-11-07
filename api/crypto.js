// /api/crypto — Crypto pages (Binance spot). Webhook secret required.
//
// GET  ?action=watchlist                      your coins
// POST {action:"add", symbol:"BTCUSDT", market?:"futures"}  add a coin (USDT pair; "futures" = perpetual only, no spot pair)
// POST {action:"remove", symbol:"BTCUSDT"}
// GET  ?action=scan&minPct=40                 daily mover scan: every USDT pair whose daily
//      candle is up ≥ minPct % gets added to the watchlist (for a scheduler, every 15 min)
// GET  ?action=scan-hits                      coins found by the scan (latest first)
// GET  ?action=movers-history                 saved Big Movers history (one-time scan of past days)
// POST {action:"movers-history", meta, rows}   save a new Big Movers scan (replaces the old one)
// GET  ?action=candles-status                4-hour perp candle store: totals + each coin's latest candle
// GET  ?action=candles-scan&view=rsi-ema&rsi=85&ratio=1.01&scope=latest|all   RSI 14 > rsi and EMA5/EMA9 > ratio
// GET  ?action=candles-scan&view=close-open&ratio=1.05&scope=latest|all       close / open > ratio
// GET  ?action=candles&symbol=EVAAUSDT       one coin's stored 4-hour candles (oldest first)
// POST {action:"candles-save", rows:[[symbol, timeMs, o, h, l, c, vol, quoteVol, rsi14, ema5, ema9, ema21], …]}
// POST {action:"candles-prune"}              drop rows older than the 3-month window
// POST {action:"candles-delete", confirm:true} delete all stored candles
// POST {action:"candles-delete-hourly", confirm:true} delete the old hourly table (candles_1h)
// Paper trading (futures style, amounts in ₹ at a fixed rate; see lib/cryptopaper.js):
// GET  ?action=cp-book                       account, open positions, fills, closed trades (checks liquidations first)
// POST {action:"cp-trade", symbol, side:"BUY"|"SELL", qty, leverage, price?}   market order (qty in coins)
// POST {action:"cp-close", symbol, price?}   close a whole position
// POST {action:"cp-reset", capitalInr, fx?, closeOpen?}  start a new period with this money (history kept;
//                                            closeOpen closes open positions at market first)
// POST {action:"cp-exit", symbol, kind:"SL"|"TP", price|null, hint?}   set / clear stop loss or take profit
// POST {action:"cp-check-now", prices?}      check liquidations / SL / TP now (page prices only fill gaps)
// GET  ?action=cp-check                      liquidation + SL/TP check (for a scheduler; accepts CRON_SECRET)
// GET  ?action=binance&path=/api/v3/klines&q=<query>
//      fallback proxy for Binance public market data, used only if the
//      browser can't reach Binance directly. Binance blocks some US servers;
//      if this fails on Vercel, set the function region to Mumbai (bom1).
import { readTable, updateTable } from '../lib/db.js';
import { HttpError, checkSecret, cors, parseBody, sendError } from '../lib/http.js';
import { DEFAULT_COINS, MAX_COINS, readHits, runDailyScan } from '../lib/cryptoscan.js';
import { checkLiquidations, closePosition, computeBook, placeTrade, resetAccount, setExit } from '../lib/cryptopaper.js';
import { candleStatus, coinCandles, deleteAllCandles, deleteHourlyCandles, pruneCandles, saveCandles, scanCandles } from '../lib/candles.js';

const TABLE = 'crypto_watchlist';
const MAX = MAX_COINS;
// Binance symbols are usually A–Z / 0–9 (BTCUSDT, 1000SATSUSDT) but a few use other
// scripts (e.g. 币安人生USDT), so allow any characters except spaces and URL / HTML specials.
const SYMBOL_RE = /^[^\s"'<>\\/?#&%=+,;:]{1,30}USDT$/u;
const DEFAULT = DEFAULT_COINS;
const PROXY_PATHS = new Set(['/api/v3/klines', '/api/v3/ticker/24hr', '/api/v3/ticker/price', '/api/v3/exchangeInfo', '/fapi/v1/klines', '/fapi/v1/ticker/24hr', '/fapi/v1/exchangeInfo', '/fapi/v1/ticker/price']);
const HOSTS = ['https://data-api.binance.vision', 'https://api.binance.com'];
const FUT_HOSTS = ['https://fapi.binance.com'];
const HISTORY_TABLE = 'crypto_movers_history';
const MAX_HISTORY_ROWS = 10000;
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** Validate a Big Movers scan sent by the page (computed in the browser from Binance candles). */
function cleanHistory(body) {
  const m = body?.meta || {};
  if (!Array.isArray(body?.rows)) throw new HttpError(400, 'rows must be a list');
  if (body.rows.length > MAX_HISTORY_ROWS) throw new HttpError(400, `At most ${MAX_HISTORY_ROWS} rows`);
  const skipped = [];
  const rows = [];
  for (const r of body.rows) {
    const symbol = String(r?.symbol || '').trim();
    const day = String(r?.day || '');
    if (!SYMBOL_RE.test(symbol) || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      skipped.push(symbol.slice(0, 40) || '(blank)'); // keep the rest of the scan
      continue;
    }
    rows.push({
      symbol,
      day,
      open: num(r.open),
      close: num(r.close),
      high: num(r.high),
      low: num(r.low),
      ratio: num(r.ratio),
      pct: num(r.pct),
      highRatio: num(r.highRatio),
      quoteVolume: num(r.quoteVolume),
      next1: num(r.next1),
      next7: num(r.next7),
      max7: num(r.max7),
    });
  }
  return {
    meta: {
      runAt: new Date().toISOString(),
      months: num(m.months),
      minRatio: num(m.minRatio),
      from: String(m.from || '').slice(0, 10),
      to: String(m.to || '').slice(0, 10),
      checked: num(m.checked),
      failed: Array.isArray(m.failed) ? m.failed.slice(0, 50).map(String) : [],
      skipped: skipped.slice(0, 50),
    },
    rows,
  };
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (process.env.VERCEL && !String(process.env.WEBHOOK_SECRET || '').trim()) {
      throw new HttpError(403, 'Set WEBHOOK_SECRET in Vercel to use the Crypto pages.');
    }
    const body = req.method === 'POST' ? parseBody(req) || {} : {};
    const action = req.method === 'POST' ? body.action : req.query?.action;
    checkSecret(req, { cron: action === 'scan' || action === 'cp-check' }); // scheduler jobs may use CRON_SECRET

    switch (`${req.method} ${action}`) {
      case 'GET watchlist': {
        const items = await watchlist();
        return res.json({ ok: true, symbols: items.map((r) => r.symbol), items });
      }
      case 'GET scan':
      case 'POST scan': {
        const raw = req.method === 'POST' ? body.minPct : req.query?.minPct;
        const minPct = raw === undefined || raw === '' ? 40 : Number(raw);
        if (!(minPct > 0 && minPct <= 10000)) throw new HttpError(400, 'minPct must be a percentage above 0, e.g. 40');
        return res.json({ ok: true, ...(await runDailyScan({ minPct })) });
      }
      case 'GET scan-hits':
        return res.json({ ok: true, hits: (await readHits()).slice().reverse() });
      case 'POST add': {
        const symbol = String(body.symbol || '').trim();
        if (!SYMBOL_RE.test(symbol)) throw new HttpError(400, 'Pick a USDT pair, e.g. BTCUSDT');
        const futures = body.market === 'futures';
        const items = await updateTable(TABLE, (rows) => {
          if (!rows.length) rows.push(...DEFAULT.map((s) => ({ symbol: s, addedAt: new Date().toISOString() })));
          if (!rows.some((r) => r.symbol === symbol)) {
            if (rows.length >= MAX) throw new HttpError(400, `At most ${MAX} coins`);
            rows.push({ symbol, addedAt: new Date().toISOString(), ...(futures ? { market: 'futures' } : {}) });
          }
          return rows.slice();
        });
        return res.json({ ok: true, symbols: items.map((r) => r.symbol), items });
      }
      case 'POST remove': {
        const symbol = String(body.symbol || '').trim().toUpperCase();
        const symbols = await updateTable(TABLE, (rows) => {
          if (!rows.length) rows.push(...DEFAULT.map((s) => ({ symbol: s, addedAt: new Date().toISOString() })));
          const keep = rows.filter((r) => r.symbol !== symbol);
          rows.length = 0;
          rows.push(...keep);
          return rows.slice();
        });
        return res.json({ ok: true, symbols: symbols.map((r) => r.symbol), items: symbols });
      }
      case 'GET movers-history': {
        const [saved] = await readTable(HISTORY_TABLE).catch(() => []);
        return res.json({ ok: true, ...(saved || { meta: null, rows: [] }) });
      }
      case 'POST movers-history': {
        const saved = cleanHistory(body);
        await updateTable(HISTORY_TABLE, (rows) => {
          rows.length = 0;
          rows.push(saved);
        });
        return res.json({ ok: true, ...saved });
      }
      case 'GET candles-status':
        return res.json({ ok: true, ...(await candleStatus()) });
      case 'GET candles-scan': {
        const p = req.query || {};
        return res.json({ ok: true, ...(await scanCandles({ view: p.view, rsi: p.rsi, ratio: p.ratio, scope: p.scope === 'all' ? 'all' : 'latest' })) });
      }
      case 'GET candles':
        return res.json({ ok: true, symbol: String(req.query?.symbol || ''), candles: await coinCandles(String(req.query?.symbol || '').trim()) });
      case 'POST candles-save':
        return res.json({ ok: true, ...(await saveCandles(body.rows)) });
      case 'POST candles-prune':
        return res.json({ ok: true, ...(await pruneCandles()) });
      case 'POST candles-delete':
        if (body.confirm !== true) throw new HttpError(400, 'Send confirm: true to delete all candle data');
        return res.json({ ok: true, ...(await deleteAllCandles()) });
      case 'POST candles-delete-hourly':
        if (body.confirm !== true) throw new HttpError(400, 'Send confirm: true to delete the old hourly data');
        return res.json({ ok: true, ...(await deleteHourlyCandles()) });
      case 'GET cp-book': {
        const check = await checkLiquidations().catch(() => ({ liquidated: [], exited: [], prices: {} }));
        return res.json({ ok: true, liquidated: check.liquidated, exited: check.exited, ...(await computeBook(check.prices)) });
      }
      case 'POST cp-check-now': {
        const check = await checkLiquidations({ hints: body.prices && typeof body.prices === 'object' ? body.prices : {} });
        return res.json({ ok: true, liquidated: check.liquidated, exited: check.exited, ...(await computeBook(check.prices)) });
      }
      case 'POST cp-exit':
        return res.json({ ok: true, ...(await setExit({ symbol: String(body.symbol || '').trim(), kind: body.kind, price: body.price, priceHint: body.hint })) });
      case 'GET cp-check':
        return res.json({ ok: true, ...(await checkLiquidations()) });
      case 'POST cp-trade': {
        const r = await placeTrade({ symbol: body.symbol, side: body.side, qty: body.qty, leverage: body.leverage, priceHint: body.price });
        return res.json({ ok: true, fill: r.fill, ...r.book });
      }
      case 'POST cp-close': {
        const r = await closePosition(String(body.symbol || '').trim(), body.price);
        return res.json({ ok: true, fill: r.fill, ...r.book });
      }
      case 'POST cp-reset':
        return res.json({ ok: true, ...(await resetAccount({ capitalInr: body.capitalInr, fx: body.fx, closeOpen: body.closeOpen === true, prices: body.prices && typeof body.prices === 'object' ? body.prices : {} })) });
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
  return rows.length ? rows : DEFAULT.map((symbol) => ({ symbol })); // starter list until you change it
}

async function proxy(path, q) {
  if (!PROXY_PATHS.has(path)) throw new HttpError(400, 'Not an allowed Binance endpoint');
  let last = '';
  for (const host of path.startsWith('/fapi/') ? FUT_HOSTS : HOSTS) {
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
