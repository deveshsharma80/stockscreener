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
// Trade types (product):
//   OPT_BUY      Options Buying  — options only; buy to open, sell only what you
//                hold (no option writing); full premium, no leverage.
//   EQ_INTRADAY  Equity Intraday — NSE/BSE stocks; buy or short-sell; leverage
//                INTRADAY_LEVERAGE (4×): a position blocks value ÷ 4.
//   OTHER        older trades in anything else (e.g. futures), shown for history.
//
// Funds: a starting amount (table "paper_account").
//   Margin used    = Σ open position value ÷ leverage of its trade type
//   Available      = starting amount + net booked P&L − margin used
//   Buying power   = Available × leverage (4× for Equity Intraday)
//   Account value  = starting amount + net booked P&L + open (unrealized) P&L
import { randomUUID } from 'node:crypto';
import { readTable, updateTable } from './db.js';

export const TRADES_TABLE = 'paper_trades';
export const ACCOUNT_TABLE = 'paper_account';
export const DEFAULT_CAPITAL = 100000;
const MAX_CAPITAL = 1e10;
const MAX_TRADES = 20000;
const envPct = Number(process.env.PAPER_BROKERAGE_PCT);
export const BROKERAGE_PCT = Number.isFinite(envPct) && envPct >= 0 ? envPct : 1; // per side: 1% on buy + 1% on sell
const envLev = Number(process.env.PAPER_INTRADAY_LEVERAGE);
export const INTRADAY_LEVERAGE = Number.isFinite(envLev) && envLev >= 1 && envLev <= 20 ? envLev : 4;

export const PRODUCTS = {
  OPT_BUY: { label: 'Options Buying', leverage: 1 },
  EQ_INTRADAY: { label: 'Equity Intraday', leverage: INTRADAY_LEVERAGE },
  OTHER: { label: 'Other', leverage: 1 },
};
const leverageOf = (product) => PRODUCTS[product]?.leverage || 1;

/** The trade type an instrument can be traded as, or null if unsupported. */
export function productFor(inst) {
  if (String(inst.instrument || '').startsWith('OPT')) return 'OPT_BUY';
  if (inst.segment === 'NSE_EQ' || inst.segment === 'BSE_EQ') return 'EQ_INTRADAY';
  return null;
}
/** Trade type of a stored trade (older trades are inferred from the instrument). */
export const productOf = (t) => (PRODUCTS[t.product] ? t.product : productFor(t) || 'OTHER');

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

export async function addTrade({ inst, side, qty, price, marketOpen, product }) {
  const trade = {
    id: randomUUID().slice(0, 13),
    at: new Date().toISOString(),
    key: `${inst.segment}:${inst.securityId}`,
    ...Object.fromEntries(INFO_FIELDS.map((f) => [f, inst[f] ?? ''])),
    product,
    side,
    qty,
    price: r2(price),
    chargesPct: BROKERAGE_PCT,
    leverage: leverageOf(product),
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

/** Why an order isn't allowed for its trade type, or null if it is. */
export function validateOrder(book, inst, { key, side, qty, product }) {
  const valid = productFor(inst);
  if (!valid) return 'Only Options Buying and Equity Intraday paper trades are supported (not futures or indices).';
  if (!PRODUCTS[product] || product === 'OTHER') return `Choose a trade type: ${PRODUCTS[valid].label}.`;
  if (product !== valid) return `${PRODUCTS[product].label} isn't possible here: this instrument can only be traded as ${PRODUCTS[valid].label}.`;
  if (product === 'OPT_BUY' && side === 'SELL') {
    const held = book.positions.find((p) => p.key === key)?.qty || 0;
    if (held <= 0) return 'Options Buying: you can only sell options you hold (option writing is not allowed).';
    if (qty > held) return `Options Buying: you hold ${held}, so you can sell at most ${held}.`;
  }
  return null;
}

/**
 * Can this order be afforded? Closing an existing position is always allowed;
 * opening (or adding to) one needs its margin (value ÷ leverage) plus
 * brokerage, counting the funds released by any part that closes first.
 */
export function checkFunds(book, { key, side, qty, price, product }) {
  const pos = book.positions.find((p) => p.key === key);
  const held = pos?.qty || 0;
  const q = side === 'BUY' ? qty : -qty;
  let closing = 0;
  if (held && Math.sign(held) !== Math.sign(q)) closing = Math.min(qty, Math.abs(held));
  const opening = qty - closing;
  const charges = chargesFor(qty, price);
  const released = closing ? (closing * pos.avg) / leverageOf(pos.product) + closing * (price - pos.avg) * Math.sign(held) : 0;
  const required = r2((opening * price) / leverageOf(product) + charges);
  const available = r2(book.account.available + released);
  return { ok: opening === 0 || required <= available, required, available, opening, leverage: leverageOf(product) };
}

/** Positions, per-trade P&L, and daily / weekly reports (gross, charges, net). */
export function computeBook(trades, today = istToday(), account = { startingCapital: DEFAULT_CAPITAL, isDefault: true }) {
  const sorted = [...trades].sort((a, b) => a.at.localeCompare(b.at) || String(a.id).localeCompare(String(b.id)));
  const thisWeek = weekStart(today);
  const pos = new Map();
  const ledger = [];
  const groups = {}; // ALL / OPT_BUY / EQ_INTRADAY / OTHER -> { days, weeks }
  const group = (g) => (groups[g] ||= { days: new Map(), weeks: new Map() });
  group('ALL');

  for (const t of sorted) {
    let p = pos.get(t.key);
    if (!p) {
      p = { key: t.key, qty: 0, avg: 0, openChargePerUnit: 0, realized: 0, realizedToday: 0, chargesToday: 0, tradesToday: 0, trades: 0, lastAt: t.at, openedAt: null };
      pos.set(t.key, p);
    }
    for (const f of INFO_FIELDS) p[f] = t[f];
    const product = productOf(t);
    p.product = product;
    if (p.qty === 0) p.openedAt = t.at;
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
        p.openedAt = t.at;
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
    ledger.push({ ...t, product, date, chargesPct: pct, charges, realized, net: r2(realized - charges), closedQty, roundTripNet, positionAfter: p.qty });

    const g1 = group('ALL');
    const g2 = group(product);
    for (const [map, k] of [[g1.days, date], [g1.weeks, weekStart(date)], [g2.days, date], [g2.weeks, weekStart(date)]]) {
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
    .map(({ openChargePerUnit, ...p }) => ({
      ...p,
      avg: r2(p.avg),
      netToday: r2(p.realizedToday - p.chargesToday),
      margin: r2((Math.abs(p.qty) * p.avg) / leverageOf(p.product)),
      // Intraday positions should be closed the same day
      carried: p.product === 'EQ_INTRADAY' && p.qty !== 0 && p.openedAt && istDate(p.openedAt) < today,
    }))
    .sort((a, b) => (b.qty !== 0) - (a.qty !== 0) || b.lastAt.localeCompare(a.lastAt));

  const sum = (rows, f) => r2(rows.reduce((s, r) => s + r[f], 0));
  const report = (g) => {
    const daily = finish(groups[g].days, 'date');
    const weekly = finish(groups[g].weeks, 'weekOf');
    const dayRow = daily.find((d) => d.date === today);
    const weekRow = weekly.find((w) => w.weekOf === thisWeek);
    const closes = ledger.filter((t) => t.closedQty && (g === 'ALL' || t.product === g));
    return {
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
        netAll: sum(daily, 'net'),
        trades: daily.reduce((s, d) => s + d.trades, 0),
        wins: closes.filter((t) => t.roundTripNet > 0).length,
        losses: closes.filter((t) => t.roundTripNet <= 0).length,
        thisWeek,
      },
    };
  };
  const reports = {};
  for (const g of ['ALL', 'OPT_BUY', 'EQ_INTRADAY', 'OTHER']) if (groups[g]) reports[g] = report(g);
  const all = reports.ALL;
  const used = r2(positions.reduce((s, p) => s + p.margin, 0));
  const available = r2(account.startingCapital + all.totals.netAll - used);
  return {
    today,
    account: {
      startingCapital: account.startingCapital,
      isDefault: Boolean(account.isDefault),
      setAt: account.setAt || null,
      netBooked: all.totals.netAll,
      used,
      available,
      buyingPower: { OPT_BUY: available, EQ_INTRADAY: r2(available * INTRADAY_LEVERAGE) },
    },
    brokeragePct: BROKERAGE_PCT,
    products: PRODUCTS,
    positions,
    trades: ledger.reverse(),
    reports,
    // combined report, kept at the top level too
    daily: all.daily,
    weekly: all.weekly,
    totals: all.totals,
  };
}
