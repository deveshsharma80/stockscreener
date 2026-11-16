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
