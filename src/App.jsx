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
  const [sort, setSort] = useState({ key: 'HitTime', dir: 'desc' });
  const [lastLoad, setLastLoad] = useState(null);
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

  const rows = useMemo(() => {
    const q = filter.trim().toUpperCase();
    const list = q
      ? data.rows.filter(
          (r) =>
            r.StockSymbol.includes(q) ||
            String(r.StockID).toUpperCase().includes(q) ||
            String(r.ScanName || '').toUpperCase().includes(q)
        )
      : data.rows;
    const { key, dir } = sort;
    const val = (r) => (key === 'HitTime' ? new Date(r.HitTime).getTime() : r[key] ?? (key === 'TriggerPrice' ? -Infinity : ''));
    return [...list].sort((a, b) => {
      const x = val(a), y = val(b);
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
      return dir === 'asc' ? c : -c;
    });
  }, [data.rows, filter, sort]);

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
          <input
            className="search"
            placeholder="Filter by symbol, scan or ID"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
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
              {data.rows.length ? 'No rows match the filter.' : 'No hits yet. Rows appear here when a Chartink alert fires.'}
            </div>
          )}
          {loading && <div className="empty">Loading…</div>}
        </div>
        <div className="foot">
          Showing {rows.length.toLocaleString()} of {data.total.toLocaleString()}
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
