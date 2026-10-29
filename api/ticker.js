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
//
// Paper trading (dummy fills at the live LTP, stored in db/paper_trades.json):
// GET  ?action=paper                                  positions, trades, daily/weekly P&L
// POST {action:"trade", key, side:"BUY"|"SELL", qty, product}
//      product: "OPT_BUY" (Options Buying) | "EQ_INTRADAY" (Equity Intraday, 4× leverage)
//      qty in shares (F&O: multiple of lot size)
// POST {action:"paper-capital", amount}               set the starting amount (keeps trades)
// POST {action:"paper-reset", amount?}                delete all paper trades, optionally set a new starting amount
import { readTable, updateTable } from '../lib/db.js';
import { HttpError, checkSecret, cors, parseBody, sendError } from '../lib/http.js';
import { PRODUCTS, addTrade, checkFunds, computeBook, productFor, readAccount, readTrades, resetTrades, setCapital, validateOrder } from '../lib/paper.js';
import {
  DhanError,
  SEGMENTS,
  clearCredentials,
  connectToken,
  getCredentials,
  getFillQuote,
  getIntradayCandles,
  getQuotes,
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
      case 'GET quotes':
        return res.json({ ok: true, ...(await quotes(req.query?.keys)), market: marketStatus(), at: new Date().toISOString() });
      case 'POST connect': {
        const { profile: p, creds } = await connectToken(body);
        return res.json({ ok: true, ...describeCreds(creds), profile: pickProfile(p) });
      }
      case 'POST renew':
        return res.json({ ok: true, ...describeCreds(await renewToken()) });
      case 'POST disconnect':
        await clearCredentials();
        return res.json({ ok: true, connected: false });
      case 'POST add':
        return res.json({ ok: true, rows: await addToWatchlist(String(body.key || '')) });
      case 'POST remove':
        return res.json({ ok: true, rows: await removeFromWatchlist(String(body.key || '')) });
      case 'GET paper':
        return res.json({ ok: true, ...(await paperBook()) });
      case 'POST trade': {
        const trade = await placePaperTrade(body);
        return res.json({ ok: true, trade, ...(await paperBook()) });
      }
      case 'POST paper-capital':
        await setCapital(body.amount);
        return res.json({ ok: true, ...(await paperBook()) });
      case 'POST paper-reset':
        if (body.amount !== undefined && body.amount !== null && body.amount !== '') await setCapital(body.amount);
        await resetTrades();
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

async function quotes(keysParam) {
  const keys = [...new Set(String(keysParam || '').split(',').map((k) => k.trim()).filter(Boolean))];
  if (keys.length > 1000) throw new HttpError(400, 'At most 1000 instruments per request');
  const instruments = [];
  for (const k of keys) {
    const m = KEY_RE.exec(k);
    if (m) instruments.push({ segment: m[1], securityId: m[2] }); // skip anything malformed rather than fail the whole feed
  }
  return { quotes: await getQuotes(instruments) };
}

// ------------------------------------------------------------------ paper trading

async function placePaperTrade({ key, side, qty, product }) {
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
  return addTrade({ inst, side, qty, price: quote.ltp, marketOpen: marketStatus().open, product });
}

async function paperBook() {
  const [trades, account] = await Promise.all([readTrades(), readAccount()]);
  return computeBook(trades, undefined, account);
}
