// Trigger orders for paper trading (table "paper_orders", db/paper_orders.json).
//
// You pick a price; the order waits until the live price reaches it, then the
// app places an Equity Intraday paper trade at the live price at that moment.
//
// "Reaches" depends on where the price was when the order was placed:
//   direction "up"   — price was below the trigger → fills when LTP ≥ trigger
//   direction "down" — price was above the trigger → fills when LTP ≤ trigger
//
// Orders are checked whenever the app asks for quotes (the Market pages), by
// the page-wide watcher (every ~10 s on other pages), and by
// /api/ticker?action=check-orders for an outside scheduler. Each order is
// claimed atomically (PENDING → FILLING) before it is filled, so two checks
// running at the same time can't fill it twice.
//
// An order is valid until the end of the next market session (3:30 PM IST
// today if placed before then on a weekday, otherwise the next weekday).
import { randomUUID } from 'node:crypto';
import { readTable, updateTable } from './db.js';

export const ORDERS_TABLE = 'paper_orders';
export const MAX_PENDING = 100;
const KEEP_DONE = 500; // finished orders kept for history
const STALE_CLAIM_MS = 90_000; // a FILLING order this old was interrupted
const CACHE_MS = 3000;

const r2 = (v) => Math.round(v * 100) / 100;
const IST = 330 * 60_000;
const CLOSE_MIN = 15 * 60 + 30;

export const ignoreHours = () => process.env.PAPER_ORDERS_IGNORE_HOURS === '1';

/** End of the session an order placed at `now` belongs to (15:30 IST), as ISO. */
export function sessionEnd(now = Date.now()) {
  const ist = new Date(now + IST);
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const d = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
  const weekday = (x) => x.getUTCDay() >= 1 && x.getUTCDay() <= 5;
  if (!(weekday(d) && mins < CLOSE_MIN)) {
    do d.setUTCDate(d.getUTCDate() + 1);
    while (!weekday(d));
  }
  return new Date(d.getTime() + CLOSE_MIN * 60_000 - IST).toISOString();
}

/** Does this price trigger the order? */
export const crosses = (o, ltp) =>
  typeof ltp === 'number' && ltp > 0 && (o.direction === 'up' ? ltp >= o.triggerPrice : ltp <= o.triggerPrice);

// ---- small per-instance cache so frequent quote polls don't re-read the table
let cache = null; // { at, rows }
const invalidate = () => (cache = null);
export async function readOrders({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.rows;
  const rows = await readTable(ORDERS_TABLE).catch(() => []);
  cache = { at: Date.now(), rows };
  return rows;
}
async function write(mutate) {
  try {
    return await updateTable(ORDERS_TABLE, mutate);
  } finally {
    invalidate();
  }
}

const isOpen = (o) => o.status === 'PENDING' || o.status === 'FILLING';
export const openKeys = (rows) => [...new Set(rows.filter(isOpen).map((o) => o.key))];

function prune(rows) {
  const done = rows.filter((o) => !isOpen(o));
  if (done.length <= KEEP_DONE) return;
  const drop = new Set(done.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(KEEP_DONE).map((o) => o.id));
  const keep = rows.filter((o) => !drop.has(o.id));
  rows.length = 0;
  rows.push(...keep);
}

export async function createOrder({ inst, side, qty, triggerPrice, ltp, source = '', refPrice = null, now = Date.now() }) {
  const order = {
    id: `o-${randomUUID().slice(0, 8)}`,
    createdAt: new Date(now).toISOString(),
    validUntil: sessionEnd(now),
    key: `${inst.segment}:${inst.securityId}`,
    segment: inst.segment,
    securityId: String(inst.securityId),
    symbol: inst.symbol,
    name: inst.name || '',
    product: 'EQ_INTRADAY',
    side,
    qty,
    triggerPrice: r2(triggerPrice),
    direction: triggerPrice >= ltp ? 'up' : 'down',
    ltpAtCreate: r2(ltp),
    refPrice: typeof refPrice === 'number' ? r2(refPrice) : null, // e.g. the first-hit trigger price
    source: String(source || '').slice(0, 20),
    status: 'PENDING',
  };
  await write((rows) => {
    if (rows.filter(isOpen).length >= MAX_PENDING) {
      throw Object.assign(new Error(`At most ${MAX_PENDING} pending orders. Cancel some first.`), { status: 400 });
    }
    rows.push(order);
    prune(rows);
  });
  return order;
}

export async function cancelOrder(id) {
  return write((rows) => {
    const o = rows.find((r) => r.id === id);
    if (!o) throw Object.assign(new Error('Order not found'), { status: 404 });
    if (o.status === 'FILLING') throw Object.assign(new Error('This order is being filled right now'), { status: 409 });
    if (o.status !== 'PENDING') throw Object.assign(new Error(`This order is already ${o.status.toLowerCase()}`), { status: 409 });
    const done = { ...o, status: 'CANCELLED', closedAt: new Date().toISOString() };
    rows[rows.indexOf(o)] = done;
    return done;
  });
}

/** Cancel every pending order (used when the paper account is reset). */
export async function cancelAllPending() {
  return write((rows) => {
    const at = new Date().toISOString();
    for (let i = 0; i < rows.length; i++) if (rows[i].status === 'PENDING') rows[i] = { ...rows[i], status: 'CANCELLED', closedAt: at, note: 'Paper account reset' };
  });
}

/** Mark orders whose session has ended as EXPIRED. Returns those orders. */
async function expire(rows, now) {
  const due = rows.filter((o) => o.status === 'PENDING' && Date.parse(o.validUntil) <= now);
  if (!due.length) return [];
  const ids = new Set(due.map((o) => o.id));
  return write((all) => {
    const out = [];
    const at = new Date(now).toISOString();
    for (let i = 0; i < all.length; i++) {
      if (ids.has(all[i].id) && all[i].status === 'PENDING') {
        all[i] = { ...all[i], status: 'EXPIRED', closedAt: at };
        out.push(all[i]);
      }
    }
    return out;
  });
}

/**
 * A FILLING order whose check was interrupted (function timed out, crashed):
 * if its trade exists it was filled, otherwise it goes back to PENDING.
 */
async function recover(rows, now, findTrade) {
  const stale = rows.filter((o) => o.status === 'FILLING' && now - Date.parse(o.claimedAt || 0) > STALE_CLAIM_MS);
  if (!stale.length) return;
  const found = new Map();
  for (const o of stale) found.set(o.id, (await findTrade?.(o.id)) || null);
  await write((all) => {
    for (let i = 0; i < all.length; i++) {
      const o = all[i];
      if (!found.has(o.id) || o.status !== 'FILLING') continue;
      const t = found.get(o.id);
      all[i] = t
        ? { ...o, status: 'FILLED', filledAt: t.at, fillPrice: t.price, tradeId: t.id, claim: undefined }
        : { ...o, status: 'PENDING', claim: undefined, claimedAt: undefined };
    }
  });
}

/**
 * Check pending orders against live prices and fill the ones that triggered.
 *   quotes       prices already fetched by the caller { "NSE_EQ:2885": {ltp} }
 *   fetchQuotes  async (keys) => quotes, for pending keys not in `quotes`
 *   fill         async (order, quote) => trade (places the paper trade)
 *   findTrade    async (orderId) => trade | null (for interrupted fills)
 *   marketOpen   only trigger during market hours (unless PAPER_ORDERS_IGNORE_HOURS=1)
 * Returns { events: [order…] (filled / failed / expired now), pending, open }.
 */
export async function processOrders({ quotes = {}, fetchQuotes, fill, findTrade, marketOpen, now = Date.now(), fresh = false }) {
  let rows = await readOrders({ fresh });
  if (!rows.some(isOpen)) return { events: [], pending: 0, open: [] };

  const events = [...(await expire(rows, now))];
  await recover(rows, now, findTrade);
  if (events.length || rows.some((o) => o.status === 'FILLING')) rows = await readOrders({ fresh: true });

  const pending = rows.filter((o) => o.status === 'PENDING');
  const summary = () => ({ events, pending: pending.length, open: pending.map((o) => o.id) });
  if (!pending.length || (!marketOpen && !ignoreHours())) return summary();

  // Prices for every pending instrument
  const prices = { ...quotes };
  const missing = [...new Set(pending.map((o) => o.key))].filter((k) => !prices[k]?.ltp);
  if (missing.length && fetchQuotes) {
    try {
      Object.assign(prices, await fetchQuotes(missing));
    } catch {
      // no prices this round (rate limit, network) — try again on the next check
    }
  }

  const hit = pending.filter((o) => crosses(o, prices[o.key]?.ltp));
  if (!hit.length) return summary();

  // Claim: only orders still PENDING in the latest copy are ours to fill.
  const claim = randomUUID().slice(0, 8);
  const hitIds = new Set(hit.map((o) => o.id));
  const claimed = await write((all) => {
    const mine = [];
    const at = new Date(now).toISOString();
    for (let i = 0; i < all.length; i++) {
      const o = all[i];
      if (hitIds.has(o.id) && o.status === 'PENDING') {
        all[i] = { ...o, status: 'FILLING', claim, claimedAt: at, triggeredAt: at, ltpAtTrigger: prices[o.key].ltp };
        mine.push(all[i]);
      }
    }
    return mine;
  });
  if (!claimed?.length) return summary();

  // Fill one by one (each trade re-checks funds against the latest book).
  const results = new Map();
  for (const o of claimed) {
    try {
      const t = await fill(o, prices[o.key]);
      results.set(o.id, { status: 'FILLED', filledAt: t.at, fillPrice: t.price, tradeId: t.id });
    } catch (err) {
      results.set(o.id, { status: 'FAILED', error: String(err?.message || err).slice(0, 300) });
    }
  }
  const done = await write((all) => {
    const out = [];
    const at = new Date().toISOString();
    for (let i = 0; i < all.length; i++) {
      const o = all[i];
      const r = results.get(o.id);
      if (!r || o.claim !== claim) continue;
      const { claim: _c, ...rest } = o;
      all[i] = { ...rest, ...r, closedAt: at };
      out.push(all[i]);
    }
    prune(all);
    return out;
  });
  events.push(...done);
  const filledIds = new Set(done.map((o) => o.id));
  return { events, pending: pending.filter((o) => !filledIds.has(o.id)).length, open: pending.filter((o) => !filledIds.has(o.id)).map((o) => o.id) };
}
