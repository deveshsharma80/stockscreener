// Automatic 4-hour Bollinger Band + RSI scan (Big Movers → 4h BB + RSI).
//
// Every Binance USDT perpetual: 4-hour candles whose LOW is above the upper
// Bollinger Band (30, 2) with RSI 14 above 70, over the last 7 days of completed
// candles. The result replaces the previous one in the "crypto_bb_scan" table,
// so "next 4h / 24h / now" figures are refreshed on every run.
//
// Run it from a scheduler a couple of minutes after each 4-hour candle closes
// (01:32, 05:32, 09:32, 13:32, 17:32, 21:32 IST):
//   /api/crypto?action=bb-scan&secret=<CRON_SECRET>
import { readTable, updateTable } from './db.js';
import { CANDLES, DEFAULT_CFG, H4, bbHits, toCandles } from '../src/bbcore.js';

export const BB_TABLE = 'crypto_bb_scan';
const FUT = () => (process.env.BINANCE_FUTURES_HOST || 'https://fapi.binance.com').replace(/\/$/, '');
const CONCURRENCY = 10;
const BUDGET_MS = 50_000; // stay inside the 60 s function limit

async function getJson(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(`${FUT()}${path}${qs ? `?${qs}` : ''}`, { headers: { accept: 'application/json' } });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    const err = new Error(`HTTP ${r.status}${r.status === 451 || r.status === 403 ? ' (Binance blocks this server location — use the Mumbai region, bom1)' : ''} ${body.slice(0, 100)}`.trim());
    err.status = r.status;
    throw err;
  }
  return r.json();
}

/** Every USDT perpetual trading now (crypto and TradFi perpetuals). */
async function perpSymbols(get) {
  const info = await get('/fapi/v1/exchangeInfo');
  return (info.symbols || [])
    .filter((x) => /PERPETUAL$/.test(x.contractType || '') && x.quoteAsset === 'USDT' && x.status === 'TRADING')
    .map((x) => x.symbol)
    .sort();
}

/** Run the scan and save it. Returns a short summary. */
export async function runBBScan({ get = getJson, now = Date.now(), save = true } = {}) {
  const started = Date.now();
  const cfg = { ...DEFAULT_CFG };
  const nowSec = Math.floor(now / 1000);
  const symbols = await perpSymbols(get);
  const queue = [...symbols];
  const rows = [];
  const failed = [];
  let checked = 0;
  let outOfTime = false;

  const worker = async () => {
    while (queue.length) {
      if (Date.now() - started > BUDGET_MS) {
        outOfTime = true;
        return;
      }
      const s = queue.shift();
      for (let attempt = 0; ; attempt++) {
        try {
          const cs = toCandles(await get('/fapi/v1/klines', { symbol: s, interval: '4h', limit: CANDLES }));
          rows.push(...bbHits(s, cs, { ...cfg, nowSec }));
          checked++;
          break;
        } catch (e) {
          if (attempt < 1 && (e.status === 429 || e.status >= 500)) {
            await new Promise((r) => setTimeout(r, 1500));
            continue;
          }
          failed.push(s);
          break;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const skipped = queue.splice(0); // not reached before the time limit

  rows.sort((a, b) => b.time - a.time || b.gap - a.gap);
  const meta = { ...cfg, auto: true, runAt: now, checked, total: symbols.length, failed: [...failed, ...skipped], outOfTime, ms: Date.now() - started };
  const saved = { meta, rows };
  if (save) {
    await updateTable(BB_TABLE, (list) => {
      list.length = 0;
      list.push(saved);
    });
  }
  const latest = Math.floor(nowSec / H4) * H4 - H4; // the candle that just closed
  return {
    checked,
    total: symbols.length,
    failed: meta.failed.length,
    outOfTime,
    hits: rows.length,
    latestCandle: new Date(latest * 1000).toISOString(),
    latestHits: rows.filter((r) => r.time === latest).map((r) => ({ symbol: r.symbol, gap: +r.gap.toFixed(2), rsi: +r.rsi.toFixed(1) })),
    ms: meta.ms,
  };
}

export async function readBBScan() {
  const [saved] = await readTable(BB_TABLE).catch(() => []);
  return saved || { meta: null, rows: [] };
}
