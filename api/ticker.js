// /api/ticker — everything the Ticker page needs. Webhook secret required.
//
// GET  ?action=status                 Dhan connection + market status
// GET  ?action=watchlist              saved instruments
// GET  ?action=search&q=nifty 25000 ce
// GET  ?action=quotes&keys=NSE_EQ:2885,NSE_FNO:49081
// POST {action:"connect", accessToken, clientId?}   save + verify Dhan token
// POST {action:"renew"}                              renew Dhan token now
// POST {action:"disconnect"}
// POST {action:"add", key:"NSE_EQ:2885"}             add to watchlist
// POST {action:"remove", key:"NSE_EQ:2885"}
import { readTable, updateTable } from '../lib/db.js';
import { HttpError, checkSecret, cors, parseBody, sendError } from '../lib/http.js';
import {
  DhanError,
  SEGMENTS,
  clearCredentials,
  connectToken,
  getCredentials,
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
    if (!m) throw new HttpError(400, `Bad instrument key "${k}"`);
    instruments.push({ segment: m[1], securityId: m[2] });
  }
  return { quotes: await getQuotes(instruments) };
}
