// Hourly candle store for Binance USDT perpetuals (Neon Postgres).
//
// One row per coin per hour, with the hourly indicators computed in the
// browser when the data was fetched (RSI 14, EMA 5 / 9 / 21). Kept as a
// rolling window: rows older than KEEP_DAYS are removed on every save.
//
// Needs DATABASE_URL (Neon connected in Vercel); works whether the rest of
// the app still uses Blob or already uses Postgres.
import { databaseUrl, pg } from './db.js';
import { HttpError } from './http.js';

export const KEEP_DAYS = 92; // ≈ 3 months
const TABLE = 'candles_1h';
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
    if (!SYMBOL_RE.test(symbol) || t == null || t < cutoff || t > Date.now() + 3_600_000 || ohlc.some((v) => v == null)) {
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
  const [latest, counts] = await Promise.all([
    q(`SELECT DISTINCT ON (symbol) symbol, t, close, rsi14, ema5, ema9, ema21, quote_volume FROM ${TABLE} ORDER BY symbol, t DESC`),
    q(`SELECT symbol, count(*)::int AS n FROM ${TABLE} GROUP BY symbol`),
  ]);
  const n = Object.fromEntries(counts.map((r) => [r.symbol, r.n]));
  return {
    connected: true,
    keepDays: KEEP_DAYS,
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

/** Delete all stored candles (the table is dropped; it comes back on the next fetch). */
export async function deleteAllCandles() {
  need();
  await pg.query(`DROP TABLE IF EXISTS ${TABLE}`);
  return { deleted: true };
}
