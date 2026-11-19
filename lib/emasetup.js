// Gap-down EMA-rejection setups (Signals → EMA Rejection). Rules: src/emasetup.js.
//
// runEmaSetups() — for every stock the EMA_SCAN Chartink screener sent today: Dhan's
// 1-minute candles for the last 5 days → 5-minute candles → evaluate → saved in the
// "ema_setups" table (one row per stock per day). Called by the feed server's scheduler
// a few seconds after each 5-minute candle closes (09:20–13:35), or by hand.
import { readTable, updateTable } from './db.js';
import { STOCKS_TABLE } from './stocks.js';
import { findEquityBySymbol, getIntradayCandles } from './dhan.js';
import { EMA_SCAN, evaluate, istDate, isEmaScan, isFirstCandleHit, simulate, to5m } from '../src/emasetup.js';

export const SETUPS_TABLE = 'ema_setups';
const KEEP_DAYS = 45;
const MAX_STOCKS = 60;

/** Today's stocks from the EMA screener — only those it sent for the first 5-minute candle (09:15). */
async function todaysHits(day) {
  const rows = await readTable(STOCKS_TABLE).catch(() => []);
  const first = new Map();
  for (const r of rows) {
    if (!isEmaScan(r.ScanName)) continue;
    const t = Date.parse(r.HitTime);
    if (!Number.isFinite(t) || istDate(t) !== day || !isFirstCandleHit(t)) continue;
    const sym = String(r.StockSymbol || '').toUpperCase();
    if (!sym) continue;
    const prev = first.get(sym);
    if (!prev || t < prev.t) first.set(sym, { t, hitTime: r.HitTime, triggerPrice: r.TriggerPrice ?? null });
  }
  return [...first.entries()].map(([symbol, v]) => ({ symbol, ...v })).sort((a, b) => a.t - b.t).slice(0, MAX_STOCKS);
}

// Vercel stops the function at 60 s and the automation still runs after this check, so the
// check stops starting new stocks after this long; the rest are checked at the next run.
const RUN_BUDGET_MS = 38_000;

export async function runEmaSetups({ now = Date.now(), budgetMs = RUN_BUDGET_MS } = {}) {
  const started = Date.now();
  const day = istDate(now);
  const hits = await todaysHits(day);
  const before = await readTable(SETUPS_TABLE).catch(() => []);
  const prevByKey = new Map(before.filter((r) => r.day === day).map((r) => [r.symbol, r]));
  // never-checked stocks first, then the ones checked longest ago
  const order = [...hits].sort((a, b) => String(prevByKey.get(a.symbol)?.checkedAt || '').localeCompare(String(prevByKey.get(b.symbol)?.checkedAt || '')));

  const results = [];
  let deferred = 0;
  for (const h of order) {
    const prev = prevByKey.get(h.symbol);
    // a finished setup (alerted / broke out / expired) doesn't change any more
    if (prev && ['rejected', 'broke-out', 'expired'].includes(prev.status)) {
      results.push(prev);
      continue;
    }
    if (Date.now() - started > budgetMs) {
      deferred++;
      results.push(prev || { day, symbol: h.symbol, hitTime: h.hitTime, triggerPrice: h.triggerPrice, status: 'waiting', note: 'checked at the next 5-minute close' });
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
  return { day, scan: EMA_SCAN, checked: results.length - deferred, deferred, setups: results, newAlerts };
}

/** Saved setups for a day (default today). */
export async function readEmaSetups(day = istDate(Date.now())) {
  const rows = await readTable(SETUPS_TABLE).catch(() => []);
  return { day, scan: EMA_SCAN, setups: rows.filter((r) => r.day === day) };
}

/**
 * Backtest one stock on past days: one Dhan request for 1-minute candles covering all
 * the days (plus a week before, so the EMAs are warmed up), then for each day the same
 * evaluate() as the live check and simulate() for what happened after an alert.
 */
export async function backtestSymbol(symbol, days) {
  const list = [...new Set(days.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort();
  if (!list.length) throw new Error('No valid days');
  const inst = await findEquityBySymbol(symbol);
  if (!inst) return list.map((day) => ({ day, symbol, status: 'error', note: `${symbol} not found in Dhan's instrument list` }));
  const from = istDate(Date.parse(`${list[0]}T12:00:00+05:30`) - 8 * 86_400_000);
  const to = list[list.length - 1];
  const c1 = await getIntradayCandles(inst, { from, to });
  return list.map((day) => {
    const end = Date.parse(`${day}T15:30:00+05:30`);
    const upto = c1.filter((c) => c.time * 1000 < end);
    const setup = evaluate(to5m(upto, end), { day });
    const dayC = upto.filter((c) => istDate(c.time * 1000) === day);
    return { day, symbol, key: `${inst.segment}:${inst.securityId}`, ...setup, outcome: dayC.length ? simulate(dayC, setup) : null };
  });
}
