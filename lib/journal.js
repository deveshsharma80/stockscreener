// Trade journal: paper fills grouped into complete trades (entry → exit), each
// with P&L in ₹ and %, timing, and your own notes (table "trade_journal").
//
// A trade starts when a position opens from zero and ends when it is back to
// zero. Adding to the position is part of the same trade (average entry);
// partial exits are part of it too (average exit). If one order flips the
// position (e.g. sell 15 while long 10), the first trade closes and a new one
// opens with the remaining 5. Brokerage of a fill is split between the trades
// it belongs to, by quantity.
//
//   Gross P&L  = Σ closed qty × (exit − average entry)   (reversed for shorts)
//   Net P&L    = gross − brokerage (entry and exit legs)
//   P&L %      = net ÷ (average entry × closed qty)      (on trade value)
//   Margin %   = net ÷ margin blocked (value ÷ leverage) (Equity Intraday 4×)
import { readTable, updateTable } from './db.js';
import { BROKERAGE_PCT, PRODUCTS, brokeragePctOf, chargesFor, productOf } from './paper.js';

export const NOTES_TABLE = 'trade_journal';
export const MAX_NOTE = 4000;

const r2 = (v) => Math.round(v * 100) / 100;
const INFO = ['segment', 'securityId', 'symbol', 'name', 'instrument', 'expiry', 'strike', 'optionType', 'underlying', 'lotSize'];

export function roundTrips(trades) {
  const sorted = [...trades].sort((a, b) => a.at.localeCompare(b.at) || String(a.id).localeCompare(String(b.id)));
  const open = new Map(); // key -> current trip
  const trips = [];

  const start = (t, qty, chargePart, product) => {
    const trip = {
      id: t.id, // the opening fill's id: stable, used for notes
      key: t.key,
      ...Object.fromEntries(INFO.map((f) => [f, t[f] ?? ''])),
      product,
      leverage: PRODUCTS[product]?.leverage || 1,
      dir: t.side === 'BUY' ? 1 : -1,
      side: t.side === 'BUY' ? 'LONG' : 'SHORT',
      openedAt: t.at,
      closedAt: null,
      pos: 0, // signed open quantity
      avg: 0,
      entryQty: 0,
      entryValue: 0,
      maxQty: 0,
      exitQty: 0,
      exitValue: 0,
      realized: 0,
      charges: 0,
      viaOrder: Boolean(t.orderId),
      fills: [],
    };
    add(trip, t, qty, chargePart);
    open.set(t.key, trip);
    trips.push(trip);
    return trip;
  };
  const add = (trip, t, qty, chargePart) => {
    const n = Math.abs(trip.pos) + qty;
    trip.avg = (trip.avg * Math.abs(trip.pos) + t.price * qty) / n;
    trip.pos += trip.dir * qty;
    trip.entryQty += qty;
    trip.entryValue += qty * t.price;
    trip.maxQty = Math.max(trip.maxQty, Math.abs(trip.pos));
    trip.charges += chargePart;
    trip.fills.push({ id: t.id, at: t.at, side: t.side, qty, price: t.price, charges: r2(chargePart), role: 'entry', orderId: t.orderId || null });
  };

  for (const t of sorted) {
    const product = productOf(t);
    const pct = Number.isFinite(t.chargesPct) ? t.chargesPct : brokeragePctOf(product) ?? BROKERAGE_PCT;
    const charges = chargesFor(t.qty, t.price, pct);
    const q = t.side === 'BUY' ? 1 : -1;
    const trip = open.get(t.key);

    if (!trip) {
      start(t, t.qty, charges, product);
      continue;
    }
    if (Math.sign(trip.pos) === q) {
      add(trip, t, t.qty, charges);
      continue;
    }
    // Reduces / closes (maybe flips) the position
    const closeQty = Math.min(t.qty, Math.abs(trip.pos));
    const rest = t.qty - closeQty;
    const closeCharges = (charges * closeQty) / t.qty;
    const pnl = closeQty * (t.price - trip.avg) * trip.dir;
    trip.realized += pnl;
    trip.exitQty += closeQty;
    trip.exitValue += closeQty * t.price;
    trip.charges += closeCharges;
    trip.pos += q * closeQty;
    trip.fills.push({ id: t.id, at: t.at, side: t.side, qty: closeQty, price: t.price, charges: r2(closeCharges), role: 'exit', realized: r2(pnl), orderId: t.orderId || null });
    if (trip.pos === 0) {
      trip.closedAt = t.at;
      open.delete(t.key);
    }
    if (rest > 0) start({ ...t, id: `${t.id}~flip` }, rest, charges - closeCharges, product);
  }

  return trips
    .map((t) => {
      const avgEntry = t.entryValue / t.entryQty;
      const avgExit = t.exitQty ? t.exitValue / t.exitQty : null;
      const cost = avgEntry * t.exitQty; // value of the part that was closed
      const net = t.realized - t.charges;
      return {
        id: t.id,
        key: t.key,
        ...Object.fromEntries(INFO.map((f) => [f, t[f]])),
        product: t.product,
        leverage: t.leverage,
        side: t.side,
        status: t.closedAt ? 'CLOSED' : 'OPEN',
        openedAt: t.openedAt,
        closedAt: t.closedAt,
        lastExitAt: t.fills.filter((f) => f.role === 'exit').at(-1)?.at || null,
        holdMs: t.closedAt ? Date.parse(t.closedAt) - Date.parse(t.openedAt) : null,
        qty: t.entryQty, // total bought (long) / sold (short) to open
        maxQty: t.maxQty,
        openQty: Math.abs(t.pos),
        avgEntry: r2(avgEntry),
        avgOpen: r2(t.avg), // average price of what's still open
        avgExit: avgExit != null ? r2(avgExit) : null,
        exitQty: t.exitQty,
        entryValue: r2(t.entryValue),
        gross: r2(t.realized),
        charges: r2(t.charges),
        net: r2(net),
        pnlPct: t.exitQty ? r2((net / cost) * 100) : null,
        movePct: avgExit != null ? r2(((avgExit - avgEntry) / avgEntry) * 100 * (t.side === 'LONG' ? 1 : -1)) : null,
        marginPct: t.exitQty ? r2((net / (cost / t.leverage)) * 100) : null,
        viaOrder: t.viaOrder,
        fills: t.fills,
      };
    })
    .sort((a, b) => b.openedAt.localeCompare(a.openedAt));
}

// ---------------------------------------------------------------- notes

export async function readNotes() {
  const rows = await readTable(NOTES_TABLE).catch(() => []);
  return Object.fromEntries(rows.map((r) => [r.id, r]));
}

/** Save (or with an empty note, delete) the note for a trade. */
export async function saveNote(id, note) {
  id = String(id || '').slice(0, 80);
  note = String(note ?? '').replace(/\r\n/g, '\n').trim();
  if (note.length > MAX_NOTE) throw Object.assign(new Error(`Notes can be up to ${MAX_NOTE} characters`), { status: 400 });
  const now = new Date().toISOString();
  return updateTable(NOTES_TABLE, (rows) => {
    const i = rows.findIndex((r) => r.id === id);
    if (!note) {
      if (i >= 0) rows.splice(i, 1);
      return null;
    }
    const row = { id, note, createdAt: i >= 0 ? rows[i].createdAt : now, updatedAt: now };
    if (i >= 0) rows[i] = row;
    else rows.push(row);
    return row;
  });
}
