import { createHmac } from 'node:crypto';

// Tells the always-on feed server (Vultr) which crypto prices to watch:
// open paper positions (liquidation / stop loss / take profit) and "at price" orders.
// Sent after every change, so the server reacts within a second or two.
// Needs FEED_URL (e.g. https://feed.devtradingapp.com) and FEED_SECRET in Vercel;
// without them nothing is sent and the app works as before.

/** The levels the server needs, from a crypto paper book. */
export function levelsOf(book) {
  return {
    at: new Date().toISOString(),
    positions: (book?.positions || []).map((p) => ({ symbol: p.symbol, side: p.side, liq: p.liqPrice ?? null, sl: p.sl ?? null, tp: p.tp ?? null })),
    orders: (book?.orders || []).map((o) => ({ id: o.id, symbol: o.symbol, side: o.side, cond: o.cond, trigger: o.trigger, status: o.status })),
  };
}

/** Push the levels to the feed server; never throws, gives up after 1.5 s. */
export async function pushLevels(book) {
  const url = String(process.env.FEED_URL || '').trim().replace(/\/$/, '');
  const secret = String(process.env.FEED_SECRET || '').trim();
  if (!url || !secret || !book) return false;
  try {
    const r = await fetch(`${url}/levels`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-feed-secret': secret },
      body: JSON.stringify(levelsOf(book)),
      signal: AbortSignal.timeout(1500),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * NSE: tell the feed server that the watchlist, orders or Dhan token changed; it then
 * re-reads them (GET /api/ticker?action=nse-feed). Never throws, gives up after 1.5 s.
 */
export async function notifyNse(reason = 'changed') {
  const url = String(process.env.FEED_URL || '').trim().replace(/\/$/, '');
  const secret = String(process.env.FEED_SECRET || '').trim();
  if (!url || !secret) return false;
  try {
    const r = await fetch(`${url}/nse-changed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-feed-secret': secret },
      body: JSON.stringify({ reason }),
      signal: AbortSignal.timeout(1500),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/** True if this request carries the feed server's secret. */
export function isFeedServer(req) {
  const secret = String(process.env.FEED_SECRET || '').trim();
  return Boolean(secret) && String(req.headers?.['x-feed-secret'] || '') === secret;
}

/**
 * A token for a page to open the live price stream (GET <FEED_URL>/stream?token=…),
 * valid 12 hours: "<expiry ms>.<HMAC-SHA256 of 'stream:<expiry>' with FEED_SECRET>".
 * null when the feed server isn't set up.
 */
export function streamToken() {
  const url = String(process.env.FEED_URL || '').trim().replace(/\/$/, '');
  const secret = String(process.env.FEED_SECRET || '').trim();
  if (!url || !secret) return null;
  const exp = Date.now() + 12 * 3600_000;
  const sig = createHmac('sha256', secret).update(`stream:${exp}`).digest('base64url');
  return { url: `${url}/stream`, base: url, token: `${exp}.${sig}`, exp };
}
