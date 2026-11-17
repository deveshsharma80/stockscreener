// Gap-down EMA-rejection setups (Signals → EMA Rejection). Rules: src/emasetup.js.
//
// runEmaSetups() — for every stock the EMA_SCAN Chartink screener sent today: Dhan's
// 1-minute candles for the last 5 days → 5-minute candles → evaluate → saved in the
// "ema_setups" table (one row per stock per day). Called by the feed server's scheduler
// a few seconds after each 5-minute candle closes (09:20–13:35), or by hand.
import { readTable, updateTable } from './db.js';
import { STOCKS_TABLE } from './stocks.js';
import { findEquityBySymbol, getIntradayCandles } from './dhan.js';
import { EMA_SCAN, evaluate, istDate, isEmaScan, to5m } from '../src/emasetup.js';

export const SETUPS_TABLE = 'ema_setups';
const KEEP_DAYS = 45;
const MAX_STOCKS = 60;

/** Today's first hit per stock from the EMA screener. */
async function todaysHits(day) {
  const rows = await readTable(STOCKS_TABLE).catch(() => []);
  const first = new Map();
  for (const r of rows) {
    if (!isEmaScan(r.ScanName)) continue;
    const t = Date.parse(r.HitTime);
    if (!Number.isFinite(t) || istDate(t) !== day) continue;
    const sym = String(r.StockSymbol || '').toUpperCase();
    if (!sym) continue;
    const prev = first.get(sym);
    if (!prev || t < prev.t) first.set(sym, { t, hitTime: r.HitTime, triggerPrice: r.TriggerPrice ?? null });
  }
  return [...first.entries()].map(([symbol, v]) => ({ symbol, ...v })).sort((a, b) => a.t - b.t).slice(0, MAX_STOCKS);
}

export async function runEmaSetups({ now = Date.now() } = {}) {
  const day = istDate(now);
  const hits = await todaysHits(day);
  const before = await readTable(SETUPS_TABLE).catch(() => []);
  const prevByKey = new Map(before.filter((r) => r.day === day).map((r) => [r.symbol, r]));

  const results = [];
  for (const h of hits) {
    const prev = prevByKey.get(h.symbol);
    // a finished setup (alerted / broke out / expired) doesn't change any more
    if (prev && ['rejected', 'broke-out', 'expired'].includes(prev.status)) {
      results.push(prev);
      continue;
    }
    const row = { day, symbol: h.symbol, hitTime: h.hitTime, triggerPrice: h.triggerPrice, checkedAt: new Date(now).toISOString() };
    try {
      const inst = await findEquityBySymbol(h.symbol);
      if (!inst) throw new Error(`${h.symbol} not found in Dhan's instrument list`);
      row.key = `${inst.segment}:${inst.securityId}`;
      const c5 = to5m(await getIntradayCandles(inst, { days: 5 }), now);
      Object.assign(row, evaluate(c5, { day }));
    } catch (e) {
      Object.assign(row, { status: 'error', note: e.message });
    }
    results.push(row);
  }

  const newAlerts = results.filter((r) => r.status === 'rejected' && prevByKey.get(r.symbol)?.status !== 'rejected');
  const oldest = istDate(now - KEEP_DAYS * 86_400_000);
  await updateTable(SETUPS_TABLE, (rows) => {
    const keep = rows.filter((r) => r.day !== day && r.day >= oldest);
    rows.length = 0;
    rows.push(...keep, ...results);
  });
  return { day, scan: EMA_SCAN, checked: results.length, setups: results, newAlerts };
}

/** Saved setups for a day (default today). */
export async function readEmaSetups(day = istDate(Date.now())) {
  const rows = await readTable(SETUPS_TABLE).catch(() => []);
  return { day, scan: EMA_SCAN, setups: rows.filter((r) => r.day === day) };
}
