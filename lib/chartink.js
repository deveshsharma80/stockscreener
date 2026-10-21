// Chartink alert webhook → stocks table rows.
//
// Chartink posts one JSON object per alert run, e.g.
//   {
//     "stocks": "SEPOWER,ASTEC,EDUCOMP",
//     "trigger_prices": "3.75,541.8,2.1",
//     "triggered_at": "2:34 pm",
//     "scan_name": "Short term breakouts",
//     "scan_url": "short-term-breakouts",
//     "alert_name": "Alert for Short term breakouts",
//     "webhook_url": "https://..."
//   }
// Each stock in the list becomes one row.
//
// PotentialProfit (₹ per share) is taken, in order of preference, from:
//   1. a result column you added to the alert payload whose name is like
//      "potential_profit" (comma-separated, same order as `stocks`)
//   2. trigger price × target %, where target % comes from ?target=5 on the
//      webhook URL (set per alert), else CHARTINK_TARGET_PCT, else 5
import { createHash } from 'node:crypto';

const IST_OFFSET_MIN = 330; // Asia/Kolkata, UTC+05:30, no DST
const DEFAULT_TARGET_PCT = 5;

export function isChartinkPayload(body) {
  return Boolean(
    body && typeof body === 'object' && !Array.isArray(body) &&
      typeof body.stocks === 'string' && 'trigger_prices' in body
  );
}

const splitList = (v) =>
  v === undefined || v === null ? [] : String(v).split(',').map((s) => s.trim());

/**
 * "2:34 pm" (Indian time, no date) → ISO UTC timestamp on today's IST date.
 * Falls back to `now` if the string can't be read.
 */
export function chartinkTimeToIso(text, now = new Date()) {
  const m = /^\s*(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*([ap])\.?\s*m\.?\s*$/i.exec(String(text || ''));
  if (!m) {
    const d = new Date(text);
    return Number.isNaN(d.getTime()) || !/\d{4}/.test(String(text)) ? now.toISOString() : d.toISOString();
  }
  let h = Number(m[1]) % 12;
  if (m[4].toLowerCase() === 'p') h += 12;
  const min = Number(m[2] || 0);
  const sec = Number(m[3] || 0);

  // Today's date as seen in India
  const istNow = new Date(now.getTime() + IST_OFFSET_MIN * 60_000);
  let t = Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate(), h, min, sec) - IST_OFFSET_MIN * 60_000;
  // A time well in the future means the alert was from the previous day.
  if (t - now.getTime() > 15 * 60_000) t -= 24 * 3600_000;
  return new Date(t).toISOString();
}

function findProfitColumn(body) {
  for (const [k, v] of Object.entries(body)) {
    const key = k.replace(/[_\s-]/g, '').toLowerCase();
    if (key === 'potentialprofit' || key === 'potentialprofits') return v;
  }
  return undefined;
}

function toNumber(v) {
  if (v === undefined || v === null || String(v).trim() === '') return NaN;
  return Number(String(v).replace(/[,₹\s]/g, ''));
}

/** Returns the generic records the webhook validates and stores. */
export function chartinkToRecords(body, { targetPct, now = new Date() } = {}) {
  const symbols = splitList(body.stocks).filter(Boolean);
  const prices = splitList(body.trigger_prices);
  const profitCol = findProfitColumn(body);
  const profits = Array.isArray(profitCol) ? profitCol : splitList(profitCol);
  const pct = Number.isFinite(targetPct) ? targetPct : DEFAULT_TARGET_PCT;
  const hitTime = chartinkTimeToIso(body.triggered_at, now);
  const scan = String(body.scan_name || body.scan_url || '').trim();

  return symbols.map((symbol, i) => {
    const price = toNumber(prices[i]);
    const given = toNumber(profits[i]);
    const profit = Number.isFinite(given)
      ? given
      : Number.isFinite(price)
        ? Math.round(price * pct) / 100
        : undefined;
    // Deterministic ID: a resent alert produces the same IDs and is not stored twice.
    const id = 'CK-' + createHash('sha1').update(`${body.scan_url}|${symbol}|${hitTime}`).digest('hex').slice(0, 12).toUpperCase();
    return {
      StockID: id,
      HitTime: hitTime,
      StockSymbol: symbol,
      PotentialProfit: profit,
      TriggerPrice: Number.isFinite(price) ? price : undefined,
      ScanName: scan || undefined,
    };
  });
}

export function resolveTargetPct(req) {
  const fromQuery = parseFloat(req.query?.target);
  if (Number.isFinite(fromQuery)) return fromQuery;
  const fromEnv = parseFloat(process.env.CHARTINK_TARGET_PCT);
  if (Number.isFinite(fromEnv)) return fromEnv;
  return DEFAULT_TARGET_PCT;
}
