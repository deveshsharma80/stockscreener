// StockHits feed server (runs on the Vultr box, Node 22, no npm packages).
//
// 1) Scheduler — replaces cron-job.org. Calls the app's existing URLs with
//    CRON_SECRET on an India-time clock:
//      nse-check-orders  every minute, Mon–Fri 09:00–15:35   (NSE paper orders, 15:09 square-off)
//      crypto-scan       every hour at :00                    (daily movers ≥ 40 %)
//      bb-scan           01:32 05:32 09:32 13:32 17:32 21:32  (4h Bollinger + RSI)
//      cp-check          safety net: every 6 h, or every 30 min while the watcher is not live
//
// 2) Crypto watcher — follows Binance trades tick by tick for coins that have an
//    open paper position or an "at price" order. When the price reaches an order
//    price, stop loss, take profit or liquidation, it asks the app to check now
//    (cp-check), so the fill happens within a second or two — and Neon is only
//    woken when something actually triggers.
//    It learns the levels from the app: pushed on every change (POST /levels) and
//    pulled at start, after each check, and every 3 hours (cp-levels).
//
// HTTP (127.0.0.1:PORT, published through Caddy as https://feed.<domain>):
//   GET  /health          short public status
//   POST /levels          app → server: current levels (header x-feed-secret)
//   GET  /status          full status            (only from this machine)
//   POST /run/<job>       run a job now           (only from this machine)
import http from 'node:http';

const APP = (process.env.APP_URL || 'https://devtradingapp.com').replace(/\/$/, '');
const CRON_SECRET = process.env.CRON_SECRET || '';
const FEED_SECRET = process.env.FEED_SECRET || '';
const PORT = Number(process.env.PORT || 8080);
const FUT_WS = process.env.BINANCE_FUTURES_WS || 'wss://fstream.binance.com/market/stream?streams=';
const SPOT_WS = process.env.BINANCE_SPOT_WS || 'wss://data-stream.binance.vision/stream?streams=';
const FAPI = 'https://fapi.binance.com';
const started = Date.now();

// ------------------------------------------------------------------ logging & time

const istParts = (d = new Date()) => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(d)
      .map((x) => [x.type, x.value])
  );
  return { wd: p.weekday, h: Number(p.hour), m: Number(p.minute), s: Number(p.second), text: `${p.day}/${p.month} ${p.hour}:${p.minute}:${p.second}` };
};
const log = (...a) => console.log(`[${istParts().text} IST]`, ...a);
const ago = (t) => (t ? Math.round((Date.now() - t) / 1000) : null);

// ------------------------------------------------------------------ calling the app

async function callApp(path, { timeoutMs = 70_000 } = {}) {
  const url = `${APP}${path}${path.includes('?') ? '&' : '?'}secret=${encodeURIComponent(CRON_SECRET)}`;
  const t0 = Date.now();
  try {
    const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'stockhits-feed' }, signal: AbortSignal.timeout(timeoutMs) });
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { ok: r.ok && json?.ok !== false, status: r.status, ms: Date.now() - t0, json, text: text.slice(0, 400) };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, json: null, text: e.message };
  }
}

const summaries = {
  'nse-check-orders': (j) => j && `market ${j.market?.open === false ? 'closed' : j.market?.label || j.market?.status || 'open'}, events ${j.orders?.events?.length ?? 0}, waiting orders ${j.orders?.pending ?? 0}`,
  'crypto-scan': (j) => j && `checked ${j.checked ?? '?'} pairs, ≥${j.minPct}% today: ${(j.matches || []).map((m) => m.symbol).join(' ') || 'none'}, newly added ${j.added?.length ?? 0}`,
  'bb-scan': (j) => j && `checked ${j.checked}/${j.total}, hits ${j.hits}, latest candle ${(j.latestHits || []).map((h) => h.symbol).join(' ') || 'none'}`,
  'cp-check': (j) =>
    j &&
    `positions ${j.checked ?? 0}, orders filled ${j.ordersFilled?.length ?? 0}, failed ${j.ordersFailed?.length ?? 0}, SL/TP ${j.exited?.length ?? 0}, liquidated ${j.liquidated?.length ?? 0}`,
};

// ------------------------------------------------------------------ scheduler

const JOBS = {
  'nse-check-orders': {
    path: '/api/ticker?action=check-orders',
    when: (t) => !['Sat', 'Sun'].includes(t.wd) && t.h * 60 + t.m >= 9 * 60 && t.h * 60 + t.m <= 15 * 60 + 35,
    note: 'every minute, Mon–Fri 09:00–15:35',
  },
  'crypto-scan': { path: '/api/crypto?action=scan&minPct=40', when: (t) => t.m === 0, note: 'hourly at :00' },
  'bb-scan': { path: '/api/crypto?action=bb-scan', when: (t) => t.m === 32 && [1, 5, 9, 13, 17, 21].includes(t.h), note: '01:32 05:32 09:32 13:32 17:32 21:32' },
  'cp-check': {
    path: '/api/crypto?action=cp-check',
    when: (t) => (t.m === 7 && t.h % 6 === 0) || (t.m % 30 === 15 && !watcherHealthy()),
    note: 'every 6 h; every 30 min while the watcher is not live; and whenever a level is reached',
  },
};
const runs = Object.fromEntries(Object.keys(JOBS).map((k) => [k, { last: null, running: false, count: 0, fails: 0 }]));

async function runJob(name, why = 'schedule') {
  const job = JOBS[name];
  const st = runs[name];
  if (!job) return { ok: false, text: `unknown job ${name}` };
  if (st.running) {
    st.again = true;
    return { ok: true, text: 'already running — will run again right after' };
  }
  st.running = true;
  const r = await callApp(job.path);
  st.running = false;
  st.count++;
  if (!r.ok) st.fails++;
  const summary = r.ok ? summaries[name]?.(r.json) || 'ok' : `HTTP ${r.status}: ${r.json?.error || r.text}`;
  st.last = { at: Date.now(), why, ok: r.ok, status: r.status, ms: r.ms, summary };
  log(`${r.ok ? 'OK  ' : 'FAIL'} ${name} (${why}, ${r.ms} ms): ${summary}`);
  if (name === 'cp-check') await afterCheck(r.json);
  if (st.again) {
    st.again = false;
    setTimeout(() => runJob(name, 'again'), 500);
  }
  return { ...st.last };
}

function scheduleNextMinute() {
  const now = Date.now();
  const next = Math.ceil((now + 1) / 60_000) * 60_000 + 2_000; // 2 s past each minute
  setTimeout(() => {
    const t = istParts();
    for (const [name, job] of Object.entries(JOBS)) {
      try {
        if (job.when(t)) runJob(name);
      } catch (e) {
        log('scheduler error', name, e.message);
      }
    }
    if (t.m === 37 && t.h % 3 === 0) pullLevels('every 3 h');
    if (t.h === 3 && t.m === 3) loadPerps();
    scheduleNextMinute();
  }, next - now);
}

// ------------------------------------------------------------------ levels (what to watch)

let levels = { positions: [], orders: [], at: null };
let levelsInfo = { syncedAt: null, via: null, pushes: 0, pulls: 0 };

function setLevels(l, via) {
  levels = {
    positions: Array.isArray(l?.positions) ? l.positions : [],
    orders: Array.isArray(l?.orders) ? l.orders.filter((o) => o.status !== 'filling') : [],
    at: l?.at || new Date().toISOString(),
  };
  levelsInfo = { ...levelsInfo, syncedAt: Date.now(), via, [via === 'push' ? 'pushes' : 'pulls']: levelsInfo[via === 'push' ? 'pushes' : 'pulls'] + 1 };
  const syms = watchedSymbols();
  log(`levels (${via}): ${levels.positions.length} positions, ${levels.orders.length} orders → watching ${syms.join(' ') || 'nothing'}`);
  resubscribe(syms);
}

async function pullLevels(why) {
  const r = await callApp('/api/crypto?action=cp-levels', { timeoutMs: 20_000 });
  if (r.ok && r.json) setLevels(r.json, 'pull');
  else log(`levels pull failed (${why}): HTTP ${r.status} ${r.json?.error || r.text}`);
}

async function afterCheck(json) {
  if (json?.levels) setLevels(json.levels, 'pull');
  else await pullLevels('after check');
}

const watchedSymbols = () => [...new Set([...levels.positions.map((p) => p.symbol), ...levels.orders.map((o) => o.symbol)])].sort();

/** Which levels this price reaches (empty = nothing to do). */
function hitsFor(symbol, price) {
  const out = [];
  for (const p of levels.positions) {
    if (p.symbol !== symbol) continue;
    const long = p.side === 'LONG';
    if (p.liq != null && (long ? price <= p.liq : price >= p.liq)) out.push(`${symbol} liquidation ${p.liq}`);
    else if (p.sl != null && (long ? price <= p.sl : price >= p.sl)) out.push(`${symbol} stop loss ${p.sl}`);
    else if (p.tp != null && (long ? price >= p.tp : price <= p.tp)) out.push(`${symbol} take profit ${p.tp}`);
  }
  for (const o of levels.orders) {
    if (o.symbol !== symbol) continue;
    if (o.cond === 'above' ? price >= o.trigger : price <= o.trigger) out.push(`${symbol} ${o.side === 'BUY' ? 'buy' : 'sell'} order ${o.trigger}`);
  }
  return out;
}

// ------------------------------------------------------------------ Binance watcher

let perps = new Set();
let lastPrice = {};
const sockets = { fut: null, spot: null };
let wsInfo = { state: 'idle', lastMsg: null, since: null, reconnects: 0, url: { fut: '', spot: '' } };
const events = []; // recent triggers, newest first
let lastFire = 0;

async function loadPerps() {
  try {
    const r = await fetch(`${FAPI}/fapi/v1/exchangeInfo`, { signal: AbortSignal.timeout(15_000) });
    const j = await r.json();
    perps = new Set((j.symbols || []).filter((x) => /PERPETUAL$/.test(x.contractType || '') && x.status === 'TRADING').map((x) => x.symbol));
    log(`Binance perpetuals: ${perps.size}`);
  } catch (e) {
    log('could not load Binance perpetuals:', e.message);
  }
}

function watcherHealthy() {
  if (!watchedSymbols().length) return true; // nothing to watch
  return wsInfo.state === 'live' && ago(wsInfo.lastMsg) != null && ago(wsInfo.lastMsg) < 120;
}

function onTick(symbol, price) {
  lastPrice[symbol] = { price, at: Date.now() };
  wsInfo.lastMsg = Date.now();
  if (wsInfo.state !== 'live') {
    wsInfo.state = 'live';
    wsInfo.since = Date.now();
  }
  const hits = hitsFor(symbol, price);
  if (!hits.length) return;
  if (Date.now() - lastFire < 8_000) return; // one check at a time; a check covers every coin
  lastFire = Date.now();
  events.unshift({ at: Date.now(), price, hits });
  events.length = Math.min(events.length, 30);
  log(`HIT at ${price}: ${hits.join(' · ')} → asking the app to check now`);
  runJob('cp-check', `price hit ${symbol}`);
}

let subKey = '';
function resubscribe(symbols) {
  const fut = symbols.filter((s) => perps.has(s) || !perps.size);
  const spot = symbols.filter((s) => perps.size && !perps.has(s));
  const key = `${fut.join(',')}|${spot.join(',')}`;
  if (key === subKey) return;
  subKey = key;
  open('fut', fut, FUT_WS);
  open('spot', spot, SPOT_WS);
  if (!symbols.length) wsInfo.state = 'idle';
}

function open(kind, symbols, base) {
  try {
    sockets[kind]?.close();
  } catch {}
  sockets[kind] = null;
  if (!symbols.length) return;
  const url = base + symbols.map((s) => `${s.toLowerCase()}@aggTrade`).join('/');
  wsInfo.url[kind] = url;
  wsInfo.state = 'connecting';
  const ws = new WebSocket(url);
  sockets[kind] = ws;
  let backoff = 2_000;
  ws.onmessage = (ev) => {
    try {
      const m = JSON.parse(ev.data);
      const d = m.data || m;
      if (d && d.s && d.p) onTick(d.s, Number(d.p));
    } catch {}
  };
  ws.onopen = () => log(`${kind} stream open: ${symbols.join(' ')}`);
  ws.onerror = () => {};
  ws.onclose = () => {
    if (sockets[kind] !== ws) return; // replaced on purpose
    wsInfo.state = 'reconnecting';
    wsInfo.reconnects++;
    log(`${kind} stream closed — reconnecting in ${backoff / 1000}s`);
    setTimeout(() => sockets[kind] === ws && open(kind, symbols, base), backoff);
    backoff = Math.min(backoff * 2, 60_000);
  };
}

// a stream can go quiet without closing (e.g. network change): restart it
setInterval(() => {
  if (!watchedSymbols().length) return;
  if (ago(wsInfo.lastMsg) != null && ago(wsInfo.lastMsg) > 180) {
    log('no prices for 3 min — restarting the streams');
    subKey = '';
    resubscribe(watchedSymbols());
    wsInfo.lastMsg = Date.now();
  }
}, 30_000);

// ------------------------------------------------------------------ HTTP

const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) && !req.headers['x-forwarded-for'];

function status() {
  const t = istParts();
  return {
    ok: true,
    now: `${t.text} IST`,
    uptimeMin: Math.round((Date.now() - started) / 60_000),
    app: APP,
    watcher: {
      state: wsInfo.state,
      healthy: watcherHealthy(),
      watching: watchedSymbols(),
      lastPriceSecondsAgo: ago(wsInfo.lastMsg),
      reconnects: wsInfo.reconnects,
      prices: Object.fromEntries(Object.entries(lastPrice).map(([s, v]) => [s, { price: v.price, secondsAgo: ago(v.at) }])),
    },
    levels: { positions: levels.positions, orders: levels.orders, syncedSecondsAgo: ago(levelsInfo.syncedAt), via: levelsInfo.via, pushes: levelsInfo.pushes, pulls: levelsInfo.pulls },
    jobs: Object.fromEntries(
      Object.entries(JOBS).map(([k, j]) => [
        k,
        { schedule: j.note, runs: runs[k].count, fails: runs[k].fails, last: runs[k].last && { ...runs[k].last, at: `${istParts(new Date(runs[k].last.at)).text} IST` } },
      ])
    ),
    recentHits: events.map((e) => ({ at: `${istParts(new Date(e.at)).text} IST`, price: e.price, hits: e.hits })),
  };
}

const send = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj, null, 2));
};

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, {
        ok: true,
        watcher: wsInfo.state,
        healthy: watcherHealthy(),
        watching: watchedSymbols().length,
        jobsFailingNow: Object.entries(runs).filter(([, r]) => r.last && !r.last.ok).map(([k]) => k),
        uptimeMin: Math.round((Date.now() - started) / 60_000),
      });
    }
    if (req.method === 'POST' && url.pathname === '/levels') {
      if (!FEED_SECRET || req.headers['x-feed-secret'] !== FEED_SECRET) return send(res, 401, { ok: false, error: 'bad secret' });
      let body = '';
      req.on('data', (c) => (body += c.length + body.length < 1_000_000 ? c : ''));
      req.on('end', () => {
        try {
          setLevels(JSON.parse(body), 'push');
          send(res, 200, { ok: true, watching: watchedSymbols() });
        } catch {
          send(res, 400, { ok: false, error: 'bad JSON' });
        }
      });
      return;
    }
    if (!isLocal(req)) return send(res, 404, { ok: false });
    if (req.method === 'GET' && url.pathname === '/status') return send(res, 200, status());
    const m = url.pathname.match(/^\/run\/([\w-]+)$/);
    if (req.method === 'POST' && m) {
      if (m[1] === 'levels') return pullLevels('by hand').then(() => send(res, 200, status().levels));
      if (!JOBS[m[1]]) return send(res, 404, { ok: false, error: `jobs: ${Object.keys(JOBS).join(', ')}, levels` });
      return runJob(m[1], 'by hand').then((r) => send(res, 200, r));
    }
    send(res, 404, { ok: false });
  })
  .listen(PORT, '127.0.0.1', () => log(`feed server on 127.0.0.1:${PORT} → app ${APP}`));

// ------------------------------------------------------------------ start

if (!CRON_SECRET) log('WARNING: CRON_SECRET is not set — the app will refuse every job.');
if (!FEED_SECRET) log('WARNING: FEED_SECRET is not set — the app cannot push levels; only pulls will be used.');
await loadPerps();
await pullLevels('start');
scheduleNextMinute();
process.on('SIGTERM', () => {
  log('stopping');
  process.exit(0);
});
