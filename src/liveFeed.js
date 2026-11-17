// Live NSE prices for every page in this tab, straight from the feed server (Vultr):
// one Server-Sent Events connection per tab, opened with a 12-hour token from the app.
//
// - Prices arrive as the market trades (batched up to 4× a second) for the instruments
//   in the Market watchlist. They are shared on QUOTES_EVENT (source: 'feed'), the same
//   event the Market page already uses, so Watchlist, Positions, the Running P&L pill,
//   Trades, P&L and the chart all update from it.
// - Pages keep polling only what the stream doesn't cover (instruments outside the
//   watchlist, or everything when the stream is down or the market is closed).
// - Trigger orders the server filled arrive as ORDERS_EVENT (source: 'feed').
import { useEffect, useState } from 'react';
import { api } from './Ticker.jsx';
import { QUOTES_EVENT, emitOrders } from './Orders.jsx';

export const LIVE_EVENT = 'stockhits:live'; // the stream's status changed

const feed = {
  status: 'off', // off | connecting | open | unavailable | error
  live: false, // server has a live Dhan feed (market hours)
  keys: new Set(), // instruments the stream covers
  quotes: {}, // latest quote per key from the stream
  note: null,
  es: null,
  secret: null,
  retryTimer: null,
  renewTimer: null,
};

const announce = () => window.dispatchEvent(new CustomEvent(LIVE_EVENT, { detail: snapshot() }));
const snapshot = () => ({ status: feed.status, live: feed.status === 'open' && feed.live, count: feed.keys.size, note: feed.note });

/** True when the stream is live and carries this instrument (and has sent a price for it). */
export function streamed(key) {
  return feed.status === 'open' && feed.live && feed.keys.has(key) && feed.quotes[key]?.ltp > 0;
}

/** Of these comma-separated keys, the ones pages still have to poll. */
export function keysToPoll(keys) {
  return String(keys || '')
    .split(',')
    .filter((k) => k && !streamed(k))
    .join(',');
}

export function isLive() {
  return feed.status === 'open' && feed.live;
}

function stop() {
  clearTimeout(feed.retryTimer);
  clearTimeout(feed.renewTimer);
  if (feed.es) feed.es.close();
  feed.es = null;
}

function retry(ms) {
  clearTimeout(feed.retryTimer);
  feed.retryTimer = setTimeout(() => start(feed.secret, true), ms);
}

async function start(secret, force = false) {
  if (!secret || typeof EventSource === 'undefined') return;
  if (!force && feed.secret === secret && (feed.es || feed.status === 'connecting' || feed.status === 'unavailable')) return;
  stop();
  feed.secret = secret;
  feed.status = 'connecting';
  announce();
  let info;
  try {
    info = (await api(secret, 'feed-token')).stream;
  } catch {
    feed.status = 'error';
    announce();
    return retry(30_000);
  }
  if (!info?.url) {
    feed.status = 'unavailable'; // feed server not set up → pages just poll
    announce();
    return retry(10 * 60_000);
  }
  const es = new EventSource(`${info.url}?token=${encodeURIComponent(info.token)}`);
  feed.es = es;
  // a fresh token before this one expires
  feed.renewTimer = setTimeout(() => start(secret, true), Math.max(60_000, info.exp - Date.now() - 10 * 60_000));

  es.addEventListener('state', (e) => {
    try {
      const d = JSON.parse(e.data);
      feed.live = Boolean(d.live);
      feed.keys = new Set(d.keys || []);
      feed.note = d.note || null;
      feed.status = 'open';
      announce();
    } catch {}
  });
  es.addEventListener('q', (e) => {
    try {
      const d = JSON.parse(e.data);
      const quotes = d.quotes || {};
      if (!Object.keys(quotes).length) return;
      for (const [k, q] of Object.entries(quotes)) feed.quotes[k] = { ...feed.quotes[k], ...q };
      window.dispatchEvent(new CustomEvent(QUOTES_EVENT, { detail: { quotes, source: 'feed' } }));
    } catch {}
  });
  es.addEventListener('orders', (e) => {
    try {
      const d = JSON.parse(e.data);
      if (d.events?.length) emitOrders({ events: d.events, pending: d.pending, source: 'feed' });
    } catch {}
  });
  es.onopen = () => {
    feed.status = 'open';
    announce();
  };
  es.onerror = () => {
    if (feed.es !== es) return;
    if (es.readyState === EventSource.CLOSED) {
      // refused (e.g. token expired) or gone: fresh token and try again shortly
      feed.status = 'error';
      feed.es = null;
      announce();
      retry(5_000);
    } else {
      feed.status = 'connecting'; // the browser reconnects by itself
      announce();
    }
  };
}

/** Start the stream for this tab (once) and re-render when its status changes. */
export function useLiveFeed(secret) {
  const [s, setS] = useState(snapshot);
  useEffect(() => {
    if (secret) start(secret);
    const on = (e) => setS(e.detail);
    window.addEventListener(LIVE_EVENT, on);
    setS(snapshot());
    return () => window.removeEventListener(LIVE_EVENT, on);
  }, [secret]);
  return s;
}
