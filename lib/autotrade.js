// Automated paper trading — its own money, separate from the manual paper account.
//
// Strategy: Signals → EMA Rejection (gap-down stocks from the "Futures April 2025" screener
// whose bounce is rejected at the 9 / 26 EMA on 5-minute candles). For each alert:
//   1. A short order waits at the alert candle's low (sell-stop). It fills at the first live
//      price at or below it (the feed server's tick, or the quote) — but only from the
//      earliest entry time (default 10:30); an entry that triggers earlier is cancelled.
//   2. If the stop loss is hit before the entry fills, the order is cancelled.
//   3. Once short: stop loss = the setup's stop (buy-stop, fills at the tick that reaches it);
//      exit = hold to 15:15 (default) or a fixed 1:2 target; anything still open at 15:15 is
//      bought back at the live price.
// Limits: at most MAX_PER_DAY (3) shorts filled per day — when the 3rd fills, the day's other
// waiting orders are cancelled and later alerts are skipped. Size per trade =
// equity × LEVERAGE (5, the NSE intraday maximum) ÷ MAX_PER_DAY, so 3 open shorts use the
// whole 5× and never more. Equity = amount + net P&L booked since the last reset.
// Charges: Dhan equity-intraday rates (brokerage ₹20 or 0.03 % per order, STT 0.025 % on the
// sell, exchange, SEBI, stamp, 18 % GST).
//
// Tables: auto_account (one row: amount, settings, resets) and auto_trades (one row per alert).
// runAuto() is called with every order check (feed server: every minute + on ticks) and right
// after each EMA check. It only reads prices for its own instruments.
import { randomUUID } from 'node:crypto';
import { readTable, updateTable } from './db.js';
import { HttpError } from './http.js';
import { SETUPS_TABLE } from './emasetup.js';

export const AUTO_ACCOUNT = 'auto_account';
export const AUTO_TRADES = 'auto_trades';
export const LEVERAGE = 5; // NSE intraday maximum (20 % margin)
export const MAX_PER_DAY = 3;
export const EXIT_TIME = '15:15';
const LAST_ENTRY = '15:00'; // no new shorts after this
// Earliest entry: a short whose entry triggers before this time is cancelled (year-long
// backtest: entries before 10:30 lost money, from 10:30 they made +0.53R a trade).
export const ENTRY_TIMES = ['09:20', '10:00', '10:15', '10:30', '10:45', '11:00'];
const DEFAULT_EARLIEST = '10:30';
const DEFAULT_AMOUNT = 500000;
const MAX_AMOUNT = 1e10;
const KEEP_TRADES = 5000;
const IST = 330 * 60_000;

const r2 = (v) => Math.round(v * 100) / 100;
const istDate = (ms) => new Date(ms + IST).toISOString().slice(0, 10);
const istHHMM = (ms) => new Date(ms + IST).toISOString().slice(11, 16);
const err = (status, message) => new HttpError(status, message);

/** Dhan equity intraday charges for one round trip (₹). */
export function chargesFor(buyValue, sellValue) {
  const brokerage = Math.min(20, buyValue * 0.0003) + Math.min(20, sellValue * 0.0003);
  const stt = sellValue * 0.00025;
  const exchange = (buyValue + sellValue) * 0.0000297;
  const sebi = (buyValue + sellValue) * 0.000001;
  const stamp = buyValue * 0.00003;
  const gst = (brokerage + exchange + sebi) * 0.18;
  return r2(brokerage + stt + exchange + sebi + stamp + gst);
}

// ------------------------------------------------------------------ account

export async function readAutoAccount() {
  const [a] = await readTable(AUTO_ACCOUNT).catch(() => []);
  return {
    amount: a?.amount > 0 ? a.amount : DEFAULT_AMOUNT,
    isDefault: !(a?.amount > 0),
    enabled: a?.enabled !== false,
    exitMode: a?.exitMode === '2R' ? '2R' : 'hold',
    earliestEntry: ENTRY_TIMES.includes(a?.earliestEntry) ? a.earliestEntry : DEFAULT_EARLIEST,
    resetAt: a?.resetAt || null,
    setAt: a?.setAt || null,
    resets: a?.resets || [],
  };
}

function checkAmount(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 10000 || n > MAX_AMOUNT) throw err(400, 'Amount must be between ₹10,000 and ₹1,000 crore');
  return r2(n);
}

async function writeAccount(patch) {
  return updateTable(AUTO_ACCOUNT, (rows) => {
    const prev = rows[0] || {};
    rows.length = 0;
    rows.push({ ...prev, ...patch });
    return rows[0];
  });
}

/** Turn automation on/off, pick the exit (hold to 15:15 | 2R) or the earliest entry time. Off cancels waiting orders. */
export async function setAutoSettings({ enabled, exitMode, earliestEntry }) {
  const patch = {};
  if (typeof enabled === 'boolean') patch.enabled = enabled;
  if (exitMode === 'hold' || exitMode === '2R') patch.exitMode = exitMode;
  if (ENTRY_TIMES.includes(earliestEntry)) patch.earliestEntry = earliestEntry;
  if (!Object.keys(patch).length) throw err(400, 'Nothing to change');
  await writeAccount(patch);
  if (patch.enabled === false) await cancelPending('Automation turned off');
  return readAutoAccount();
}

/** Start a new period with this amount (trades stay as history). Needs no open shorts. */
export async function resetAuto(amount) {
  amount = checkAmount(amount);
  const trades = await readTable(AUTO_TRADES).catch(() => []);
  if (trades.some((t) => t.status === 'OPEN')) throw err(409, 'Close the open shorts first (or wait for 15:15), then reset.');
  await cancelPending('Account reset');
  const now = new Date().toISOString();
  const prev = await readAutoAccount();
  await writeAccount({ amount, setAt: now, resetAt: now, resets: [...prev.resets, { at: now, amount, previous: prev.isDefault ? null : prev.amount }].slice(-100) });
  return readAutoAccount();
}

async function cancelPending(note) {
  const at = new Date().toISOString();
  await updateTable(AUTO_TRADES, (rows) => {
    for (let i = 0; i < rows.length; i++) if (rows[i].status === 'PENDING') rows[i] = { ...rows[i], status: 'CANCELLED', closedAt: at, note };
  });
}

// ------------------------------------------------------------------ book

const inPeriod = (acct) => (t) => !acct.resetAt || t.createdAt >= acct.resetAt;

/** Money and stats for the current period. ltp: { key: price } for open shorts. */
export function autoBook(trades, acct, ltp = {}, today = istDate(Date.now())) {
  const mine = trades.filter(inPeriod(acct));
  const closed = mine.filter((t) => t.status === 'CLOSED');
  const open = mine.filter((t) => t.status === 'OPEN');
  const booked = r2(closed.reduce((s, t) => s + t.net, 0));
  const equity = r2(acct.amount + booked);
  const mtm = (t) => {
    const p = ltp[t.key];
    if (!(p > 0)) return null;
    const gross = (t.fillPrice - p) * t.qty;
    return r2(gross - chargesFor(p * t.qty, t.fillPrice * t.qty));
  };
  const openPnl = r2(open.reduce((s, t) => s + (mtm(t) ?? 0), 0));
  const days = new Map();
  for (const t of closed) {
    const d = days.get(t.day) || { day: t.day, trades: 0, wins: 0, gross: 0, charges: 0, net: 0 };
    d.trades++;
    if (t.net > 0) d.wins++;
    d.gross = r2(d.gross + t.gross);
    d.charges = r2(d.charges + t.charges);
    d.net = r2(d.net + t.net);
    days.set(t.day, d);
  }
  const daily = [...days.values()].sort((a, b) => b.day.localeCompare(a.day));
  let run = acct.amount;
  for (const d of [...daily].reverse()) {
    d.pctOfEquity = r2((d.net / run) * 100);
    run += d.net;
  }
  const wins = closed.filter((t) => t.net > 0).length;
  const perTrade = r2((equity * LEVERAGE) / MAX_PER_DAY);
  const usedMargin = r2(open.reduce((s, t) => s + (t.fillPrice * t.qty) / LEVERAGE, 0));
  return {
    amount: acct.amount,
    equity,
    booked,
    bookedPct: r2((booked / acct.amount) * 100),
    openPnl,
    value: r2(equity + openPnl),
    today: {
      net: r2(closed.filter((t) => t.day === today).reduce((s, t) => s + t.net, 0) + openPnl),
      filled: mine.filter((t) => t.day === today && (t.status === 'OPEN' || t.status === 'CLOSED')).length,
    },
    perTrade,
    usedMargin,
    freeMargin: r2(equity - usedMargin),
    trades: closed.length,
    wins,
    losses: closed.length - wins,
    winRate: closed.length ? Math.round((wins / closed.length) * 100) : null,
    charges: r2(closed.reduce((s, t) => s + t.charges, 0)),
    daily,
    mtm: Object.fromEntries(open.map((t) => [t.id, mtm(t)])),
  };
}

// ------------------------------------------------------------------ engine

/**
 * One pass: new alerts → waiting shorts; waiting shorts → filled / cancelled; open shorts →
 * stop / target / 15:15. Never throws (returns { events, error }).
 *   getQuotes(keys) → { key: { ltp } }   seen: { key: { price, at } } from the feed server
 */
export async function runAuto({ getQuotes, seen = {}, marketOpen = true, ignoreHours = false, instFor, now = Date.now() }) {
  const events = [];
  try {
    const acct = await readAutoAccount();
    const day = istDate(now);
    const hhmm = istHHMM(now);
    let trades = await readTable(AUTO_TRADES).catch(() => []);

    // 1) new alerts from today's EMA check
    if (acct.enabled && (marketOpen || ignoreHours) && hhmm < LAST_ENTRY) {
      const setups = (await readTable(SETUPS_TABLE).catch(() => [])).filter((s) => s.day === day && s.status === 'rejected');
      const have = new Set(trades.filter((t) => t.day === day).map((t) => t.symbol));
      const fresh = setups.filter((s) => !have.has(s.symbol) && s.entry > 0 && s.sl > s.entry);
      if (fresh.length) {
        const book = autoBook(trades, acct, {}, day);
        const rows = [];
        for (const s of fresh) {
          const inst = s.key ? { key: s.key, segment: s.key.split(':')[0], securityId: s.key.split(':')[1] } : await instFor?.(s.symbol);
          const filledToday = trades.filter((t) => t.day === day && ['OPEN', 'CLOSED'].includes(t.status)).length;
          const qty = Math.floor(book.perTrade / s.entry);
          const base = {
            id: `a-${randomUUID().slice(0, 8)}`,
            day,
            createdAt: new Date(now).toISOString(),
            symbol: s.symbol,
            key: inst?.key || null,
            segment: inst?.segment || null,
            securityId: inst?.securityId ? String(inst.securityId) : null,
            alertAt: s.alertAt,
            entry: s.entry,
            sl: s.sl,
            target: r2(s.entry - 2 * (s.sl - s.entry)),
            qty,
            value: r2(qty * s.entry),
            exitMode: acct.exitMode,
          };
          if (!inst?.key) rows.push({ ...base, status: 'SKIPPED', note: 'instrument not found' });
          else if (filledToday >= MAX_PER_DAY) rows.push({ ...base, status: 'SKIPPED', note: `daily limit (${MAX_PER_DAY}) reached` });
          else if (qty < 1) rows.push({ ...base, status: 'SKIPPED', note: 'amount too small for one share' });
          else rows.push({ ...base, status: 'PENDING' });
        }
        await updateTable(AUTO_TRADES, (all) => {
          const taken = new Set(all.filter((t) => t.day === day).map((t) => t.symbol));
          for (const r of rows) if (!taken.has(r.symbol)) all.push(r);
          if (all.length > KEEP_TRADES) all.splice(0, all.length - KEEP_TRADES);
        });
        for (const r of rows) {
          if (r.status === 'PENDING') events.push(ev(r, `Auto: short ${r.qty} ${r.symbol} below ₹${r.entry} (stop ₹${r.sl}) — EMA rejection at ${r.alertAt}.`));
          else events.push({ ...ev(r, `Auto: ${r.symbol} alert skipped — ${r.note}.`), quiet: true });
        }
        trades = await readTable(AUTO_TRADES).catch(() => trades);
      }
    }

    // 2) prices for waiting + open shorts
    const live = trades.filter((t) => t.status === 'PENDING' || t.status === 'OPEN');
    if (!live.length) return { events, active: 0 };
    const keys = [...new Set(live.map((t) => t.key))];
    let quotes = {};
    try {
      quotes = (await getQuotes(keys)) || {};
    } catch {
      // no quotes this round; ticks (seen) can still decide
    }
    const tick = (t) => (seen[t.key] && seen[t.key].at >= Date.parse(t.createdAt) && now - seen[t.key].at < 10 * 60_000 ? seen[t.key].price : null);

    // 3) decide, then apply on the latest rows (status checks make it safe to run twice)
    const decisions = new Map();
    for (const t of live) {
      const q = quotes[t.key]?.ltp > 0 ? quotes[t.key].ltp : null;
      const tk = tick(t);
      const late = t.day < day || hhmm >= EXIT_TIME;
      if (t.status === 'PENDING') {
        if (late || hhmm >= LAST_ENTRY) decisions.set(t.id, { status: 'CANCELLED', note: 'entry not reached by ' + LAST_ENTRY });
        else if (!(marketOpen || ignoreHours)) continue;
        else if ((tk != null && tk >= t.sl) || (q != null && q >= t.sl)) decisions.set(t.id, { status: 'CANCELLED', note: 'stop hit before entry' });
        else if (((tk != null && tk <= t.entry) || (q != null && q <= t.entry)) && hhmm < acct.earliestEntry) {
          decisions.set(t.id, { status: 'CANCELLED', note: `entry came at ${hhmm}, before ${acct.earliestEntry}` });
        } else if (tk != null && tk <= t.entry) decisions.set(t.id, { fill: tk });
        else if (q != null && q <= t.entry) {
          // don't chase: more than 1R below the entry already → missed
          if (q < t.entry - (t.sl - t.entry)) decisions.set(t.id, { status: 'CANCELLED', note: `missed: price already ₹${q}` });
          else decisions.set(t.id, { fill: q });
        }
      } else {
        const px = q ?? tk;
        if ((tk != null && tk >= t.sl) || (q != null && q >= t.sl)) decisions.set(t.id, { exit: tk != null && tk >= t.sl ? tk : q, reason: 'stop' });
        else if (t.exitMode === '2R' && ((tk != null && tk <= t.target) || (q != null && q <= t.target))) decisions.set(t.id, { exit: q != null && q <= t.target ? q : t.target, reason: 'target' });
        else if (late && px != null) decisions.set(t.id, { exit: px, reason: 'time' });
      }
    }
    if (!decisions.size) return { events, active: live.length };

    const at = new Date(now).toISOString();
    const changed = await updateTable(AUTO_TRADES, (all) => {
      const out = [];
      const filledOn = (d) => all.filter((t) => t.day === d && (t.status === 'OPEN' || t.status === 'CLOSED')).length;
      for (let i = 0; i < all.length; i++) {
        const t = all[i];
        const d = decisions.get(t.id);
        if (!d) continue;
        if (t.status === 'PENDING' && d.fill != null) {
          if (filledOn(t.day) >= MAX_PER_DAY) all[i] = { ...t, status: 'CANCELLED', closedAt: at, note: `daily limit (${MAX_PER_DAY}) reached` };
          else all[i] = { ...t, status: 'OPEN', fillPrice: r2(d.fill), filledAt: at, value: r2(d.fill * t.qty) };
          out.push(all[i]);
        } else if (t.status === 'PENDING' && d.status) {
          all[i] = { ...t, status: d.status, closedAt: at, note: d.note };
          out.push(all[i]);
        } else if (t.status === 'OPEN' && d.exit != null) {
          const exit = r2(d.exit);
          const gross = r2((t.fillPrice - exit) * t.qty);
          const charges = chargesFor(exit * t.qty, t.fillPrice * t.qty);
          all[i] = { ...t, status: 'CLOSED', exitPrice: exit, exitAt: at, exitReason: d.reason, gross, charges, net: r2(gross - charges), r: r2((t.fillPrice - exit) / (t.sl - t.entry)) };
          out.push(all[i]);
        }
      }
      // the day's limit reached → its other waiting shorts are cancelled
      for (const d of new Set(out.filter((t) => t.status === 'OPEN').map((t) => t.day))) {
        if (filledOn(d) < MAX_PER_DAY) continue;
        for (let i = 0; i < all.length; i++) {
          if (all[i].day === d && all[i].status === 'PENDING') {
            all[i] = { ...all[i], status: 'CANCELLED', closedAt: at, note: `daily limit (${MAX_PER_DAY}) reached` };
            out.push(all[i]);
          }
        }
      }
      return out;
    });
    for (const t of changed || []) {
      if (t.status === 'OPEN') events.push(ev(t, `Auto: SHORT ${t.qty} ${t.symbol} at ₹${t.fillPrice} (stop ₹${t.sl}${t.exitMode === '2R' ? `, target ₹${t.target}` : ', exit 15:15'}).`));
      else if (t.status === 'CLOSED') events.push(ev(t, `Auto: covered ${t.qty} ${t.symbol} at ₹${t.exitPrice} (${t.exitReason === 'stop' ? 'stop loss' : t.exitReason === 'target' ? '1:2 target' : '15:15 exit'}) · net ${t.net >= 0 ? '+' : '−'}₹${Math.abs(t.net).toLocaleString('en-IN')}.`));
      else events.push({ ...ev(t, `Auto: ${t.symbol} order cancelled — ${t.note}.`), quiet: t.note?.startsWith('daily limit') });
    }
    return { events, active: live.length - (changed || []).filter((t) => t.status !== 'OPEN').length };
  } catch (e) {
    console.error('auto', e.message);
    return { events, error: e.message };
  }
}

const ev = (t, text) => ({ id: `auto-${t.id}-${t.status}`, kind: 'AUTO', status: 'FILLED', symbol: t.symbol, key: t.key, text, at: new Date().toISOString() });

/** Close one open short (or cancel a waiting one) by hand. */
export async function closeAuto(id, getQuotes) {
  const t = (await readTable(AUTO_TRADES)).find((x) => x.id === id);
  if (!t) throw err(404, 'Not found');
  if (t.status === 'PENDING') {
    await updateTable(AUTO_TRADES, (all) => {
      const i = all.findIndex((x) => x.id === id && x.status === 'PENDING');
      if (i >= 0) all[i] = { ...all[i], status: 'CANCELLED', closedAt: new Date().toISOString(), note: 'cancelled by you' };
    });
    return { cancelled: true };
  }
  if (t.status !== 'OPEN') throw err(409, `Already ${t.status.toLowerCase()}`);
  const q = (await getQuotes([t.key]))?.[t.key]?.ltp;
  if (!(q > 0)) throw err(502, 'No live price right now — try again');
  return updateTable(AUTO_TRADES, (all) => {
    const i = all.findIndex((x) => x.id === id && x.status === 'OPEN');
    if (i < 0) throw err(409, 'Already closed');
    const exit = r2(q);
    const gross = r2((t.fillPrice - exit) * t.qty);
    const charges = chargesFor(exit * t.qty, t.fillPrice * t.qty);
    all[i] = { ...all[i], status: 'CLOSED', exitPrice: exit, exitAt: new Date().toISOString(), exitReason: 'manual', gross, charges, net: r2(gross - charges), r: r2((t.fillPrice - exit) / (t.sl - t.entry)) };
    return all[i];
  });
}

/** What the feed server should watch for the automation: instruments and their trigger levels. */
export async function autoLevels() {
  const trades = await readTable(AUTO_TRADES).catch(() => []);
  const live = trades.filter((t) => (t.status === 'PENDING' || t.status === 'OPEN') && t.key);
  const watch = live.map((t) => ({ key: t.key, segment: t.segment, securityId: t.securityId, symbol: t.symbol }));
  const orders = [];
  for (const t of live) {
    const base = { key: t.key, symbol: t.symbol, createdAt: t.createdAt };
    if (t.status === 'PENDING') {
      orders.push({ ...base, id: `${t.id}-in`, kind: null, side: 'SELL', direction: 'down', triggerPrice: t.entry });
      orders.push({ ...base, id: `${t.id}-x`, kind: 'SL', side: 'BUY', direction: 'up', triggerPrice: t.sl });
    } else {
      orders.push({ ...base, id: `${t.id}-sl`, kind: 'SL', side: 'BUY', direction: 'up', triggerPrice: t.sl });
      if (t.exitMode === '2R') orders.push({ ...base, id: `${t.id}-tp`, kind: 'TP', side: 'BUY', direction: 'down', triggerPrice: t.target });
    }
  }
  return { watch, orders };
}

/** Everything the Auto Trading page shows. */
export async function autoView(getQuotes, { today = istDate(Date.now()) } = {}) {
  const [acct, trades] = await Promise.all([readAutoAccount(), readTable(AUTO_TRADES).catch(() => [])]);
  const openKeys = [...new Set(trades.filter((t) => t.status === 'OPEN' || t.status === 'PENDING').map((t) => t.key).filter(Boolean))];
  let ltp = {};
  if (openKeys.length) {
    try {
      const q = await getQuotes(openKeys);
      ltp = Object.fromEntries(Object.entries(q || {}).map(([k, v]) => [k, v?.ltp]));
    } catch {
      /* page still works without prices */
    }
  }
  const book = autoBook(trades, acct, ltp, today);
  return {
    account: acct,
    rules: { leverage: LEVERAGE, maxPerDay: MAX_PER_DAY, exitTime: EXIT_TIME, lastEntry: LAST_ENTRY, entryTimes: ENTRY_TIMES },
    book,
    ltp,
    trades: [...trades].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 500),
    today,
  };
}
