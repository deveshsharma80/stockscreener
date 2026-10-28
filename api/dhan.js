// Dhan (DhanHQ v2) client used by the Ticker page.
//
//  - Credentials: client ID + access token, saved from the Ticker page into the
//    JSON database (table "dhan_settings"), or DHAN_CLIENT_ID / DHAN_ACCESS_TOKEN
//    env vars as a fallback. Tokens from Dhan Web last 24 hours; when one has
//    under an hour left it is renewed automatically via /v2/RenewToken.
//  - Instruments: Dhan's public instrument master CSV, trimmed to NSE/BSE
//    equity, indices and live F&O contracts, cached once per day.
//  - Quotes: POST /v2/marketfeed/quote (max 1000 instruments, 1 request/sec).
//
// Set DHAN_MOCK=1 to run the whole page with simulated data (no Dhan account).
import { readJson, readTable, updateTable, writeJson } from './db.js';

const API = 'https://api.dhan.co/v2';
const SCRIP_MASTER_URL = 'https://images.dhan.co/api-data/api-scrip-master.csv';
const SETTINGS_TABLE = 'dhan_settings';
const INSTRUMENT_CACHE = 'instruments_cache';
const MOCK = process.env.DHAN_MOCK === '1';

export const SEGMENTS = ['IDX_I', 'NSE_EQ', 'NSE_FNO', 'BSE_EQ', 'BSE_FNO'];

export class DhanError extends Error {
  constructor(message, { status = 502, code, kind } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.kind = kind; // 'auth' | 'plan' | 'rate' | 'input' | 'network' | 'other'
  }
}

// ------------------------------------------------------------------ time helpers

const istNow = () => new Date(Date.now() + 330 * 60_000);
export const istToday = () => istNow().toISOString().slice(0, 10);

/** NSE cash/F&O session: Mon–Fri 09:15–15:30 IST (exchange holidays not included). */
export function marketStatus() {
  const n = istNow();
  const day = n.getUTCDay();
  const mins = n.getUTCHours() * 60 + n.getUTCMinutes();
  const open = day >= 1 && day <= 5 && mins >= 9 * 60 + 15 && mins < 15 * 60 + 30;
  return { open, label: open ? 'Market open' : 'Market closed' };
}

// ------------------------------------------------------------------ credentials

let credCache = null; // { value, at }
const CRED_TTL_MS = 5 * 60_000;

function decodeJwtExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** Current credentials, or null if none are configured. */
export async function getCredentials({ fresh = false } = {}) {
  if (MOCK) return { clientId: '1000000001', accessToken: 'mock', source: 'mock', expiresAt: Date.now() + 20 * 3600_000 };
  if (!fresh && credCache && Date.now() - credCache.at < CRED_TTL_MS) return credCache.value;

  let value = null;
  const [saved] = await readTable(SETTINGS_TABLE).catch(() => []);
  if (saved?.accessToken) {
    value = { ...saved, source: 'saved' };
  } else if (process.env.DHAN_ACCESS_TOKEN) {
    value = {
      clientId: String(process.env.DHAN_CLIENT_ID || '').trim(),
      accessToken: String(process.env.DHAN_ACCESS_TOKEN).trim(),
      source: 'env',
    };
  }
  if (value) value.expiresAt = value.expiresAt || decodeJwtExpiry(value.accessToken);
  credCache = { value, at: Date.now() };
  return value;
}

async function saveCredentials(creds) {
  const record = {
    clientId: creds.clientId,
    accessToken: creds.accessToken,
    expiresAt: creds.expiresAt || decodeJwtExpiry(creds.accessToken) || null,
    updatedAt: new Date().toISOString(),
  };
  await updateTable(SETTINGS_TABLE, (rows) => {
    rows.length = 0;
    rows.push(record);
  });
  credCache = { value: { ...record, source: 'saved' }, at: Date.now() };
  return credCache.value;
}

export async function clearCredentials() {
  await updateTable(SETTINGS_TABLE, (rows) => {
    rows.length = 0;
  });
  credCache = null;
}

// ------------------------------------------------------------------ HTTP

function classify(status, body) {
  const code = String(body?.errorCode ?? body?.data?.errorCode ?? body?.code ?? '');
  const msg = String(body?.errorMessage ?? body?.data?.errorMessage ?? body?.message ?? body?.remarks ?? '');
  if (['DH-901', '807', '808', '809', '810'].includes(code) || status === 401) {
    return new DhanError(
      code === '807'
        ? 'Your Dhan access token has expired. Paste a new one in Dhan connection.'
        : 'Dhan rejected the access token or client ID. Paste a fresh token in Dhan connection.',
      { status: 401, code, kind: 'auth' }
    );
  }
  if (['DH-902', '806'].includes(code)) {
    return new DhanError('Dhan says Data APIs are not active on this account. Check your Data API subscription.', { status: 403, code, kind: 'plan' });
  }
  if (['DH-904', '805'].includes(code) || status === 429) {
    return new DhanError('Dhan rate limit reached (quotes are limited to 1 request per second).', { status: 429, code, kind: 'rate' });
  }
  if (['DH-905', '804', '813', '814'].includes(code)) {
    return new DhanError(`Dhan rejected the request${msg ? `: ${msg}` : ''}`, { status: 400, code, kind: 'input' });
  }
  return new DhanError(`Dhan error ${code || status}${msg ? `: ${msg}` : ''}`, { status: 502, code, kind: 'other' });
}

async function dhanFetch(path, { method = 'GET', body, creds, headers = {} } = {}) {
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        'access-token': creds.accessToken,
        ...(creds.clientId ? { 'client-id': creds.clientId } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new DhanError(`Could not reach Dhan: ${err.message}`, { status: 504, kind: 'network' });
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  const failed = !res.ok || json?.status === 'failure' || json?.status === 'failed' || json?.errorCode;
  if (failed) throw classify(res.status, json || { errorMessage: text.slice(0, 200) });
  return json;
}

// ------------------------------------------------------------------ token management

/** Check a token against /v2/profile and save it. Returns the profile. */
export async function connectToken({ accessToken, clientId }) {
  accessToken = String(accessToken || '').trim();
  if (!accessToken) throw new DhanError('Paste your Dhan access token', { status: 400, kind: 'input' });
  if (MOCK) return { profile: mockProfile(), creds: await getCredentials() };

  const profile = await dhanFetch('/profile', { creds: { accessToken, clientId: String(clientId || '').trim() } });
  const resolvedClientId = String(profile?.dhanClientId || clientId || '').trim();
  if (!resolvedClientId) throw new DhanError('Could not read your Dhan client ID — enter it as well', { status: 400, kind: 'input' });
  const expiresAt = decodeJwtExpiry(accessToken) || parseDhanDate(profile?.tokenValidity);
  const creds = await saveCredentials({ clientId: resolvedClientId, accessToken, expiresAt });
  return { profile, creds };
}

/** Renew the current token (Dhan Web tokens only). The old token stops working. */
export async function renewToken() {
  if (MOCK) return getCredentials();
  const creds = await getCredentials({ fresh: true });
  if (!creds) throw new DhanError('No Dhan token saved yet', { status: 400, kind: 'auth' });
  const json = await dhanFetch('/RenewToken', { creds, headers: { dhanClientId: creds.clientId } });
  const token = json?.token || json?.accessToken || json?.access_token || json?.data?.accessToken || json?.data?.token;
  if (!token) {
    console.error('RenewToken: unexpected response keys', Object.keys(json || {}));
    throw new DhanError('Dhan renewed the token but the reply was not understood. Paste a new token from Dhan Web.', { kind: 'other' });
  }
  const expiresAt = decodeJwtExpiry(token) || parseDhanDate(json?.expiryTime) || null;
  return saveCredentials({ clientId: creds.clientId, accessToken: token, expiresAt });
}

let lastRenewAttempt = 0;
/** Renew automatically when under an hour is left (it would lapse anyway). */
async function maybeAutoRenew(creds) {
  if (MOCK || creds.source !== 'saved' || !creds.expiresAt) return creds;
  const left = creds.expiresAt - Date.now();
  if (left > 60 * 60_000 || left <= 0 || Date.now() - lastRenewAttempt < 10 * 60_000) return creds;
  lastRenewAttempt = Date.now();
  try {
    const renewed = await renewToken();
    console.log('Dhan token auto-renewed');
    return renewed;
  } catch (err) {
    console.error('Dhan token auto-renew failed:', err.message);
    return creds;
  }
}

export async function profile() {
  if (MOCK) return mockProfile();
  const creds = await getCredentials();
  if (!creds) return null;
  return dhanFetch('/profile', { creds });
}

function parseDhanDate(s) {
  // "30/03/2025 15:37" (IST) or "2024-12-05 09:37:52.0"
  if (!s) return null;
  let m = /^(\d{2})\/(\d{2})\/(\d{4})[ T](\d{2}):(\d{2})/.exec(s);
  if (m) return Date.parse(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:00+05:30`) || null;
  m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(:\d{2})?)/.exec(s);
  if (m) return Date.parse(`${m[1]}T${m[2].length === 5 ? `${m[2]}:00` : m[2]}+05:30`) || null;
  return null;
}

// ------------------------------------------------------------------ quotes

let quoteCache = { key: '', at: 0, data: null };
const lastQuotes = new Map(); // "SEG:ID" -> { q, at } — latest quote per instrument
let inFlight = null;

/**
 * Live quotes for [{segment, securityId}] → { "NSE_EQ:2885": quote, ... }.
 * Responses are shared for 900 ms so several open tabs don't break the
 * 1 request/second limit.
 */
export async function getQuotes(instruments) {
  if (!instruments.length) return {};
  const key = instruments.map((i) => `${i.segment}:${i.securityId}`).sort().join(',');
  if (quoteCache.key === key && Date.now() - quoteCache.at < 900) return quoteCache.data;
  if (inFlight?.key === key) return inFlight.promise;

  const promise = (async () => {
    if (MOCK) return mockQuotes(instruments);
    let creds = await getCredentials();
    if (!creds) throw new DhanError('Connect your Dhan account first (Dhan connection → paste access token).', { status: 400, kind: 'auth' });
    creds = await maybeAutoRenew(creds);

    const body = {};
    for (const { segment, securityId } of instruments) (body[segment] ||= []).push(Number(securityId));

    let json;
    try {
      json = await dhanFetch('/marketfeed/quote', { method: 'POST', body, creds });
    } catch (err) {
      // Token may have been changed from another instance — retry once with fresh credentials.
      if (err.kind !== 'auth') throw err;
      const fresh = await getCredentials({ fresh: true });
      if (!fresh || fresh.accessToken === creds.accessToken) throw err;
      json = await dhanFetch('/marketfeed/quote', { method: 'POST', body, creds: fresh });
    }
    const root = json?.data?.data && typeof json.data.data === 'object' ? json.data.data : json?.data || {};
    const out = {};
    for (const [segment, byId] of Object.entries(root)) {
      if (!byId || typeof byId !== 'object') continue;
      for (const [id, q] of Object.entries(byId)) out[`${segment}:${id}`] = normalizeQuote(q);
    }
    return out;
  })();

  inFlight = { key, promise };
  try {
    const data = await promise;
    quoteCache = { key, at: Date.now(), data };
    for (const [k, q] of Object.entries(data)) lastQuotes.set(k, { q, at: Date.now() });
    return data;
  } finally {
    if (inFlight?.promise === promise) inFlight = null;
  }
}

/**
 * A current quote for filling a paper trade: reuses one fetched in the last
 * few seconds (the page polls constantly), otherwise asks Dhan, waiting out
 * the 1 request/second limit if needed.
 */
export async function getFillQuote({ segment, securityId }) {
  const key = `${segment}:${securityId}`;
  const recent = lastQuotes.get(key);
  if (recent && Date.now() - recent.at < 5000 && recent.q.ltp) return recent.q;
  for (let attempt = 0; ; attempt++) {
    try {
      const q = (await getQuotes([{ segment, securityId: String(securityId) }]))[key];
      if (!q || !q.ltp) throw new DhanError('Dhan returned no price for this instrument right now. Try again.', { kind: 'other' });
      return q;
    } catch (err) {
      if (err.kind !== 'rate' || attempt >= 2) throw err;
      await new Promise((r) => setTimeout(r, 1100));
    }
  }
}

const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

function normalizeQuote(q) {
  const ltp = num(q.last_price);
  const change = num(q.net_change);
  let prevClose = ltp !== null && change !== null ? ltp - change : null;
  if (!prevClose && num(q.ohlc?.close)) prevClose = num(q.ohlc.close);
  const changePct = change !== null && prevClose ? (change / prevClose) * 100 : null;
  const bestBid = q.depth?.buy?.find((d) => num(d.price) > 0);
  const bestAsk = q.depth?.sell?.find((d) => num(d.price) > 0);
  return {
    ltp,
    change,
    changePct,
    prevClose,
    open: num(q.ohlc?.open),
    high: num(q.ohlc?.high),
    low: num(q.ohlc?.low),
    volume: num(q.volume),
    oi: num(q.oi),
    avgPrice: num(q.average_price),
    lastQty: num(q.last_quantity),
    lastTradeTime: q.last_trade_time ?? null,
    bid: bestBid ? num(bestBid.price) : null,
    bidQty: bestBid ? num(bestBid.quantity) : null,
    ask: bestAsk ? num(bestAsk.price) : null,
    askQty: bestAsk ? num(bestAsk.quantity) : null,
    upperCircuit: num(q.upper_circuit_limit),
    lowerCircuit: num(q.lower_circuit_limit),
  };
}

// ------------------------------------------------------------------ instruments

let index = null; // { date, list: [...records], hay: [...strings] }
let building = null;

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function segmentOf(exch, seg, inst) {
  if (inst === 'INDEX' || seg === 'I') return 'IDX_I';
  if (exch === 'NSE' && seg === 'E') return 'NSE_EQ';
  if (exch === 'NSE' && seg === 'D') return 'NSE_FNO';
  if (exch === 'BSE' && seg === 'E') return 'BSE_EQ';
  if (exch === 'BSE' && seg === 'D') return 'BSE_FNO';
  return null;
}

const KEEP_INSTRUMENTS = new Set(['EQUITY', 'INDEX', 'OPTIDX', 'OPTSTK', 'FUTIDX', 'FUTSTK']);

/** Split one CSV line, honouring quotes. */
function splitCsv(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') (cur += '"'), i++;
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') out.push(cur), (cur = '');
    else cur += c;
  }
  out.push(cur);
  return out;
}

/**
 * Parse Dhan's compact scrip master (header names from Dhan's docs) into
 * compact rows: [segment, securityId, tradingSymbol, displayName, instrument,
 * expiry(YYYY-MM-DD), strike, optionType, lotSize, underlyingName].
 */
export function parseScripMaster(text, today = istToday()) {
  const lines = text.split(/\r?\n/);
  const header = splitCsv(lines[0]).map((h) => h.trim().toUpperCase());
  const col = (...names) => {
    for (const n of names) {
      const i = header.indexOf(n);
      if (i !== -1) return i;
    }
    return -1;
  };
  const C = {
    exch: col('SEM_EXM_EXCH_ID', 'EXCH_ID'),
    seg: col('SEM_SEGMENT', 'SEGMENT'),
    id: col('SEM_SMST_SECURITY_ID', 'SECURITY_ID'),
    inst: col('SEM_INSTRUMENT_NAME', 'INSTRUMENT'),
    tsym: col('SEM_TRADING_SYMBOL', 'TRADING_SYMBOL'),
    disp: col('SEM_CUSTOM_SYMBOL', 'DISPLAY_NAME'),
    exp: col('SEM_EXPIRY_DATE', 'SM_EXPIRY_DATE'),
    strike: col('SEM_STRIKE_PRICE', 'STRIKE_PRICE'),
    opt: col('SEM_OPTION_TYPE', 'OPTION_TYPE'),
    lot: col('SEM_LOT_UNITS', 'LOT_SIZE'),
    name: col('SM_SYMBOL_NAME', 'SYMBOL_NAME'),
    under: col('UNDERLYING_SYMBOL'),
  };
  if (C.id === -1 || C.exch === -1 || C.inst === -1) {
    throw new Error(`Unexpected instrument file columns: ${header.slice(0, 12).join(', ')}`);
  }

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const f = splitCsv(line);
    const inst = (f[C.inst] || '').trim().toUpperCase();
    if (!KEEP_INSTRUMENTS.has(inst)) continue;
    const segment = segmentOf((f[C.exch] || '').trim().toUpperCase(), C.seg === -1 ? '' : (f[C.seg] || '').trim().toUpperCase(), inst);
    if (!segment) continue;
    const expiry = C.exp === -1 ? '' : (f[C.exp] || '').trim().slice(0, 10);
    const derivative = inst.startsWith('OPT') || inst.startsWith('FUT');
    if (derivative && (!/^\d{4}-\d{2}-\d{2}$/.test(expiry) || expiry < today)) continue;
    const strike = Number(f[C.strike]) > 0 ? Number(f[C.strike]) : 0;
    const opt = (f[C.opt] || '').trim().toUpperCase();
    rows.push([
      segment,
      String(f[C.id]).trim(),
      (f[C.tsym] || '').trim(),
      (C.disp === -1 ? '' : f[C.disp] || '').trim(),
      inst,
      derivative ? expiry : '',
      inst.startsWith('OPT') ? strike : 0,
      opt === 'CE' || opt === 'PE' ? opt : '',
      Number(f[C.lot]) || 1,
      (C.under !== -1 && f[C.under] ? f[C.under] : C.name !== -1 ? f[C.name] || '' : '').trim(),
    ]);
  }
  return rows;
}

function toRecord(r) {
  const [segment, securityId, symbol, display, instrument, expiry, strike, optionType, lotSize, underlying] = r;
  return { key: `${segment}:${securityId}`, segment, securityId, symbol, name: display || symbol, instrument, expiry, strike, optionType, lotSize, underlying };
}

function searchText(rec) {
  const parts = [rec.symbol, rec.name, rec.underlying, rec.securityId];
  if (rec.expiry) {
    const [y, m, d] = rec.expiry.split('-');
    parts.push(`${Number(d)} ${MONTHS[Number(m) - 1]} ${y} ${MONTHS[Number(m) - 1]}${y}`);
  }
  if (rec.strike) parts.push(String(rec.strike));
  if (rec.optionType) parts.push(rec.optionType);
  if (rec.instrument.startsWith('FUT')) parts.push('FUT FUTURE');
  return (
    ' ' +
    parts
      .join(' ')
      .toUpperCase()
      .replace(/\bCALL\b/g, 'CE')
      .replace(/\bPUT\b/g, 'PE')
      .replace(/[-_,/()]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

function buildIndex(date, rows) {
  const list = rows.map(toRecord);
  return { date, list, hay: list.map(searchText), byKey: new Map(list.map((r) => [r.key, r])) };
}

async function downloadScripMaster() {
  if (MOCK) return mockScripMaster();
  const res = await fetch(SCRIP_MASTER_URL, { signal: AbortSignal.timeout(45_000) });
  if (!res.ok) throw new DhanError(`Could not download Dhan instrument list (HTTP ${res.status})`, { kind: 'network' });
  return res.text();
}

/** The instrument index for today, from memory, the daily cache, or Dhan. */
export async function getInstrumentIndex() {
  const today = istToday();
  if (index?.date === today) return index;
  if (building) return building;
  building = (async () => {
    try {
      const cached = await readJson(INSTRUMENT_CACHE).catch(() => null);
      if (cached?.date === today && Array.isArray(cached.rows) && cached.rows.length) {
        index = buildIndex(today, cached.rows);
        return index;
      }
      const rows = parseScripMaster(await downloadScripMaster(), today);
      if (!rows.length) throw new DhanError('Dhan instrument list was empty', { kind: 'other' });
      index = buildIndex(today, rows);
      await writeJson(INSTRUMENT_CACHE, { date: today, rows }).catch((e) => console.error('instrument cache write failed:', e.message));
      return index;
    } finally {
      building = null;
    }
  })();
  return building;
}

const SEG_RANK = { NSE_EQ: 0, IDX_I: 0, BSE_EQ: 2, NSE_FNO: 1, BSE_FNO: 3 };

/** Search instruments. "reliance", "nifty 25000 ce", "banknifty fut", "NSE_FNO:49081" */
export async function searchInstruments(query, { limit = 25, segment } = {}) {
  const idx = await getInstrumentIndex();
  const raw = String(query || '').trim().toUpperCase();
  if (!raw) return [];

  const direct = /^([A-Z_]+):(\d+)$/.exec(raw.replace(/\s+/g, ''));
  if (direct) {
    const hit = idx.byKey.get(`${direct[1]}:${direct[2]}`);
    return hit ? [hit] : [];
  }

  const tokens = raw
    .replace(/\bCALL\b/g, 'CE')
    .replace(/\bPUT\b/g, 'PE')
    .replace(/[-_,/()]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const matches = [];
  for (let i = 0; i < idx.list.length; i++) {
    const rec = idx.list[i];
    if (segment && rec.segment !== segment) continue;
    const hay = idx.hay[i];
    if (tokens.every((t) => hay.includes(` ${t}`))) matches.push(rec);
  }

  const first = tokens[0];
  const score = (r) => {
    let s = SEG_RANK[r.segment] ?? 5;
    if (r.symbol.toUpperCase() === raw || r.name.toUpperCase() === raw) s -= 10;
    else if (r.symbol.toUpperCase() === first || r.underlying.toUpperCase() === first) s -= 4;
    return s;
  };
  matches.sort(
    (a, b) =>
      score(a) - score(b) ||
      (a.expiry || '').localeCompare(b.expiry || '') ||
      a.strike - b.strike ||
      a.optionType.localeCompare(b.optionType) ||
      a.symbol.localeCompare(b.symbol)
  );
  return matches.slice(0, limit);
}

export async function lookupInstrument(key) {
  const idx = await getInstrumentIndex();
  return idx.byKey.get(key) || null;
}

// ------------------------------------------------------------------ mock mode

function mockProfile() {
  return { dhanClientId: '1000000001', tokenValidity: 'mock', dataPlan: 'Active', dataValidity: 'mock', activeSegment: 'Equity, Derivative' };
}

function mockScripMaster() {
  const exp = (days) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  const lines = ['SEM_EXM_EXCH_ID,SEM_SEGMENT,SEM_SMST_SECURITY_ID,SEM_INSTRUMENT_NAME,SEM_EXPIRY_CODE,SEM_TRADING_SYMBOL,SEM_LOT_UNITS,SEM_CUSTOM_SYMBOL,SEM_EXPIRY_DATE,SEM_STRIKE_PRICE,SEM_OPTION_TYPE,SEM_TICK_SIZE,SEM_EXPIRY_FLAG,SEM_EXCH_INSTRUMENT_TYPE,SEM_SERIES,SM_SYMBOL_NAME'];
  const eq = [['2885', 'RELIANCE', 'Reliance Industries'], ['1333', 'HDFCBANK', 'HDFC Bank'], ['11536', 'TCS', 'Tata Consultancy'], ['1594', 'INFY', 'Infosys'], ['3045', 'SBIN', 'State Bank of India'], ['3456', 'TATAMOTORS', 'Tata Motors'], ['2475', 'ONGC', 'ONGC']];
  for (const [id, sym, name] of eq) lines.push(`NSE,E,${id},EQUITY,,${sym},1,${name},,0,XX,5,NA,ES,EQ,"${name.toUpperCase()} LTD"`);
  lines.push('NSE,I,13,INDEX,,NIFTY,1,Nifty 50,,0,XX,5,NA,INDEX,NA,NIFTY 50');
  lines.push('NSE,I,25,INDEX,,BANKNIFTY,1,Nifty Bank,,0,XX,5,NA,INDEX,NA,NIFTY BANK');
  let id = 40000;
  for (const [days, d] of [[2, 'W'], [9, 'W'], [30, 'M']]) {
    const e = exp(days);
    const [y, m, dd] = e.split('-');
    const mon = MONTHS[Number(m) - 1];
    for (let k = 24600; k <= 25400; k += 100) {
      for (const t of ['CE', 'PE']) {
        lines.push(`NSE,D,${id++},OPTIDX,0,NIFTY-${mon[0]}${mon.slice(1).toLowerCase()}${y}-${k}-${t},75,NIFTY ${Number(dd)} ${mon} ${k} ${t === 'CE' ? 'CALL' : 'PUT'},${e} 14:30:00,${k}.00000,${t},5,${d},OP,NA,NIFTY`);
      }
    }
  }
  lines.push(`NSE,D,${id++},FUTIDX,0,BANKNIFTY-Nov${new Date().getFullYear()}-FUT,35,BANKNIFTY NOV FUT,${exp(30)} 14:30:00,-0.01000,XX,20,M,FX,NA,BANKNIFTY`);
  lines.push(`NSE,D,${id++},OPTSTK,0,RELIANCE-Nov${new Date().getFullYear()}-1500-CE,500,RELIANCE 25 NOV 1500 CALL,${exp(30)} 14:30:00,1500.00000,CE,5,M,OP,NA,RELIANCE`);
  lines.push(`NSE,D,${id++},OPTIDX,0,NIFTY-Jan2020-12000-CE,75,NIFTY 30 JAN 12000 CALL,2020-01-30 14:30:00,12000.00000,CE,5,M,OP,NA,NIFTY`);
  lines.push('MCX,M,99999,FUTCOM,0,GOLD-Dec2026-FUT,1,GOLD DEC FUT,2026-12-05 23:30:00,-0.01,XX,1,M,FUTCOM,NA,GOLD');
  return lines.join('\n');
}

const mockState = new Map();
function mockQuotes(instruments) {
  const out = {};
  for (const { segment, securityId } of instruments) {
    const key = `${segment}:${securityId}`;
    let s = mockState.get(key);
    if (!s) {
      const base = segment === 'IDX_I' ? (securityId === '25' ? 56000 : 25100) : segment.endsWith('FNO') ? 80 + (Number(securityId) % 17) * 9 : 300 + (Number(securityId) % 97) * 25;
      s = { prev: base, ltp: base * (1 + (Math.random() - 0.5) * 0.02), vol: Math.floor(Math.random() * 1e6), oi: segment.endsWith('FNO') ? Math.floor(Math.random() * 5e6) : 0 };
      s.open = s.prev * (1 + (Math.random() - 0.5) * 0.01);
      s.high = Math.max(s.open, s.ltp);
      s.low = Math.min(s.open, s.ltp);
      mockState.set(key, s);
    }
    if (Math.random() < 0.7) s.ltp = Math.max(0.05, s.ltp * (1 + (Math.random() - 0.5) * 0.004));
    s.high = Math.max(s.high, s.ltp);
    s.low = Math.min(s.low, s.ltp);
    s.vol += Math.floor(Math.random() * 5000);
    const r2 = (v) => Math.round(v * 20) / 20;
    out[key] = normalizeQuote({
      last_price: r2(s.ltp),
      net_change: r2(s.ltp) - r2(s.prev),
      ohlc: { open: r2(s.open), high: r2(s.high), low: r2(s.low), close: r2(s.prev) },
      volume: segment === 'IDX_I' ? 0 : s.vol,
      oi: s.oi,
      last_quantity: 25,
      average_price: r2((s.high + s.low) / 2),
      last_trade_time: new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 19).replace('T', ' '),
      depth: segment === 'IDX_I' ? undefined : { buy: [{ price: r2(s.ltp - 0.05), quantity: 120 }], sell: [{ price: r2(s.ltp + 0.05), quantity: 90 }] },
    });
  }
  return out;
}
