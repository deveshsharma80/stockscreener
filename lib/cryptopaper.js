// Crypto paper trading — Binance-Futures style (one-way mode, isolated margin).
//
// - Money is kept in USDT internally; you enter and see amounts in rupees at a
//   fixed rate (default ₹85 per USDT, saved with the account so history stays stable).
// - Long or short any USDT pair, leverage 1–125× (Binance's maximum for BTC/ETH) chosen when a position opens.
//   Liquidation ignores Binance's maintenance margin, so at high leverage the real exchange liquidates a little sooner.
// - Fee 0.05 % of the traded value per side (Binance taker).
// - A position is liquidated when its loss uses up its margin:
//     long  at entry × (1 − 1/leverage), short at entry × (1 + 1/leverage)
//   (checked whenever the book is read or ?action=cp-check runs). The server also
//   walks Binance's 1-minute candles of the last hour, so a scheduled check every
//   15–30 minutes still catches a stop loss / take profit / liquidation the price
//   touched in between, and fills it at that level (Neon can sleep between checks).
// - Fill prices come from Binance (futures last price, else spot) fetched by the
//   server; if the server can't reach Binance, the price the page showed is used.
// - Stop loss / take profit per position (set or dragged on the chart): when the
//   price reaches it the whole position closes at market. Checked with the
//   liquidation check. A level belongs to the position it was set on: it is
//   dropped when that position closes or flips.
// - Trigger orders ("at price"): buy or sell a coin with a ₹ amount and leverage
//   automatically when the price reaches a level. Checked with the liquidation
//   check (every minute from the scheduler, instantly while a Crypto page is open).
//   The server also looks at the 1-minute candles since the order was set, so a
//   quick wick through the price between checks still counts. Fills at your
//   price; a breakout order (buy above / sell below the price when it was set)
//   fills at the current price if the market has already jumped past it.
//   Optional stop loss / take profit are attached to the position after the fill.
// - Reset starts a new period: earlier fills stay saved for the reports.
import { randomUUID } from 'node:crypto';
import { readTable, updateTable } from './db.js';
import { HttpError } from './http.js';

export const FILLS = 'crypto_paper_fills';
export const ACCOUNT = 'crypto_paper_account';
export const EXITS = 'crypto_paper_exits'; // stop loss / take profit per open position
export const ORDERS = 'crypto_paper_orders'; // trigger ("at price") orders
const KEEP_DONE_ORDERS = 200;
export const FEE_RATE = 0.0005;
export const MAX_LEVERAGE = 125;
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

const FUT = process.env.BINANCE_FUTURES_HOST || 'https://fapi.binance.com'; // override only for tests
const SPOT = process.env.BINANCE_SPOT_HOST ? [process.env.BINANCE_SPOT_HOST] : ['https://data-api.binance.vision', 'https://api.binance.com'];

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
  const [account, fills, exitRows, orderRows] = await Promise.all([
    readAccount(),
    readTable(FILLS).catch(() => []),
    readTable(EXITS).catch(() => []),
    readTable(ORDERS).catch(() => []),
  ]);
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
    const side = p.qty > 0 ? 'LONG' : 'SHORT';
    // a level counts only for the position it was set on (same side, set after it opened)
    const ex = exitRows.find((e) => e.symbol === symbol && e.side === side && Date.parse(e.setAt) >= Date.parse(p.openedAt));
    return {
      symbol,
      side,
      sl: ex?.sl ?? null,
      tp: ex?.tp ?? null,
      exitSetAt: ex?.setAt ?? null,
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
    orders: orderRows.filter((o) => o.status === 'open' || o.status === 'filling').sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
    orderHistory: orderRows
      .filter((o) => o.status !== 'open' && o.status !== 'filling')
      .sort((a, b) => Date.parse(b.doneAt || b.createdAt) - Date.parse(a.doneAt || a.createdAt))
      .slice(0, 30),
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
      if (f.kind === 'sl' || f.kind === 'tp') t.exitBy = f.kind.toUpperCase();
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
export async function placeTrade({ symbol, side, qty, leverage, priceHint, reduceOnly = false, kind = 'trade', fillPrice = null, extra = null }) {
  symbol = String(symbol || '').trim();
  if (!SYMBOL_RE.test(symbol)) throw new HttpError(400, 'Pick a USDT pair, e.g. BTCUSDT');
  if (side !== 'BUY' && side !== 'SELL') throw new HttpError(400, 'side must be BUY or SELL');
  qty = Number(qty);
  if (!(qty > 0) || !Number.isFinite(qty)) throw new HttpError(400, 'Quantity must be above 0');
  qty = sig(qty);

  let price = null;
  let priceSource = 'binance';
  const got = Number(fillPrice) > 0 ? { price: Number(fillPrice) } : await fetchPrice(symbol);
  if (Number(fillPrice) > 0) {
    price = Number(fillPrice);
    priceSource = kind;
  } else if (got?.price > 0) price = got.price;
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
    ...(extra || {}),
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
 * Set (or clear with null) the stop loss / take profit of an open position.
 * A long's stop loss must be below the price and its take profit above (short: the reverse),
 * and a stop loss must trigger before liquidation.
 */
export async function setExit({ symbol, kind, price, priceHint }) {
  if (kind !== 'SL' && kind !== 'TP') throw new HttpError(400, 'kind must be SL or TP');
  const book = await computeBook();
  const pos = book.positions.find((p) => p.symbol === symbol);
  if (!pos) throw new HttpError(400, 'No open position for this coin.');
  let level = price === null || price === '' || price === undefined ? null : Number(price);
  if (level !== null) {
    if (!(level > 0) || !Number.isFinite(level)) throw new HttpError(400, 'Price must be above 0');
    level = sig(level);
    const now = (await fetchPrice(symbol))?.price || (Number(priceHint) > 0 ? Number(priceHint) : null);
    const long = pos.qty > 0;
    const name = kind === 'SL' ? 'Stop loss' : 'Take profit';
    if (now) {
      const below = level < now;
      if (kind === 'SL' && below !== long) throw new HttpError(400, `${name} for a ${long ? 'long' : 'short'} must be ${long ? 'below' : 'above'} the current price (${now}).`);
      if (kind === 'TP' && below === long) throw new HttpError(400, `${name} for a ${long ? 'long' : 'short'} must be ${long ? 'above' : 'below'} the current price (${now}).`);
    }
    if (kind === 'SL' && (long ? level <= pos.liqPrice : level >= pos.liqPrice)) {
      throw new HttpError(400, `Stop loss is past the liquidation price (${pos.liqPrice}); the position would be liquidated first.`);
    }
  }
  await updateTable(EXITS, (rows) => {
    // drop levels of positions that no longer exist
    const live = new Set(book.positions.map((p) => `${p.symbol}|${p.side}`));
    for (let i = rows.length - 1; i >= 0; i--) if (!live.has(`${rows[i].symbol}|${rows[i].side}`)) rows.splice(i, 1);
    let row = rows.find((r) => r.symbol === symbol && r.side === pos.side && Date.parse(r.setAt) >= Date.parse(pos.openedAt));
    if (!row) {
      const at = rows.findIndex((r) => r.symbol === symbol);
      if (at >= 0) rows.splice(at, 1);
      row = { symbol, side: pos.side, sl: null, tp: null, setAt: new Date().toISOString() };
      rows.push(row);
    }
    row[kind === 'SL' ? 'sl' : 'tp'] = level;
    if (row.sl == null && row.tp == null) rows.splice(rows.indexOf(row), 1);
  });
  return computeBook();
}

/**
 * Liquidate positions whose price has crossed the liquidation price. Uses
 * Binance prices fetched here (never the page's), so it can run from a cron.
 */
/**
 * `seen`: trades the feed server watched happen, { SYMBOL: { price, at } } — proof that the
 * price touched a level even if it has moved away again by the time this check runs
 * (Binance's ticker a second later, and the 1-minute candle of the minute an order was set,
 * can both miss it). Ignored if more than 15 % away from the current price or older than 10 min.
 */
export async function checkLiquidations({ hints = {}, seen = {} } = {}) {
  const book = await computeBook();
  const candles = candleCache();
  const filled = book.orders.length ? await checkOrders(book.orders, hints, candles, seen) : { filled: [], failed: [], prices: {} };
  const after = filled.filled.length ? await computeBook() : book;
  const res = await checkPositions(after, hints, candles, seen);
  return { ...res, prices: { ...filled.prices, ...res.prices }, ordersFilled: filled.filled, ordersFailed: filled.failed };
}

async function checkPositions(book, hints, candles = candleCache(), seen = {}) {
  if (!book.positions.length) return { checked: 0, liquidated: [], exited: [], prices: {} };
  const prices = await fetchPrices(book.positions.map((p) => p.symbol));
  // the page's prices only fill in coins the server couldn't price
  for (const [sym, v] of Object.entries(hints || {})) if (!(prices[sym] > 0) && Number(v) > 0) prices[sym] = Number(v);
  const liquidated = [];
  const exited = [];

  const closeAt = async (p, price, kind) => {
    const fee = Math.abs(p.qty) * price * FEE_RATE;
    await updateTable(FILLS, (rows) => {
      rows.push({
        id: `cf-${randomUUID().slice(0, 8)}`,
        at: new Date().toISOString(),
        symbol: p.symbol,
        side: p.qty > 0 ? 'SELL' : 'BUY',
        qty: Math.abs(p.qty),
        price: sig(price),
        priceSource: kind,
        notional: sig(Math.abs(p.qty) * price),
        leverage: p.leverage,
        fee: r8(fee),
        realized: r8((price - p.avg) * p.qty),
        kind,
        ...(kind === 'sl' || kind === 'tp' ? { level: kind === 'sl' ? p.sl : p.tp } : {}),
      });
    });
    if (kind === 'liquidation') liquidated.push({ symbol: p.symbol, side: p.side, price: p.liqPrice, markPrice: prices[p.symbol] ?? price });
    else exited.push({ symbol: p.symbol, side: p.side, kind: kind.toUpperCase(), level: kind === 'sl' ? p.sl : p.tp, price, realized: (price - p.avg) * p.qty - fee });
  };

  for (const p of book.positions) {
    const long = p.qty > 0;
    // 1) Walk the 1-minute candles since the position opened (SL / TP: since they were set),
    //    oldest first: the first level touched decides, at that level's price.
    //    A stop loss is always reached before liquidation; if one candle touches both SL and TP, SL counts.
    const opened = Date.parse(p.openedAt);
    const exitsFrom = p.exitSetAt ? Math.max(opened, Date.parse(p.exitSetAt)) : opened;
    let decided = null;
    for (const c of await candles.get(p.symbol)) {
      if (c.open < opened) continue; // only whole minutes after it opened (the live price covers the rest)
      const exitsLive = c.open >= exitsFrom;
      const slHit = exitsLive && p.sl != null && (long ? c.low <= p.sl : c.high >= p.sl);
      const tpHit = exitsLive && p.tp != null && (long ? c.high >= p.tp : c.low <= p.tp);
      const liqHit = long ? c.low <= p.liqPrice : c.high >= p.liqPrice;
      if (slHit) decided = { kind: 'sl', price: p.sl };
      else if (liqHit) decided = { kind: 'liquidation', price: p.liqPrice };
      else if (tpHit) decided = { kind: 'tp', price: p.tp };
      if (decided) break;
    }
    // 2) Otherwise the live price (e.g. the newest seconds, or no candles available),
    // 3) or a trade the feed server saw after the position opened / the levels were set
    const judge = (price, exitsOk) => {
      if (!(price > 0)) return null;
      if (long ? price <= p.liqPrice : price >= p.liqPrice) return { kind: 'liquidation', price: p.liqPrice };
      if (exitsOk && p.sl != null && (long ? price <= p.sl : price >= p.sl)) return { kind: 'sl', price };
      if (exitsOk && p.tp != null && (long ? price >= p.tp : price <= p.tp)) return { kind: 'tp', price };
      return null;
    };
    if (!decided) decided = judge(prices[p.symbol], true);
    const sw = seenFor(seen, p.symbol, prices[p.symbol]);
    if (!decided && sw && sw.at >= opened) decided = judge(sw.price, sw.at >= exitsFrom);
    if (decided) await closeAt(p, decided.price, decided.kind);
  }
  return { checked: book.positions.length, liquidated, exited, prices };
}

/**
 * The last hour of 1-minute candles per coin, fetched once per check and shared by
 * the order and position checks. Perpetual, else spot. [] if Binance can't be reached.
 */
function candleCache() {
  const memo = {};
  return {
    get(symbol) {
      memo[symbol] ||= (async () => {
        const q = `symbol=${encodeURIComponent(symbol)}&interval=1m&limit=61`;
        for (const url of [`${FUT}/fapi/v1/klines?${q}`, ...SPOT.map((h) => `${h}/api/v3/klines?${q}`)]) {
          try {
            return (await getJson(url)).map((k) => ({ open: Number(k[0]), close: Number(k[6]), high: Number(k[2]), low: Number(k[3]) }));
          } catch {}
        }
        return [];
      })();
      return memo[symbol];
    },
  };
}

// ---------------------------------------------------------------- trigger orders

/** True if this price has reached the order's level. */
export const orderReached = (o, price) => price > 0 && (o.cond === 'above' ? price >= o.trigger : price <= o.trigger);

/** Set an order: buy / sell `amountInr` (your money) at `leverage` when the price reaches `trigger`. */
export async function placeOrder({ symbol, side, trigger, amountInr, leverage, sl, tp, priceHint }) {
  symbol = String(symbol || '').trim();
  if (!SYMBOL_RE.test(symbol)) throw new HttpError(400, 'Pick a USDT pair, e.g. BTCUSDT');
  if (side !== 'BUY' && side !== 'SELL') throw new HttpError(400, 'side must be BUY or SELL');
  trigger = Number(trigger);
  if (!(trigger > 0) || !Number.isFinite(trigger)) throw new HttpError(400, 'Enter the price for the order.');
  trigger = sig(trigger);
  amountInr = Number(amountInr);
  if (!(amountInr > 0) || !Number.isFinite(amountInr)) throw new HttpError(400, 'Enter how much money (₹) to use.');
  const lev = Math.round(Number(leverage) || 1);
  if (!(lev >= 1 && lev <= MAX_LEVERAGE)) throw new HttpError(400, `Leverage must be 1× to ${MAX_LEVERAGE}×`);

  const now = (await fetchPrice(symbol))?.price || (Number(priceHint) > 0 ? Number(priceHint) : null);
  if (!(now > 0)) throw new HttpError(502, "Couldn't get the current price from Binance. Try again.");
  if (Math.abs(trigger - now) / now < 1e-9) throw new HttpError(400, 'That is the current price — use a market order instead.');
  const cond = trigger > now ? 'above' : 'below';

  const long = side === 'BUY';
  const liq = long ? trigger * (1 - 1 / lev) : trigger * (1 + 1 / lev);
  const level = (v, name) => {
    if (v === null || v === undefined || v === '') return null;
    const x = Number(v);
    if (!(x > 0) || !Number.isFinite(x)) throw new HttpError(400, `${name} must be a price above 0.`);
    return sig(x);
  };
  const slv = level(sl, 'Stop loss');
  const tpv = level(tp, 'Take profit');
  if (slv != null) {
    if (long ? slv >= trigger : slv <= trigger) throw new HttpError(400, `Stop loss for a ${long ? 'buy' : 'sell'} must be ${long ? 'below' : 'above'} the order price.`);
    if (long ? slv <= liq : slv >= liq) throw new HttpError(400, `Stop loss is past the liquidation price (${sig(liq)}) at ${lev}×.`);
  }
  if (tpv != null && (long ? tpv <= trigger : tpv >= trigger)) {
    throw new HttpError(400, `Take profit for a ${long ? 'buy' : 'sell'} must be ${long ? 'above' : 'below'} the order price.`);
  }

  const book = await computeBook();
  const fx = book.fx;
  const marginUsdt = amountInr / fx;
  const need = marginUsdt * (1 + lev * FEE_RATE);
  if (need > book.totals.available + 1e-9) {
    throw new HttpError(400, `Not enough money: ₹${Math.ceil(need * fx).toLocaleString('en-IN')} needed (margin + fee), ₹${Math.floor(Math.max(0, book.totals.available) * fx).toLocaleString('en-IN')} available now.`);
  }

  const order = {
    id: `co-${randomUUID().slice(0, 8)}`,
    symbol,
    side,
    trigger,
    cond,
    amountInr: Math.round(amountInr * 100) / 100,
    leverage: lev,
    sl: slv,
    tp: tpv,
    refPrice: sig(now),
    createdAt: new Date().toISOString(),
    status: 'open',
  };
  await updateTable(ORDERS, (rows) => {
    if (rows.filter((o) => o.status === 'open').length >= 50) throw new HttpError(400, 'At most 50 open orders.');
    rows.push(order);
  });
  return { order, book: await computeBook({ [symbol]: now }) };
}

/** Cancel an open order. */
export async function cancelOrder(id) {
  let found = false;
  await updateTable(ORDERS, (rows) => {
    const o = rows.find((r) => r.id === id);
    if (!o) return;
    if (o.status !== 'open') throw new HttpError(400, o.status === 'filling' ? 'This order is being filled right now.' : `This order is already ${o.status}.`);
    o.status = 'cancelled';
    o.doneAt = new Date().toISOString();
    found = true;
  });
  if (!found) throw new HttpError(404, 'Order not found.');
  return computeBook();
}

async function finishOrder(id, patch) {
  await updateTable(ORDERS, (rows) => {
    const o = rows.find((r) => r.id === id);
    if (o) Object.assign(o, patch, { doneAt: new Date().toISOString() });
    // keep the list small: open ones + the latest finished ones
    const done = rows.filter((r) => r.status !== 'open' && r.status !== 'filling').sort((a, b) => Date.parse(b.doneAt || b.createdAt) - Date.parse(a.doneAt || a.createdAt));
    for (const old of done.slice(KEEP_DONE_ORDERS)) rows.splice(rows.indexOf(old), 1);
  });
}

/** Fill every open order whose price has been reached. */
async function checkOrders(orders, hints = {}, candles = candleCache(), seen = {}) {
  // An order left "filling" by a check that stopped half-way: finish it if its fill was saved, else reopen it.
  const stuck = orders.filter((o) => o.status === 'filling' && Date.now() - Date.parse(o.claimedAt || o.createdAt) > 120_000);
  if (stuck.length) {
    const fills = await readTable(FILLS).catch(() => []);
    for (const o of stuck) {
      const f = fills.find((x) => x.orderId === o.id);
      if (f) await finishOrder(o.id, { status: 'filled', fillPrice: f.price, fillQty: f.qty, fillId: f.id });
      else
        await updateTable(ORDERS, (rows) => {
          const row = rows.find((r) => r.id === o.id);
          if (row && row.status === 'filling') row.status = 'open';
        });
    }
    if (stuck.some((o) => !fills.some((x) => x.orderId === o.id))) orders = orders.map((o) => (stuck.includes(o) && !fills.some((x) => x.orderId === o.id) ? { ...o, status: 'open' } : o));
  }
  const symbols = [...new Set(orders.filter((o) => o.status === 'open').map((o) => o.symbol))];
  const prices = await fetchPrices(symbols);
  for (const [sym, v] of Object.entries(hints || {})) if (!(prices[sym] > 0) && Number(v) > 0) prices[sym] = Number(v);
  const filled = [];
  const failed = [];
  const resetAt = Date.parse((await readAccount()).resetAt || 0) || 0;

  for (const o of orders) {
    if (o.status !== 'open') continue;
    const live = prices[o.symbol];
    // The first whole minute after the order was set whose candle touched the price: the order
    // fills as of that minute (so a check every 15–30 minutes gives the same result as watching live).
    const created = Math.max(Date.parse(o.createdAt), resetAt); // never before the last reset
    const touch = (await candles.get(o.symbol)).find((c) => c.open >= created && (o.cond === 'above' ? c.high >= o.trigger : c.low <= o.trigger));
    const sw = seenFor(seen, o.symbol, live);
    const viaSeen = !touch && Boolean(sw) && sw.at >= created && orderReached(o, sw.price);
    const viaLive = !touch && !viaSeen && orderReached(o, live);
    const hit = Boolean(touch) || viaSeen || viaLive;
    const fillAt = touch ? new Date(touch.open + 30_000).toISOString() : viaSeen ? new Date(sw.at).toISOString() : new Date().toISOString();
    if (!hit) continue;

    // claim it, so two checks running at once can't both fill it
    let claimed = false;
    await updateTable(ORDERS, (rows) => {
      const row = rows.find((r) => r.id === o.id);
      if (row && row.status === 'open') {
        row.status = 'filling';
        row.claimedAt = new Date().toISOString();
        claimed = true;
      }
    });
    if (!claimed) continue;

    // limit-style (buy the dip / sell the rally) fills at your price; breakout-style fills
    // at the current price when the market is already past it
    const breakout = (o.side === 'BUY') === (o.cond === 'above');
    const price = breakout && viaLive ? live : breakout && viaSeen ? sw.price : o.trigger;
    try {
      const book = await computeBook({ [o.symbol]: price });
      const pos = book.positions.find((p) => p.symbol === o.symbol);
      const adding = pos && (pos.qty > 0) === (o.side === 'BUY');
      const lev = adding ? pos.leverage : o.leverage;
      const qty = sig(((o.amountInr / book.fx) * lev) / price);
      const r = await placeTrade({ symbol: o.symbol, side: o.side, qty, leverage: o.leverage, kind: 'order', fillPrice: price, extra: { orderId: o.id, trigger: o.trigger, at: fillAt } });
      const notes = [];
      // SL / TP were checked against the order price when it was set; they apply from the fill time,
      // so the position check right after this replays any later candles against them.
      const now = r.book.positions.find((x) => x.symbol === o.symbol);
      if (now && (o.sl != null || o.tp != null)) {
        await updateTable(EXITS, (rows) => {
          for (let i = rows.length - 1; i >= 0; i--) if (rows[i].symbol === o.symbol) rows.splice(i, 1);
          rows.push({ symbol: o.symbol, side: now.side, sl: o.sl ?? null, tp: o.tp ?? null, setAt: fillAt });
        });
      } else if (o.sl != null || o.tp != null) notes.push('SL / TP not set: the order closed the position.');
      await finishOrder(o.id, { status: 'filled', fillPrice: r.fill.price, fillQty: r.fill.qty, fillId: r.fill.id, note: notes.join(' ') || undefined });
      filled.push({ id: o.id, symbol: o.symbol, side: o.side, trigger: o.trigger, price: r.fill.price, qty: r.fill.qty, leverage: r.fill.leverage, note: notes.join(' ') || undefined });
    } catch (e) {
      await finishOrder(o.id, { status: 'failed', error: e.message });
      failed.push({ id: o.id, symbol: o.symbol, side: o.side, trigger: o.trigger, error: e.message });
    }
  }
  return { filled, failed, prices };
}

/** A trade the feed server saw for this coin, if it is recent and believable. */
function seenFor(seen, symbol, current) {
  const sw = seen?.[symbol];
  const price = Number(sw?.price);
  const at = Number(sw?.at);
  if (!(price > 0) || !(at > 0)) return null;
  if (at > Date.now() + 5_000 || Date.now() - at > 10 * 60_000) return null;
  if (current > 0 && Math.abs(price / current - 1) > 0.15) return null; // fast wicks can be big; this only stops nonsense
  return { price, at };
}

/** Parse "BTCUSDT:64275.2:1794822271000,ETHUSDT:…" from the feed server. */
export function parseSeen(text) {
  const out = {};
  for (const part of String(text || '').split(',').slice(0, 50)) {
    const [symbol, price, at] = part.split(':');
    if (SYMBOL_RE.test(symbol || '') && Number(price) > 0 && Number(at) > 0) out[symbol] = { price: Number(price), at: Number(at) };
  }
  return out;
}
