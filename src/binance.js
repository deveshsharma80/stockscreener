// Binance market data, straight from the browser (free, no API key).
// Spot pairs first; coins listed only on USDⓈ-M Futures (perpetuals, e.g. EVAAUSDT)
// come from the futures API (fapi / fstream) instead — see isFutures().
//
// REST: Binance's market-data-only host first, then the main API host, then
// this app's own /api/crypto proxy as a last resort (e.g. if a network blocks
// Binance). Live prices: Binance WebSocket streams, with the same host
// fallback; if no stream connects, callers fall back to polling REST.
// Docs: https://developers.binance.com/docs/binance-spot-api-docs/faqs/market_data_only

const REST_HOSTS = ['https://data-api.binance.vision', 'https://api.binance.com'];
const WS_HOSTS = ['wss://data-stream.binance.vision', 'wss://stream.binance.com:9443'];
const FUT_REST_HOSTS = ['https://fapi.binance.com'];
// USDⓈ-M futures market streams (kline, miniTicker) live under /market since Apr 2026
const FUT_WS_HOSTS = ['wss://fstream.binance.com/market'];
let restIdx = 0; // remember which host worked

// Symbols that exist only as USDⓈ-M perpetuals (no spot pair)
const futuresOnly = new Set();
export const isFutures = (symbol) => futuresOnly.has(symbol);
/** Tell this module which symbols are futures-only (e.g. from the saved watchlist). */
export const markFutures = (symbols = []) => symbols.forEach((s) => futuresOnly.add(s));
let proxySecret = '';
/** Let REST calls fall back to /api/crypto (needs the webhook secret). */
export const useProxy = (secret) => (proxySecret = secret || '');

export const INTERVALS = { '1h': 3600, '1d': 86400 };

async function rest(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const fut = path.startsWith('/fapi/');
  const tries = fut ? FUT_REST_HOSTS : [...REST_HOSTS.slice(restIdx), ...REST_HOSTS.slice(0, restIdx)];
  let lastErr;
  for (const host of tries) {
    try {
      const r = await fetch(`${host}${path}?${qs}`, { cache: 'no-store' });
      if (r.status === 400) {
        const j = await r.json().catch(() => ({}));
        throw Object.assign(new Error(j.msg || 'Binance rejected the request'), { fatal: true });
      }
      if (!r.ok) throw new Error(`Binance HTTP ${r.status}`);
      if (!fut) restIdx = REST_HOSTS.indexOf(host);
      return await r.json();
    } catch (e) {
      if (e.fatal) throw e;
      lastErr = e;
    }
  }
  if (proxySecret) {
    const r = await fetch(`/api/crypto?${new URLSearchParams({ action: 'binance', path, q: qs })}`, {
      cache: 'no-store',
      headers: { 'X-Webhook-Secret': proxySecret },
    });
    const j = await r.json().catch(() => null);
    if (r.ok && j?.ok) return j.data;
    lastErr = new Error(j?.error || `Proxy HTTP ${r.status}`);
  }
  throw new Error(`Couldn't reach Binance (${lastErr?.message || 'network error'}).`);
}

const toCandle = (k) => ({
  time: Math.floor(k[0] / 1000), // open time, seconds (UTC)
  open: +k[1],
  high: +k[2],
  low: +k[3],
  close: +k[4],
  volume: +k[5],
  quoteVolume: +k[7],
});

/**
 * The latest `count` candles (paged 1000 at a time, newest page first).
 * 1h × 3000 ≈ 4 months; 1d × 1000 ≈ 2¾ years.
 */
export async function klines(symbol, interval, count = 1000) {
  try {
    return await klinesFrom(isFutures(symbol) ? '/fapi/v1/klines' : '/api/v3/klines', symbol, interval, count);
  } catch (e) {
    // Not a spot pair (e.g. opened from a link)? Try the perpetual.
    if (isFutures(symbol) || !e.fatal) throw e;
    const out = await klinesFrom('/fapi/v1/klines', symbol, interval, count);
    futuresOnly.add(symbol);
    return out;
  }
}

async function klinesFrom(path, symbol, interval, count) {
  let out = [];
  let endTime;
  const page = path.startsWith('/fapi/') ? 1500 : 1000; // futures allow 1500 per request
  while (out.length < count) {
    const limit = Math.min(page, count - out.length);
    const rows = await rest(path, { symbol, interval, limit, ...(endTime ? { endTime } : {}) });
    if (!Array.isArray(rows) || !rows.length) break;
    out = rows.map(toCandle).concat(out);
    if (rows.length < limit) break;
    endTime = rows[0][0] - 1;
  }
  return out;
}

/** The latest `count` candles of a USDⓈ-M perpetual (always the futures API). */
export const futuresKlines = (symbol, interval, count) => klinesFrom('/fapi/v1/klines', symbol, interval, count);

/** Every USDT perpetual currently trading on Binance USDⓈ-M Futures. */
export async function perpSymbols() {
  const info = await rest('/fapi/v1/exchangeInfo');
  return (info.symbols || [])
    .filter((x) => x.contractType === 'PERPETUAL' && x.quoteAsset === 'USDT' && x.status === 'TRADING')
    .map((x) => x.symbol)
    .sort();
}

/** 24-hour stats for some symbols: { BTCUSDT: { price, changePct, quoteVolume, high, low } } */
export async function tickers(symbols) {
  if (!symbols.length) return {};
  const spot = symbols.filter((s) => !isFutures(s));
  const fut = symbols.filter(isFutures);
  const [a, b] = await Promise.all([
    spot.length ? rest('/api/v3/ticker/24hr', { symbols: JSON.stringify(spot) }) : [],
    fut.length ? futuresTickers().then((all) => all.filter((t) => fut.includes(t.symbol))) : [],
  ]);
  return Object.fromEntries([...a, ...b].map((t) => [t.symbol, mapTicker(t)]));
}

let futCache = null; // { at, rows } — the futures API only gives one symbol or all of them
async function futuresTickers() {
  if (futCache && Date.now() - futCache.at < 5_000) return futCache.rows;
  const rows = await rest('/fapi/v1/ticker/24hr');
  futCache = { at: Date.now(), rows };
  return rows;
}
const mapTicker = (t) => ({
  price: +t.lastPrice,
  open: +t.openPrice,
  changePct: +t.priceChangePercent,
  quoteVolume: +t.quoteVolume,
  high: +t.highPrice,
  low: +t.lowPrice,
});

let marketsCache = null; // { at, list }
/**
 * Every USDT spot pair, plus USDⓈ-M perpetuals that have no spot pair (market: 'futures'),
 * with 24 h volume, biggest first (for search). Cached 10 min. If one of the two
 * lists can't be loaded, the other is still returned.
 */
export async function usdtMarkets() {
  if (marketsCache && Date.now() - marketsCache.at < 600_000) return marketsCache.list;
  const [spotRows, futRows] = await Promise.allSettled([rest('/api/v3/ticker/24hr', { type: 'MINI' }), futuresTickers()]);
  if (spotRows.status === 'rejected' && futRows.status === 'rejected') throw spotRows.reason;
  const spot = (spotRows.value || [])
    .filter((t) => t.symbol.endsWith('USDT') && +t.quoteVolume > 0 && !/(UP|DOWN|BULL|BEAR)USDT$/.test(t.symbol))
    .map((t) => ({ symbol: t.symbol, base: t.symbol.slice(0, -4), price: +t.lastPrice, quoteVolume: +t.quoteVolume, market: 'spot' }));
  const have = new Set(spot.map((m) => m.symbol));
  const fut = (futRows.value || [])
    // perpetuals only (quarterly contracts look like BTCUSDT_261225)
    .filter((t) => t.symbol.endsWith('USDT') && !t.symbol.includes('_') && +t.quoteVolume > 0 && !have.has(t.symbol))
    .map((t) => ({ symbol: t.symbol, base: t.symbol.slice(0, -4), price: +t.lastPrice, quoteVolume: +t.quoteVolume, market: 'futures' }));
  markFutures(fut.map((m) => m.symbol));
  const list = [...spot, ...fut].sort((a, b) => b.quoteVolume - a.quoteVolume);
  marketsCache = { at: Date.now(), list };
  return list;
}

/**
 * Subscribe to Binance streams (e.g. ["btcusdt@miniTicker", "btcusdt@kline_1h"]).
 * onMessage gets each event's data. Reconnects with back-off and tries the
 * other host; onStatus('live' | 'connecting' | 'down'). Returns unsubscribe().
 */
export function stream(streams, onMessage, onStatus = () => {}) {
  const symOf = (st) => st.split('@')[0].toUpperCase();
  const fut = streams.filter((st) => isFutures(symOf(st)));
  const spot = streams.filter((st) => !isFutures(symOf(st)));
  if (!fut.length) return connect(spot, WS_HOSTS, onMessage, onStatus);
  if (!spot.length) return connect(fut, FUT_WS_HOSTS, onMessage, onStatus);
  // Both kinds: two connections; report the weaker of the two states
  const st = { spot: 'connecting', fut: 'connecting' };
  const rank = { live: 0, connecting: 1, down: 2 };
  const report = (k) => (s) => {
    st[k] = s;
    onStatus(rank[st.spot] >= rank[st.fut] ? st.spot : st.fut);
  };
  const a = connect(spot, WS_HOSTS, onMessage, report('spot'));
  const b = connect(fut, FUT_WS_HOSTS, onMessage, report('fut'));
  return () => (a(), b());
}

function connect(streams, hosts, onMessage, onStatus) {
  let ws = null;
  let closed = false;
  let attempt = 0;
  let timer = null;
  const open = () => {
    if (closed || !streams.length) return;
    const host = hosts[attempt % hosts.length];
    onStatus(attempt === 0 ? 'connecting' : attempt > 3 ? 'down' : 'connecting');
    try {
      ws = new WebSocket(`${host}/stream?streams=${streams.join('/')}`);
    } catch {
      return retry();
    }
    let gotData = false;
    ws.onmessage = (e) => {
      if (!gotData) {
        gotData = true;
        attempt = 0;
        onStatus('live');
      }
      try {
        const m = JSON.parse(e.data);
        if (m?.data) onMessage(m.data);
      } catch {}
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      if (!closed) retry();
    };
  };
  const retry = () => {
    attempt++;
    onStatus(attempt > 3 ? 'down' : 'connecting');
    timer = setTimeout(open, Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)));
  };
  open();
  return () => {
    closed = true;
    clearTimeout(timer);
    try {
      ws?.close();
    } catch {}
  };
}

/** Fold a kline stream event into a candle array (updates the last candle or appends). */
export function applyKline(candles, k) {
  const c = { time: Math.floor(k.t / 1000), open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v, quoteVolume: +k.q };
  const last = candles[candles.length - 1];
  if (last && last.time === c.time) candles[candles.length - 1] = c;
  else if (!last || c.time > last.time) candles.push(c);
  return c;
}

// ---- formatting (USDT prices span 0.00001 to 100,000)
export function fmtPrice(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const d = a >= 1000 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 5 : 8;
  return v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: d });
}
export function fmtCompact(v) {
  if (v == null) return '—';
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(0);
}
