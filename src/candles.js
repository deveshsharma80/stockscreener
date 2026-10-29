// Build N-minute candles from 1-minute candles, aligned to the NSE session
// start (09:15 IST): 3-min candles start 09:15, 09:18, 09:21…; 5-min candles
// 09:15, 09:20, 09:25…  Times are epoch seconds (UTC).

export const IST_OFFSET = 19800; // seconds (UTC+05:30)
const SESSION_START = 9 * 3600 + 15 * 60;

/** Start (epoch s) of the N-minute bucket containing epoch-second t. */
export function bucketStart(t, minutes) {
  const size = minutes * 60;
  const ist = t + IST_OFFSET;
  const midnight = ist - (((ist % 86400) + 86400) % 86400);
  const session = midnight + SESSION_START;
  const from = ist >= session ? session : midnight;
  return from + Math.floor((ist - from) / size) * size - IST_OFFSET;
}

/** 1-minute candles (sorted) → N-minute candles. */
export function aggregate(oneMin, minutes) {
  const out = [];
  let cur = null;
  for (const c of oneMin) {
    const b = bucketStart(c.time, minutes);
    if (!cur || cur.time !== b) {
      cur = { time: b, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 };
      out.push(cur);
    } else {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      cur.volume += c.volume || 0;
    }
  }
  return out;
}

/**
 * Apply a live price to the candle list (returns the updated/new last candle,
 * or null if nothing changed). `volDelta` is volume traded since the last tick.
 */
export function applyTick(candles, { time, price, volDelta = 0 }, minutes) {
  if (price == null) return null;
  const b = bucketStart(time, minutes);
  const last = candles[candles.length - 1];
  if (last && last.time === b) {
    last.high = Math.max(last.high, price);
    last.low = Math.min(last.low, price);
    last.close = price;
    last.volume += Math.max(0, volDelta);
    return last;
  }
  if (last && b < last.time) return null; // out-of-order tick
  const open = last ? last.close : price;
  const c = { time: b, open, high: Math.max(open, price), low: Math.min(open, price), close: price, volume: Math.max(0, volDelta) };
  candles.push(c);
  return c;
}
