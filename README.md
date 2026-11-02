# Stock Hits — React app with a webhook and a JSON-file database

A Vite + React dashboard plus two Vercel serverless functions:

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/webhook` | `POST` | Third-party apps send stock hits here |
| `/api/webhook` | `GET` | Health check / example payload |
| `/api/stocks` | `GET` | Read the `stocks` table (`?symbol=`, `?since=`, `?limit=`) |

## The database

Each table is a JSON file containing an array of rows. The `stocks` table:

| Column | Type | Notes |
|---|---|---|
| `StockID` | string | Optional in the webhook; a UUID is generated if missing |
| `HitTime` | ISO 8601 (UTC) | Optional; defaults to the time the hit arrives. Accepts ISO strings or Unix seconds/ms |
| `StockSymbol` | string | Required; stored uppercase (`M&M`, `BAJAJ-AUTO`, `NSE:TCS` are fine) |
| `PotentialProfit` | number | Required; numeric strings like `"1,250.5"` are accepted |

Where the JSON file lives:

- **Locally:** `data/stocks.json`
- **On Vercel:** `db/stocks.json` in a private **Vercel Blob** store

Vercel's serverless filesystem is read-only and reset between requests, so a file in the repo can't be written to in production. Blob stores the same JSON file durably. Writes use ETag-conditional updates, so simultaneous webhook hits never overwrite each other.

To add another table, call `readTable('name')` / `updateTable('name', rows => …)` from `lib/db.js`; it becomes `data/name.json` (or `db/name.json` in Blob).

## Pages

Left menu (collapsible; a drawer on phones), grouped by market — **NSE Market** and **Crypto**; each section has tabs at the top of the page:

| Section | Tabs | Address |
|---|---|---|
| **Signals** | Hits · First Hit · Screener · Webhook setup | `#/signals/hits`, `#/signals/firsthit`, `#/signals/screener`, `#/signals/setup` |
| **Market** | Watchlist · Positions · Orders · Dhan connection | `#/market/watchlist`, `#/market/positions`, `#/market/orders`, `#/market/connection` |
| **Trades** | All trades · With notes | `#/trades/all`, `#/trades/notes` |
| **Crypto › Coins** | Watchlist · Chart | `#/crypto/watchlist`, `#/crypto/chart?s=BTCUSDT` |
| **Crypto › Big Movers** | History | `#/movers/history` |
| **Paper Trading** | Overview · Reports · Fills | `#/paper/overview`, `#/paper/reports`, `#/paper/trades` |

Older links (`#/`, `#/screener`, `#/ticker`, `#/pnl`) redirect to the matching page.

- **Hits** — every webhook hit, summary tiles, filters (HitTime, time window, scan), delete by date range or all.
- **First Hit** — each stock’s first hit of the day (Today by default, or any day / all days), with hits later that day and other scans that picked it.
- **Add to Ticker** (Hits, First Hit, Screener) — adds the stock to the Market watchlist by its NSE symbol (`POST /api/ticker {action:"add-symbol"}`); asks for the webhook secret once if this device hasn't saved it.
- **Buy / Sell at a price** (First Hit, **B** / **S**) — a popup to set the price and quantity; the stock is added to the Ticker and the order waits until the price reaches your level, then a paper **Equity Intraday** trade is placed at the live price. See *Trigger orders* below.
- **Screener** — one row per stock across all hits; filter by period, scan and minimum hits; CSV export.
- **Webhook setup** — Chartink URL builder, webhook endpoint details, test form.
- **Watchlist** — live Dhan prices, 3/5-minute candle charts with EMA crossover, paper Buy / Sell.
- **Positions** — open paper positions with live P&L and Exit.
- **Orders** — trigger orders waiting for their price (with Cancel), and what filled, failed or expired.
- **Dhan connection** — paste / renew the Dhan access token.
- **Trades** — your trading journal: each trade from entry to exit (adding and partial exits included) with entry/exit time and average price, time held, net P&L after brokerage, P&L % (hover for the return on margin), and your notes. Filter by period, trade type and result; 20/50/100 per page; search finds notes too; CSV export includes notes. Notes are stored in `trade_journal` (`GET /api/ticker?action=journal`, `POST {action:"journal-note", id, note}`).
- **Overview / Reports / Fills** — paper account, P&L by trade type, daily and weekly reports, trade history.

## Ticker and Dhan

- Uses Dhan's Quote API (`/v2/marketfeed/quote`, 1 request/second, up to 1000 instruments) through `/api/ticker`, so your Dhan token never reaches the browser. Dhan's WebSocket feed can't be used because Vercel functions can't hold a connection open.
- Paste your access token in **Dhan connection** on the Ticker page (web.dhan.co → My Profile → Access DhanHQ APIs). It's checked against `/v2/profile` and stored in your private Blob store. Tokens last 24 h; in its last hour the app renews it automatically (`/v2/RenewToken`) while the page is in use. Alternatively set `DHAN_CLIENT_ID` and `DHAN_ACCESS_TOKEN` in Vercel.
- Instruments come from Dhan's public scrip master CSV (NSE/BSE equity, indices, and live NSE/BSE F&O contracts), cached once a day. The first search of the day takes a few seconds while it downloads.
- `DHAN_MOCK=1` runs the page on simulated prices for testing.

## Trigger orders (Buy / Sell at your price)

- Always **Equity Intraday** (4× leverage, 0.025% brokerage per side), NSE/BSE stocks only.
- Direction comes from the price when you place the order: below your price → fills when the price **rises** to it; above → fills when it **falls** to it. The fill is at the live price at that moment (like a stop-market order), so it can be a little past your price.
- Valid until 3:30 PM IST of the current session (placed after the close or on a weekend → the next weekday's session). Unfilled orders become **Expired**.
- Paper funds are checked when you place the order and again when it fills; if they've run out it's marked **Not placed**.
- Checked only during market hours: on every price refresh of the Market pages, and every ~10 s from any other page of the app (the secret must be remembered on that device).
- With every tab closed, nothing checks prices unless you add a scheduler. Free option: [cron-job.org](https://cron-job.org) → new cron job → URL `https://YOUR-APP.vercel.app/api/ticker?action=check-orders&secret=YOUR_SECRET`, every 1 minute, Mon–Fri. Each call checks waiting orders once.
- Stored in `paper_orders`. Resetting the paper account cancels waiting orders.
- Testing outside market hours: set `PAPER_ORDERS_IGNORE_HOURS=1` (with `DHAN_MOCK=1` locally) so orders trigger any time.

## Crypto (Binance)

- **Watchlist** — your coins (Binance spot, USDT pairs) with live price, 24 h change and volume, and readings on hourly or daily candles (switch at the top): **RSI** (Overbought ≥ 70 / Oversold ≤ 30), **EMA trend** (fast vs slow, with "crossed N h ago" for recent crossovers) and **Bollinger** position (%B meter, or Above upper / Below lower). Add coins with the search box (all USDT pairs, biggest volume first). Click a row for its chart. The list starts with BTC, ETH, SOL, BNB, XRP and is saved on the server (`crypto_watchlist`).
- **Chart** — 1-hour (≈ 4 months, 3,000 candles) or 1-day (≈ 2¾ years, 1,000 candles) candles with volume, **EMA** fast/slow lines with Bull/Bear crossover markers, **Bollinger Bands** (upper / middle / lower) and an **RSI** panel with 70 / 50 / 30 lines. Each indicator can be switched off and its settings changed (saved on this device). The current candle moves live.
- Indicators are calculated in the app with TradingView's default formulas (EMA seeded with an SMA, Wilder's RSI, Bollinger with population standard deviation), so values match TradingView closely.
- Prices come straight from Binance's free public market data (`data-api.binance.vision`, no API key) and live WebSocket streams, in your browser. If a stream can't connect, the page refreshes every 10 s instead. If your network blocks Binance completely, the page falls back to `/api/crypto?action=binance` on your server; Binance blocks some US servers, so if that fallback fails on Vercel set **Settings → Functions → Function Region** to Mumbai (`bom1`).
- Crypto pages don't read or write Blob except to load / change the coin list.

### Big Movers (history)

- A one-time look back (1, 3 or 6 months) over the **daily candles of every Binance USDT coin**, listing each completed day where **close ÷ open ≥ 1.4** (changeable). Click **Run scan**; your browser fetches one request per coin straight from Binance (≈ 1 minute, with a progress bar and Cancel), and the result is saved on the server (`crypto_movers_history`, one write per run). **Run again** to refresh it.
- Each day shows open → close, high ÷ open, volume, and what happened next: next day's close, the close 7 days later, and the best price within 7 days (all vs the big day's close). The tiles show averages and how often the coin rose afterwards. Filter by coin or a higher ratio, sort any column, export CSV, add a coin to the watchlist, or open its chart.
- Only coins trading on Binance today are included (coins delisted since aren't).

### Daily mover scan (automatic)

- Checks **every Binance USDT spot pair** (leveraged UP/DOWN tokens excluded) and adds any coin whose **daily candle is up ≥ N %** (default 40 %: close ≥ 1.40 × open, using the live price for today's candle) to the crypto watchlist. Binance's day starts 00:00 UTC = 5:30 AM IST.
- Each coin is added at most once per day; if you remove it, it isn't re-added that day. Coins found are listed under **Daily mover scan** on Crypto › Coins, and tagged "Auto +62%" in the watchlist. The list holds at most 100 coins; extra finds are logged as "List full".
- **Run it 24/7** with a free scheduler (cron-job.org), every 15 minutes:
  `https://YOUR-APP.vercel.app/api/crypto?action=scan&minPct=40&secret=YOUR_SECRET`
  Change `minPct` to change the threshold. **Scan now** on the page runs it immediately.
- Uses Binance's trading-day ticker (100 coins per request, ~5 requests per run). Blob is only touched when a coin qualifies for the first time that day.
- `vercel.json` sets the function region to **Mumbai (`bom1`)**: Binance blocks requests from US servers, which is Vercel's default. (Mumbai is also next to Dhan.)

## Stop loss / take profit (on the chart)

- Open a chart for an instrument you hold (Watchlist chart button, or **Positions → Set SL / TP on chart**).
- Click **+ Stop loss** / **+ Take profit**: a level is placed 1% / 2% away from the price. **Drag the dashed line** on the chart and drop it where you want; it's saved when you let go. You can also type the price in the box above the chart, or remove it with ×.
- Each line shows the P&L of the whole position if it exits there. The dotted grey line is your average entry.
- When the price reaches a level, the app closes the **whole open position** at the live price (as a paper trade), during market hours, using the same checking as trigger orders (open app pages, or the cron-job.org scheduler).
- One-cancels-other: when one fills, or you exit the position yourself, the other is removed. Levels don't expire while the position is open.
- Rules: for a long (bought) position the stop loss must be below the current price and the take profit above it; reversed for a short. A level on the wrong side is rejected and the line snaps back.
- API: `POST /api/ticker {action:"set-exit", key, kind:"SL"|"TP", price}` (`price: null` removes it). Stored with the orders in `paper_orders`.

## Chartink (premium alerts → webhook)

Chartink payloads are detected automatically. In the Chartink alert, set **Webhook URL** to:

```
https://YOUR-APP.vercel.app/api/webhook?secret=YOUR_SECRET&target=5
```

The dashboard's **Connect Chartink** panel builds this URL for you. Chartink can't send custom headers, so the secret goes in the URL.

What happens to each alert:

| Chartink field | Becomes |
|---|---|
| `stocks` (comma-separated) | one row per stock → `StockSymbol` |
| `trigger_prices` | `TriggerPrice` (extra column) |
| `triggered_at` ("2:34 pm", Indian time, no date) | `HitTime` on today's IST date, stored as UTC |
| `scan_name` | `ScanName` (extra column) |
| — | `StockID` = `CK-` + hash of scan + symbol + time, so a resent alert isn't stored twice |
| — | `PotentialProfit` = trigger price × `target` % (₹ per share) |

`target` can differ per alert (each alert has its own URL). Without it, `CHARTINK_TARGET_PCT` is used, then 5%.

If you add a result column to the alert payload named `potential_profit`, its values are used for `PotentialProfit` instead of the target %.

A symbol the app can't read is skipped; the rest of the alert is still stored. The last 200 raw Chartink payloads are kept in `webhook_log` — view them at `/api/log?secret=YOUR_SECRET` to see exactly what Chartink sent.

## Webhook payload (any other app)

```bash
curl -X POST https://YOUR-APP.vercel.app/api/webhook \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: YOUR_SECRET" \
  -d '{"StockSymbol":"RELIANCE","PotentialProfit":125.5,"HitTime":"2026-10-21T09:15:00+05:30"}'
```

Accepted body shapes: one object, an array of objects, or `{ "records": [ ... ] }` (up to 500 per request). Key names are case/underscore-insensitive (`stock_symbol`, `stockSymbol` both work). `Content-Type: text/plain` with a JSON body also works.

Responses:

- `201` — `{ ok: true, inserted, duplicates, records }`
- `200` — every record was a duplicate (same `StockID` + `HitTime` already stored, i.e. a retry)
- `401` — missing/wrong secret
- `422` — validation failed; nothing stored. `invalid` lists each bad record and why
- `503` — no Blob store connected on Vercel

### Sign-in (dashboard)

Set **`APP_PASSWORD`** in Vercel → Settings → Environment Variables (all environments) and redeploy. From then on:

- The site shows only a **Sign in** page until you enter the password; no data is loaded or returned without it (`/api/stocks` included).
- Signing in sets a private cookie (HttpOnly, SameSite=Lax, Secure) for 12 hours, or **30 days** with "Keep me signed in". **Sign out** is at the bottom of the menu. Changing `APP_PASSWORD` or `WEBHOOK_SECRET` signs everyone out.
- While signed in, pages no longer ask for the webhook secret.
- 8 wrong passwords from one IP → locked for 15 minutes.
- Chartink, cron-job.org and anything else using `?secret=` / `X-Webhook-Secret` keep working unchanged.
- Search engines are told not to index the site (`robots.txt`, `noindex` meta tag and `X-Robots-Tag` header).

Without `APP_PASSWORD` the app works as before (the menu shows "Sign-in is off").

### Securing it

Set `WEBHOOK_SECRET`. Callers then pass it as any of:

- header `X-Webhook-Secret: <secret>`
- header `Authorization: Bearer <secret>`
- query string `https://YOUR-APP.vercel.app/api/webhook?secret=<secret>` — for tools that can't set headers

## Run locally

```bash
npm install
npm run dev          # http://localhost:5173 — dashboard + /api routes, data in data/stocks.json
```

Optional: copy `.env.example` to `.env.local` and set `WEBHOOK_SECRET`.

## Deploy to Vercel

1. Push this folder to a GitHub repo.
2. In Vercel: **Add New → Project**, import the repo. The Vite preset is detected automatically; keep the defaults.
3. In the project: **Storage → Create Database → Blob**, choose **Private**, and connect it to the project (all environments). This adds `BLOB_STORE_ID` automatically.
4. **Settings → Environment Variables:** add `WEBHOOK_SECRET` (recommended).
5. **Deployments → Redeploy** so the new variables take effect.
6. Give your third-party app: `https://YOUR-APP.vercel.app/api/webhook`

Or with the CLI: `npm i -g vercel && vercel` then `vercel --prod`.

**Use the production URL for the webhook.** Preview deployments sit behind Vercel Authentication by default, so outside apps get a 401 login page there.

## Notes and limits

- The dashboard and `/api/stocks` are public by default; anyone with the URL can read the table. Add Vercel password protection or an auth check if that matters.
- One JSON file per table works well up to tens of thousands of rows. Every write rewrites the whole file, so for very high volume (many hits per second, sustained) move to a real database such as Postgres or Redis from the Vercel Marketplace.
- `data/stocks.json` in the repo is only the local dev copy; it is not uploaded to Blob.

## Project layout

```
api/webhook.js     POST endpoint for third-party apps
api/stocks.js      GET endpoint used by the dashboard
api/log.js         GET last raw Chartink payloads (secret required)
api/delete.js      POST delete rows (all / date range, secret required)
api/auth.js        sign in / out (APP_PASSWORD)
api/crypto.js      Crypto: coin list + Binance fallback proxy
api/ticker.js      Ticker page: Dhan connection, instrument search, watchlist, quotes
lib/dhan.js        Dhan client: token, instrument list, quotes
lib/paper.js       paper trades, positions, daily/weekly P&L
lib/journal.js     fills → complete trades (entry → exit) + journal notes
lib/cryptoscan.js  daily mover scan (Binance) → crypto watchlist
lib/orders.js      trigger orders: create, cancel, expire, fill when the price is reached
lib/chartink.js    Chartink alert → stocks rows
lib/db.js          JSON-file database (local files or Vercel Blob)
lib/stocks.js      stocks table schema + validation
lib/http.js        CORS, body parsing, secret / session check, errors
lib/auth.js        sign-in session cookie, wrong-password limit
src/App.jsx        Hits page + tabs
src/Screener.jsx   Screener page (one row per stock)
src/Ticker.jsx     Ticker page (live Dhan prices, Buy/Sell, positions)
src/Chart.jsx      3 / 5-minute candle chart
src/candles.js     builds 3 / 5-minute candles from 1-minute data
src/Pnl.jsx        P&L reports page
src/Journal.jsx    Trades page (journal)
src/Crypto.jsx     Crypto watchlist + chart
src/Movers.jsx     Big Movers history (one-time scan of past daily candles)
src/binance.js     Binance market data (REST + live streams) in the browser
src/indicators.js  EMA, RSI, Bollinger Bands
src/Orders.jsx     Buy/Sell-at-price popup and the Orders table
src/FirstHits.jsx  First Hit tab
src/AddToTicker.jsx  "+ Ticker" and B / S buttons on the Signals pages
data/stocks.json   local table file
vite.config.js     runs /api routes inside `npm run dev`
```
