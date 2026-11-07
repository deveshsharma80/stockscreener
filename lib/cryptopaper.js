// Crypto paper trading — Binance-Futures style (one-way mode, isolated margin).
//
// - Money is kept in USDT internally; you enter and see amounts in rupees at a
//   fixed rate (default ₹85 per USDT, saved with the account so history stays stable).
// - Long or short any USDT pair, leverage 1–10× chosen when a position opens.
// - Fee 0.05 % of the traded value per side (Binance taker).
// - A position is liquidated when its loss uses up its margin:
//     long  at entry × (1 − 1/leverage), short at entry × (1 + 1/leverage)
//   (checked whenever the book is read or ?action=cp-check runs).
// - Fill prices come from Binance (futures last price, else spot) fetched by the
//   server; if the server can't reach Binance, the price the page showed is used.
// - Reset starts a new period: earlier fills stay saved for the reports.
import { randomUUID } from 'node:crypto';
import { readTable, updateTable } from './db.js';
import { HttpError } from './http.js';

export const FILLS = 'crypto_paper_fills';
export const ACCOUNT = 'crypto_paper_account';
export const FEE_RATE = 0.0005;
export const MAX_LEVERAGE = 10;
export const DEFAULT_FX = 85; // ₹ per USDT
export const DEFAULT_CAPITAL_INR = 100_000;
const SYMBOL_RE = /^[^\s"'<>\\/?#&%=+,;:]{1,30}USDT$/u;
const EPS = 1e-12;

const r8 = (v) => Math.round(v * 1e8) / 1e8;
const sig = (v) => (v === 0 ? 0 : Number(v.toPrecision(10)));

// ---------------------------------------------------------------- account

export async function readAccount() {
  const [a] = await readTable(ACCOUNT).catch(() => []);
  const fx = a?.fx > 0 ? a.fx : DEFAULT_FX;
  const capitalInr = a?.capitalInr > 0 ? a.capitalInr : DEFAULT_CAPITAL_INR;
  return { capitalInr, fx, capital: capitalInr / fx, resetAt: a?.resetAt || null, resets: a?.resets || [] };
}

/** Start a new period with this much money (rupees). Earlier fills are kept for reports. */
export async function resetAccount({ capitalInr, fx, closeOpen = false, prices = {} }) {
  const amount = Number(capitalInr);
  if (!(amount >= 1000 && amount <= 1e10)) throw new HttpError(400, 'Amount must be between ₹1,000 and ₹1,000 crore');
  const rate = fx === undefined || fx === '' ? undefined : Number(fx);
  if (rate !== undefined && !(rate > 1 && rate < 1000)) throw new HttpError(400, 'Rate must be rupees per USDT, e.g. 85');
  let book = await computeBook();
  if (book.positions.length && closeOpen) {
    for (const p of book.positions) await closePosition(p.symbol, prices?.[p.symbol]); // page price used only if Binance is unreachable
    book = await computeBook();
  }
  if (book.positions.length) throw new HttpError(409, 'Close your open positions before resetting.');
  const now = new Date().toISOString();
  await updateTable(ACCOUNT, (rows) => {
    const prev = rows[0] || {};
    const next = {
      capitalInr: Math.round(amount),
      fx: rate ?? (prev.fx > 0 ? prev.fx : DEFAULT_FX),
      resetAt: now,
      resets: [...(prev.resets || []), { at: now, capitalInr: Math.round(amount), prevCapitalInr: prev.capitalInr ?? null }].slice(-50),
    };
    rows.length = 0;
    rows.push(next);
  });
  return computeBook();
}

// ---------------------------------------------------------------- prices

const FUT = 'https://fapi.binance.com';
const SPOT = ['https://data-api.binance.vision', 'https://api.binance.com'];

async function getJson(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
  return r.json();
}

/** Last price for one symbol: the perpetual if there is one, else spot. */
export async function fetchPrice(symbol) {
  try {
    return { price: Number((await getJson(`${FUT}/fapi/v1/ticker/price?symbol=${encodeURIComponent(symbol)}`)).price), source: 'futures' };
  } catch {
    // no perpetual (400) or Binance Futures unreachable: try spot
  }
  for (const host of SPOT) {
    try {
      return { price: Number((await getJson(`${host}/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`)).price), source: 'spot' };
    } catch {}
  }
  return null;
}

/** Last prices for several symbols (futures list in one call, spot for the rest). */
export async function fetchPrices(symbols) {
  const out = {};
  if (!symbols.length) return out;
  try {
    for (const t of await getJson(`${FUT}/fapi/v1/ticker/price`)) if (symbols.includes(t.symbol)) out[t.symbol] = Number(t.price);
  } catch {}
  const rest = symbols.filter((s) => !(out[s] > 0));
  if (rest.length) {
    for (const host of SPOT) {
      try {
        for (const t of await getJson(`${host}/api/v3/ticker/price?symbols=${encodeURIComponent(JSON.stringify(rest))}`)) out[t.symbol] = Number(t.price);
        break;
      } catch {}
    }
  }
  return out;
}

// ---------------------------------------------------------------- the book

export const liqPrice = (pos) => (pos.qty > 0 ? pos.avg * (1 - 1 / pos.leverage) : pos.avg * (1 + 1 / pos.leverage));

/**
 * Apply one fill to a position (one-way mode). Returns the new position and
 * the P&L realised by the part of the fill that reduced / closed it.
 */
function apply(pos, fill) {
  const signed = fill.side === 'BUY' ? fill.qty : -fill.qty;
  if (!pos || Math.abs(pos.qty) < EPS) {
    return { pos: { qty: signed, avg: fill.price, leverage: fill.leverage, openedAt: fill.at }, realized: 0, closedQty: 0 };
  }
  if (Math.sign(signed) === Math.sign(pos.qty)) {
    const qty = pos.qty + signed;
    return { pos: { ...pos, qty, avg: (pos.avg * Math.abs(pos.qty) + fill.price * fill.qty) / Math.abs(qty) }, realized: 0, closedQty: 0 };
  }
  const closedQty = Math.min(Math.abs(signed), Math.abs(pos.qty));
  const realized = (fill.price - pos.avg) * closedQty * Math.sign(pos.qty);
  const qty = pos.qty + signed;
  if (Math.abs(qty) < EPS) return { pos: null, realized, closedQty };
  if (Math.sign(qty) === Math.sign(pos.qty)) return { pos: { ...pos, qty }, realized, closedQty };
  // flipped: the rest opens a new position at this price
  return { pos: { qty, avg: fill.price, leverage: fill.leverage, openedAt: fill.at }, realized, closedQty };
}

/**
 * The account for the current period: money, open positions, and (for reports)
 * every period's closed trades. Prices (USDT) are optional, for unrealised P&L.
 */
export async function computeBook(prices = {}) {
  const [account, fills] = await Promise.all([readAccount(), readTable(FILLS).catch(() => [])]);
  const since = account.resetAt ? Date.parse(account.resetAt) : 0;
  const fx = account.fx;
  const period = fills.filter((f) => Date.parse(f.at) >= since).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  const positions = {};
  let realized = 0;
  let fees = 0;
  for (const f of period) {
    const { pos } = apply(positions[f.symbol], f);
    if (pos) positions[f.symbol] = pos;
    else delete positions[f.symbol];
    realized += f.realized || 0;
    fees += f.fee || 0;
  }
  const open = Object.entries(positions).map(([symbol, p]) => {
    const margin = (Math.abs(p.qty) * p.avg) / p.leverage;
    const price = prices[symbol] > 0 ? prices[symbol] : null;
    const upnl = price != null ? (price - p.avg) * p.qty : null;
    return {
      symbol,
      side: p.qty > 0 ? 'LONG' : 'SHORT',
      qty: sig(p.qty),
      avg: sig(p.avg),
      leverage: p.leverage,
      openedAt: p.openedAt,
      notional: sig(Math.abs(p.qty) * p.avg),
      margin: sig(margin),
      liqPrice: sig(liqPrice(p)),
      price,
      upnl: upnl == null ? null : sig(upnl),
      roe: upnl == null ? null : sig((upnl / margin) * 100),
    };
  });
  const usedMargin = open.reduce((s, p) => s + p.margin, 0);
  const upnl = open.every((p) => p.upnl != null) ? open.reduce((s, p) => s + p.upnl, 0) : null;
  const balance = account.capital + realized - fees; // wallet balance (USDT)
  return {
    fx,
    account: { capitalInr: account.capitalInr, fx, resetAt: account.resetAt, resets: account.resets },
    feeRate: FEE_RATE,
    maxLeverage: MAX_LEVERAGE,
    totals: {
      capital: sig(account.capital),
      balance: sig(balance),
      realized: sig(realized),
      fees: sig(fees),
      usedMargin: sig(usedMargin),
      available: sig(balance - usedMargin - Math.max(0, -(upnl || 0))), // losses on open positions reduce what you can use
      upnl: upnl == null ? null : sig(upnl),
      equity: upnl == null ? null : sig(balance + upnl),
    },
    positions: open,
    fills: fills.slice().sort((a, b) => Date.parse(b.at) - Date.parse(a.at)),
    trips: roundTrips(fills),
  };
}

/** Closed trades: from opening a position until it is flat again (a flip ends one and starts the next). */
export function roundTrips(fills) {
  const sorted = fills.slice().sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const pos = {};
  const cur = {};
  const trips = [];
  const start = (f, p) => ({
    id: `${f.id}${p && Math.sign(p.qty) !== Math.sign(f.side === 'BUY' ? 1 : -1) ? '~flip' : ''}`,
    symbol: f.symbol,
    side: f.side === 'BUY' ? 'LONG' : 'SHORT',
    leverage: f.leverage,
    openedAt: f.at,
    entryQty: 0,
    entryValue: 0,
    exitQty: 0,
    exitValue: 0,
    realized: 0,
    fees: 0,
    liquidated: false,
  });
  for (const f of sorted) {
    const before = pos[f.symbol];
    const { pos: after, closedQty } = apply(before, f);
    let t = cur[f.symbol];
    if (!t) t = cur[f.symbol] = start(f, null);
    const openedQty = f.qty - closedQty;
    // fee split between the closing and opening parts of a flip
    const closeShare = f.qty > 0 ? closedQty / f.qty : 0;
    if (closedQty > 0) {
      t.exitQty += closedQty;
      t.exitValue += closedQty * f.price;
      t.realized += f.realized || 0;
      t.fees += (f.fee || 0) * closeShare;
      if (f.kind === 'liquidation') t.liquidated = true;
    }
    if (!after) {
      finish(t, f);
      trips.push(t);
      delete cur[f.symbol];
    } else if (before && Math.sign(after.qty) !== Math.sign(before.qty) && Math.abs(before.qty) > EPS) {
      finish(t, f);
      trips.push(t);
      const n = (cur[f.symbol] = start(f, before));
      n.entryQty += openedQty;
      n.entryValue += openedQty * f.price;
      n.fees += (f.fee || 0) * (1 - closeShare);
    } else if (openedQty > 0) {
      t.entryQty += openedQty;
      t.entryValue += openedQty * f.price;
      t.fees += (f.fee || 0) * (1 - closeShare);
    }
    if (after) pos[f.symbol] = after;
    else delete pos[f.symbol];
  }
  for (const t of Object.values(cur)) trips.push({ ...summarize(t), status: 'OPEN' });
  return trips.sort((a, b) => Date.parse(b.closedAt || b.openedAt) - Date.parse(a.closedAt || a.openedAt));

  function finish(t, f) {
    Object.assign(t, summarize(t), { status: 'CLOSED', closedAt: f.at, holdMs: Date.parse(f.at) - Date.parse(t.openedAt) });
  }
  function summarize(t) {
    const entry = t.entryQty ? t.entryValue / t.entryQty : null;
    const exit = t.exitQty ? t.exitValue / t.exitQty : null;
    const margin = entry ? (t.entryQty * entry) / t.leverage : null;
    const net = t.realized - t.fees;
    return {
      ...t,
      qty: sig(t.entryQty),
      entry: entry == null ? null : sig(entry),
      exit: exit == null ? null : sig(exit),
      margin: margin == null ? null : sig(margin),
      realized: sig(t.realized),
      fees: sig(t.fees),
      net: sig(net),
      roe: margin ? sig((net / margin) * 100) : null,
    };
  }
}

// ---------------------------------------------------------------- trading

/**
 * Market order. qty in coins (> 0). leverage only matters when opening a new
 * position (an existing one keeps its leverage). reduceOnly refuses to open.
 */
export async function placeTrade({ symbol, side, qty, leverage, priceHint, reduceOnly = false, kind = 'trade' }) {
  symbol = String(symbol || '').trim();
  if (!SYMBOL_RE.test(symbol)) throw new HttpError(400, 'Pick a USDT pair, e.g. BTCUSDT');
  if (side !== 'BUY' && side !== 'SELL') throw new HttpError(400, 'side must be BUY or SELL');
  qty = Number(qty);
  if (!(qty > 0) || !Number.isFinite(qty)) throw new HttpError(400, 'Quantity must be above 0');
  qty = sig(qty);

  let price = null;
  let priceSource = 'binance';
  const got = await fetchPrice(symbol);
  if (got?.price > 0) price = got.price;
  else if (Number(priceHint) > 0) {
    price = Number(priceHint);
    priceSource = 'browser';
  } else throw new HttpError(502, "Couldn't get a price from Binance right now. Try again.");

  const book = await computeBook({ [symbol]: price });
  const pos = book.positions.find((p) => p.symbol === symbol);
  const signed = side === 'BUY' ? qty : -qty;
  const reduces = pos && Math.sign(pos.qty) !== Math.sign(signed);
  if (reduceOnly && !reduces) throw new HttpError(400, 'Nothing to close for this coin.');
  if (reduceOnly && pos) qty = Math.min(qty, Math.abs(pos.qty));

  const lev = pos && !reduces ? pos.leverage : Math.round(Number(leverage) || 1);
  if (!(lev >= 1 && lev <= MAX_LEVERAGE)) throw new HttpError(400, `Leverage must be 1× to ${MAX_LEVERAGE}×`);

  // Money check for the part that opens or adds
  const openingQty = reduces ? Math.max(0, qty - Math.abs(pos.qty)) : qty;
  const fee = qty * price * FEE_RATE;
  if (openingQty > 0) {
    const need = (openingQty * price) / lev + openingQty * price * FEE_RATE;
    const freed = reduces ? pos.margin : 0;
    const avail = book.totals.available + freed;
    if (need > avail + 1e-9) {
      const fx = book.fx;
      throw new HttpError(400, `Not enough money: needs ₹${Math.ceil(need * fx).toLocaleString('en-IN')} (margin + fee), ₹${Math.floor(Math.max(0, avail) * fx).toLocaleString('en-IN')} available.`, {
        kind: 'funds',
      });
    }
  }

  const realized = reduces ? (price - pos.avg) * Math.min(qty, Math.abs(pos.qty)) * Math.sign(pos.qty) : 0;
  const fill = {
    id: `cf-${randomUUID().slice(0, 8)}`,
    at: new Date().toISOString(),
    symbol,
    side,
    qty,
    price: sig(price),
    priceSource,
    notional: sig(qty * price),
    leverage: lev,
    fee: r8(fee),
    realized: r8(realized),
    kind,
  };
  await updateTable(FILLS, (rows) => {
    rows.push(fill);
  });
  return { fill, book: await computeBook({ [symbol]: price }) };
}

/** Close a whole position at market. */
export const closePosition = async (symbol, priceHint) => {
  const book = await computeBook();
  const pos = book.positions.find((p) => p.symbol === symbol);
  if (!pos) throw new HttpError(400, 'No open position for this coin.');
  return placeTrade({ symbol, side: pos.qty > 0 ? 'SELL' : 'BUY', qty: Math.abs(pos.qty), priceHint, reduceOnly: true });
};

/**
 * Liquidate positions whose price has crossed the liquidation price. Uses
 * Binance prices fetched here (never the page's), so it can run from a cron.
 */
export async function checkLiquidations() {
  const book = await computeBook();
  if (!book.positions.length) return { checked: 0, liquidated: [], prices: {} };
  const prices = await fetchPrices(book.positions.map((p) => p.symbol));
  const liquidated = [];
  for (const p of book.positions) {
    const price = prices[p.symbol];
    if (!(price > 0)) continue;
    const hit = p.qty > 0 ? price <= p.liqPrice : price >= p.liqPrice;
    if (!hit) continue;
    // filled at the liquidation price: the margin is lost, plus the fee
    await updateTable(FILLS, (rows) => {
      rows.push({
        id: `cf-${randomUUID().slice(0, 8)}`,
        at: new Date().toISOString(),
        symbol: p.symbol,
        side: p.qty > 0 ? 'SELL' : 'BUY',
        qty: Math.abs(p.qty),
        price: p.liqPrice,
        priceSource: 'liquidation',
        notional: sig(Math.abs(p.qty) * p.liqPrice),
        leverage: p.leverage,
        fee: r8(Math.abs(p.qty) * p.liqPrice * FEE_RATE),
        realized: r8((p.liqPrice - p.avg) * p.qty),
        kind: 'liquidation',
      });
    });
    liquidated.push({ symbol: p.symbol, side: p.side, price: p.liqPrice, markPrice: price });
  }
  return { checked: book.positions.length, liquidated, prices };
}
