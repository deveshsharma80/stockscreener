// Daily mover scan: every Binance USDT spot pair whose daily candle is up by
// at least `minPct` % (close ÷ open − 1, using the live price for the current
// day) is added to the crypto watchlist, and logged in "crypto_scan_hits".
//
// The daily candle is Binance's: it opens at 00:00 UTC (05:30 IST), like the
// 1-day candles on the Crypto chart. Run it from a scheduler (cron-job.org,
// every 15 minutes, 24/7) via /api/crypto?action=scan&secret=…
//
// Blob usage: nothing is read or written unless a coin qualifies that hasn't
// been recorded yet for that day (this instance also remembers what it has
// already recorded).
import { readTable, updateTable } from './db.js';

export const WATCH_TABLE = 'crypto_watchlist';
export const HITS_TABLE = 'crypto_scan_hits';
export const DEFAULT_COINS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'];
export const MAX_COINS = 100;
const KEEP_HITS = 500;
const BATCH = 100; // Binance: at most 100 symbols per tradingDay request

const hosts = () =>
  (process.env.BINANCE_REST_HOSTS || 'https://api.binance.com,https://data-api.binance.vision')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);

/** GET a Binance public endpoint, trying each host in turn. */
export async function binanceGet(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  let last = '';
  for (const host of hosts()) {
    try {
      const r = await fetch(`${host}${path}?${qs}`, { headers: { accept: 'application/json' } });
      if (r.ok) return await r.json();
      const body = await r.text().catch(() => '');
      last = `HTTP ${r.status}${r.status === 451 || r.status === 403 ? ' — Binance blocks this server location; set the Vercel function region to Mumbai (bom1)' : ''} ${body.slice(0, 120)}`;
    } catch (e) {
      last = e.message;
    }
  }
  throw Object.assign(new Error(`Binance unreachable from the server: ${last.trim()}`), { status: 502 });
}

const LEVERAGED = /(UP|DOWN|BULL|BEAR)USDT$/;

/** Find today's movers. Returns { day, checked, matches: [{ symbol, open, price, pct, high, quoteVolume }] } */
export async function findDailyMovers({ minPct = 40, get = binanceGet } = {}) {
  const all = await get('/api/v3/ticker/24hr', { type: 'MINI' });
  const symbols = all.filter((t) => t.symbol.endsWith('USDT') && !LEVERAGED.test(t.symbol) && Number(t.quoteVolume) > 0).map((t) => t.symbol);
  const rows = [];
  for (let i = 0; i < symbols.length; i += BATCH) {
    const batch = symbols.slice(i, i + BATCH);
    rows.push(...(await get('/api/v3/ticker/tradingDay', { symbols: JSON.stringify(batch), type: 'MINI', timeZone: '0', symbolStatus: 'TRADING' })));
  }
  const matches = [];
  let day = null;
  for (const t of rows) {
    const open = Number(t.openPrice);
    const price = Number(t.lastPrice);
    if (!(open > 0) || !(price > 0)) continue;
    const pct = Math.round((price / open - 1) * 10000) / 100; // 2 decimals, so +40% isn't 39.9999…%
    day ||= new Date(Number(t.openTime) || Date.now()).toISOString().slice(0, 10);
    if (pct >= minPct) {
      matches.push({ symbol: t.symbol, open, price, pct, high: Number(t.highPrice), quoteVolume: Number(t.quoteVolume) });
    }
  }
  matches.sort((a, b) => b.pct - a.pct);
  return { day: day || new Date().toISOString().slice(0, 10), checked: rows.length, matches };
}

const seen = new Set(); // "day|symbol" already recorded (per server instance)

/** Record new matches and add them to the watchlist. */
export async function recordMovers({ day, matches, minPct }) {
  const fresh = matches.filter((m) => !seen.has(`${day}|${m.symbol}`));
  if (!fresh.length) return { added: [], logged: [], full: [] };

  const hits = await readTable(HITS_TABLE).catch(() => []);
  const known = new Set(hits.map((h) => `${h.day}|${h.symbol}`));
  const toLog = fresh.filter((m) => !known.has(`${day}|${m.symbol}`));
  fresh.forEach((m) => known.has(`${day}|${m.symbol}`) && seen.add(`${day}|${m.symbol}`));
  if (!toLog.length) return { added: [], logged: [], full: [] };

  const at = new Date().toISOString();
  // Watchlist first, so a coin is logged only once it's really added (or already there)
  const { added, full } = await updateTable(WATCH_TABLE, (rows) => {
    if (!rows.length) rows.push(...DEFAULT_COINS.map((s) => ({ symbol: s, addedAt: at })));
    const out = { added: [], full: [] };
    for (const m of toLog) {
      if (rows.some((r) => r.symbol === m.symbol)) continue;
      if (rows.length >= MAX_COINS) {
        out.full.push(m.symbol);
        continue;
      }
      rows.push({ symbol: m.symbol, addedAt: at, addedBy: 'scan', note: `+${m.pct.toFixed(1)}% day (${day})` });
      out.added.push(m.symbol);
    }
    return out;
  });
  const addedSet = new Set(added);
  await updateTable(HITS_TABLE, (rows) => {
    for (const m of toLog) {
      if (rows.some((r) => r.day === day && r.symbol === m.symbol)) continue;
      rows.push({ day, symbol: m.symbol, open: m.open, price: m.price, pct: m.pct, minPct, at, added: addedSet.has(m.symbol), full: full.includes(m.symbol) });
    }
    if (rows.length > KEEP_HITS) rows.splice(0, rows.length - KEEP_HITS);
  });
  toLog.forEach((m) => seen.add(`${day}|${m.symbol}`));
  return { added, logged: toLog.map((m) => m.symbol), full };
}

export async function runDailyScan({ minPct = 40, get } = {}) {
  const found = await findDailyMovers({ minPct, get });
  const rec = await recordMovers({ ...found, minPct });
  return { ...found, minPct, ...rec, at: new Date().toISOString() };
}

export const readHits = () => readTable(HITS_TABLE).catch(() => []);
export const _resetSeen = () => seen.clear(); // tests
