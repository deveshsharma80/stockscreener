import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SECRET_KEY, SecretGate, store } from './Ticker.jsx';
import { fmtCompact, fmtPrice, klines, usdtMarkets, useProxy } from './binance.js';
import { cryptoApi as api } from './Crypto.jsx';
import { bigDays } from './indicators.js';

// Big Movers: a one-time look back over Binance daily candles for every USDT
// pair, listing each completed day where close ÷ open reached the ratio
// (default 1.4 = +40%), with what the coin did afterwards. The scan runs in
// the browser (≈ one request per coin) and the result is saved on the server.

const DAY = 86_400;
const CONCURRENCY = 6;
const PAGE = 50;
const dayFmt = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const shortDay = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: '2-digit', timeZone: 'UTC' });
const runFmt = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
const coin = (s) => s.replace(/USDT$/, '');
const tone = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
const pctText = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default function Movers() {
  const [secret, setSecret] = useState(() => store.get(SECRET_KEY));
  const [checking, setChecking] = useState(Boolean(store.get(SECRET_KEY)));
  const [unlocked, setUnlocked] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(null); // { meta, rows }
  const [watch, setWatch] = useState(new Set());

  const load = useCallback(async (s) => {
    try {
      const [h, w] = await Promise.all([api(s, 'movers-history'), api(s, 'watchlist')]);
      setSaved(h);
      setWatch(new Set(w.symbols));
      setUnlocked(true);
      setError('');
      useProxy(s);
      return true;
    } catch (e) {
      setError(e.message);
      return false;
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

  if (checking) return <p className="tk-note">Opening Big Movers…</p>;
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

  return (
    <>
      <ScanBox secret={secret} saved={saved} onSaved={setSaved} />
      {saved?.meta && (
        <Results
          saved={saved}
          watch={watch}
          onWatch={async (s) => {
            const j = await api(secret, 'add', { method: 'POST', body: { symbol: s } });
            setWatch(new Set(j.symbols));
          }}
        />
      )}
    </>
  );
}

// ------------------------------------------------------------------ the one-time scan

function ScanBox({ secret, saved, onSaved }) {
  const [months, setMonths] = useState(3);
  const [ratio, setRatio] = useState('1.4');
  const [run, setRun] = useState(null); // { done, total, found, failed, phase }
  const [err, setErr] = useState('');
  const cancel = useRef(false);
  const minRatio = Number(ratio);
  const okRatio = minRatio > 1 && minRatio <= 100;

  const start = async () => {
    cancel.current = false;
    setErr('');
    const now = Math.floor(Date.now() / 1000);
    const toSec = Math.floor(now / DAY) * DAY; // start of today (UTC): only completed days
    const from = new Date(toSec * 1000);
    from.setUTCMonth(from.getUTCMonth() - months);
    const fromSec = Math.floor(from.getTime() / 1000);
    const need = Math.ceil((toSec - fromSec) / DAY) + 2;
    try {
      setRun({ phase: 'list', done: 0, total: 0, found: 0, failed: [] });
      const symbols = (await usdtMarkets()).map((m) => m.symbol);
      const rows = [];
      const failed = [];
      let done = 0;
      const queue = [...symbols];
      setRun({ phase: 'scan', done, total: symbols.length, found: 0, failed });
      const worker = async () => {
        while (queue.length && !cancel.current) {
          const s = queue.shift();
          for (let attempt = 0; ; attempt++) {
            try {
              const cs = await klines(s, '1d', Math.min(1000, need));
              rows.push(...bigDays(s, cs, { minRatio, fromSec, toSec }));
              break;
            } catch (e) {
              if (attempt < 2 && /429|418|HTTP 5/.test(e.message)) {
                await sleep(3000 * (attempt + 1)); // Binance asked us to slow down
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
        setErr('Scan cancelled — nothing was saved.');
        return;
      }
      setRun({ phase: 'save', done, total: symbols.length, found: rows.length, failed });
      rows.sort((a, b) => b.day.localeCompare(a.day) || b.ratio - a.ratio);
      const meta = {
        months,
        minRatio,
        from: new Date(fromSec * 1000).toISOString().slice(0, 10),
        to: new Date((toSec - DAY) * 1000).toISOString().slice(0, 10),
        checked: symbols.length - failed.length,
        failed,
      };
      const j = await api(secret, 'movers-history', { method: 'POST', body: { meta, rows } });
      onSaved({ meta: j.meta, rows: j.rows });
      setRun(null);
    } catch (e) {
      setRun(null);
      setErr(e.message);
    }
  };

  const busy = Boolean(run);
  const pct = run?.total ? Math.round((run.done / run.total) * 100) : 0;
  return (
    <section className="card scan-card mv-scan">
      <div className="card-head">
        <div>
          <h2>Find big daily moves</h2>
          <p className="muted scan-sub">
            Looks back over the daily candles of <b>every Binance USDT coin</b> and lists each completed day where the close was at least{' '}
            <b>{okRatio ? `${minRatio}×` : '…'} the open</b>{okRatio && ` (+${Math.round((minRatio - 1) * 100)}%)`}. Days start 5:30 AM IST (00:00 UTC).
            {saved?.meta && <> Last run {runFmt.format(new Date(saved.meta.runAt))}.</>}
          </p>
        </div>
        <div className="form-actions">
          <div className="seg" role="group" aria-label="Look back">
            {[1, 3, 6].map((m) => (
              <button key={m} className={months === m ? 'on' : ''} onClick={() => setMonths(m)} disabled={busy}>
                {m} {m === 1 ? 'month' : 'months'}
              </button>
            ))}
          </div>
          <label className="tk-ema-in">
            Close ÷ open ≥
            <input type="number" min="1.01" max="100" step="0.05" value={ratio} onChange={(e) => setRatio(e.target.value)} disabled={busy} aria-label="Minimum close divided by open" />
          </label>
          {busy ? (
            <button className="btn btn-close" onClick={() => (cancel.current = true)} disabled={run.phase !== 'scan'}>Cancel</button>
          ) : (
            <button className="btn primary" onClick={start} disabled={!okRatio}>{saved?.meta ? 'Run again' : 'Run scan'}</button>
          )}
        </div>
      </div>
      {busy && (
        <div className="mv-progress">
          <div className="mv-bar"><i style={{ width: `${pct}%` }} /></div>
          <span className="mono">
            {run.phase === 'list'
              ? 'Getting the list of coins…'
              : run.phase === 'save'
                ? 'Saving…'
                : `${run.done} / ${run.total} coins · ${run.found} big ${run.found === 1 ? 'day' : 'days'} found${run.failed.length ? ` · ${run.failed.length} couldn’t load` : ''}`}
          </span>
        </div>
      )}
      {err && <p className="status err tk-pos-msg">{err}</p>}
      {!saved?.meta && !busy && !err && (
        <p className="muted mv-first">Takes about a minute (one request per coin, straight from Binance). The result is saved, so you only need to run it again to refresh it.</p>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ results

const COLS = [
  ['day', 'Date'],
  ['symbol', 'Coin'],
  ['ratio', 'Close ÷ open', 'num', 'Hover a value for the % gain'],
  ['close', 'Open → close', 'num'],
  ['highRatio', 'High ÷ open', 'num', 'How far the price went during the day'],
  ['quoteVolume', 'Volume (USDT)', 'num'],
  ['next1', 'Next day', 'num', 'Close the next day vs this close'],
  ['next7', '7 days later', 'num', 'Close 7 days later vs this close'],
  ['max7', 'Best in 7 days', 'num', 'Highest price in the next 7 days vs this close'],
];

function Results({ saved, watch, onWatch }) {
  const { meta, rows } = saved;
  const [q, setQ] = useState('');
  const [min, setMin] = useState(String(meta.minRatio ?? 1.4));
  const [sort, setSort] = useState({ key: 'day', dir: 'desc' });
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState('');

  const view = useMemo(() => {
    const term = q.trim().toUpperCase();
    const m = Number(min) || 0;
    const list = rows.filter((r) => r.ratio >= m && (!term || coin(r.symbol).startsWith(term)));
    const { key, dir } = sort;
    return list.sort((a, b) => {
      const x = a[key];
      const y = b[key];
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      const c = typeof x === 'string' ? x.localeCompare(y) : x - y;
      return (dir === 'asc' ? c : -c) || b.ratio - a.ratio;
    });
  }, [rows, q, min, sort]);
  useEffect(() => setPage(1), [q, min, sort]);

  const stats = useMemo(() => {
    const avg = (f) => {
      const v = view.map((r) => r[f]).filter((x) => x != null);
      return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
    };
    const up = (f) => {
      const v = view.map((r) => r[f]).filter((x) => x != null);
      return v.length ? (v.filter((x) => x > 0).length / v.length) * 100 : null;
    };
    const top = view.reduce((a, r) => (!a || r.ratio > a.ratio ? r : a), null);
    return { coins: new Set(view.map((r) => r.symbol)).size, avg1: avg('next1'), up1: up('next1'), avg7: avg('next7'), up7: up('next7'), top };
  }, [view]);

  const pages = Math.max(1, Math.ceil(view.length / PAGE));
  const cur = Math.min(page, pages);
  const shown = view.slice((cur - 1) * PAGE, cur * PAGE);
  const toggle = (key) => setSort((s) => (s.key === key ? { key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: key === 'symbol' ? 'asc' : 'desc' }));

  const exportCsv = () => {
    const head = ['Date', 'Coin', 'Pair', 'Open', 'Close', 'CloseOverOpen', 'GainPct', 'High', 'HighOverOpen', 'QuoteVolumeUSDT', 'NextDayPct', 'Day7Pct', 'Best7Pct'];
    const lines = view.map((r) => [r.day, coin(r.symbol), r.symbol, r.open, r.close, r.ratio, r.pct, r.high, r.highRatio, r.quoteVolume, r.next1 ?? '', r.next7 ?? '', r.max7 ?? ''].join(','));
    const blob = new Blob([[head.join(','), ...lines].join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `big-movers-${meta.from}-to-${meta.to}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <>
      <section className="stats stats-4">
        <div className="stat">
          <div className="stat-label">Big days</div>
          <div className="stat-value">{view.length.toLocaleString('en-IN')}</div>
          <div className="stat-note">{stats.coins} {stats.coins === 1 ? 'coin' : 'coins'} · {meta.checked?.toLocaleString('en-IN')} checked</div>
        </div>
        <div className="stat">
          <div className="stat-label">Biggest day</div>
          <div className="stat-value mono-val">{stats.top ? `${coin(stats.top.symbol)} ${stats.top.ratio.toFixed(2)}×` : '—'}</div>
          <div className="stat-note">{stats.top ? dayFmt.format(new Date(`${stats.top.day}T00:00:00Z`)) : ''}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Next day (average)</div>
          <div className={`stat-value ${tone(stats.avg1)}`}>{pctText(stats.avg1)}</div>
          <div className="stat-note">{stats.up1 != null ? `rose after ${stats.up1.toFixed(0)}% of big days` : ''}</div>
        </div>
        <div className="stat">
          <div className="stat-label">7 days later (average)</div>
          <div className={`stat-value ${tone(stats.avg7)}`}>{pctText(stats.avg7)}</div>
          <div className="stat-note">{stats.up7 != null ? `higher after ${stats.up7.toFixed(0)}% of big days` : ''}</div>
        </div>
      </section>

      <section className="card">
        <div className="filters">
          <input className="search" placeholder="Search coin" value={q} onChange={(e) => setQ(e.target.value)} />
          <label className="tk-ema-in">
            Show close ÷ open ≥
            <input type="number" min={meta.minRatio} step="0.1" value={min} onChange={(e) => setMin(e.target.value)} aria-label="Show only ratios at least" />
          </label>
          <span className="muted-cell mv-range">
            {dayFmt.format(new Date(`${meta.from}T00:00:00Z`))} – {dayFmt.format(new Date(`${meta.to}T00:00:00Z`))}
          </span>
          <button className="btn push" onClick={exportCsv} disabled={!view.length}>Export CSV</button>
        </div>
        <div className="table-wrap">
          <table className="journal mv-table">
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
                <tr key={`${r.symbol}|${r.day}`}>
                  <td className="jr-day">{shortDay.format(new Date(`${r.day}T00:00:00Z`))}</td>
                  <td><a className="link mono" href={`#/crypto/chart?s=${r.symbol}`} title="Open chart"><b>{coin(r.symbol)}</b></a></td>
                  <td className="num mono pos" title={`+${r.pct.toFixed(1)}% on the day`}><b>{r.ratio.toFixed(2)}×</b></td>
                  <td className="num mono mv-oc">{fmtPrice(r.open)} → {fmtPrice(r.close)}</td>
                  <td className="num mono muted-cell">{r.highRatio?.toFixed(2)}×</td>
                  <td className="num mono muted-cell">{fmtCompact(r.quoteVolume)}</td>
                  <td className={`num mono ${tone(r.next1)}`}>{pctText(r.next1)}</td>
                  <td className={`num mono ${tone(r.next7)}`}>{pctText(r.next7)}</td>
                  <td className={`num mono ${tone(r.max7)}`}>{pctText(r.max7)}</td>
                  <td className="tk-x">
                    {watch.has(r.symbol) ? (
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
          {!view.length && <div className="empty">{rows.length ? 'No days match these filters.' : `No coin closed at ${meta.minRatio}× its open on any day in this period.`}</div>}
        </div>
        <div className="foot jr-foot">
          <span>
            {view.length ? `${(cur - 1) * PAGE + 1}–${Math.min(cur * PAGE, view.length)} of ${view.length}` : '0'} days
            {meta.failed?.length ? ` · ${meta.failed.length} ${meta.failed.length === 1 ? 'coin' : 'coins'} couldn’t be loaded (${meta.failed.slice(0, 5).map(coin).join(', ')}${meta.failed.length > 5 ? '…' : ''})` : ''}
          </span>
          <span className="jr-pager">
            <button className="btn" onClick={() => setPage(cur - 1)} disabled={cur <= 1}>‹ Prev</button>
            <span>Page {cur} of {pages}</span>
            <button className="btn" onClick={() => setPage(cur + 1)} disabled={cur >= pages}>Next ›</button>
          </span>
        </div>
        <div className="foot">
          Binance spot, USDT pairs trading today (coins delisted since then aren’t included). Next day / 7 days later compare that later close with the big day’s close; best in 7 days uses the highest price.
        </div>
      </section>
    </>
  );
}
