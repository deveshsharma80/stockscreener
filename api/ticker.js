// /api/ticker — everything the Ticker page needs. Webhook secret required.
//
// GET  ?action=status                 Dhan connection + market status
// GET  ?action=watchlist              saved instruments
// GET  ?action=search&q=nifty 25000 ce
// GET  ?action=quotes&keys=NSE_EQ:2885,NSE_FNO:49081
// GET  ?action=candles&key=NSE_EQ:2885&days=5       1-minute candles (page builds 3m / 5m)
// POST {action:"connect", accessToken, clientId?}   save + verify Dhan token
// POST {action:"renew"}                              renew Dhan token now
// POST {action:"disconnect"}
// POST {action:"add", key:"NSE_EQ:2885"}             add to watchlist
// POST {action:"remove", key:"NSE_EQ:2885"}
// POST {action:"add-symbol", symbol:"SBIN"}            add a stock by its NSE symbol (from Chartink)
//
// Paper trading (dummy fills at the live LTP, stored in db/paper_trades.json):
// GET  ?action=paper                                  positions, trades, daily/weekly P&L
// POST {action:"trade", key, side:"BUY"|"SELL", qty, product}
//      product: "OPT_BUY" (Options Buying) | "EQ_INTRADAY" (Equity Intraday, 4× leverage)
//      qty in shares (F&O: multiple of lot size)
// POST {action:"paper-capital", amount}               set the starting amount (keeps trades)
// POST {action:"paper-reset", amount?}                delete all paper trades, optionally set a new starting amount
//
// Trigger orders (always Equity Intraday; fill at the live price once it reaches the trigger):
// GET  ?action=resolve&symbol=SBIN                    instrument, live price and funds for the order popup
// GET  ?action=orders                                 pending + recent orders
// POST {action:"place-order", symbol|key, side, qty, triggerPrice, refPrice?, source?}
//      also adds the stock to the Ticker
// POST {action:"cancel-order", id}
// GET  ?action=check-orders                           check prices now (for an outside scheduler, e.g. every minute)
import { readTable, updateTable } from '../lib/db.js';
import { HttpError, checkSecret, cors, parseBody, sendError } from '../lib/http.js';
import { PRODUCTS, addTrade, checkFunds, computeBook, productFor, readAccount, readTrades, resetTrades, setCapital, validateOrder } from '../lib/paper.js';
import { cancelAllPending, cancelOrder, createOrder, ignoreHours, openKeys, processOrders, readOrders, sessionEnd } from '../lib/orders.js';
import {
  DhanError,
  SEGMENTS,
  clearCredentials,
  connectToken,
  getCredentials,
  getFillQuote,
  getIntradayCandles,
  getQuotes,
  findEquityBySymbol,
  lookupInstrument,
  marketStatus,
  profile,
  renewToken,
  searchInstruments,
} from '../lib/dhan.js';

const WATCHLIST = 'ticker_watchlist';
const MAX_WATCH = 200;
const KEY_RE = new RegExp(`^(${SEGMENTS.join('|')}):(\\d{1,12})$`);

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (process.env.VERCEL && !String(process.env.WEBHOOK_SECRET || '').trim()) {
      throw new HttpError(403, 'Set WEBHOOK_SECRET in Vercel to use the Ticker page.');
    }
    checkSecret(req);

    const body = req.method === 'POST' ? parseBody(req) || {} : {};
    const action = req.method === 'POST' ? body.action : req.query?.action;

    switch (`${req.method} ${action}`) {
      case 'GET status':
        return res.json({ ok: true, ...(await status(req.query?.check === '1')), market: marketStatus() });
      case 'GET watchlist':
        return res.json({ ok: true, rows: await readTable(WATCHLIST) });
      case 'GET search': {
        const q = String(req.query?.q || '').slice(0, 80);
        const results = q.trim().length < 2 ? [] : await searchInstruments(q, { limit: 25 });
        return res.json({ ok: true, results });
      }
      case 'GET candles': {
        const key = String(req.query?.key || '');
        if (!KEY_RE.test(key)) throw new HttpError(400, 'Unknown instrument');
        const days = Math.min(Math.max(parseInt(req.query?.days, 10) || 5, 1), 30);
        const inst =
          (await readTable(WATCHLIST)).find((r) => r.key === key) ||
          (await readTrades()).findLast((t) => t.key === key) ||
          (await lookupInstrument(key));
        if (!inst) throw new HttpError(404, `${key} is not a known instrument`);
        return res.json({ ok: true, key, candles: await getIntradayCandles(inst, { days }), market: marketStatus() });
      }
      case 'GET quotes': {
        // Pending trigger orders are priced (and filled) with every quote poll.
        const pendingKeys = openKeys(await readOrders());
        const q = await quotes(req.query?.keys, pendingKeys);
        const orders = await checkOrders({ quotes: q.quotes });
        return res.json({ ok: true, ...q, orders, market: marketStatus(), at: new Date().toISOString() });
      }
      case 'GET check-orders':
      case 'POST check-orders':
        return res.json({ ok: true, orders: await checkOrders({ fresh: true }), market: marketStatus(), at: new Date().toISOString() });
      case 'GET orders':
        return res.json({ ok: true, ...(await ordersView()) });
      case 'GET resolve':
        return res.json({ ok: true, ...(await resolveForOrder(req.query || {})) });
      case 'POST place-order': {
        const { order, rows, watchNote } = await placeTriggerOrder(body);
        return res.json({ ok: true, order, rows, watchNote, ...(await ordersView()) });
      }
      case 'POST cancel-order': {
        const order = await cancelOrder(String(body.id || ''));
        return res.json({ ok: true, order, ...(await ordersView()) });
      }
      case 'POST connect': {
        const { profile: p, creds } = await connectToken(body);
        return res.json({ ok: true, ...describeCreds(creds), profile: pickProfile(p) });
      }
      case 'POST renew':
        return res.json({ ok: true, ...describeCreds(await renewToken()) });
      case 'POST disconnect':
        await clearCredentials();
        return res.json({ ok: true, connected: false });
      case 'POST add-symbol': {
        const symbol = String(body.symbol || '').trim().toUpperCase();
        if (!symbol) throw new HttpError(400, 'Which stock? Send a symbol like SBIN');
        const inst = await findEquityBySymbol(symbol);
        if (!inst) throw new HttpError(404, `${symbol} wasn't found in Dhan's NSE/BSE equity list`);
        return res.json({ ok: true, key: inst.key, symbol: inst.symbol, rows: await addToWatchlist(inst.key) });
      }
      case 'POST add':
        return res.json({ ok: true, rows: await addToWatchlist(String(body.key || '')) });
      case 'POST remove':
        return res.json({ ok: true, rows: await removeFromWatchlist(String(body.key || '')) });
      case 'GET paper':
        return res.json({ ok: true, ...(await paperBook()) });
      case 'POST trade': {
        const trade = await placePaperTrade({ key: body.key, side: body.side, qty: body.qty, product: body.product });
        return res.json({ ok: true, trade, ...(await paperBook()) });
      }
      case 'POST paper-capital':
        await setCapital(body.amount);
        return res.json({ ok: true, ...(await paperBook()) });
      case 'POST paper-reset':
        if (body.amount !== undefined && body.amount !== null && body.amount !== '') await setCapital(body.amount);
        await resetTrades();
        await cancelAllPending();
        return res.json({ ok: true, ...(await paperBook()) });
      default:
        throw new HttpError(400, `Unknown action "${action}"`);
    }
  } catch (err) {
    if (err instanceof DhanError) {
      return res.status(err.status).json({ ok: false, error: err.message, kind: err.kind, code: err.code });
    }
    return sendError(res, err);
  }
}

// ------------------------------------------------------------------ connection

function describeCreds(creds) {
  if (!creds) return { connected: false };
  const id = String(creds.clientId || '');
  return {
    connected: true,
    clientId: id ? `${'•'.repeat(Math.max(0, id.length - 4))}${id.slice(-4)}` : '',
    source: creds.source, // saved | env | mock
    expiresAt: creds.expiresAt ? new Date(creds.expiresAt).toISOString() : null,
    updatedAt: creds.updatedAt || null,
  };
}

function pickProfile(p) {
  if (!p) return null;
  return {
    dataPlan: p.dataPlan ?? null,
    dataValidity: p.dataValidity ?? null,
    tokenValidity: p.tokenValidity ?? null,
    activeSegment: p.activeSegment ?? null,
  };
}

async function status(check) {
  const creds = await getCredentials({ fresh: true });
  const out = describeCreds(creds);
  if (creds && check) {
    try {
      out.profile = pickProfile(await profile());
    } catch (err) {
      out.problem = err.message;
      out.problemKind = err.kind;
    }
  }
  return out;
}

// ------------------------------------------------------------------ watchlist

async function addToWatchlist(key) {
  const m = KEY_RE.exec(key);
  if (!m) throw new HttpError(400, 'Pick an instrument from the search results');
  const inst = await lookupInstrument(key);
  if (!inst) throw new HttpError(404, `${key} is not in today's Dhan instrument list (it may have expired)`);
  const row = {
    key,
    segment: inst.segment,
    securityId: inst.securityId,
    symbol: inst.symbol,
    name: inst.name,
    instrument: inst.instrument,
    expiry: inst.expiry || '',
    strike: inst.strike || 0,
    optionType: inst.optionType || '',
    lotSize: inst.lotSize || 1,
    underlying: inst.underlying || '',
    addedAt: new Date().toISOString(),
  };
  return updateTable(WATCHLIST, (rows) => {
    if (rows.some((r) => r.key === key)) return rows.slice();
    if (rows.length >= MAX_WATCH) throw new HttpError(400, `The ticker holds at most ${MAX_WATCH} instruments`);
    rows.push(row);
    return rows.slice();
  });
}

async function removeFromWatchlist(key) {
  return updateTable(WATCHLIST, (rows) => {
    const keep = rows.filter((r) => r.key !== key);
    rows.length = 0;
    rows.push(...keep);
    return rows.slice();
  });
}

// ------------------------------------------------------------------ quotes

async function quotes(keysParam, extraKeys = []) {
  const keys = [...new Set([...String(keysParam || '').split(','), ...extraKeys].map((k) => k.trim()).filter(Boolean))];
  if (keys.length > 1000) throw new HttpError(400, 'At most 1000 instruments per request');
  const instruments = [];
  for (const k of keys) {
    const m = KEY_RE.exec(k);
    if (m) instruments.push({ segment: m[1], securityId: m[2] }); // skip anything malformed rather than fail the whole feed
  }
  return { quotes: await getQuotes(instruments) };
}

// ------------------------------------------------------------------ paper trading

async function placePaperTrade({ key, side, qty, product, orderId }) {
  key = String(key || '');
  side = String(side || '').toUpperCase();
  qty = Number(qty);
  if (!KEY_RE.test(key)) throw new HttpError(400, 'Unknown instrument');
  if (side !== 'BUY' && side !== 'SELL') throw new HttpError(400, 'Side must be BUY or SELL');
  if (!Number.isInteger(qty) || qty <= 0 || qty > 10_000_000) throw new HttpError(400, 'Quantity must be a whole number above 0');

  // Instrument details: from the watchlist, an earlier trade, or Dhan's list.
  const inst =
    (await readTable(WATCHLIST)).find((r) => r.key === key) ||
    (await readTrades()).findLast((t) => t.key === key) ||
    (await lookupInstrument(key));
  if (!inst) throw new HttpError(404, `${key} is not a known instrument`);
  const lot = Number(inst.lotSize) || 1;
  if (inst.segment.endsWith('FNO') && qty % lot !== 0) {
    throw new HttpError(400, `F&O quantity must be a multiple of the lot size (${lot})`);
  }

  // Trade type: closing an existing position keeps that position's type;
  // anything that opens or adds must follow the type's rules.
  const book = await paperBook();
  const pos = book.positions.find((p) => p.key === key && p.qty !== 0);
  const closesOnly = pos && (side === 'BUY' ? pos.qty < 0 : pos.qty > 0) && qty <= Math.abs(pos.qty);
  product = closesOnly ? pos.product : String(product || productFor(inst) || '').toUpperCase();
  if (!closesOnly) {
    const problem = validateOrder(book, inst, { key, side, qty, product });
    if (problem) throw new HttpError(400, problem, { kind: 'rules' });
  }

  const quote = await getFillQuote(inst);
  const funds = checkFunds(book, { key, side, qty, price: quote.ltp, product });
  if (!funds.ok) {
    const f = (v) => v.toLocaleString('en-IN', { maximumFractionDigits: 2 });
    const what = funds.leverage > 1 ? `margin at ${funds.leverage}× + brokerage` : 'value + brokerage';
    throw new HttpError(400, `Not enough paper funds for ${PRODUCTS[product].label}: this order needs ₹${f(funds.required)} (${what}), available ₹${f(funds.available)}.`, { kind: 'funds' });
  }
  return addTrade({ inst, side, qty, price: quote.ltp, marketOpen: marketStatus().open, product, orderId });
}

async function paperBook() {
  const [trades, account] = await Promise.all([readTrades(), readAccount()]);
  return computeBook(trades, undefined, account);
}

// ------------------------------------------------------------------ trigger orders

const ORDER_PRODUCT = 'EQ_INTRADAY';

/** Check pending orders; never fails the request that asked (quotes keep flowing). */
async function checkOrders({ quotes: known = {}, fresh = false } = {}) {
  try {
    const r = await processOrders({
      quotes: known,
      fresh,
      marketOpen: marketStatus().open,
      fetchQuotes: async (keys) =>
        getQuotes(keys.map((k) => KEY_RE.exec(k)).filter(Boolean).map((m) => ({ segment: m[1], securityId: m[2] }))),
      fill: (o) => placePaperTrade({ key: o.key, side: o.side, qty: o.qty, product: ORDER_PRODUCT, orderId: o.id }),
      findTrade: async (id) => (await readTrades()).find((t) => t.orderId === id) || null,
    });
    const active = r.pending > 0 && (marketStatus().open || ignoreHours());
    return { ...r, checkEveryMs: active ? 10_000 : 60_000 };
  } catch (err) {
    return { events: [], pending: null, error: err.message, checkEveryMs: 30_000 };
  }
}

async function ordersView() {
  const rows = await readOrders({ fresh: true });
  const orders = [...rows].sort((a, b) => (a.status === 'PENDING') === (b.status === 'PENDING') ? b.createdAt.localeCompare(a.createdAt) : a.status === 'PENDING' ? -1 : 1);
  return { orders, market: marketStatus(), ignoreHours: ignoreHours() };
}

async function instForOrder({ key, symbol }) {
  key = String(key || '');
  symbol = String(symbol || '').trim().toUpperCase();
  let inst = null;
  if (key) {
    if (!KEY_RE.test(key)) throw new HttpError(400, 'Unknown instrument');
    inst = (await readTable(WATCHLIST)).find((r) => r.key === key) || (await lookupInstrument(key));
  } else if (symbol) {
    inst = await findEquityBySymbol(symbol);
    if (!inst) throw new HttpError(404, `${symbol} wasn't found in Dhan's NSE/BSE equity list`);
  } else {
    throw new HttpError(400, 'Which stock? Send a symbol like SBIN');
  }
  if (!inst) throw new HttpError(404, `${key} is not a known instrument`);
  if (productFor(inst) !== ORDER_PRODUCT) throw new HttpError(400, 'Trigger orders are Equity Intraday only: pick an NSE/BSE stock.');
  return inst;
}

/** What the order popup needs: the instrument, its live price and the paper funds. */
async function resolveForOrder(params) {
  const inst = await instForOrder(params);
  let quote = null;
  let quoteError = null;
  try {
    quote = await getFillQuote(inst);
  } catch (err) {
    quoteError = err.message;
  }
  const book = await paperBook();
  const pos = book.positions.find((p) => p.key === inst.key && p.qty !== 0) || null;
  return {
    inst: { key: inst.key, symbol: inst.symbol, name: inst.name, segment: inst.segment },
    ltp: quote?.ltp ?? null,
    change: quote?.change ?? null,
    changePct: quote?.changePct ?? null,
    quoteError,
    position: pos && { qty: pos.qty, avg: pos.avg, product: pos.product },
    account: book.account,
    product: { id: ORDER_PRODUCT, ...PRODUCTS[ORDER_PRODUCT] },
    validUntil: sessionEnd(),
    market: marketStatus(),
    ignoreHours: ignoreHours(),
  };
}

async function placeTriggerOrder(body) {
  const side = String(body.side || '').toUpperCase();
  const qty = Number(body.qty);
  const triggerPrice = Math.round(Number(body.triggerPrice) * 100) / 100;
  if (side !== 'BUY' && side !== 'SELL') throw new HttpError(400, 'Side must be BUY or SELL');
  if (!Number.isInteger(qty) || qty <= 0 || qty > 10_000_000) throw new HttpError(400, 'Quantity must be a whole number above 0');
  if (!Number.isFinite(triggerPrice) || triggerPrice <= 0 || triggerPrice > 1e7) throw new HttpError(400, 'Enter the price at which to take the trade');

  const inst = await instForOrder(body);
  const key = `${inst.segment}:${inst.securityId}`;
  const quote = await getFillQuote(inst); // needs Dhan: sets which way the price has to move

  // Funds at the trigger price (checked again when it fills)
  const book = await paperBook();
  const problem = validateOrder(book, inst, { key, side, qty, product: ORDER_PRODUCT });
  if (problem) throw new HttpError(400, problem, { kind: 'rules' });
  const funds = checkFunds(book, { key, side, qty, price: triggerPrice, product: ORDER_PRODUCT });
  if (!funds.ok) {
    const f = (v) => v.toLocaleString('en-IN', { maximumFractionDigits: 2 });
    throw new HttpError(400, `Not enough paper funds: at ₹${f(triggerPrice)} this order needs ₹${f(funds.required)} (margin at ${funds.leverage}× + brokerage), available ₹${f(funds.available)}.`, { kind: 'funds' });
  }

  // Into the Ticker, so it shows up on the Market pages
  let rows = null;
  let watchNote = null;
  try {
    rows = await addToWatchlist(key);
  } catch (err) {
    watchNote = `Couldn't add to the Ticker: ${err.message}`;
  }

  const order = await createOrder({
    inst,
    side,
    qty,
    triggerPrice,
    ltp: quote.ltp,
    refPrice: Number.isFinite(Number(body.refPrice)) && body.refPrice !== null && body.refPrice !== '' ? Number(body.refPrice) : null,
    source: body.source,
  });
  return { order, rows, watchNote };
}
