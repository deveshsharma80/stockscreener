#!/usr/bin/env node
// Stock Hits — history data on the Vultr server (Node 22, no npm packages).
//
//   node history.mjs universe [minVolume=1000000] [days=20]
//       For every stock in mis_5x.csv (Dhan's 5× intraday list): last ~100 days of daily
//       candles from Dhan → average daily volume and turnover over the last `days`
//       sessions. Stocks above minVolume → universe.json (+ universe.csv to look at).
//   node history.mjs download [months=12]
//       1-minute candles for every stock in universe.json, `months` back, 85 days per
//       request. Already-downloaded ranges are skipped, so it can be stopped and re-run.
//   node history.mjs update
//       Adds the days since the last download (run every weekday at 16:05 by a timer).
//   node history.mjs status
//   node history.mjs serve
//       Scan service on 127.0.0.1:9020 (Caddy: https://feed.<domain>/history/…) — runs your
//       Scanners and Back Tests over the saved history. Same token as the live price stream.
//
// Files (DATA_DIR, default /var/lib/stockhits/history):
//   universe-all.json   every stock with its volume numbers
//   universe.json       the stocks that passed the filter
//   universe.csv        the same, for Excel
//   1m/<SYMBOL>/<YYYY-MM>.json.gz   {"t":[epoch s…],"o":[…],"h":[…],"l":[…],"c":[…],"v":[…]}
//   1m/<SYMBOL>/meta.json          { securityId, from, to }
//   status.json         the running / last job
//
// The Dhan token comes from the app (GET /api/ticker?action=nse-feed with FEED_SECRET),
// exactly like the live feed. Read-only: no orders.
import { createHmac, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';

// shared rules from the app: next to this file on the server (src/…), ../../src in the repo
const HERE = path.dirname(new URL(import.meta.url).pathname);
const SRC = fs.existsSync(path.join(HERE, 'src', 'scanner', 'engine.js')) ? path.join(HERE, 'src') : path.join(HERE, '..', '..', 'src');
const engine = await import(path.join(SRC, 'scanner', 'engine.js'));
const ema = await import(path.join(SRC, 'emasetup.js'));
const bbs = await import(path.join(SRC, 'strategies', 'bbBreakout.js'));
const rbs = await import(path.join(SRC, 'strategies', 'rangeBreakout.js'));

loadEnv('/etc/stockhits/feed.env');
const APP = (process.env.APP_URL || 'https://devtradingapp.com').replace(/\/$/, '');
const FEED_SECRET = process.env.FEED_SECRET || '';
const DATA = process.env.HISTORY_DIR || '/var/lib/stockhits/history';
const LIST = process.env.MIS_LIST || path.join(path.dirname(new URL(import.meta.url).pathname), 'mis_5x.csv');
const DHAN = process.env.DHAN_API || 'https://api.dhan.co/v2';
const SCRIP_MASTER = process.env.SCRIP_MASTER_URL || 'https://images.dhan.co/api-data/api-scrip-master.csv';
const GAP_MS = Number(process.env.HISTORY_GAP_MS || 1100); // ≈ 1 request a second
const RETRY_MS = [5000, 10000, 20000, 40000, 60000];
const CHUNK_DAYS = 85; // Dhan allows 90 days of minute data a request
const IST = 330 * 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const istDate = (ms = Date.now()) => new Date(ms + IST).toISOString().slice(0, 10);
const istHHMM = (ms = Date.now()) => new Date(ms + IST).toISOString().slice(11, 16);
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const log = (...a) => console.log(`[${new Date(Date.now() + IST).toISOString().slice(0, 19).replace('T', ' ')} IST]`, ...a);

function loadEnv(file) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (m && process.env[m[1]] == null) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    /* running elsewhere: use the environment */
  }
}

// ------------------------------------------------------------------ files

fs.mkdirSync(path.join(DATA, '1m'), { recursive: true });
const writeJson = (f, v) => {
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v));
  fs.renameSync(tmp, f);
};
const readJson = (f, def = null) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return def;
  }
};
const readGz = (f) => {
  try {
    return JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString());
  } catch {
    return null;
  }
};
const writeGz = (f, v) => {
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, zlib.gzipSync(JSON.stringify(v)));
  fs.renameSync(tmp, f);
};

let status = { job: null };
const setStatus = (patch) => {
  status = { ...status, ...patch, updatedAt: new Date().toISOString() };
  writeJson(path.join(DATA, 'status.json'), status);
};

function lock(job) {
  const f = path.join(DATA, 'job.lock');
  const cur = readJson(f);
  if (cur && cur.pid !== process.pid) {
    try {
      process.kill(cur.pid, 0);
      console.error(`Another job is running: ${cur.job} (pid ${cur.pid}). Wait for it, or stop it with: sudo systemctl stop stockdata-*`);
      process.exit(1);
    } catch {
      /* stale lock */
    }
  }
  writeJson(f, { pid: process.pid, job, at: new Date().toISOString() });
  const release = () => {
    try {
      fs.unlinkSync(f);
    } catch {
      /* gone */
    }
  };
  process.on('exit', release);
  process.on('SIGINT', () => process.exit(130));
  process.on('SIGTERM', () => process.exit(143));
}

// ------------------------------------------------------------------ Dhan

let creds = null;
async function getCreds(fresh = false) {
  if (creds && !fresh) return creds;
  if (!FEED_SECRET) throw new Error('FEED_SECRET missing in /etc/stockhits/feed.env');
  const r = await fetch(`${APP}/api/ticker?action=nse-feed`, { headers: { 'x-feed-secret': FEED_SECRET }, signal: AbortSignal.timeout(30_000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.dhan?.accessToken) throw new Error(`Could not get the Dhan token from the app: HTTP ${r.status} ${j.error || ''}`);
  creds = j.dhan;
  return creds;
}

let lastCall = 0;
async function dhan(p, body) {
  for (let attempt = 0; ; attempt++) {
    const wait = lastCall + GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    const c = await getCreds();
    let res;
    let text = '';
    try {
      res = await fetch(`${DHAN}${p}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'access-token': c.accessToken, ...(c.clientId ? { 'client-id': c.clientId } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      text = await res.text();
    } catch (e) {
      if (attempt < RETRY_MS.length) {
        log(`network error (${e.message}) — retrying in ${RETRY_MS[attempt] / 1000}s`);
        await sleep(RETRY_MS[attempt]);
        continue;
      }
      throw e;
    }
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    const code = json?.errorCode || json?.data?.errorCode || '';
    if (res.ok && !code) return json?.data && json.data.timestamp ? json.data : json;
    const rate = res.status === 429 || /DH-904/.test(code) || /rate|too many/i.test(text);
    if (rate && attempt < RETRY_MS.length) {
      log(`Dhan says slow down — waiting ${RETRY_MS[attempt] / 1000}s`);
      await sleep(RETRY_MS[attempt]);
      continue;
    }
    if ((res.status === 401 || /DH-901|DH-906/.test(code)) && attempt === 0) {
      log('token rejected — asking the app for the current one');
      await getCreds(true);
      continue;
    }
    // "no data" for a range (holidays, new listing) is not an error
    if (/DH-905|no data/i.test(text)) return { timestamp: [] };
    throw new Error(`Dhan HTTP ${res.status} ${code} ${(json?.errorMessage || text).slice(0, 200)}`);
  }
}

function splitCsv(line) {
  const out = [];
  let f = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') (f += '"'), i++;
      else if (ch === '"') q = false;
      else f += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') out.push(f), (f = '');
    else f += ch;
  }
  out.push(f);
  return out;
}

/** NSE equity trading symbol → security id, from Dhan's instrument file. */
async function nseEquities() {
  const r = await fetch(SCRIP_MASTER, { signal: AbortSignal.timeout(120_000) });
  if (!r.ok) throw new Error(`Could not download Dhan's instrument list (HTTP ${r.status})`);
  const lines = (await r.text()).split(/\r?\n/);
  const head = splitCsv(lines[0]).map((h) => h.trim().toUpperCase());
  const col = (n) => head.indexOf(n);
  const C = { exch: col('SEM_EXM_EXCH_ID'), seg: col('SEM_SEGMENT'), id: col('SEM_SMST_SECURITY_ID'), inst: col('SEM_INSTRUMENT_NAME'), sym: col('SEM_TRADING_SYMBOL'), series: col('SEM_SERIES') };
  const map = new Map();
  for (const line of lines.slice(1)) {
    if (!line) continue;
    const f = splitCsv(line);
    if (f[C.exch] !== 'NSE' || f[C.seg] !== 'E' || (f[C.inst] || '').toUpperCase() !== 'EQUITY') continue;
    const sym = (f[C.sym] || '').trim().toUpperCase();
    const series = C.series >= 0 ? (f[C.series] || '').trim().toUpperCase() : 'EQ';
    // prefer the EQ series when a symbol appears twice
    if (!map.has(sym) || series === 'EQ') map.set(sym, { securityId: String(f[C.id]).trim(), series });
  }
  return map;
}

function readList() {
  const rows = fs.readFileSync(LIST, 'utf8').split(/\r?\n/).map(splitCsv);
  const out = [];
  const seen = new Set();
  for (const r of rows) {
    const sym = (r[1] || '').trim().toUpperCase();
    if (!sym || sym === 'SYMBOL' || seen.has(sym)) continue;
    seen.add(sym);
    out.push({ symbol: sym, isin: (r[2] || '').trim(), leverage: (r[3] || '').trim() });
  }
  return out;
}

const arrays = (d) => {
  const t = Array.isArray(d?.timestamp) ? d.timestamp : [];
  return t.map((ts, i) => ({ t: Math.round(Number(ts)), o: +d.open[i], h: +d.high[i], l: +d.low[i], c: +d.close[i], v: +(d.volume?.[i] ?? 0) }));
};

// ------------------------------------------------------------------ universe

async function universe(minVolume = 1_000_000, days = 20) {
  lock('universe');
  const list = readList();
  log(`universe: ${list.length} stocks in ${path.basename(LIST)}; filter = average daily volume over the last ${days} sessions > ${minVolume.toLocaleString('en-IN')}`);
  const eq = await nseEquities();
  const today = istDate();
  const all = [];
  setStatus({ job: 'universe', startedAt: new Date().toISOString(), done: 0, total: list.length, errors: 0, finishedAt: null });
  let errors = 0;
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    const inst = eq.get(s.symbol);
    if (!inst) {
      all.push({ ...s, error: 'not in Dhan’s NSE equity list' });
    } else {
      try {
        const d = await dhan('/charts/historical', { securityId: inst.securityId, exchangeSegment: 'NSE_EQ', instrument: 'EQUITY', expiryCode: 0, oi: false, fromDate: addDays(today, -110), toDate: addDays(today, 1) });
        const c = arrays(d).filter((x) => x.v > 0);
        const last = c.slice(-days);
        const last60 = c.slice(-60);
        const avg = (xs, f) => (xs.length ? xs.reduce((a, x) => a + f(x), 0) / xs.length : 0);
        all.push({
          ...s,
          securityId: inst.securityId,
          sessions: c.length,
          close: c.length ? c[c.length - 1].c : null,
          avgVol: Math.round(avg(last, (x) => x.v)),
          avgVol60: Math.round(avg(last60, (x) => x.v)),
          avgTurnoverCr: Math.round(avg(last, (x) => x.v * x.c) / 1e5) / 100, // ₹ crore
        });
      } catch (e) {
        errors++;
        all.push({ ...s, securityId: inst.securityId, error: e.message.slice(0, 200) });
      }
    }
    if ((i + 1) % 25 === 0 || i + 1 === list.length) {
      log(`universe: ${i + 1}/${list.length}${errors ? ` (${errors} errors)` : ''}`);
      setStatus({ done: i + 1, errors });
    }
  }
  const ok = all.filter((x) => !x.error && x.sessions >= Math.min(days, 5));
  const passed = ok.filter((x) => x.avgVol > minVolume).sort((a, b) => b.avgVol - a.avgVol);
  writeJson(path.join(DATA, 'universe-all.json'), { builtAt: new Date().toISOString(), days, minVolume, stocks: all });
  writeJson(path.join(DATA, 'universe.json'), { builtAt: new Date().toISOString(), days, minVolume, stocks: passed.map(({ symbol, securityId, avgVol, avgTurnoverCr, close }) => ({ symbol, securityId, avgVol, avgTurnoverCr, close })) });
  fs.writeFileSync(path.join(DATA, 'universe.csv'), ['symbol,securityId,close,avgVolume,avgVolume60,avgTurnoverCr', ...passed.map((x) => [x.symbol, x.securityId, x.close, x.avgVol, x.avgVol60, x.avgTurnoverCr].join(','))].join('\n'));
  const count = (v) => ok.filter((x) => x.avgVol > v).length;
  setStatus({ job: 'universe', finishedAt: new Date().toISOString(), passed: passed.length });
  log(`universe done: ${list.length} listed · ${ok.length} with data · ${all.filter((x) => x.error).length} not found / errors`);
  log(`average volume > 5 L: ${count(5e5)} · > 10 L (1 M): ${count(1e6)} · > 20 L: ${count(2e6)} · > 50 L: ${count(5e6)}`);
  log(`PASSED (> ${minVolume.toLocaleString('en-IN')}): ${passed.length} stocks → ${path.join(DATA, 'universe.json')}`);
  const missing = all.filter((x) => x.error).map((x) => `${x.symbol} (${x.error})`);
  if (missing.length) log(`not used: ${missing.slice(0, 40).join(', ')}${missing.length > 40 ? ` … +${missing.length - 40}` : ''}`);
}

// ------------------------------------------------------------------ 1-minute history

const symDir = (s) => path.join(DATA, '1m', s.replace(/[^A-Z0-9&_-]/gi, '_'));

function saveCandles(symbol, candles) {
  const byMonth = new Map();
  for (const c of candles) {
    const m = istDate(c.t * 1000).slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(c);
  }
  const dir = symDir(symbol);
  fs.mkdirSync(dir, { recursive: true });
  for (const [m, list] of byMonth) {
    const f = path.join(dir, `${m}.json.gz`);
    const old = readGz(f);
    const merged = new Map();
    if (old?.t) old.t.forEach((t, i) => merged.set(t, { t, o: old.o[i], h: old.h[i], l: old.l[i], c: old.c[i], v: old.v[i] }));
    for (const c of list) merged.set(c.t, c);
    const rows = [...merged.values()].sort((a, b) => a.t - b.t);
    writeGz(f, { t: rows.map((x) => x.t), o: rows.map((x) => x.o), h: rows.map((x) => x.h), l: rows.map((x) => x.l), c: rows.map((x) => x.c), v: rows.map((x) => x.v) });
  }
}

/** Last day with complete data: today after 15:35, else yesterday. */
const lastFullDay = () => (istHHMM() >= '15:35' ? istDate() : addDays(istDate(), -1));

async function download(months = 12, { updateOnly = false } = {}) {
  lock(updateOnly ? 'update' : 'download');
  const uni = readJson(path.join(DATA, 'universe.json'));
  if (!uni?.stocks?.length) throw new Error('No universe yet — run:  stockdata universe');
  const end = lastFullDay();
  const want = addDays(end, -Math.round(months * 30.44));
  const stocks = uni.stocks;
  log(`${updateOnly ? 'update' : 'download'}: ${stocks.length} stocks · ${updateOnly ? 'new days up to' : `${want} → `} ${end} · 1-minute candles`);
  setStatus({ job: updateOnly ? 'update' : 'download', startedAt: new Date().toISOString(), done: 0, total: stocks.length, errors: 0, candles: 0, finishedAt: null, range: [want, end] });
  let errors = 0;
  let total = 0;
  for (let i = 0; i < stocks.length; i++) {
    const s = stocks[i];
    const metaF = path.join(symDir(s.symbol), 'meta.json');
    const meta = readJson(metaF) || {};
    // ranges still missing: before what we have, and after it
    const ranges = [];
    if (!meta.from || !meta.to) {
      if (!updateOnly) ranges.push([want, end]);
    } else {
      if (!updateOnly && want < meta.from) ranges.push([want, addDays(meta.from, -1)]);
      if (meta.to < end) ranges.push([addDays(meta.to, 1), end]);
    }
    let got = 0;
    try {
      for (const [a, b] of ranges) {
        for (let from = a; from <= b; from = addDays(from, CHUNK_DAYS)) {
          const to = addDays(from, CHUNK_DAYS - 1) < b ? addDays(from, CHUNK_DAYS - 1) : b;
          const d = await dhan('/charts/intraday', { securityId: String(s.securityId), exchangeSegment: 'NSE_EQ', instrument: 'EQUITY', interval: '1', oi: false, fromDate: `${from} 09:00:00`, toDate: `${to} 15:31:00` });
          const c = arrays(d);
          if (c.length) saveCandles(s.symbol, c);
          got += c.length;
        }
      }
      if (ranges.length) {
        const from = !meta.from ? want : !updateOnly && want < meta.from ? want : meta.from;
        writeJson(metaF, { symbol: s.symbol, securityId: s.securityId, from, to: end, updatedAt: new Date().toISOString() });
      }
    } catch (e) {
      errors++;
      log(`${s.symbol}: ${e.message}`);
    }
    total += got;
    if ((i + 1) % 10 === 0 || i + 1 === stocks.length) {
      log(`${i + 1}/${stocks.length} stocks · ${total.toLocaleString('en-IN')} candles${errors ? ` · ${errors} errors` : ''}`);
      setStatus({ done: i + 1, errors, candles: total });
    }
  }
  setStatus({ finishedAt: new Date().toISOString() });
  log(`done: ${total.toLocaleString('en-IN')} candles saved${errors ? `, ${errors} stocks had errors (run the same command again to retry them)` : ''}`);
}

function showStatus() {
  const st = readJson(path.join(DATA, 'status.json'), {});
  const uni = readJson(path.join(DATA, 'universe.json'));
  let stocks = 0;
  let from = null;
  let to = null;
  let bytes = 0;
  const root = path.join(DATA, '1m');
  for (const d of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    const m = readJson(path.join(root, d, 'meta.json'));
    if (!m) continue;
    stocks++;
    if (!from || m.from < from) from = m.from;
    if (!to || m.to > to) to = m.to;
    for (const f of fs.readdirSync(path.join(root, d))) bytes += fs.statSync(path.join(root, d, f)).size;
  }
  console.log(JSON.stringify({
    lastJob: st,
    universe: uni ? { builtAt: uni.builtAt, minVolume: uni.minVolume, days: uni.days, stocks: uni.stocks.length } : null,
    history: { stocks, from, to, sizeMB: Math.round(bytes / 1e5) / 10 },
  }, null, 2));
}

// ------------------------------------------------------------------ scan service

const PORT = Number(process.env.HISTORY_PORT || 9020);

/** 1-minute candles of one stock between two days (inclusive), oldest first. */
function loadCandles(symbol, from, to) {
  const dir = symDir(symbol);
  const out = [];
  let m = from.slice(0, 7);
  const last = to.slice(0, 7);
  while (m <= last) {
    const j = readGz(path.join(dir, `${m}.json.gz`));
    if (j?.t) for (let i = 0; i < j.t.length; i++) out.push({ t: j.t[i], o: j.o[i], h: j.h[i], l: j.l[i], c: j.c[i], v: j.v[i] });
    const [y, mo] = m.split('-').map(Number);
    m = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
  }
  const lo = Date.parse(`${from}T00:00:00+05:30`) / 1000;
  const hi = Date.parse(`${to}T23:59:59+05:30`) / 1000;
  return out.filter((c) => c.t >= lo && c.t <= hi).sort((a, b) => a.t - b.t);
}

function tokenOk(token) {
  const [exp, sig] = String(token || '').split('.');
  if (!exp || !sig || !(Number(exp) > Date.now()) || !FEED_SECRET) return false;
  const want = createHmac('sha256', FEED_SECRET).update(`stream:${exp}`).digest('base64url');
  return want.length === sig.length && timingSafeEqual(Buffer.from(want), Buffer.from(sig));
}

function universeFor(minTurnoverCr = 0) {
  const all = readJson(path.join(DATA, 'universe-all.json'));
  const uni = readJson(path.join(DATA, 'universe.json'));
  const turn = new Map((all?.stocks || []).map((x) => [x.symbol, x.avgTurnoverCr]));
  return (uni?.stocks || []).filter((s) => fs.existsSync(path.join(symDir(s.symbol), 'meta.json')) && (turn.get(s.symbol) ?? s.avgTurnoverCr ?? 0) >= minTurnoverCr);
}

const toStrat = (cs) => cs.map((c) => ({ time: c.t, open: c.o, high: c.h, low: c.l, close: c.c, volume: c.v }));

/** Scan every stock (and optionally run a strategy on each hit). */
async function scanAll({ scan, from, to, minTurnoverCr = 0, strategy = null, params = {} }) {
  const errs = engine.checkScan(scan);
  if (errs.length) throw Object.assign(new Error(errs.join('; ')), { status: 400 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) throw Object.assign(new Error('Pick a from and to date'), { status: 400 });
  const span = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  if (span > 800) throw Object.assign(new Error('At most about 2 years at a time'), { status: 400 });
  const stocks = universeFor(Number(minTurnoverCr) || 0);
  const warm = Math.max(engine.warmupDays(scan), strategy ? 10 : 0);
  const loadFrom = addDays(from, -Math.ceil(warm * 1.6) - 4);
  const t0 = Date.now();
  const hits = [];
  const rows = [];
  for (const s of stocks) {
    const c1 = loadCandles(s.symbol, loadFrom, to);
    if (!c1.length) continue;
    const found = engine.runScan(scan, c1, { from, to });
    for (const h of found) hits.push({ day: h.day, time: h.time, symbol: s.symbol, close: h.close, values: h.values });
    if (!strategy || !found.length) continue;
    const sc = toStrat(c1);
    const days = [...new Set(found.map((h) => h.day))];
    for (const day of days) {
      const end = Date.parse(`${day}T15:30:00+05:30`);
      const upto = sc.filter((c) => c.time * 1000 < end);
      const c1Day = upto.filter((c) => engine.istDay(c.time) === day);
      const c5 = ema.to5m(upto, end);
      const hit = found.find((h) => h.day === day);
      const base = { day, symbol: s.symbol, key: `NSE_EQ:${s.securityId}`, scanTime: hit.time };
      if (strategy === 'ema-rejection') {
        const setup = ema.evaluate(c5, { day });
        rows.push({ ...base, ...setup, outcome: c1Day.length ? ema.simulate(c1Day, setup) : null });
      } else if (strategy === 'bb-breakout') {
        rows.push({ ...base, ...bbs.runBbBreakout({ c5, c1Day, day, params: { ...params, skipSetup: true } }) });
      } else if (strategy === 'range-breakout') {
        rows.push({ ...base, ...rbs.runRangeBreakout({ c5, c1Day, day, params, at: hit.time }) });
      } else throw Object.assign(new Error(`Unknown strategy ${strategy}`), { status: 400 });
    }
  }
  hits.sort((a, b) => a.day.localeCompare(b.day) || a.time.localeCompare(b.time) || a.symbol.localeCompare(b.symbol));
  return { ok: true, stocks: stocks.length, from, to, hits, rows: strategy ? rows : undefined, ms: Date.now() - t0 };
}

function serve() {
  let busy = Promise.resolve(); // one scan at a time (keeps memory low)
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' };
  const send = (res, code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors });
    res.end(JSON.stringify(obj));
  };
  http
    .createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      if (req.method === 'OPTIONS') return res.writeHead(204, cors), res.end();
      if (!url.pathname.startsWith('/history/')) return send(res, 404, { ok: false, error: 'not found' });
      if (!tokenOk(url.searchParams.get('token'))) return send(res, 401, { ok: false, error: 'bad or expired token — reload the page' });
      if (req.method === 'GET' && url.pathname === '/history/info') {
        const uni = universeFor(0);
        const metas = uni.map((s) => readJson(path.join(symDir(s.symbol), 'meta.json'))).filter(Boolean);
        const all = new Map((readJson(path.join(DATA, 'universe-all.json'))?.stocks || []).map((x) => [x.symbol, x]));
        return send(res, 200, {
          ok: true,
          stocks: uni.length,
          from: metas.reduce((a, m) => (!a || m.from < a ? m.from : a), null),
          to: metas.reduce((a, m) => (!a || m.to > a ? m.to : a), null),
          list: uni.map((s) => ({ symbol: s.symbol, avgVol: s.avgVol, avgTurnoverCr: all.get(s.symbol)?.avgTurnoverCr ?? s.avgTurnoverCr, close: s.close })),
        });
      }
      if (req.method === 'POST' && (url.pathname === '/history/scan' || url.pathname === '/history/backtest')) {
        let body = '';
        req.on('data', (c) => {
          body += c;
          if (body.length > 200_000) req.destroy();
        });
        req.on('end', () => {
          let input;
          try {
            input = JSON.parse(body || '{}');
          } catch {
            return send(res, 400, { ok: false, error: 'bad JSON' });
          }
          if (url.pathname === '/history/scan') input.strategy = null;
          const job = busy.then(() => scanAll(input));
          busy = job.catch(() => {});
          job.then((r) => send(res, 200, r)).catch((e) => send(res, e.status || 500, { ok: false, error: e.message }));
        });
        return;
      }
      send(res, 404, { ok: false, error: 'not found' });
    })
    .listen(PORT, '127.0.0.1', () => log(`scan service on 127.0.0.1:${PORT}`));
}

// ------------------------------------------------------------------ main

const [cmd, a1, a2] = process.argv.slice(2);
try {
  if (cmd === 'universe') await universe(Number(a1) || 1_000_000, Number(a2) || 20);
  else if (cmd === 'download') await download(Number(a1) || 12);
  else if (cmd === 'update') await download(0, { updateOnly: true });
  else if (cmd === 'status') showStatus();
  else if (cmd === 'serve') serve();
  else console.log('usage: history.mjs universe [minVolume] [days] | download [months] | update | status | serve');
} catch (e) {
  log('FAILED:', e.message);
  setStatus({ error: e.message, finishedAt: new Date().toISOString() });
  process.exit(1);
}
