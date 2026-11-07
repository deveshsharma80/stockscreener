// 4-hour candle store for Binance USDT perpetuals (Neon Postgres).
//
// One row per coin per 4-hour candle (t = candle start), with the indicators
// computed in the browser on 4-hour closes when the data was fetched (RSI 14, EMA 5 / 9 / 21).
// (The first version stored hourly candles in candles_1h; that table can be deleted from the page.) Kept as a
// rolling window: rows older than KEEP_DAYS are removed on every save.
//
// Needs DATABASE_URL (Neon connected in Vercel); works whether the rest of
// the app still uses Blob or already uses Postgres.
import { databaseUrl, pg } from './db.js';
import { HttpError } from './http.js';

export const KEEP_DAYS = 92; // ≈ 3 months
const TABLE = 'candles_4h';
const LEGACY_TABLE = 'candles_1h'; // hourly candles from the first version
const MAX_ROWS_PER_SAVE = 25_000;
// Binance symbols: mostly A–Z/0–9, a few in other scripts (e.g. 币安人生USDT)
const SYMBOL_RE = /^[^\s"'<>\\/?#&%=+,;:]{1,30}USDT$/u;

const DDL = `CREATE TABLE IF NOT EXISTS ${TABLE} (
  symbol text NOT NULL,
  t timestamptz NOT NULL,
  open real NOT NULL, high real NOT NULL, low real NOT NULL, close real NOT NULL,
  volume real, quote_volume real,
  rsi14 real, ema5 real, ema9 real, ema21 real,
  PRIMARY KEY (symbol, t)
)`;

function need() {
  if (!databaseUrl()) {
    throw new HttpError(400, 'Candle data is stored in Postgres: connect your Neon database to this project in Vercel (Storage) and redeploy.');
  }
}

async function q(text, params) {
  need();
  try {
    return await pg.query(text, params);
  } catch (err) {
    if (err?.code !== '42P01') throw err; // table missing (first use, or deleted) → create it
    await pg.query(DDL);
    return pg.query(text, params);
  }
}

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/**
 * Save candles: rows = [[symbol, timeMs, open, high, low, close, volume, quoteVolume, rsi14, ema5, ema9, ema21], …].
 * Existing hours are overwritten (so re-fetching refreshes the last candle and its indicators).
 */
export async function saveCandles(rows) {
  if (!Array.isArray(rows) || !rows.length) throw new HttpError(400, 'rows must be a non-empty list');
  if (rows.length > MAX_ROWS_PER_SAVE) throw new HttpError(400, `At most ${MAX_ROWS_PER_SAVE} rows per save`);
  const cols = Array.from({ length: 12 }, () => []);
  const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
  let skipped = 0;
  for (const r of rows) {
    const symbol = String(r?.[0] ?? '');
    const t = num(r?.[1]);
    const ohlc = [2, 3, 4, 5].map((i) => num(r?.[i]));
    if (!SYMBOL_RE.test(symbol) || t == null || t < cutoff || t > Date.now() || ohlc.some((v) => v == null)) {
      skipped++;
      continue;
    }
    cols[0].push(symbol);
    cols[1].push(new Date(t).toISOString());
    for (let i = 2; i < 12; i++) cols[i].push(num(r[i]));
  }
  if (cols[0].length) {
    await q(
      `INSERT INTO ${TABLE} (symbol, t, open, high, low, close, volume, quote_volume, rsi14, ema5, ema9, ema21)
       SELECT * FROM unnest($1::text[], $2::timestamptz[], $3::real[], $4::real[], $5::real[], $6::real[],
                            $7::real[], $8::real[], $9::real[], $10::real[], $11::real[], $12::real[])
       ON CONFLICT (symbol, t) DO UPDATE SET
         open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close,
         volume = EXCLUDED.volume, quote_volume = EXCLUDED.quote_volume,
         rsi14 = EXCLUDED.rsi14, ema5 = EXCLUDED.ema5, ema9 = EXCLUDED.ema9, ema21 = EXCLUDED.ema21`,
      cols
    );
  }
  return { saved: cols[0].length, skipped };
}

/** Remove rows older than the rolling window. */
export async function pruneCandles() {
  const r = await q(`DELETE FROM ${TABLE} WHERE t < now() - make_interval(days => $1) RETURNING 1`, [KEEP_DAYS]);
  return { removed: r.length };
}

/** Totals, plus each coin's latest candle with its indicators. */
export async function candleStatus() {
  if (!databaseUrl()) return { connected: false };
  const [tot] = await q(
    `SELECT count(*)::bigint AS candles, count(DISTINCT symbol)::int AS coins, min(t) AS first, max(t) AS last,
            pg_total_relation_size('${TABLE}')::bigint AS bytes
     FROM ${TABLE}`
  );
  const [legacy] = await pg.query(`SELECT coalesce(pg_total_relation_size(to_regclass('${LEGACY_TABLE}')), 0)::bigint AS bytes`);
  const [latest, counts] = await Promise.all([
    q(`SELECT DISTINCT ON (symbol) symbol, t, close, rsi14, ema5, ema9, ema21, quote_volume FROM ${TABLE} ORDER BY symbol, t DESC`),
    q(`SELECT symbol, count(*)::int AS n FROM ${TABLE} GROUP BY symbol`),
  ]);
  const n = Object.fromEntries(counts.map((r) => [r.symbol, r.n]));
  return {
    connected: true,
    interval: '4h',
    keepDays: KEEP_DAYS,
    legacyBytes: Number(legacy?.bytes || 0),
    candles: Number(tot.candles),
    coins: tot.coins,
    first: tot.first,
    last: tot.last,
    bytes: Number(tot.bytes),
    latest: latest.map((r) => ({
      symbol: r.symbol,
      t: r.t,
      close: r.close,
      rsi14: r.rsi14,
      ema5: r.ema5,
      ema9: r.ema9,
      ema21: r.ema21,
      quoteVolume: r.quote_volume,
      count: n[r.symbol] || 0,
    })),
  };
}

const SCAN_LIMIT = 1000;
const finite = (v, name, { min = -Infinity, max = Infinity } = {}) => {
  const n = Number(v);
  if (v === '' || v == null || !Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${name} must be a number${Number.isFinite(min) ? ` from ${min}` : ''}${Number.isFinite(max) ? ` to ${max}` : ''}`);
  return n;
};

/**
 * Filtered views over the stored candles.
 *   view "rsi-ema":   RSI 14 > rsi  AND  EMA 5 ÷ EMA 9 > ratio
 *   view "close-open": close ÷ open > ratio
 * scope "latest" = each coin's latest stored hour; "all" = any hour in the 3 months (newest first).
 */
export async function scanCandles({ view, rsi, ratio, scope = 'latest' }) {
  const params = [];
  let where;
  if (view === 'rsi-ema') {
    params.push(finite(rsi, 'RSI', { min: 0, max: 100 }), finite(ratio, 'EMA 5 / EMA 9', { min: 0, max: 100 }));
    where = 'rsi14 > $1 AND ema9 > 0 AND ema5::float8 / ema9::float8 > $2';
  } else if (view === 'close-open') {
    params.push(finite(ratio, 'Close / Open', { min: 0, max: 1000 }));
    where = 'open > 0 AND close::float8 / open::float8 > $1';
  } else {
    throw new HttpError(400, 'view must be "rsi-ema" or "close-open"');
  }
  const from = scope === 'all' ? TABLE : `(SELECT DISTINCT ON (symbol) * FROM ${TABLE} ORDER BY symbol, t DESC) AS latest`;
  const cols = `symbol, t, open, high, low, close, quote_volume, rsi14, ema5, ema9, ema21,
                CASE WHEN open > 0 THEN close::float8 / open::float8 END AS co,
                CASE WHEN ema9 > 0 THEN ema5::float8 / ema9::float8 END AS er`;
  const [rows, [{ n }]] = await Promise.all([
    q(`SELECT ${cols} FROM ${from} WHERE ${where} ORDER BY t DESC, symbol LIMIT ${SCAN_LIMIT}`, params),
    q(`SELECT count(*)::int AS n FROM ${from} WHERE ${where}`, params),
  ]);
  return {
    total: n,
    limit: SCAN_LIMIT,
    rows: rows.map((r) => ({
      symbol: r.symbol,
      t: r.t,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      quoteVolume: r.quote_volume,
      rsi14: r.rsi14,
      ema5: r.ema5,
      ema9: r.ema9,
      ema21: r.ema21,
      closeOpen: r.co,
      emaRatio: r.er,
    })),
  };
}

/** Every stored candle for one coin, oldest first. */
export async function coinCandles(symbol) {
  if (!SYMBOL_RE.test(symbol)) throw new HttpError(400, 'Pick a USDT symbol, e.g. BTCUSDT');
  const rows = await q(
    `SELECT t, open, high, low, close, volume, quote_volume, rsi14, ema5, ema9, ema21 FROM ${TABLE} WHERE symbol = $1 ORDER BY t`,
    [symbol]
  );
  return rows.map((r) => ({
    t: r.t,
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: r.volume,
    quoteVolume: r.quote_volume,
    rsi14: r.rsi14,
    ema5: r.ema5,
    ema9: r.ema9,
    ema21: r.ema21,
  }));
}

/** Delete the old hourly table (from before the switch to 4-hour candles). */
export async function deleteHourlyCandles() {
  need();
  await pg.query(`DROP TABLE IF EXISTS ${LEGACY_TABLE}`);
  return { deleted: true };
}

/** Delete all stored candles (the table is dropped; it comes back on the next fetch). */
export async function deleteAllCandles() {
  need();
  await pg.query(`DROP TABLE IF EXISTS ${TABLE}`);
  await pg.query(`DROP TABLE IF EXISTS ${LEGACY_TABLE}`);
  return { deleted: true };
}
