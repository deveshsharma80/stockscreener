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
//      product: "EQ_INTRADAY" (Equity Intraday, 4× leverage) | "IDX_OPT_BUY" (Index Options Buying)
//               | "STK_OPT_BUY" (Equity Options Buying). Each type trades from its own third of the money.
//      qty in shares (F&O: multiple of lot size)
// POST {action:"paper-capital", amount}               set the starting amount (keeps trades)
// POST {action:"paper-reset", amount?}                start a new money period (keeps every trade and note);
//                                                    needs no open positions
//
// Trigger orders (always Equity Intraday; fill at the live price once it reaches the trigger):
// GET  ?action=resolve&symbol=SBIN                    instrument, live price and funds for the order popup
// GET  ?action=orders                                 pending + recent orders
// POST {action:"place-order", symbol|key, side, qty, triggerPrice, refPrice?, source?}
//      also adds the stock to the Ticker
// POST {action:"cancel-order", id}
// GET  ?action=check-orders                           check prices now (for an outside scheduler, e.g. every minute;
//                                                    accepts the limited CRON_SECRET)
// POST {action:"set-exit", key, kind:"SL"|"TP", price|null}   stop loss / take profit for an open position
//
// Trade journal (fills grouped into entry → exit trades, with your notes):
// GET  ?action=journal                                trades + notes
// POST {action:"journal-note", id, note}              save a note ("" deletes it)
// POST {action:"journal-delete", ids:[tradeId…]}      delete closed trades (their fills and notes)
// POST {action:"paper-reset-bucket", product, amount} reset one trade type's money (keeps history)
// GET  ?action=paper-stops / POST {action:"paper-stops", enabled?, EQ_INTRADAY?, IDX_OPT_BUY?, STK_OPT_BUY?}
//      default stop loss (% from entry) added to every new paper position
//
// Scanners and Back Test moved to the Strategy Lab app; it reaches scans, Dhan and the
// Vultr token through /api/link (LAB_LINK_SECRET).
//
// Automated trading (EMA Rejection shorts, own money — lib/autotrade.js):
// GET  ?action=auto                                    account, rules, trades, P&L
// POST {action:"auto-settings", enabled?, exitMode?: "hold"|"2R", earliestEntry?: "10:30"…}
// POST {action:"auto-reset", amount}                   new period with this amount (no open shorts)
// POST {action:"auto-close", id}                       cover an open short now / cancel a waiting one
//
// Equity Intraday auto square-off: from 15:09 IST (PAPER_SQUAREOFF_TIME) every open Equity Intraday
// position is closed at the live price, and new Equity Intraday entries are refused until the close.
// Runs with the price polls and ?action=check-orders (cron-job.org), so it works with every tab closed.
import { readTable, updateTable } from '../lib/db.js';
import { HttpError, checkSecret, cors, parseBody, sendError } from '../lib/http.js';
import { CHARGE_MODEL, PRODUCTS, addTrade, defaultStopFor, readStops, setStops, inSquareOffWindow, squareOffLabel, checkFunds, computeBook, deleteTrades, productFor, readAccount, readTrades, resetAccount, resetBucket, setCapital, validateOrder } from '../lib/paper.js';
import { deleteNotes, fillsToDelete, readNotes, roundTrips, saveNote } from '../lib/journal.js';
import { cancelOrder, cancelOrphanExits, createOrder, ignoreHours, isExit, openKeys, parseSeenTicks, processOrders, readOrders, sessionEnd, setExit } from '../lib/orders.js';
import { isFeedServer, notifyNse, streamToken } from '../lib/feed.js';
import { runEmaSetups } from '../lib/emasetup.js';
import { autoLevels, autoView, closeAuto, resetAuto, runAuto, setAutoSettings } from '../lib/autotrade.js';
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
    const body = req.method === 'POST' ? parseBody(req) || {} : {};
    const action = req.method === 'POST' ? body.action : req.query?.action;
    // The feed server (Vultr) reads what to watch with its own secret; everything else as before.
    if (action === 'nse-feed') {
      if (!isFeedServer(req)) throw new HttpError(401, 'Wrong feed secret');
      return res.json({ ok: true, ...(await nseFeedState()) });
    }
    checkSecret(req, { cron: action === 'check-orders' || action === 'ema-setups-run' }); // the scheduler may use CRON_SECRET

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
        if (orders.events?.length) await notifyNse('orders filled');
        return res.json({ ok: true, ...q, orders, market: marketStatus(), at: new Date().toISOString() });
      }
      case 'GET check-orders':
      case 'POST check-orders':
      {
        // seen = ticks the feed server watched reach an order's price (key|price|time,…)
        const orders = await checkOrders({ fresh: true, seen: parseSeenTicks(req.query?.seen || body.seen) });
        if (orders.events?.length) await notifyNse('orders filled');
        return res.json({ ok: true, orders, market: marketStatus(), at: new Date().toISOString() });
      }
      case 'GET orders':
        return res.json({ ok: true, ...(await ordersView()) });
      case 'GET ema-setups-run':
      case 'POST ema-setups-run': {
        // gap-down EMA-rejection check (scheduler: a few seconds after each 5-minute close),
        // then the automation places its shorts for any new alert right away
        const r = await runEmaSetups();
        const auto = await runAutoNow();
        if (auto.events?.length) await notifyNse('auto trades');
        return res.json({ ok: true, ...r, auto });
      }
      case 'GET auto':
        return res.json({ ok: true, ...(await autoView(quoteKeys)), market: marketStatus() });
      case 'POST auto-settings':
        return res.json({ ok: true, account: await setAutoSettings({ enabled: body.enabled, exitMode: body.exitMode, earliestEntry: body.earliestEntry }), ...(await autoAfterChange()) });
      case 'POST auto-reset':
        return res.json({ ok: true, account: await resetAuto(body.amount), ...(await autoAfterChange()) });
      case 'POST auto-close': {
        const r = await closeAuto(String(body.id || ''), quoteKeys);
        await notifyNse('auto trade closed');
        return res.json({ ok: true, result: r });
      }
      case 'GET feed-token':
        // live prices straight from the feed server (Vultr); null → pages keep polling
        return res.json({ ok: true, stream: streamToken() });
      case 'GET journal': {
        const [trades, notes] = await Promise.all([readTrades(), readNotes()]);
        return res.json({ ok: true, trips: roundTrips(trades), notes, market: marketStatus() });
      }
      case 'POST journal-note': {
        const id = String(body.id || '');
        const removing = !String(body.note ?? '').trim(); // notes of deleted trades can still be removed
        if (!removing && !roundTrips(await readTrades()).some((t) => t.id === id)) throw new HttpError(404, 'That trade no longer exists');
        const note = await saveNote(id, body.note);
        return res.json({ ok: true, id, note });
      }
      case 'POST journal-delete': {
        const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map(String))].slice(0, 2000);
        if (!ids.length) throw new HttpError(400, 'Select at least one trade');
        const fillIds = fillsToDelete(await readTrades(), ids);
        const removed = await deleteTrades(fillIds);
        await deleteNotes(ids);
        const [trades, notes] = await Promise.all([readTrades(), readNotes()]);
        return res.json({ ok: true, deleted: ids.length, fillsRemoved: removed, trips: roundTrips(trades), notes });
      }
      case 'POST paper-reset-bucket': {
        const product = String(body.product || '');
        const book = await paperBook();
        const open = book.positions.filter((p) => p.qty !== 0 && p.product === product);
        if (open.length) {
          throw new HttpError(400, `Exit your open ${PRODUCTS[product]?.label || product} positions first (${open.map((p) => p.symbol).slice(0, 5).join(', ')}).`, { kind: 'open-positions' });
        }
        await resetBucket(product, body.amount);
        return res.json({ ok: true, ...(await paperBook()) });
      }
      case 'GET resolve':
        return res.json({ ok: true, ...(await resolveForOrder(req.query || {})) });
      case 'POST place-order': {
        const { order, rows, watchNote } = await placeTriggerOrder(body);
        await notifyNse('order placed');
        return res.json({ ok: true, order, rows, watchNote, ...(await ordersView()) });
      }
      case 'POST set-exit': {
        const order = await placeExit(body);
        await notifyNse('exit set');
        return res.json({ ok: true, order, ...(await ordersView()) });
      }
      case 'POST cancel-order': {
        const order = await cancelOrder(String(body.id || ''));
        await notifyNse('order cancelled');
        return res.json({ ok: true, order, ...(await ordersView()) });
      }
      case 'POST connect': {
        const { profile: p, creds } = await connectToken(body);
        await notifyNse('dhan token');
        return res.json({ ok: true, ...describeCreds(creds), profile: pickProfile(p) });
      }
      case 'POST renew': {
        const creds = await renewToken();
        await notifyNse('dhan token');
        return res.json({ ok: true, ...describeCreds(creds) });
      }
      case 'POST disconnect':
        await clearCredentials();
        return res.json({ ok: true, connected: false });
      case 'POST add-symbol': {
        const symbol = String(body.symbol || '').trim().toUpperCase();
        if (!symbol) throw new HttpError(400, 'Which stock? Send a symbol like SBIN');
        const inst = await findEquityBySymbol(symbol);
        if (!inst) throw new HttpError(404, `${symbol} wasn't found in Dhan's NSE/BSE equity list`);
        const rows = await addToWatchlist(inst.key);
        await notifyNse('watchlist');
        return res.json({ ok: true, key: inst.key, symbol: inst.symbol, rows });
      }
      case 'POST add': {
        const rows = await addToWatchlist(String(body.key || ''));
        await notifyNse('watchlist');
        return res.json({ ok: true, rows });
      }
      case 'POST remove': {
        const rows = await removeFromWatchlist(String(body.key || ''));
        await notifyNse('watchlist');
        return res.json({ ok: true, rows });
      }
      case 'GET paper':
        return res.json({ ok: true, ...(await paperBook()) });
      case 'POST trade': {
        const trade = await placePaperTrade({ key: body.key, side: body.side, qty: body.qty, product: body.product });
        const book = await paperBook();
        const gone = await tidyExits(book); // closed by hand → its SL / TP go away
        if (gone?.length) await notifyNse('exits removed');
        return res.json({ ok: true, trade, ...book });
      }
      case 'GET paper-stops':
        return res.json({ ok: true, stops: await readStops() });
      case 'POST paper-stops':
        return res.json({ ok: true, stops: await setStops(body) });
      case 'POST paper-capital':
        await setCapital(body.amount);
        return res.json({ ok: true, ...(await paperBook()) });
      case 'POST paper-reset': {
        // Nothing is deleted: a reset starts a new money period. Close positions first
        // so none is left straddling the old and new period.
        const book = await paperBook();
        const open = book.positions.filter((p) => p.qty !== 0);
        if (open.length) {
          throw new HttpError(400, `Exit your open positions first (${open.map((p) => p.symbol).slice(0, 5).join(', ')}${open.length > 5 ? '…' : ''}). Reset keeps all trade history; it only starts your money again.`, { kind: 'open-positions' });
        }
        const hasAmount = body.amount !== undefined && body.amount !== null && body.amount !== '';
        await resetAccount(hasAmount ? body.amount : undefined, book.account);
        return res.json({ ok: true, ...(await paperBook()) });
      }
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

async function placePaperTrade({ key, side, qty, product, orderId, atPrice = null }) {
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
  if (product === 'OPT_BUY') product = productFor(inst); // older pages had a single options type
  if (!closesOnly && product === 'EQ_INTRADAY' && inSquareOffWindow()) {
    // cancelled: a trigger order reaching its price now is cancelled, not left failing
    throw Object.assign(new HttpError(400, `Equity Intraday is closed for the day: positions are squared off at ${squareOffLabel()}. Only exits are allowed now.`, { kind: 'rules' }), { cancelled: true });
  }
  if (!closesOnly) {
    const problem = validateOrder(book, inst, { key, side, qty, product });
    if (problem) throw new HttpError(400, problem, { kind: 'rules' });
  }

  // A tick the feed server saw reach an order's price is the market price at that moment.
  const quote = Number(atPrice) > 0 ? { ltp: Math.round(Number(atPrice) * 100) / 100 } : await getFillQuote(inst);
  const funds = checkFunds(book, { key, side, qty, price: quote.ltp, product });
  if (!funds.ok) {
    const f = (v) => v.toLocaleString('en-IN', { maximumFractionDigits: 2 });
    const what = funds.leverage > 1 ? `margin at ${funds.leverage}× + brokerage` : 'value + brokerage';
    throw new HttpError(400, `Not enough paper funds in your ${PRODUCTS[product].label} money: this order needs ₹${f(funds.required)} (${what}), available ₹${f(funds.available)}.`, { kind: 'funds' });
  }
  const trade = await addTrade({ inst, side, qty, price: quote.ltp, marketOpen: marketStatus().open, product, orderId });
  // A new position gets the default stop loss for its trade type (never fails the trade)
  if (!closesOnly) {
    const sl = await applyDefaultStop(key).catch((e) => console.warn('default stop:', e.message));
    if (sl) trade.defaultStop = sl;
  }
  return trade;
}

/** Add the default stop loss to the position on `key` if it has none yet. Returns the level. */
async function applyDefaultStop(key) {
  const stops = await readStops();
  if (!stops.enabled) return null;
  const pos = (await paperBook()).positions.find((p) => p.key === key && p.qty !== 0);
  if (!pos) return null;
  const has = (await readOrders({ fresh: true })).some((o) => o.key === key && o.kind === 'SL' && o.status === 'PENDING');
  if (has) return null; // adding to a position keeps its stop where it is
  const level = defaultStopFor(stops, pos);
  if (level == null) return null;
  await setExit({ inst: pos, kind: 'SL', price: level, pos });
  await notifyNse('default stop');
  return level;
}

async function paperBook() {
  const [trades, account] = await Promise.all([readTrades(), readAccount()]);
  return computeBook(trades, undefined, account);
}

// ------------------------------------------------------------------ trigger orders

const ORDER_PRODUCT = 'EQ_INTRADAY';

/** Check pending orders; never fails the request that asked (quotes keep flowing). */
async function checkOrders({ quotes: known = {}, fresh = false, seen = {} } = {}) {
  const squared = await squareOffIntraday({ force: fresh });
  const r = await checkPending({ quotes: known, fresh, seen });
  if (squared.length) r.events = [...squared, ...(r.events || [])];
  // Automated trading (its own money): only on the scheduler's / feed server's checks
  if (fresh) {
    const auto = await runAutoNow({ known, seen });
    if (auto.events?.length) r.events = [...(r.events || []), ...auto.events];
    r.auto = { active: auto.active ?? null, error: auto.error };
  }
  return r;
}

/** Quotes for "SEG:ID" keys (Dhan's 1-per-second queue). */
const quoteKeys = (keys) => getQuotes(keys.map((k) => KEY_RE.exec(k)).filter(Boolean).map((m) => ({ segment: m[1], securityId: m[2] })));

async function runAutoNow({ known = {}, seen = {} } = {}) {
  return runAuto({
    getQuotes: async (keys) => {
      const missing = keys.filter((k) => !(known[k]?.ltp > 0));
      return { ...known, ...(missing.length ? await quoteKeys(missing) : {}) };
    },
    seen,
    marketOpen: marketStatus().open,
    ignoreHours: ignoreHours(),
    instFor: async (symbol) => {
      const i = await findEquityBySymbol(symbol);
      return i ? { ...i, key: `${i.segment}:${i.securityId}` } : null;
    },
  });
}

/** After a settings change / reset: the page's new view, and the feed server re-reads its levels. */
async function autoAfterChange() {
  await notifyNse('auto settings');
  return autoView(quoteKeys);
}

// Square-off state for this server instance: checked at most every 20 s, and not again
// today once nothing is left open (keeps storage reads low during the window).
const sq = { date: '', done: false, lastAt: 0 };

/** From 15:09 IST close every open Equity Intraday position at the live price. Never throws. */
async function squareOffIntraday({ force = false, now = Date.now() } = {}) {
  if (!inSquareOffWindow(now)) return [];
  const date = new Date(now + 330 * 60_000).toISOString().slice(0, 10);
  if (sq.date !== date) Object.assign(sq, { date, done: false, lastAt: 0 });
  if (sq.done || (!force && now - sq.lastAt < 20_000)) return [];
  sq.lastAt = now;
  const events = [];
  try {
    const open = (await paperBook()).positions.filter((p) => p.qty !== 0 && p.product === 'EQ_INTRADAY');
    let left = 0;
    for (const p of open) {
      try {
        const t = await placePaperTrade({ key: p.key, side: p.qty > 0 ? 'SELL' : 'BUY', qty: Math.abs(p.qty), product: p.product });
        events.push({ id: `sqoff-${t.id || p.key}`, kind: 'SQOFF', status: 'FILLED', key: p.key, symbol: p.symbol, side: t.side, filledQty: t.qty, fillPrice: t.price, at: new Date().toISOString() });
      } catch (err) {
        left++;
        console.error('square-off', p.key, err.message); // tried again on the next check
      }
    }
    if (events.length) await tidyExits(await paperBook()); // their SL / TP go away
    sq.done = left === 0;
  } catch (err) {
    console.error('square-off', err.message);
  }
  return events;
}

async function checkPending({ quotes: known = {}, fresh = false, seen = {} } = {}) {
  try {
    const r = await processOrders({
      quotes: known,
      seen,
      fresh,
      marketOpen: marketStatus().open,
      fetchQuotes: async (keys) =>
        getQuotes(keys.map((k) => KEY_RE.exec(k)).filter(Boolean).map((m) => ({ segment: m[1], securityId: m[2] }))),
      fill: async (o) => {
        const atPrice = o.viaTick || null; // set when a feed-server tick decided it
        if (!isExit(o)) {
          const t = await placePaperTrade({ key: o.key, side: o.side, qty: o.qty, product: o.product || ORDER_PRODUCT, orderId: o.id, atPrice });
          if (o.sl != null || o.tp != null) await attachExits(o); // never fails the fill
          return t;
        }
        // Stop loss / take profit: close whatever is open right now
        const pos = (await paperBook()).positions.find((p) => p.key === o.key && p.qty !== 0);
        if (!pos || (o.side === 'SELL') !== pos.qty > 0) throw Object.assign(new Error('Position was already closed'), { cancelled: true });
        return placePaperTrade({ key: o.key, side: o.side, qty: Math.abs(pos.qty), product: pos.product, orderId: o.id, atPrice });
      },
      findTrade: async (id) => (await readTrades()).find((t) => t.orderId === id) || null,
    });
    // One-cancels-other: an exit filled (or the position closed) → drop the other exit
    if (r.events.some((e) => e.status === 'FILLED')) {
      const gone = await tidyExits(await paperBook());
      r.events.push(...gone.map((o) => ({ ...o, quiet: true }))); // refresh lists, no pop-up
    }
    const active = r.pending > 0 && (marketStatus().open || ignoreHours());
    return { ...r, checkEveryMs: active ? 10_000 : 60_000 };
  } catch (err) {
    return { events: [], pending: null, error: err.message, checkEveryMs: 30_000 };
  }
}

/**
 * What the feed server watches: watchlist instruments, waiting orders (incl. SL / TP),
 * the Dhan login for the live feed, and whether the market is open.
 */
async function nseFeedState() {
  const [rows, orders, creds, auto] = await Promise.all([readTable(WATCHLIST), readOrders({ fresh: true }), getCredentials({ fresh: true }), autoLevels().catch(() => ({ watch: [], orders: [] }))]);
  const watch = rows.map((r) => ({ key: r.key, segment: r.segment, securityId: String(r.securityId), symbol: r.symbol }));
  // automated shorts are watched tick by tick too, even when not in the watchlist
  for (const w of auto.watch) if (!watch.some((x) => x.key === w.key)) watch.push(w);
  return {
    market: marketStatus(),
    watch,
    orders: [
      ...orders
        .filter((o) => o.status === 'PENDING')
        .map((o) => ({ id: o.id, key: o.key, symbol: o.symbol, kind: o.kind || null, side: o.side, direction: o.direction, triggerPrice: o.triggerPrice, createdAt: o.createdAt })),
      ...auto.orders,
    ],
    dhan: creds?.accessToken ? { clientId: creds.clientId, accessToken: creds.accessToken, expiresAt: creds.expiresAt || null } : null,
  };
}

/** After an at-price order fills: put its stop loss / take profit on the position. */
async function attachExits(o) {
  try {
    const pos = (await paperBook()).positions.find((p) => p.key === o.key && p.qty !== 0);
    if (!pos) return;
    const inst = { segment: o.segment, securityId: o.securityId, symbol: o.symbol, name: o.name };
    for (const [kind, price] of [['SL', o.sl], ['TP', o.tp]]) if (price != null) await setExit({ inst, kind, price, pos });
  } catch (err) {
    console.warn('SL/TP after order fill:', err.message);
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
  if (!productFor(inst)) throw new HttpError(400, 'At-price orders work for NSE/BSE stocks and options only.');
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
    pot: book.account.buckets?.[ORDER_PRODUCT] || null, // trigger orders use the Equity Intraday money
    product: { id: ORDER_PRODUCT, ...PRODUCTS[ORDER_PRODUCT] },
    chargeModel: CHARGE_MODEL,
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
  // Trade type: the one the Trade box chose (stocks: Equity Intraday; options: Options Buying)
  const product = body.product == null || body.product === '' ? productFor(inst) || ORDER_PRODUCT : String(body.product);
  if (!PRODUCTS[product] || product === 'OTHER') throw new HttpError(400, 'At-price orders work for Equity Intraday and Options Buying.');
  const quote = await getFillQuote(inst); // needs Dhan: sets which way the price has to move

  // Optional stop loss / take profit, set on the position when the order fills
  const level = (v, name) => {
    if (v === null || v === undefined || v === '') return null;
    const x = Math.round(Number(v) * 100) / 100;
    if (!(x > 0) || !Number.isFinite(x)) throw new HttpError(400, `${name} must be a price above 0.`);
    return x;
  };
  const sl = level(body.sl, 'Stop loss');
  const tp = level(body.tp, 'Take profit');
  const long = side === 'BUY';
  if ((sl != null || tp != null) && (product === 'IDX_OPT_BUY' || product === 'STK_OPT_BUY') && !long) {
    throw new HttpError(400, 'Stop loss / take profit go on a buy (selling options you hold closes them).');
  }
  if (sl != null && (long ? sl >= triggerPrice : sl <= triggerPrice)) throw new HttpError(400, `Stop loss for a ${long ? 'buy' : 'sell'} must be ${long ? 'below' : 'above'} the order price.`);
  if (tp != null && (long ? tp <= triggerPrice : tp >= triggerPrice)) throw new HttpError(400, `Take profit for a ${long ? 'buy' : 'sell'} must be ${long ? 'above' : 'below'} the order price.`);

  // Funds at the trigger price (checked again when it fills)
  const book = await paperBook();
  const problem = validateOrder(book, inst, { key, side, qty, product });
  if (problem) throw new HttpError(400, problem, { kind: 'rules' });
  const funds = checkFunds(book, { key, side, qty, price: triggerPrice, product });
  if (!funds.ok) {
    const f = (v) => v.toLocaleString('en-IN', { maximumFractionDigits: 2 });
    throw new HttpError(400, `Not enough paper funds in your ${PRODUCTS[product].label} money: at ₹${f(triggerPrice)} this order needs ₹${f(funds.required)} (margin at ${funds.leverage}× + brokerage), available ₹${f(funds.available)}.`, { kind: 'funds' });
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
    product,
    sl,
    tp,
  });
  return { order, rows, watchNote };
}

// ------------------------------------------------------------------ stop loss / take profit

async function tidyExits(book) {
  try {
    return await cancelOrphanExits(new Map(book.positions.filter((p) => p.qty !== 0).map((p) => [p.key, p.qty])));
  } catch {
    return [];
  }
}

async function placeExit(body) {
  const key = String(body.key || '');
  const kind = String(body.kind || '').toUpperCase();
  if (!KEY_RE.test(key)) throw new HttpError(400, 'Unknown instrument');
  if (kind !== 'SL' && kind !== 'TP') throw new HttpError(400, 'kind must be SL or TP');
  const remove = body.price === null || body.price === undefined || body.price === '';
  const level = remove ? null : Math.round(Number(body.price) * 100) / 100;
  if (!remove && !(level > 0 && level < 1e7)) throw new HttpError(400, 'Enter a valid price');

  const pos = (await paperBook()).positions.find((p) => p.key === key && p.qty !== 0);
  if (!pos) throw new HttpError(400, 'There is no open position to protect. Buy or sell first.');
  const name = kind === 'SL' ? 'Stop loss' : 'Take profit';
  if (!remove) {
    const ltp = (await getFillQuote(pos)).ltp;
    const long = pos.qty > 0;
    const below = level < ltp;
    const wantBelow = (kind === 'SL') === long; // long SL / short TP sit below the price
    if (below !== wantBelow) {
      const f = (v) => v.toLocaleString('en-IN', { maximumFractionDigits: 2 });
      throw new HttpError(
        400,
        `${name} for a ${long ? 'long (bought)' : 'short (sold)'} position must be ${wantBelow ? 'below' : 'above'} the current price ₹${f(ltp)}.`,
        { kind: 'rules' }
      );
    }
  }
  return setExit({ inst: pos, kind, price: level, pos });
}
