// Paper trading: dummy Buy/Sell fills stored in the JSON database
// (table "paper_trades", i.e. db/paper_trades.json in Vercel Blob).
//
// Positions use the average-price method, like Indian broker P&L screens:
// adding to a position averages the price; reducing it books realized P&L
// = closed qty × (exit price − average price) for longs (reversed for
// shorts). Short selling (Sell first) is allowed.
//
// Brokerage: BROKERAGE_PCT (default 1%) of each trade's value (qty × price), charged on
// every buy and every sell when the trade is placed. The rate is saved on each
// trade, so changing it later doesn't rewrite history.
//   Gross P&L = realized price P&L     Net P&L = gross − brokerage
//
// Funds: a starting amount (table "paper_account"). Open positions use their
// full value (avg price × qty, no leverage, longs and shorts alike):
//   Available = starting amount + net booked P&L − value used in open positions
//   Account value = starting amount + net booked P&L + open (unrealized) P&L
import { randomUUID } from 'node:crypto';
import { readTable, updateTable } from './db.js';

export const TRADES_TABLE = 'paper_trades';
export const ACCOUNT_TABLE = 'paper_account';
export const DEFAULT_CAPITAL = 100000;
const MAX_CAPITAL = 1e10;
const MAX_TRADES = 20000;
const envPct = Number(process.env.PAPER_BROKERAGE_PCT);
export const BROKERAGE_PCT = Number.isFinite(envPct) && envPct >= 0 ? envPct : 1; // per side: 1% on buy + 1% on sell

const r2 = (v) => Math.round(v * 100) / 100;
const istDate = (iso) => new Date(new Date(iso).getTime() + 330 * 60_000).toISOString().slice(0, 10);
export const istToday = () => istDate(new Date().toISOString());

/** Monday (IST) of the week containing an IST date "YYYY-MM-DD". */
export function weekStart(date) {
  const d = new Date(`${date}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  return new Date(d.getTime() - dow * 86_400_000).toISOString().slice(0, 10);
}

/** Brokerage for one trade. */
export const chargesFor = (qty, price, pct = BROKERAGE_PCT) => r2((qty * price * pct) / 100);

const INFO_FIELDS = ['segment', 'securityId', 'symbol', 'name', 'instrument', 'expiry', 'strike', 'optionType', 'underlying', 'lotSize'];

export async function addTrade({ inst, side, qty, price, marketOpen }) {
  const trade = {
    id: randomUUID().slice(0, 13),
    at: new Date().toISOString(),
    key: `${inst.segment}:${inst.securityId}`,
    ...Object.fromEntries(INFO_FIELDS.map((f) => [f, inst[f] ?? ''])),
    side,
    qty,
    price: r2(price),
    chargesPct: BROKERAGE_PCT,
    marketOpen: Boolean(marketOpen),
  };
  await updateTable(TRADES_TABLE, (rows) => {
    if (rows.length >= MAX_TRADES) throw Object.assign(new Error(`Paper account is full (${MAX_TRADES} trades). Reset it to continue.`), { status: 400 });
    rows.push(trade);
  });
  return { ...trade, charges: chargesFor(trade.qty, trade.price, trade.chargesPct) };
}

export async function resetTrades() {
  await updateTable(TRADES_TABLE, (rows) => {
    rows.length = 0;
  });
}

export const readTrades = () => readTable(TRADES_TABLE);

/** The paper account's starting amount (₹1,00,000 until you set one). */
export async function readAccount() {
  const [a] = await readTable(ACCOUNT_TABLE).catch(() => []);
  return a?.startingCapital > 0 ? { ...a, isDefault: false } : { startingCapital: DEFAULT_CAPITAL, isDefault: true };
}

export async function setCapital(amount) {
  amount = Number(amount);
  if (!Number.isFinite(amount) || amount < 1000 || amount > MAX_CAPITAL) {
    throw Object.assign(new Error('Starting amount must be between ₹1,000 and ₹1,000 crore'), { status: 400 });
  }
  const row = { startingCapital: r2(amount), setAt: new Date().toISOString() };
  await updateTable(ACCOUNT_TABLE, (rows) => {
    rows.length = 0;
    rows.push(row);
  });
  return { ...row, isDefault: false };
}

/**
 * Can this order be afforded? Closing an existing position is always allowed;
 * opening (or adding to) one needs its full value plus brokerage, counting the
 * funds released by any part that closes first.
 */
export function checkFunds(book, { key, side, qty, price }) {
  const pos = book.positions.find((p) => p.key === key);
  const held = pos?.qty || 0;
  const q = side === 'BUY' ? qty : -qty;
  let closing = 0;
  if (held && Math.sign(held) !== Math.sign(q)) closing = Math.min(qty, Math.abs(held));
  const opening = qty - closing;
  const charges = chargesFor(qty, price);
  const released = closing ? closing * pos.avg + closing * (price - pos.avg) * Math.sign(held) : 0;
  const required = r2(opening * price + charges);
  const available = r2(book.account.available + released);
  return { ok: opening === 0 || required <= available, required, available, opening };
}

/** Positions, per-trade P&L, and daily / weekly reports (gross, charges, net). */
export function computeBook(trades, today = istToday(), account = { startingCapital: DEFAULT_CAPITAL, isDefault: true }) {
  const sorted = [...trades].sort((a, b) => a.at.localeCompare(b.at) || String(a.id).localeCompare(String(b.id)));
  const thisWeek = weekStart(today);
  const pos = new Map();
  const ledger = [];
  const days = new Map();
  const weeks = new Map();

  for (const t of sorted) {
    let p = pos.get(t.key);
    if (!p) {
      p = { key: t.key, qty: 0, avg: 0, openChargePerUnit: 0, realized: 0, realizedToday: 0, chargesToday: 0, tradesToday: 0, trades: 0, lastAt: t.at };
      pos.set(t.key, p);
    }
    for (const f of INFO_FIELDS) p[f] = t[f];
    const pct = Number.isFinite(t.chargesPct) ? t.chargesPct : BROKERAGE_PCT;
    const charges = chargesFor(t.qty, t.price, pct);
    const chargePerUnit = charges / t.qty;
    const q = t.side === 'BUY' ? t.qty : -t.qty;
    let realized = 0;
    let closedQty = 0;
    let roundTripNet = null; // P&L of the closed part after brokerage on both legs
    if (p.qty === 0 || Math.sign(p.qty) === Math.sign(q)) {
      const n = Math.abs(p.qty) + Math.abs(q);
      p.avg = (p.avg * Math.abs(p.qty) + t.price * Math.abs(q)) / n;
      p.openChargePerUnit = (p.openChargePerUnit * Math.abs(p.qty) + chargePerUnit * Math.abs(q)) / n;
      p.qty += q;
    } else {
      closedQty = Math.min(Math.abs(q), Math.abs(p.qty));
      realized = r2(closedQty * (t.price - p.avg) * Math.sign(p.qty));
      roundTripNet = r2(realized - closedQty * p.openChargePerUnit - closedQty * chargePerUnit);
      const next = p.qty + q;
      if (next === 0) {
        p.avg = 0;
        p.openChargePerUnit = 0;
      } else if (Math.sign(next) !== Math.sign(p.qty)) {
        p.avg = t.price; // flipped: remainder opens at this price
        p.openChargePerUnit = chargePerUnit;
      }
      p.qty = next;
    }
    p.realized = r2(p.realized + realized);
    p.trades++;
    p.lastAt = t.at;

    const date = istDate(t.at);
    if (date === today) {
      p.realizedToday = r2(p.realizedToday + realized);
      p.chargesToday = r2(p.chargesToday + charges);
      p.tradesToday++;
    }
    ledger.push({ ...t, date, chargesPct: pct, charges, realized, net: r2(realized - charges), closedQty, roundTripNet, positionAfter: p.qty });

    for (const [map, k] of [[days, date], [weeks, weekStart(date)]]) {
      let a = map.get(k);
      if (!a) map.set(k, (a = { key: k, trades: 0, turnover: 0, realized: 0, charges: 0, wins: 0, losses: 0, instruments: new Set() }));
      a.trades++;
      a.turnover = r2(a.turnover + t.qty * t.price);
      a.realized = r2(a.realized + realized);
      a.charges = r2(a.charges + charges);
      if (closedQty && roundTripNet > 0) a.wins++;
      if (closedQty && roundTripNet <= 0) a.losses++;
      a.instruments.add(t.key);
    }
  }

  const finish = (map, name) =>
    [...map.values()]
      .sort((a, b) => b.key.localeCompare(a.key))
      .map(({ key, instruments, ...rest }) => ({ [name]: key, ...rest, net: r2(rest.realized - rest.charges), instruments: instruments.size }));

  const positions = [...pos.values()]
    .filter((p) => p.qty !== 0 || p.tradesToday > 0)
    .map(({ openChargePerUnit, ...p }) => ({ ...p, avg: r2(p.avg), netToday: r2(p.realizedToday - p.chargesToday) }))
    .sort((a, b) => (b.qty !== 0) - (a.qty !== 0) || b.lastAt.localeCompare(a.lastAt));

  const daily = finish(days, 'date');
  const weekly = finish(weeks, 'weekOf');
  const sum = (rows, f) => r2(rows.reduce((s, r) => s + r[f], 0));
  const dayRow = daily.find((d) => d.date === today);
  const weekRow = weekly.find((w) => w.weekOf === thisWeek);
  const closes = ledger.filter((t) => t.closedQty);
  const netAll = sum(daily, 'net');
  const used = r2(positions.reduce((s, p) => s + Math.abs(p.qty) * p.avg, 0));
  return {
    today,
    account: {
      startingCapital: account.startingCapital,
      isDefault: Boolean(account.isDefault),
      setAt: account.setAt || null,
      netBooked: netAll,
      used,
      available: r2(account.startingCapital + netAll - used),
    },
    brokeragePct: BROKERAGE_PCT,
    positions,
    trades: ledger.reverse(),
    daily,
    weekly,
    totals: {
      realizedToday: dayRow?.realized ?? 0,
      chargesToday: dayRow?.charges ?? 0,
      netToday: dayRow?.net ?? 0,
      realizedWeek: weekRow?.realized ?? 0,
      chargesWeek: weekRow?.charges ?? 0,
      netWeek: weekRow?.net ?? 0,
      realizedAll: sum(daily, 'realized'),
      chargesAll: sum(daily, 'charges'),
      netAll,
      trades: ledger.length,
      wins: closes.filter((t) => t.roundTripNet > 0).length,
      losses: closes.filter((t) => t.roundTripNet <= 0).length,
      thisWeek,
    },
  };
}
