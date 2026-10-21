// The "stocks" table: StockID, HitTime, StockSymbol, PotentialProfit
import { randomUUID } from 'node:crypto';

export const STOCKS_TABLE = 'stocks';
export const COLUMNS = ['StockID', 'HitTime', 'StockSymbol', 'PotentialProfit'];
// Optional extra columns, filled by the Chartink adapter (or any sender).
export const OPTIONAL_COLUMNS = ['TriggerPrice', 'ScanName'];

// Accept StockSymbol, stockSymbol, stock_symbol, STOCK_SYMBOL, ... for every column.
const KEY_LOOKUP = Object.fromEntries([...COLUMNS, ...OPTIONAL_COLUMNS].map((c) => [c.toLowerCase(), c]));

function canonicalKeys(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const col = KEY_LOOKUP[k.replace(/[_\s-]/g, '').toLowerCase()];
    if (col) out[col] = v;
  }
  return out;
}

/**
 * Validate one incoming record and convert it to a table row.
 * Returns { row } or { errors: [...] }.
 */
export function toStockRow(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { errors: ['Record must be a JSON object'] };
  }
  const rec = canonicalKeys(input);
  const errors = [];

  // StockSymbol — required, e.g. RELIANCE, M&M, BAJAJ-AUTO, NSE:TCS
  let symbol = typeof rec.StockSymbol === 'string' ? rec.StockSymbol.trim().toUpperCase() : '';
  if (!symbol) errors.push('StockSymbol is required');
  else if (!/^[A-Z0-9.&_:^-]{1,32}$/.test(symbol)) errors.push(`StockSymbol "${symbol}" has invalid characters`);

  // PotentialProfit — required number (numeric strings are accepted)
  let profit = rec.PotentialProfit;
  if (typeof profit === 'string' && profit.trim() !== '') profit = Number(profit.replace(/,/g, ''));
  if (profit === undefined || profit === null || profit === '') errors.push('PotentialProfit is required');
  else if (typeof profit !== 'number' || !Number.isFinite(profit)) errors.push('PotentialProfit must be a number');

  // HitTime — optional, defaults to now; stored as ISO 8601 UTC
  let hitTime = new Date().toISOString();
  if (rec.HitTime !== undefined && rec.HitTime !== null && rec.HitTime !== '') {
    const raw = rec.HitTime;
    // Unix timestamps: seconds (10 digits) or milliseconds (13 digits)
    const asNum = typeof raw === 'number' ? raw : /^\d{10,13}$/.test(String(raw)) ? Number(raw) : NaN;
    const d = Number.isFinite(asNum) ? new Date(asNum < 1e12 ? asNum * 1000 : asNum) : new Date(raw);
    if (Number.isNaN(d.getTime())) errors.push(`HitTime "${raw}" is not a valid date/time`);
    else hitTime = d.toISOString();
  }

  // StockID — optional, generated when missing
  let id = rec.StockID;
  if (id === undefined || id === null || id === '') id = randomUUID();
  else if (typeof id !== 'string' && typeof id !== 'number') errors.push('StockID must be a string or number');
  else id = String(id).trim();

  // Optional extras
  const extras = {};
  if (rec.TriggerPrice !== undefined && rec.TriggerPrice !== null && rec.TriggerPrice !== '') {
    const p = Number(String(rec.TriggerPrice).replace(/,/g, ''));
    if (Number.isFinite(p)) extras.TriggerPrice = p;
    else errors.push('TriggerPrice must be a number');
  }
  if (typeof rec.ScanName === 'string' && rec.ScanName.trim()) extras.ScanName = rec.ScanName.trim().slice(0, 120);

  if (errors.length) return { errors };
  return {
    row: { StockID: id, HitTime: hitTime, StockSymbol: symbol, PotentialProfit: profit, ...extras },
    idempotent: rec.StockID != null && rec.StockID !== '' && rec.HitTime != null && rec.HitTime !== '',
  };
}

/** Pull a list of records out of whatever shape the sender posted. */
export function extractRecords(body) {
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object') {
    for (const key of ['records', 'data', 'stocks', 'items']) {
      if (Array.isArray(body[key])) return body[key];
    }
    return [body];
  }
  return null;
}
