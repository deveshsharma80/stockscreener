// Binance spot market data, straight from the browser (free, no API key).
//
// REST: Binance's market-data-only host first, then the main API host, then
// this app's own /api/crypto proxy as a last resort (e.g. if a network blocks
// Binance). Live prices: Binance WebSocket streams, with the same host
// fallback; if no stream connects, callers fall back to polling REST.
// Docs: https://developers.binance.com/docs/binance-spot-api-docs/faqs/market_data_only

const REST_HOSTS = ['https://data-api.binance.vision', 'https://api.binance.com'];
const WS_HOSTS = ['wss://data-stream.binance.vision', 'wss://stream.binance.com:9443'];
let restIdx = 0; // remember which host worked
let proxySecret = '';
/** Let REST calls fall back to /api/crypto (needs the webhook secret). */
export const useProxy = (secret) => (proxySecret = secret || '');

export const INTERVALS = { '1h': 3600, '1d': 86400 };

async function rest(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const tries = [...REST_HOSTS.slice(restIdx), ...REST_HOSTS.slice(0, restIdx)];
  let lastErr;
  for (const host of tries) {
    try {
      const r = await fetch(`${host}${path}?${qs}`, { cache: 'no-store' });
      if (r.status === 400) {
        const j = await r.json().catch(() => ({}));
        throw Object.assign(new Error(j.msg || 'Binance rejected the request'), { fatal: true });
      }
      if (!r.ok) throw new Error(`Binance HTTP ${r.status}`);
      restIdx = REST_HOSTS.indexOf(host);
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
  let out = [];
  let endTime;
  while (out.length < count) {
    const limit = Math.min(1000, count - out.length);
    const rows = await rest('/api/v3/klines', { symbol, interval, limit, ...(endTime ? { endTime } : {}) });
    if (!Array.isArray(rows) || !rows.length) break;
    out = rows.map(toCandle).concat(out);
    if (rows.length < limit) break;
    endTime = rows[0][0] - 1;
  }
  return out;
}

/** 24-hour stats for some symbols: { BTCUSDT: { price, changePct, quoteVolume, high, low } } */
export async function tickers(symbols) {
  if (!symbols.length) return {};
  const rows = await rest('/api/v3/ticker/24hr', { symbols: JSON.stringify(symbols) });
  return Object.fromEntries(rows.map((t) => [t.symbol, mapTicker(t)]));
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
/** Every USDT spot pair with its 24 h volume, biggest first (for search). Cached 10 min. */
export async function usdtMarkets() {
  if (marketsCache && Date.now() - marketsCache.at < 600_000) return marketsCache.list;
  const rows = await rest('/api/v3/ticker/24hr', { type: 'MINI' });
  const list = rows
    .filter((t) => t.symbol.endsWith('USDT') && +t.quoteVolume > 0 && !/(UP|DOWN|BULL|BEAR)USDT$/.test(t.symbol))
    .map((t) => ({ symbol: t.symbol, base: t.symbol.slice(0, -4), price: +t.lastPrice, quoteVolume: +t.quoteVolume }))
    .sort((a, b) => b.quoteVolume - a.quoteVolume);
  marketsCache = { at: Date.now(), list };
  return list;
}

/**
 * Subscribe to Binance streams (e.g. ["btcusdt@miniTicker", "btcusdt@kline_1h"]).
 * onMessage gets each event's data. Reconnects with back-off and tries the
 * other host; onStatus('live' | 'connecting' | 'down'). Returns unsubscribe().
 */
export function stream(streams, onMessage, onStatus = () => {}) {
  let ws = null;
  let closed = false;
  let attempt = 0;
  let timer = null;
  const open = () => {
    if (closed || !streams.length) return;
    const host = WS_HOSTS[attempt % WS_HOSTS.length];
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
