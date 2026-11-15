import { useEffect, useMemo, useRef, useState } from 'react';
import { SECRET_KEY, SecretGate, store } from './Ticker.jsx';
import { fmtCompact, fmtPrice, futuresKlines, perpSymbols, useProxy } from './binance.js';
import { cryptoApi as api } from './Crypto.jsx';
import { CANDLES, H4, LOOKBACK_MAX, bbHits } from './bbcore.js';

// Big Movers → 4h BB + RSI: every Binance USDT perpetual, 4-hour candles, listing
// each candle whose LOW is above the upper Bollinger Band and whose RSI is above
// the level — the whole candle traded outside the band. Runs in the browser
// (one request per coin, straight from Binance); the last result is kept on this device.

const CONCURRENCY = 4;
const STORE = 'stockhits.bbscan';
const LOOKBACK = [
  [1, 'Latest candle'],
  [6, '1 day'],
  [18, '3 days'],
  [42, '7 days'],
];
const PAGE = 50;

const timeFmt = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
const runFmt = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
const coin = (s) => s.replace(/USDT$/, '');
const tone = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
const pctText = (v, d = 1) => (v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(d)}%`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadSaved() {
  try {
    return JSON.parse(localStorage.getItem(STORE) || 'null');
  } catch {
    return null;
  }
}

export default function BBScan() {
  const [secret, setSecret] = useState(() => store.get(SECRET_KEY));
  const [gateErr, setGateErr] = useState('');
  const [auto, setAuto] = useState(null); // saved by the automatic server scan
  const [manual, setManual] = useState(loadSaved); // your last "Run now" on this device
  const [source, setSource] = useState('auto');
  const [loading, setLoading] = useState(Boolean(secret));
  const [watch, setWatch] = useState(new Set());

  const load = async (s) => {
    const r = await api(s, 'bb-scan-result'); // throws on a wrong secret
    useProxy(s);
    if (r?.meta) setAuto({ meta: r.meta, rows: r.rows || [] });
    api(s, 'watchlist')
      .then((w) => setWatch(new Set(w.symbols)))
      .catch(() => {});
  };

  useEffect(() => {
    if (!secret) return;
    load(secret)
      .catch(() => {
        store.set(SECRET_KEY, '');
        setSecret('');
      })
      .finally(() => setLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!secret) {
    return (
      <SecretGate
        error={gateErr}
        notice=""
        onSubmit={async (s, remember) => {
          try {
            await load(s);
            setGateErr('');
            setSecret(s);
            store.set(SECRET_KEY, remember ? s : '');
          } catch (e) {
            setGateErr(e.message);
          }
        }}
      />
    );
  }

  const onManual = (s) => {
    setManual(s);
    setSource('manual');
    try {
      localStorage.setItem(STORE, JSON.stringify(s));
    } catch {}
  };

  const shown = source === 'manual' && manual?.meta ? manual : auto?.meta ? auto : manual?.meta ? manual : null;
  const which = shown === auto ? 'auto' : 'manual';

  return (
    <>
      <ScanBox saved={manual} autoMeta={auto?.meta} onSaved={onManual} />
      {loading && !shown && <p className="tk-note">Loading the latest automatic scan…</p>}
      {shown && (
        <Results
          key={`${which}-${shown.meta.runAt}`}
          saved={shown}
          which={which}
          both={Boolean(auto?.meta && manual?.meta)}
          onSource={setSource}
          watch={watch}
          canWatch={Boolean(secret)}
          onWatch={async (s) => {
            const j = await api(secret, 'add', { method: 'POST', body: { symbol: s, market: 'futures' } });
            setWatch(new Set(j.symbols));
          }}
        />
      )}
      {!loading && !shown && (
        <section className="card pad">
          <p className="muted">No scan yet. The automatic scan fills this in after the next 4-hour candle closes, or tap <b>Run now</b>.</p>
        </section>
      )}
    </>
  );
}

// ------------------------------------------------------------------ scan

function ScanBox({ saved, autoMeta, onSaved }) {
  const m = saved?.meta || {};
  const [bbLen, setBbLen] = useState(String(m.bbLen ?? 30));
  const [bbMult, setBbMult] = useState(String(m.bbMult ?? 2));
  const [rsiLen, setRsiLen] = useState(String(m.rsiLen ?? 14));
  const [rsiMin, setRsiMin] = useState(String(m.rsiMin ?? 70));
  const [includeForming, setIncludeForming] = useState(m.includeForming ?? false);
  const [run, setRun] = useState(null);
  const [err, setErr] = useState('');
  const cancel = useRef(false);

  const cfg = { bbLen: Math.round(+bbLen), bbMult: +bbMult, rsiLen: Math.round(+rsiLen), rsiMin: +rsiMin, lookback: LOOKBACK_MAX, includeForming };
  const ok = cfg.bbLen >= 2 && cfg.bbLen <= 200 && cfg.bbMult > 0 && cfg.rsiLen >= 2 && cfg.rsiLen <= 100 && cfg.rsiMin > 0 && cfg.rsiMin < 100;

  const start = async () => {
    cancel.current = false;
    setErr('');
    try {
      setRun({ phase: 'list', done: 0, total: 0, found: 0, failed: [] });
      const symbols = await perpSymbols();
      const rows = [];
      const failed = [];
      let done = 0;
      const queue = [...symbols];
      const nowSec = Math.floor(Date.now() / 1000);
      setRun({ phase: 'scan', done, total: symbols.length, found: 0, failed });
      const worker = async () => {
        while (queue.length && !cancel.current) {
          const s = queue.shift();
          for (let attempt = 0; ; attempt++) {
            try {
              const cs = await futuresKlines(s, '4h', CANDLES);
              rows.push(...bbHits(s, cs, { ...cfg, nowSec }));
              break;
            } catch (e) {
              if (attempt < 2 && /429|418|HTTP 5/.test(e.message)) {
                await sleep(3000 * (attempt + 1));
                continue;
              }
              failed.push(s);
              break;
            }
          }
          done++;
          setRun({ phase: 'scan', done, total: symbols.length, found: rows.length, failed: [...failed] });
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      if (cancel.current) {
        setRun(null);
        setErr('Scan cancelled.');
        return;
      }
      rows.sort((a, b) => b.time - a.time || b.gap - a.gap);
      onSaved({ meta: { ...cfg, runAt: Date.now(), checked: symbols.length - failed.length, failed }, rows });
      setRun(null);
    } catch (e) {
      setRun(null);
      setErr(e.message);
    }
  };

  const busy = Boolean(run);
  const pct = run?.total ? Math.round((run.done / run.total) * 100) : 0;
  const num = (label, value, set, props) => (
    <label className="tk-ema-in">
      {label}
      <input type="number" value={value} onChange={(e) => set(e.target.value)} disabled={busy} aria-label={label} {...props} />
    </label>
  );

  return (
    <section className="card scan-card mv-scan">
      <div className="card-head">
        <div>
          <h2>4-hour candles above the Bollinger Band</h2>
          <p className="muted scan-sub">
            Checks <b>every Binance USDT perpetual</b> and lists each 4-hour candle whose <b>low is above the upper Bollinger Band</b> ({ok ? `${cfg.bbLen}, ${cfg.bbMult}` : '…'}) with{' '}
            <b>RSI {ok ? cfg.rsiLen : '…'} above {ok ? cfg.rsiMin : '…'}</b> — the whole candle traded outside the band. Candles start 1:30, 5:30, 9:30 … IST.
          </p>
          <p className="muted scan-sub bbs-auto">
            {autoMeta ? (
              <>⟳ Runs automatically every 4 hours with BB 30, 2 and RSI 14 &gt; 70 · last run <b>{runFmt.format(new Date(autoMeta.runAt))}</b>. Use <b>Run now</b> to try other settings.</>
            ) : (
              <>⟳ The automatic 4-hourly scan hasn’t saved a result yet. You can <b>Run now</b> any time.</>
            )}
          </p>
        </div>
      </div>
      <div className="bbs-controls">
        {num('BB length', bbLen, setBbLen, { min: 2, max: 200, step: 1, className: 'w-sm' })}
        {num('StdDev', bbMult, setBbMult, { min: 0.5, max: 5, step: 0.5, className: 'w-sm' })}
        {num('RSI length', rsiLen, setRsiLen, { min: 2, max: 100, step: 1, className: 'w-sm' })}
        {num('RSI >', rsiMin, setRsiMin, { min: 1, max: 99, step: 1, className: 'w-sm' })}
        <label className="switch" title="The current 4-hour candle hasn't closed yet, so it can still drop back inside the band">
          <input type="checkbox" checked={includeForming} onChange={(e) => setIncludeForming(e.target.checked)} disabled={busy} />
          <span>Include the candle still forming</span>
        </label>
        {busy ? (
          <button className="btn btn-close push" onClick={() => (cancel.current = true)} disabled={run.phase !== 'scan'}>Cancel</button>
        ) : (
          <button className="btn primary push" onClick={start} disabled={!ok}>Run now</button>
        )}
      </div>
      {busy && (
        <div className="mv-progress">
          <div className="mv-bar"><i style={{ width: `${pct}%` }} /></div>
          <span className="mono">
            {run.phase === 'list'
              ? 'Getting the list of perpetuals…'
              : `${run.done} / ${run.total} coins · ${run.found} ${run.found === 1 ? 'candle' : 'candles'} found${run.failed.length ? ` · ${run.failed.length} couldn’t load` : ''}`}
          </span>
        </div>
      )}
      {err && <p className="status err tk-pos-msg">{err}</p>}
      {!saved?.meta && !autoMeta && !busy && !err && (
        <p className="muted mv-first">Run now takes about a minute (one request per coin, straight from Binance) and looks back 7 days; its result is kept on this device.</p>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ results

const COLS = [
  ['time', 'Candle (IST)'],
  ['symbol', 'Coin'],
  ['low', 'Low', 'num'],
  ['upper', 'Upper band', 'num'],
  ['gap', 'Low above band', 'num', 'How far the candle’s low is above the upper band'],
  ['rsi', 'RSI', 'num'],
  ['chg', 'Candle', 'num', 'Close vs open of this candle'],
  ['quoteVolume', 'Volume (USDT)', 'num'],
  ['next1', 'Next 4h', 'num', 'Close of the next candle vs this close'],
  ['max6', 'Best / worst 24h', 'num', 'Highest high and lowest low in the next 6 candles vs this close'],
  ['now', 'Now', 'num', 'Price now vs this close'],
];

function Results({ saved, which, both, onSource, watch, canWatch, onWatch }) {
  const { meta, rows } = saved;
  const [q, setQ] = useState('');
  const [latestOnly, setLatestOnly] = useState(false);
  const [win, setWin] = useState(6);
  const lastClosed = Math.floor(meta.runAt / 1000 / H4) * H4 - H4;
  const [sort, setSort] = useState({ key: 'time', dir: 'desc' });
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState('');

  const view = useMemo(() => {
    const term = q.trim().toUpperCase();
    const from = lastClosed - (win - 1) * H4;
    let list = rows.filter((r) => (r.forming || r.time >= from) && (!term || coin(r.symbol).startsWith(term)));
    if (latestOnly) {
      const seen = new Set();
      list = [...list].sort((a, b) => b.time - a.time).filter((r) => (seen.has(r.symbol) ? false : seen.add(r.symbol)));
    }
    const { key, dir } = sort;
    return [...list].sort((a, b) => {
      const x = a[key];
      const y = b[key];
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      const c = typeof x === 'string' ? x.localeCompare(y) : x - y;
      return (dir === 'asc' ? c : -c) || b.gap - a.gap;
    });
  }, [rows, q, latestOnly, sort, win, lastClosed]);
  useEffect(() => setPage(1), [q, latestOnly, sort, win]);

  const stats = useMemo(() => {
    const avg = (f) => {
      const v = view.map((r) => r[f]).filter((x) => x != null);
      return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
    };
    const share = (f) => {
      const v = view.map((r) => r[f]).filter((x) => x != null);
      return v.length ? (v.filter((x) => x > 0).length / v.length) * 100 : null;
    };
    const top = view.reduce((a, r) => (!a || r.gap > a.gap ? r : a), null);
    return { coins: new Set(view.map((r) => r.symbol)).size, avg1: avg('next1'), up1: share('next1'), avgMax: avg('max6'), avgMin: avg('min6'), top };
  }, [view]);

  const pages = Math.max(1, Math.ceil(view.length / PAGE));
  const cur = Math.min(page, pages);
  const shown = view.slice((cur - 1) * PAGE, cur * PAGE);
  const toggle = (key) => setSort((s) => (s.key === key ? { key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: key === 'symbol' ? 'asc' : 'desc' }));
  const lookLabel = LOOKBACK.find(([n]) => n === win)?.[1] || `${win} candles`;

  const exportCsv = () => {
    const head = ['CandleOpenIST', 'Coin', 'Pair', 'Open', 'High', 'Low', 'Close', 'UpperBand', 'LowAboveBandPct', 'RSI', 'CandlePct', 'QuoteVolumeUSDT', 'Next4hPct', 'Best24hPct', 'Worst24hPct', 'NowPct', 'Forming'];
    const lines = view.map((r) =>
      [`"${timeFmt.format(new Date(r.time * 1000))}"`, coin(r.symbol), r.symbol, r.open, r.high, r.low, r.close, r.upper, r.gap.toFixed(3), r.rsi.toFixed(2), r.chg.toFixed(3), r.quoteVolume, r.next1 ?? '', r.max6 ?? '', r.min6 ?? '', r.now ?? '', r.forming ? 'yes' : ''].join(',')
    );
    const blob = new Blob([[head.join(','), ...lines].join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `bb-rsi-4h-${new Date(meta.runAt).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <>
      <section className="stats stats-4">
        <div className="stat">
          <div className="stat-label">Candles found</div>
          <div className="stat-value">{view.length.toLocaleString('en-IN')}</div>
          <div className="stat-note">{stats.coins} {stats.coins === 1 ? 'coin' : 'coins'} · {meta.checked?.toLocaleString('en-IN')} checked · {lookLabel}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Furthest above band</div>
          <div className="stat-value mono-val">{stats.top ? `${coin(stats.top.symbol)} ${pctText(stats.top.gap)}` : '—'}</div>
          <div className="stat-note">{stats.top ? `${timeFmt.format(new Date(stats.top.time * 1000))} · RSI ${stats.top.rsi.toFixed(1)}` : ''}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Next 4h (average)</div>
          <div className={`stat-value ${tone(stats.avg1)}`}>{pctText(stats.avg1)}</div>
          <div className="stat-note">{stats.up1 != null ? `closed higher after ${stats.up1.toFixed(0)}%` : 'no completed next candle yet'}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Next 24h (average)</div>
          <div className="stat-value bbs-split">
            <span className={tone(stats.avgMax)}>{pctText(stats.avgMax)}</span> <span className="muted-cell">/</span> <span className={tone(stats.avgMin)}>{pctText(stats.avgMin)}</span>
          </div>
          <div className="stat-note">best high / worst low after the candle</div>
        </div>
      </section>

      <section className="card">
        <div className="filters">
          {both && (
            <div className="seg" role="group" aria-label="Which result">
              <button className={which === 'auto' ? 'on' : ''} onClick={() => onSource('auto')}>Automatic</button>
              <button className={which === 'manual' ? 'on' : ''} onClick={() => onSource('manual')}>My run</button>
            </div>
          )}
          <div className="seg" role="group" aria-label="Show candles from">
            {LOOKBACK.map(([n, label]) => (
              <button key={n} className={win === n ? 'on' : ''} onClick={() => setWin(n)}>{label}</button>
            ))}
          </div>
          <input className="search" placeholder="Search coin" value={q} onChange={(e) => setQ(e.target.value)} />
          <label className="switch">
            <input type="checkbox" checked={latestOnly} onChange={(e) => setLatestOnly(e.target.checked)} />
            <span>Latest per coin only</span>
          </label>
          <span className="muted-cell mv-range">
            {which === 'auto' ? 'Automatic' : 'My run'} {runFmt.format(new Date(meta.runAt))} · BB {meta.bbLen}, {meta.bbMult} · RSI {meta.rsiLen} &gt; {meta.rsiMin}
            {meta.includeForming ? ' · incl. forming candle' : ' · completed candles'}
          </span>
          <button className="btn push" onClick={exportCsv} disabled={!view.length}>Export CSV</button>
        </div>
        <div className="table-wrap">
          <table className="journal mv-table bbs-table">
            <thead>
              <tr>
                {COLS.map(([k, label, cls, title]) => (
                  <th key={k} className={cls || ''} title={title}>
                    <button onClick={() => toggle(k)}>
                      {label}
                      <span className="arrow">{sort.key === k ? (sort.dir === 'asc' ? '▲' : '▼') : ''}</span>
                    </button>
                  </th>
                ))}
                <th aria-label="Watchlist" />
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={`${r.symbol}|${r.time}`}>
                  <td className="jr-day">
                    {timeFmt.format(new Date(r.time * 1000))}
                    {r.forming && <span className="bbs-forming" title="This candle hasn't closed yet">forming</span>}
                  </td>
                  <td><a className="link mono" href={`#/crypto/chart?s=${r.symbol}`} title="Open chart"><b>{coin(r.symbol)}</b></a></td>
                  <td className="num mono">{fmtPrice(r.low)}</td>
                  <td className="num mono muted-cell">{fmtPrice(r.upper)}</td>
                  <td className="num mono pos"><b>{pctText(r.gap, 2)}</b></td>
                  <td className="num mono"><b>{r.rsi.toFixed(1)}</b></td>
                  <td className={`num mono ${tone(r.chg)}`}>{pctText(r.chg)}</td>
                  <td className="num mono muted-cell">{fmtCompact(r.quoteVolume)}</td>
                  <td className={`num mono ${tone(r.next1)}`}>{pctText(r.next1)}</td>
                  <td className="num mono">
                    {r.max6 == null ? '—' : (
                      <>
                        <span className={tone(r.max6)}>{pctText(r.max6)}</span> <span className="muted-cell">/</span> <span className={tone(r.min6)}>{pctText(r.min6)}</span>
                      </>
                    )}
                  </td>
                  <td className={`num mono ${tone(r.now)}`}>{pctText(r.now)}</td>
                  <td className="tk-x">
                    {!canWatch ? null : watch.has(r.symbol) ? (
                      <span className="muted-cell mv-in">✓ Watching</span>
                    ) : (
                      <button
                        className="btn add-ticker"
                        disabled={busy === r.symbol}
                        onClick={async () => {
                          setBusy(r.symbol);
                          try {
                            await onWatch(r.symbol);
                          } finally {
                            setBusy('');
                          }
                        }}
                      >
                        + Watch
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!view.length && <div className="empty">{rows.length && q ? 'No candles match the search.' : `No coin had a 4-hour candle fully above the band with RSI above ${meta.rsiMin} in this period.`}</div>}
        </div>
        <div className="foot jr-foot">
          <span>
            {view.length ? `${(cur - 1) * PAGE + 1}–${Math.min(cur * PAGE, view.length)} of ${view.length}` : '0'} candles
            {meta.failed?.length ? ` · ${meta.failed.length} ${meta.failed.length === 1 ? 'coin' : 'coins'} couldn’t be loaded` : ''}
          </span>
          <span className="jr-pager">
            <button className="btn" onClick={() => setPage(cur - 1)} disabled={cur <= 1}>‹ Prev</button>
            <span>Page {cur} of {pages}</span>
            <button className="btn" onClick={() => setPage(cur + 1)} disabled={cur >= pages}>Next ›</button>
          </span>
        </div>
        <div className="foot">
          Binance USDⓈ-M perpetuals, 4-hour candles. Bollinger Band = SMA of closes ± StdDev × standard deviation; RSI uses Wilder’s smoothing (same as the chart and TradingView). Next 4h / 24h compare later prices with this candle’s close.
        </div>
      </section>
    </>
  );
}
