import { useCallback, useEffect, useMemo, useState } from 'react';
import Screener from './Screener.jsx';

// Hash routing (#/ and #/screener) needs no server rewrites on Vercel.
function useHashPage() {
  const read = () => (window.location.hash.replace(/^#\/?/, '').split(/[/?]/)[0] === 'screener' ? 'screener' : 'hits');
  const [page, setPage] = useState(read);
  useEffect(() => {
    const on = () => setPage(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return page;
}

const REFRESH_MS = 10_000;

// ---- Stocks table filters (all dates/times are Indian time, like Chartink)
const NO_SCAN = '__none__';
const EMPTY_FILTERS = { period: 'all', from: '', to: '', tFrom: '', tTo: '', scan: '' };
const HIT_PERIODS = [
  ['all', 'All'],
  ['today', 'Today'],
  ['yesterday', 'Yesterday'],
  ['7d', '7 days'],
  ['custom', 'Dates…'],
];
const shiftDay = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const istTimeOf = (iso) => new Date(new Date(iso).getTime() + 330 * 60_000).toISOString().slice(11, 19);

// Returns a test for an IST date string (YYYY-MM-DD)
function periodMatcher({ period, from, to }) {
  const today = istToday();
  if (period === 'today') return (d) => d === today;
  if (period === 'yesterday') {
    const y = shiftDay(today, -1);
    return (d) => d === y;
  }
  if (period === '7d') {
    const start = shiftDay(today, -6);
    return (d) => d >= start;
  }
  if (period === 'custom') return (d) => (!from || d >= from) && (!to || d <= to);
  return () => true;
}
const num = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' });

function timeAgo(iso) {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.max(s, 0)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function App() {
  const [data, setData] = useState({ rows: [], total: 0 });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [auto, setAuto] = useState(true);
  const [filter, setFilter] = useState('');
  // HitTime / Scan filters for the Stocks table (dates and times in IST)
  const [hf, setHf] = useState(EMPTY_FILTERS);
  const setHfKey = (k) => (e) => setHf((f) => ({ ...f, [k]: e.target.value }));
  const [sort, setSort] = useState({ key: 'HitTime', dir: 'desc' });
  const [lastLoad, setLastLoad] = useState(null);
  const [showDelete, setShowDelete] = useState(false);
  const page = useHashPage();

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/stocks?limit=5000', { cache: 'no-store' });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setData(j);
      setError('');
      setLastLoad(new Date());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    if (!auto) return;
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [auto, load]);

  const scanNames = useMemo(
    () => [...new Set(data.rows.map((r) => r.ScanName).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [data.rows]
  );
  const hasNoScanRows = useMemo(() => data.rows.some((r) => !r.ScanName), [data.rows]);
  const filtersOn = filter.trim() || hf.period !== 'all' || hf.scan || hf.tFrom || hf.tTo;

  const rows = useMemo(() => {
    const q = filter.trim().toUpperCase();
    const inPeriod = periodMatcher(hf);
    const list = data.rows.filter((r) => {
      if (q && !(r.StockSymbol.includes(q) || String(r.StockID).toUpperCase().includes(q) || String(r.ScanName || '').toUpperCase().includes(q))) return false;
      if (hf.scan === NO_SCAN ? r.ScanName : hf.scan && r.ScanName !== hf.scan) return false;
      if (!inPeriod(istDateOf(r.HitTime))) return false;
      if (hf.tFrom || hf.tTo) {
        const t = istTimeOf(r.HitTime);
        if (hf.tFrom && t < hf.tFrom) return false;
        if (hf.tTo && t > `${hf.tTo}:59`) return false;
      }
      return true;
    });
    const { key, dir } = sort;
    const val = (r) => (key === 'HitTime' ? new Date(r.HitTime).getTime() : r[key] ?? (key === 'TriggerPrice' ? -Infinity : ''));
    return [...list].sort((a, b) => {
      const x = val(a), y = val(b);
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
      return dir === 'asc' ? c : -c;
    });
  }, [data.rows, filter, sort, hf]);

  const stats = useMemo(() => {
    const all = data.rows;
    if (!all.length) return null;
    const profits = all.map((r) => r.PotentialProfit);
    const today = new Date().toDateString();
    return {
      hits: data.total,
      today: all.filter((r) => new Date(r.HitTime).toDateString() === today).length,
      symbols: new Set(all.map((r) => r.StockSymbol)).size,
      avg: profits.reduce((a, b) => a + b, 0) / profits.length,
      best: all.reduce((a, b) => (b.PotentialProfit > a.PotentialProfit ? b : a)),
      last: all[0],
    };
  }, [data]);

  const toggleSort = (key) =>
    setSort((s) => ({ key, dir: s.key === key && s.dir === 'desc' ? 'asc' : 'desc' }));

  return (
    <div className="page">
      <header className="top">
        <div>
          <h1>{page === 'screener' ? 'Stocks Screener' : 'Stock Hits'}</h1>
          <p className="sub">
            {page === 'screener' ? 'Every stock your scans have picked, one row per stock' : 'Signals received through the webhook'}
            {data.storage && <span className="badge">{data.storage === 'blob' ? 'Vercel Blob' : 'local JSON'}</span>}
          </p>
        </div>
        <div className="controls">
          <label className="switch">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
            <span>Auto-refresh</span>
          </label>
          <button className="btn" onClick={load}>Refresh</button>
        </div>
      </header>

      <nav className="tabs" aria-label="Pages">
        <a href="#/" className={page === 'hits' ? 'active' : ''}>Hits</a>
        <a href="#/screener" className={page === 'screener' ? 'active' : ''}>Screener</a>
      </nav>

      {error && <div className="alert">⚠ {error}</div>}

      {page === 'screener' ? (
        <Screener rows={data.rows} total={data.total} loading={loading} lastLoad={lastLoad} />
      ) : (
        <>
      <section className="stats">
        <Stat label="Total hits" value={stats ? stats.hits.toLocaleString() : '—'} />
        <Stat label="Hits today" value={stats ? stats.today.toLocaleString() : '—'} />
        <Stat label="Unique symbols" value={stats ? stats.symbols : '—'} />
        <Stat label="Avg potential profit" value={stats ? num.format(stats.avg) : '—'} tone={stats && stats.avg} />
        <Stat
          label="Best potential profit"
          value={stats ? num.format(stats.best.PotentialProfit) : '—'}
          note={stats?.best.StockSymbol}
          tone={stats && stats.best.PotentialProfit}
        />
        <Stat label="Last hit" value={stats ? timeAgo(stats.last.HitTime) : '—'} note={stats?.last.StockSymbol} />
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Stocks table</h2>
          <div className="head-actions">
            <button
              className={`btn danger-outline ${showDelete ? 'pressed' : ''}`}
              onClick={() => setShowDelete((v) => !v)}
              aria-expanded={showDelete}
            >
              Delete…
            </button>
          </div>
        </div>
        {showDelete && (
          <DeletePanel
            rows={data.rows}
            total={data.total}
            onClose={() => setShowDelete(false)}
            onDeleted={load}
          />
        )}
        <div className="filters hit-filters">
          <input
            className="search"
            placeholder="Search symbol or ID"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <div className="fgroup">
            <span className="flabel">HitTime</span>
            <div className="seg" role="group" aria-label="HitTime">
              {HIT_PERIODS.map(([v, label]) => (
                <button key={v} className={hf.period === v ? 'on' : ''} onClick={() => setHf((f) => ({ ...f, period: v }))}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          {hf.period === 'custom' && (
            <div className="fgroup">
              <input type="date" className="finput" value={hf.from} max={hf.to || undefined} onChange={setHfKey('from')} aria-label="From date" />
              <span className="fsep">to</span>
              <input type="date" className="finput" value={hf.to} min={hf.from || undefined} onChange={setHfKey('to')} aria-label="To date" />
            </div>
          )}
          <div className="fgroup">
            <span className="flabel">Time</span>
            <input type="time" className="finput" value={hf.tFrom} onChange={setHfKey('tFrom')} aria-label="From time" />
            <span className="fsep">to</span>
            <input type="time" className="finput" value={hf.tTo} onChange={setHfKey('tTo')} aria-label="To time" />
          </div>
          <div className="fgroup">
            <span className="flabel">Scan</span>
            <select className="select" value={hf.scan} onChange={setHfKey('scan')}>
              <option value="">All scans</option>
              {scanNames.map((s) => <option key={s} value={s}>{s}</option>)}
              {hasNoScanRows && <option value={NO_SCAN}>(no scan name)</option>}
            </select>
          </div>
          {filtersOn && (
            <button className="link" onClick={() => { setHf(EMPTY_FILTERS); setFilter(''); }}>Clear filters</button>
          )}
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {[
                  ['StockID', 'StockID'],
                  ['HitTime', 'HitTime'],
                  ['StockSymbol', 'StockSymbol'],
                  ['ScanName', 'Scan'],
                  ['TriggerPrice', 'TriggerPrice'],
                  ['PotentialProfit', 'PotentialProfit'],
                ].map(([key, label]) => (
                  <th key={key} className={key === 'PotentialProfit' || key === 'TriggerPrice' ? 'num' : ''}>
                    <button onClick={() => toggleSort(key)}>
                      {label}
                      <span className="arrow">{sort.key === key ? (sort.dir === 'asc' ? '▲' : '▼') : ''}</span>
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.StockID}|${r.HitTime}`}>
                  <td className="mono id" title={r.StockID}>{r.StockID}</td>
                  <td title={r.HitTime}>{dateFmt.format(new Date(r.HitTime))}</td>
                  <td><span className="sym">{r.StockSymbol}</span></td>
                  <td className="scan" title={r.ScanName}>{r.ScanName || <span className="muted-dash">—</span>}</td>
                  <td className="num mono">
                    {typeof r.TriggerPrice === 'number' ? num.format(r.TriggerPrice) : <span className="muted-dash">—</span>}
                  </td>
                  <td className={`num mono ${r.PotentialProfit >= 0 ? 'pos' : 'neg'}`}>
                    {num.format(r.PotentialProfit)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && rows.length === 0 && (
            <div className="empty">
              {data.rows.length ? 'No rows match these filters.' : 'No hits yet. Rows appear here when a Chartink alert fires.'}
            </div>
          )}
          {loading && <div className="empty">Loading…</div>}
        </div>
        <div className="foot">
          Showing {rows.length.toLocaleString()} of {data.total.toLocaleString()}
          {filtersOn && <> · filtered</>}
          {lastLoad && <> · updated {lastLoad.toLocaleTimeString()}</>}
        </div>
      </section>

      <ChartinkSetup secretRequired={data.secretRequired} />

      <div className="two-col">
        <WebhookInfo secretRequired={data.secretRequired} />
        <TestHit secretRequired={data.secretRequired} onSent={load} />
      </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, note, tone }) {
  const cls = typeof tone === 'number' ? (tone >= 0 ? 'pos' : 'neg') : '';
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${cls}`}>{value}</div>
      {note && <div className="stat-note">{note}</div>}
    </div>
  );
}

function WebhookInfo({ secretRequired }) {
  const url = `${window.location.origin}/api/webhook`;
  const [copied, setCopied] = useState('');
  const curl = `curl -X POST ${url} \\
  -H "Content-Type: application/json" \\${secretRequired ? '\n  -H "X-Webhook-Secret: <your-secret>" \\' : ''}
  -d '{"StockSymbol":"RELIANCE","PotentialProfit":125.5,"HitTime":"${new Date().toISOString()}"}'`;

  const copy = async (text, which) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied(''), 1500);
    } catch {}
  };

  return (
    <section className="card pad">
      <h2>Webhook endpoint</h2>
      <p className="muted">Point your third-party application at this URL and send a POST with JSON.</p>
      <div className="url-row">
        <code className="url">{url}</code>
        <button className="btn" onClick={() => copy(url, 'url')}>{copied === 'url' ? 'Copied' : 'Copy'}</button>
      </div>
      <p className="muted small">
        {secretRequired
          ? 'A secret is required: send it as the X-Webhook-Secret header, Authorization: Bearer <secret>, or ?secret=<secret> in the URL.'
          : 'No secret is set, so anyone with this URL can post. Set WEBHOOK_SECRET in Vercel to lock it down.'}
      </p>
      <div className="code-head">
        <span>Example</span>
        <button className="link" onClick={() => copy(curl, 'curl')}>{copied === 'curl' ? 'Copied' : 'Copy'}</button>
      </div>
      <pre className="code">{curl}</pre>
    </section>
  );
}

function TestHit({ secretRequired, onSent }) {
  const [form, setForm] = useState({ StockSymbol: '', PotentialProfit: '', StockID: '', secret: '' });
  const [status, setStatus] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setStatus({ kind: 'busy', text: 'Sending…' });
    const body = { StockSymbol: form.StockSymbol, PotentialProfit: form.PotentialProfit };
    if (form.StockID.trim()) body.StockID = form.StockID.trim();
    try {
      const r = await fetch('/api/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(form.secret ? { 'X-Webhook-Secret': form.secret } : {}),
        },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!j.ok) {
        const detail = j.invalid?.flatMap((i) => i.errors).join('; ');
        throw new Error(detail || j.error);
      }
      setStatus({ kind: 'ok', text: `Stored ${j.records[0]?.StockSymbol} (${r.status})` });
      setForm((f) => ({ ...f, StockSymbol: '', PotentialProfit: '', StockID: '' }));
      onSent();
    } catch (err) {
      setStatus({ kind: 'err', text: err.message });
    }
  };

  return (
    <section className="card pad">
      <h2>Send a test hit</h2>
      <p className="muted">Posts to the webhook exactly like an external app would.</p>
      <form className="form" onSubmit={submit}>
        <label>
          StockSymbol
          <input required value={form.StockSymbol} onChange={set('StockSymbol')} placeholder="TCS" />
        </label>
        <label>
          PotentialProfit
          <input required inputMode="decimal" value={form.PotentialProfit} onChange={set('PotentialProfit')} placeholder="42.75" />
        </label>
        <label>
          StockID <span className="opt">optional</span>
          <input value={form.StockID} onChange={set('StockID')} placeholder="auto-generated" />
        </label>
        {secretRequired && (
          <label>
            Webhook secret
            <input type="password" value={form.secret} onChange={set('secret')} />
          </label>
        )}
        <div className="form-actions">
          <button className="btn primary" type="submit" disabled={status?.kind === 'busy'}>Send hit</button>
          {status && <span className={`status ${status.kind}`}>{status.text}</span>}
        </div>
      </form>
    </section>
  );
}

function ChartinkSetup({ secretRequired }) {
  const [secret, setSecret] = useState('');
  const [target, setTarget] = useState('5');
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState(null);

  const params = new URLSearchParams();
  if (secret) params.set('secret', secret);
  if (target.trim() !== '') params.set('target', target.trim());
  const qs = params.toString();
  const url = `${window.location.origin}/api/webhook${qs ? `?${qs}` : ''}`;
  const isLocal = /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  // Sends a payload shaped exactly like a Chartink alert.
  const sendSample = async () => {
    setStatus({ kind: 'busy', text: 'Sending sample alert…' });
    const now = new Date();
    const h = now.getHours() % 12 || 12;
    const m = String(now.getMinutes()).padStart(2, '0');
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stocks: 'TATAMOTORS,SBIN,HDFCBANK',
          trigger_prices: '712.45,818.1,1702.6',
          triggered_at: `${h}:${m} ${now.getHours() < 12 ? 'am' : 'pm'}`,
          scan_name: 'Sample breakout scan',
          scan_url: 'sample-breakout-scan',
          alert_name: 'Alert for Sample breakout scan',
          webhook_url: url,
        }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      setStatus({ kind: 'ok', text: `Stored ${j.inserted} rows${j.duplicates ? `, ${j.duplicates} duplicates ignored` : ''}` });
    } catch (e) {
      setStatus({ kind: 'err', text: e.message });
    }
  };

  return (
    <section className="card pad chartink">
      <div className="ck-head">
        <h2>Connect Chartink</h2>
        <span className="badge">Premium · Alerts → Webhook</span>
      </div>
      <ol className="steps">
        <li>On Chartink, open your scan and create (or edit) an alert for it.</li>
        <li>Paste the URL below into the alert's <b>Webhook URL</b> field and save.</li>
        <li>Each stock in an alert becomes one row. Alerts fire during market hours.</li>
      </ol>
      <div className="ck-fields">
        {secretRequired && (
          <label>
            Webhook secret
            <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="your WEBHOOK_SECRET" />
          </label>
        )}
        <label>
          Target % for PotentialProfit
          <input inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} />
        </label>
      </div>
      <div className="url-row">
        <code className="url">{url}</code>
        <button className="btn" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
      <p className="muted small">
        PotentialProfit = trigger price × target % (₹ per share). Use a different <code>target</code> per alert if your scans
        have different targets. If you add a result column named <code>potential_profit</code> to the alert, that value is used instead.
        {isLocal && ' This is a local address — Chartink needs your Vercel URL, so copy it from the deployed site.'}
        {secretRequired && !secret && ' Enter your secret so it is included in the URL.'}
      </p>
      <div className="form-actions">
        <button className="btn" onClick={sendSample} disabled={status?.kind === 'busy' || (secretRequired && !secret)}>
          Send a sample Chartink alert
        </button>
        {status && <span className={`status ${status.kind}`}>{status.text}</span>}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- delete

const DAY_MS = 86_400_000;
const istDayStart = (d) => Date.parse(`${d}T00:00:00+05:30`);
// Today's date in India as YYYY-MM-DD
const istToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const istDateOf = (iso) => new Date(new Date(iso).getTime() + 330 * 60_000).toISOString().slice(0, 10);
const SECRET_KEY = 'stockhits.secret';

function readSavedSecret() {
  try {
    return localStorage.getItem(SECRET_KEY) || '';
  } catch {
    return '';
  }
}

function DeletePanel({ rows, total, onClose, onDeleted }) {
  const today = istToday();
  const oldest = rows.length ? istDateOf(rows.reduce((a, b) => (a.HitTime < b.HitTime ? a : b)).HitTime) : today;
  const [mode, setMode] = useState('range');
  const [from, setFrom] = useState(oldest);
  const [to, setTo] = useState(today);
  const [secret, setSecret] = useState(readSavedSecret);
  const [remember, setRemember] = useState(() => Boolean(readSavedSecret()));
  const [confirming, setConfirming] = useState(false);
  const [status, setStatus] = useState(null);

  const rangeError = mode === 'range' && (!from || !to ? 'Pick both dates' : from > to ? '"From" must be on or before "To"' : '');

  const count = useMemo(() => {
    if (mode === 'all') return total;
    if (rangeError) return 0;
    const start = istDayStart(from);
    const end = istDayStart(to) + DAY_MS;
    return rows.filter((r) => {
      const t = new Date(r.HitTime).getTime();
      return t >= start && t < end;
    }).length;
  }, [mode, from, to, rows, total, rangeError]);

  // Any change to what will be deleted cancels a pending confirmation.
  useEffect(() => setConfirming(false), [mode, from, to]);

  const doDelete = async () => {
    setStatus({ kind: 'busy', text: 'Deleting…' });
    try {
      try {
        if (remember) localStorage.setItem(SECRET_KEY, secret.trim());
        else localStorage.removeItem(SECRET_KEY);
      } catch {}
      const r = await fetch('/api/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': secret.trim() },
        body: JSON.stringify(mode === 'all' ? { mode } : { mode, from, to }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setStatus({ kind: 'ok', text: `Deleted ${j.deleted.toLocaleString()} rows. ${j.remaining.toLocaleString()} left.` });
      setConfirming(false);
      onDeleted();
    } catch (e) {
      setStatus({ kind: 'err', text: e.message });
      setConfirming(false);
    }
  };

  const what =
    mode === 'all'
      ? 'all data'
      : from === to
        ? fmtDay(from)
        : `${fmtDay(from)} – ${fmtDay(to)}`;

  return (
    <div className="delete-panel">
      <div className="dp-row">
        <div className="seg" role="group" aria-label="What to delete">
          <button className={mode === 'range' ? 'on' : ''} onClick={() => setMode('range')}>Date range</button>
          <button className={mode === 'all' ? 'on' : ''} onClick={() => setMode('all')}>All data</button>
        </div>
        {mode === 'range' && (
          <div className="dp-dates">
            <label>
              From
              <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label>
              To
              <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
            </label>
            <span className="dp-quick">
              <button className="link" onClick={() => { setFrom(today); setTo(today); }}>Today</button>
              <button className="link" onClick={() => { setFrom(oldest); setTo(today); }}>Everything so far</button>
            </span>
          </div>
        )}
        <button className="link dp-close" onClick={onClose} aria-label="Close">Close</button>
      </div>

      <div className="dp-row">
        <label className="dp-secret">
          Webhook secret
          <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="same as in Vercel" autoComplete="off" />
        </label>
        <label className="switch dp-remember">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          <span>Remember on this device</span>
        </label>
      </div>

      <div className="dp-row dp-foot">
        <p className={`dp-summary ${count ? 'warn' : ''}`}>
          {rangeError
            ? rangeError
            : count
              ? <>This permanently deletes <b>{count.toLocaleString()}</b> {count === 1 ? 'row' : 'rows'} ({what}). It can't be undone.</>
              : mode === 'all' ? <>There is no data to delete.</> : <>No rows in this date range.</>}
          {mode === 'range' && !rangeError && <span className="dp-note"> Dates are in Indian time and include both days.</span>}
        </p>
        <div className="form-actions">
          {!confirming ? (
            <button
              className="btn danger"
              disabled={!count || !secret.trim() || status?.kind === 'busy'}
              onClick={() => setConfirming(true)}
            >
              Delete {count ? count.toLocaleString() : ''} {count === 1 ? 'row' : 'rows'}
            </button>
          ) : (
            <>
              <span className="dp-ask">Are you sure?</span>
              <button className="btn danger" onClick={doDelete} disabled={status?.kind === 'busy'}>
                Yes, delete {mode === 'all' ? 'everything' : count.toLocaleString()}
              </button>
              <button className="btn" onClick={() => setConfirming(false)}>Cancel</button>
            </>
          )}
          {status && <span className={`status ${status.kind}`}>{status.text}</span>}
        </div>
      </div>
    </div>
  );
}

function fmtDay(d) {
  return new Date(`${d}T12:00:00+05:30`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
}
