import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SECRET_KEY, SecretGate, store } from './Ticker.jsx';
import { fmtCompact, fmtPrice, futuresKlines, perpSymbols, useProxy } from './binance.js';
import { cryptoApi } from './Crypto.jsx';
import { ema, rsi } from './indicators.js';

// Candle Data: 3 months of hourly candles for every Binance USDT perpetual,
// with hourly RSI 14 and EMA 5 / 9 / 21, stored in Neon Postgres.
// "Get / update data" downloads from Binance in this browser (paced to stay
// well inside Binance's rate limit) and saves in batches; a second run only
// fetches the hours added since the last one.

const H = 3_600_000;
const KEEP_DAYS = 92;
const KEEP_HOURS = KEEP_DAYS * 24;
const WARMUP = 250; // extra older candles so RSI / EMA are settled at the start of the window
const CONCURRENCY = 3;
const WEIGHT_PER_MIN = 1500; // Binance allows 2,400 per minute per IP; leave room for the other pages
const SAVE_ROWS = 15_000; // rows per save request (≈ 1.5 MB)
const PAGE = 100;

const coin = (s) => s.replace(/USDT$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sig = (v) => (v == null || !Number.isFinite(v) ? null : Number(v.toPrecision(7)));
const istFmt = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
const istDay = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
const when = (t) => (t ? istFmt.format(new Date(t)) : '—');
const mb = (b) => (b == null ? '—' : b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(1)} MB`);
const dur = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s` : `${s} s`;
};

// Binance request weight for /fapi/v1/klines by limit
const weightOf = (limit) => (limit < 100 ? 1 : limit < 500 ? 2 : limit <= 1000 ? 5 : 10);
const weightFor = (count) => {
  let w = 0;
  for (let left = count; left > 0; left -= 1500) w += weightOf(Math.min(1500, left));
  return w;
};

async function getJson(secret, action, params = {}) {
  const r = await fetch(`/api/crypto?${new URLSearchParams({ action, ...params })}`, { cache: 'no-store', headers: { 'X-Webhook-Secret': secret } });
  const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
  if (!j.ok) throw Object.assign(new Error(j.error || `HTTP ${r.status}`), { status: r.status });
  return j;
}

export default function CandleData() {
  const [secret, setSecret] = useState(() => store.get(SECRET_KEY));
  const [checking, setChecking] = useState(Boolean(store.get(SECRET_KEY)));
  const [unlocked, setUnlocked] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState(null);

  const load = useCallback(async (s) => {
    try {
      setStatus(await getJson(s, 'candles-status'));
      setUnlocked(true);
      setError('');
      useProxy(s);
      return true;
    } catch (e) {
      setError(e.message);
      return e.status !== 401 && e.status !== 403 ? (setUnlocked(true), true) : false;
    }
  }, []);

  useEffect(() => {
    if (!secret) return;
    load(secret).then((ok) => {
      setChecking(false);
      if (!ok) {
        store.set(SECRET_KEY, '');
        setSecret('');
      }
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (checking) return <p className="tk-note">Opening Candle Data…</p>;
  if (!unlocked) {
    return (
      <SecretGate
        error={error}
        notice=""
        onSubmit={async (s, remember) => {
          setSecret(s);
          if (await load(s)) store.set(SECRET_KEY, remember ? s : '');
        }}
      />
    );
  }
  return <Store secret={secret} status={status} error={error} reload={() => load(secret)} />;
}

function Store({ secret, status, error, reload }) {
  const [run, setRun] = useState(null); // progress while fetching
  const [msg, setMsg] = useState(null); // { kind, text }
  const [confirmDel, setConfirmDel] = useState(false);
  const cancel = useRef(false);

  useEffect(() => {
    if (!confirmDel) return;
    const t = setTimeout(() => setConfirmDel(false), 5000);
    return () => clearTimeout(t);
  }, [confirmDel]);

  // Leaving the page mid-run would lose the batch in memory
  useEffect(() => {
    if (!run?.active) return;
    const warn = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [run?.active]);

  const fetchAll = async () => {
    cancel.current = false;
    setMsg(null);
    const started = Date.now();
    const p = { active: true, phase: 'Loading the list of USDT perpetuals…', total: 0, done: 0, saved: 0, current: '', failed: [], started };
    const push = () => setRun({ ...p, failed: [...p.failed] });
    push();
    try {
      const symbols = await perpSymbols();
      const lastAt = Object.fromEntries((status?.latest || []).map((r) => [r.symbol, Date.parse(r.t)]));
      p.total = symbols.length;
      p.phase = 'Downloading hourly candles from Binance';
      push();

      // Pacing: keep Binance request weight under WEIGHT_PER_MIN in any 60 s
      const spent = []; // [time, weight]
      const take = async (w) => {
        for (;;) {
          const now = Date.now();
          while (spent.length && now - spent[0][0] > 60_000) spent.shift();
          const used = spent.reduce((s, x) => s + x[1], 0);
          if (used + w <= WEIGHT_PER_MIN) {
            spent.push([now, w]);
            return;
          }
          await sleep(Math.max(200, 60_000 - (now - spent[0][0])));
        }
      };

      let buffer = [];
      let saving = Promise.resolve();
      const flush = () => {
        if (!buffer.length) return saving;
        const rows = buffer;
        buffer = [];
        saving = saving.then(async () => {
          const j = await cryptoApi(secret, 'candles-save', { method: 'POST', body: { rows } });
          p.saved += j.saved;
          push();
        });
        return saving;
      };

      const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
      const closedBefore = Math.floor(Date.now() / H) * H; // the current hour is still forming
      const one = async (sym) => {
        const last = lastAt[sym];
        const hours = last ? Math.ceil((closedBefore - last) / H) : KEEP_HOURS;
        if (last && hours <= 0) return; // already up to date
        const count = Math.min(KEEP_HOURS + WARMUP, hours + WARMUP + 1);
        for (let attempt = 0; ; attempt++) {
          await take(weightFor(count));
          try {
            const cs = (await futuresKlines(sym, '1h', count)).filter((c) => c.time * 1000 < closedBefore);
            const r14 = rsi(cs, 14);
            const e5 = ema(cs, 5);
            const e9 = ema(cs, 9);
            const e21 = ema(cs, 21);
            cs.forEach((c, i) => {
              const t = c.time * 1000;
              if (t < cutoff || (last && t <= last - 2 * H)) return;
              buffer.push([sym, t, sig(c.open), sig(c.high), sig(c.low), sig(c.close), sig(c.volume), sig(c.quoteVolume), sig(r14[i]), sig(e5[i]), sig(e9[i]), sig(e21[i])]);
            });
            if (buffer.length >= SAVE_ROWS) await flush();
            return;
          } catch (e) {
            const limited = /HTTP (429|418)/.test(e.message);
            if (limited && attempt < 2) {
              p.phase = 'Binance asked to slow down — pausing for a minute';
              push();
              await sleep(65_000);
              p.phase = 'Downloading hourly candles from Binance';
              continue;
            }
            throw e;
          }
        }
      };

      let next = 0;
      const worker = async () => {
        while (next < symbols.length && !cancel.current) {
          const sym = symbols[next++];
          p.current = sym;
          push();
          try {
            await one(sym);
          } catch (e) {
            p.failed.push(`${coin(sym)}: ${e.message}`);
          }
          p.done++;
          push();
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      p.phase = 'Saving the last batch…';
      push();
      await flush();
      await cryptoApi(secret, 'candles-prune', { method: 'POST', body: {} });
      const took = dur(Date.now() - started);
      setMsg(
        cancel.current
          ? { kind: 'err', text: `Stopped after ${p.done} of ${p.total} coins (${took}); ${p.saved.toLocaleString('en-IN')} candles saved. Run again to continue.` }
          : { kind: 'ok', text: `Done in ${took}: ${p.total} coins checked, ${p.saved.toLocaleString('en-IN')} candles saved${p.failed.length ? `, ${p.failed.length} failed` : ''}.` }
      );
    } catch (e) {
      setMsg({ kind: 'err', text: e.message });
    }
    p.active = false;
    push();
    reload();
  };

  const deleteAll = async () => {
    setConfirmDel(false);
    try {
      await cryptoApi(secret, 'candles-delete', { method: 'POST', body: { confirm: true } });
      setMsg({ kind: 'ok', text: 'All candle data deleted.' });
      setRun(null);
      reload();
    } catch (e) {
      setMsg({ kind: 'err', text: e.message });
    }
  };

  const connected = status?.connected !== false;
  const has = (status?.candles || 0) > 0;
  const busy = run?.active;
  const pct = run?.total ? Math.round((run.done / run.total) * 100) : 0;
  const eta = run?.done && run.total && busy ? ((Date.now() - run.started) / run.done) * (run.total - run.done) : null;

  return (
    <>
      <section className="card">
        <div className="card-head">
          <h2>Hourly candles · USDT perpetuals</h2>
          <div className="form-actions">
            {busy ? (
              <button className="btn" onClick={() => (cancel.current = true)} disabled={cancel.current}>Stop</button>
            ) : (
              <>
                <button className="btn primary" onClick={fetchAll} disabled={!connected}>
                  {has ? 'Update data' : 'Get data'}
                </button>
                {has &&
                  (confirmDel ? (
                    <button className="btn danger" onClick={deleteAll}>Confirm: delete all</button>
                  ) : (
                    <button className="btn cd-del" onClick={() => setConfirmDel(true)}>Delete all data</button>
                  ))}
              </>
            )}
          </div>
        </div>
        {error && <p className="status err tk-pos-msg">{error}</p>}
        {msg && <p className={`status ${msg.kind} tk-pos-msg`}>{msg.text}</p>}
        {!connected ? (
          <div className="empty">Candle data is kept in Postgres. Connect your Neon database to this project in Vercel (Storage), redeploy, then come back.</div>
        ) : (
          <div className="cd-stats">
            <Stat label="Coins" value={status?.coins ?? 0} />
            <Stat label="Candles" value={(status?.candles ?? 0).toLocaleString('en-IN')} />
            <Stat label="From" value={status?.first ? istDay.format(new Date(status.first)) : '—'} />
            <Stat label="Latest hour" value={when(status?.last)} />
            <Stat label="Storage used" value={mb(status?.bytes)} note="of Neon's 1 GB free" />
          </div>
        )}
        {busy || run ? (
          <div className="cd-progress">
            <div className="cd-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
              <span style={{ width: `${pct}%` }} />
            </div>
            <div className="cd-progress-text">
              <span>{busy ? run.phase : 'Last run'}</span>
              {run.total > 0 && <span className="mono">{run.done} / {run.total} coins</span>}
              <span className="mono">{run.saved.toLocaleString('en-IN')} candles saved</span>
              {busy && run.current && <span className="muted-cell">now: {coin(run.current)}</span>}
              {eta != null && <span className="muted-cell">about {dur(eta)} left</span>}
            </div>
            {run.failed.length > 0 && (
              <details className="cd-failed">
                <summary>{run.failed.length} coin{run.failed.length === 1 ? '' : 's'} failed</summary>
                <ul>{run.failed.slice(0, 50).map((f) => <li key={f}>{f}</li>)}</ul>
              </details>
            )}
          </div>
        ) : (
          connected && (
            <p className="tk-note cd-note">
              {has ? 'Update fetches only the hours added since the last run (a minute or two). ' : 'The first run downloads about 3 months × 24 hours for each of ~600 coins; it takes 5–10 minutes. Keep this tab open. '}
              Data older than {KEEP_DAYS} days is removed automatically. RSI 14 and EMA 5 / 9 / 21 are on hourly closes (TradingView formulas).
            </p>
          )
        )}
      </section>
      {connected && has && <Latest secret={secret} rows={status.latest} />}
    </>
  );
}

function Stat({ label, value, note }) {
  return (
    <div className="cd-stat">
      <div className="cd-stat-label">{label}</div>
      <div className="cd-stat-value">{value}</div>
      {note && <div className="cd-stat-note">{note}</div>}
    </div>
  );
}

const trendOf = (r) => {
  if (r.ema5 == null || r.ema9 == null || r.ema21 == null) return null;
  if (r.ema5 > r.ema9 && r.ema9 > r.ema21) return 'up';
  if (r.ema5 < r.ema9 && r.ema9 < r.ema21) return 'down';
  return 'mixed';
};

function Latest({ secret, rows }) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState({ key: 'quoteVolume', dir: -1 });
  const [limit, setLimit] = useState(PAGE);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  const list = useMemo(() => {
    const term = q.trim().toUpperCase();
    const out = rows.filter((r) => !term || r.symbol.startsWith(term) || coin(r.symbol).includes(term)).map((r) => ({ ...r, trend: trendOf(r) }));
    const val = (r) => (sort.key === 'symbol' ? r.symbol : sort.key === 'trend' ? { up: 2, mixed: 1, down: 0 }[r.trend] ?? -1 : r[sort.key]);
    return out.sort((a, b) => {
      const x = val(a);
      const y = val(b);
      if (x == null) return 1;
      if (y == null) return -1;
      return (x > y ? 1 : x < y ? -1 : 0) * sort.dir;
    });
  }, [rows, q, sort]);

  const Th = ({ k, children, className = '' }) => (
    <th className={className} aria-sort={sort.key === k ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none'}>
      <button onClick={() => setSort((s) => ({ key: k, dir: s.key === k ? -s.dir : k === 'symbol' ? 1 : -1 }))}>
        {children}
        <span className="arrow">{sort.key === k ? (sort.dir > 0 ? '▲' : '▼') : ''}</span>
      </button>
    </th>
  );

  const csv = async (symbol) => {
    setBusy(symbol);
    setErr('');
    try {
      const { candles } = await getJson(secret, 'candles', { symbol });
      const head = 'time_ist,time_utc,open,high,low,close,volume,quote_volume,rsi14,ema5,ema9,ema21';
      const ist = (t) => new Date(Date.parse(t) + 330 * 60_000).toISOString().slice(0, 16).replace('T', ' ');
      const lines = candles.map((c) => [ist(c.t), new Date(c.t).toISOString(), c.open, c.high, c.low, c.close, c.volume, c.quoteVolume, c.rsi14, c.ema5, c.ema9, c.ema21].map((v) => v ?? '').join(','));
      const blob = new Blob([[head, ...lines].join('\n')], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${symbol}_1h_${KEEP_DAYS}d.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (e) {
      setErr(e.message);
    }
    setBusy('');
  };

  return (
    <section className="card">
      <div className="card-head">
        <h2>Latest hour per coin</h2>
        <input className="search cd-search" placeholder="Find coin…" value={q} onChange={(e) => (setQ(e.target.value), setLimit(PAGE))} aria-label="Find coin" />
      </div>
      {err && <p className="status err tk-pos-msg">{err}</p>}
      <div className="table-wrap">
        <table className="ticker cd-table">
          <thead>
            <tr>
              <Th k="symbol">Coin</Th>
              <Th k="t">Hour (IST)</Th>
              <Th k="close" className="num">Close</Th>
              <Th k="quoteVolume" className="num">Hour volume</Th>
              <Th k="rsi14" className="num">RSI 14</Th>
              <Th k="ema5" className="num">EMA 5</Th>
              <Th k="ema9" className="num">EMA 9</Th>
              <Th k="ema21" className="num">EMA 21</Th>
              <Th k="trend">EMA trend</Th>
              <Th k="count" className="num">Candles</Th>
              <th aria-label="Download" />
            </tr>
          </thead>
          <tbody>
            {list.slice(0, limit).map((r) => (
              <tr key={r.symbol}>
                <td className="mono">
                  <a className="link" href={`#/crypto/chart?s=${r.symbol}`}><b>{coin(r.symbol)}</b></a>
                </td>
                <td className="muted-cell">{when(r.t)}</td>
                <td className="num mono">{fmtPrice(r.close)}</td>
                <td className="num mono">{fmtCompact(r.quoteVolume)}</td>
                <td className="num mono">
                  {r.rsi14 == null ? '—' : <span className={r.rsi14 >= 70 ? 'cd-rsi hot' : r.rsi14 <= 30 ? 'cd-rsi cold' : ''}>{r.rsi14.toFixed(1)}</span>}
                </td>
                <td className="num mono">{fmtPrice(r.ema5)}</td>
                <td className="num mono">{fmtPrice(r.ema9)}</td>
                <td className="num mono">{fmtPrice(r.ema21)}</td>
                <td>
                  {r.trend === 'up' ? <span className="cd-trend up" title="EMA 5 > 9 > 21">Bullish ▲</span> : r.trend === 'down' ? <span className="cd-trend down" title="EMA 5 < 9 < 21">Bearish ▼</span> : r.trend === 'mixed' ? <span className="muted-cell">Mixed</span> : '—'}
                </td>
                <td className="num mono muted-cell">{r.count.toLocaleString('en-IN')}</td>
                <td className="num">
                  <button className="btn cd-csv" onClick={() => csv(r.symbol)} disabled={busy === r.symbol} title={`Download ${coin(r.symbol)} hourly candles with RSI and EMAs (CSV)`}>
                    {busy === r.symbol ? '…' : 'CSV'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="foot">
        {list.length} coin{list.length === 1 ? '' : 's'} · hourly closes from Binance USDⓈ-M Futures
        {list.length > limit && (
          <>
            {' · '}
            <button className="cd-more" onClick={() => setLimit((l) => l + PAGE * 3)}>show more</button>
          </>
        )}
      </div>
    </section>
  );
}
