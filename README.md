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

- **Hits** (`/#/`) — every webhook hit as it arrives, summary tiles, Chartink setup panel, test form.
- **Screener** (`/#/screener`) — one row per stock across all stored hits: hit count, first/last hit, last trigger price, % move since first hit, latest and best potential profit, and which scans picked it. Filter by period (today / 7 / 30 days / all), scan and minimum hits; sort any column; click a stock to see its full hit history; export the current view as CSV.

Both pages refresh every 10 seconds while auto-refresh is on.

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
lib/chartink.js    Chartink alert → stocks rows
lib/db.js          JSON-file database (local files or Vercel Blob)
lib/stocks.js      stocks table schema + validation
lib/http.js        CORS, body parsing, secret check, errors
src/App.jsx        Hits page + tabs
src/Screener.jsx   Screener page (one row per stock)
data/stocks.json   local table file
vite.config.js     runs /api routes inside `npm run dev`
```
