import { useMemo, useState } from 'react';
import { AddToTicker, OrderButtons } from './AddToTicker.jsx';

// First Hit: for each day (Indian time), the first time each stock was picked,
// with how many more times — and by which scans — it was picked that day.

const price = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const time = new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
const dayLabel = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const istDate = (iso) => new Date(new Date(iso).getTime() + 330 * 60_000).toISOString().slice(0, 10);
const istToday = () => istDate(new Date().toISOString());
const NO_SCAN = '__none__';

export default function FirstHits({ rows, loading }) {
  const [day, setDay] = useState('today'); // 'today' | 'YYYY-MM-DD' | 'all'
  const [scan, setScan] = useState('');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState({ key: 'first', dir: 'desc' });

  const today = istToday();
  const days = useMemo(() => [...new Set(rows.map((r) => istDate(r.HitTime)))].sort().reverse(), [rows]);
  const scans = useMemo(() => [...new Set(rows.map((r) => r.ScanName).filter(Boolean))].sort((a, b) => a.localeCompare(b)), [rows]);
  const hasNoScan = rows.some((r) => !r.ScanName);
  const wantDay = day === 'today' ? today : day;

  // One row per (day, stock): the earliest hit, plus later hits that day
  const firsts = useMemo(() => {
    const groups = new Map();
    for (const r of rows) {
      if (scan === NO_SCAN ? r.ScanName : scan && r.ScanName !== scan) continue;
      const d = istDate(r.HitTime);
      if (wantDay !== 'all' && d !== wantDay) continue;
      const k = `${d}|${r.StockSymbol}`;
      let g = groups.get(k);
      if (!g) groups.set(k, (g = { day: d, symbol: r.StockSymbol, hits: [] }));
      g.hits.push(r);
    }
    return [...groups.values()].map((g) => {
      g.hits.sort((a, b) => new Date(a.HitTime) - new Date(b.HitTime));
      const first = g.hits[0];
      const last = g.hits[g.hits.length - 1];
      const later = [...new Set(g.hits.slice(1).map((h) => h.ScanName).filter((s) => s && s !== first.ScanName))];
      return {
        key: `${g.day}|${g.symbol}`,
        day: g.day,
        symbol: g.symbol,
        first: new Date(first.HitTime).getTime(),
        firstIso: first.HitTime,
        scan: first.ScanName || '',
        price: typeof first.TriggerPrice === 'number' ? first.TriggerPrice : null,
        lastPrice: typeof last.TriggerPrice === 'number' ? last.TriggerPrice : null,
        count: g.hits.length,
        laterScans: later,
      };
    });
  }, [rows, wantDay, scan]);

  const view = useMemo(() => {
    const term = q.trim().toUpperCase();
    const list = firsts.filter((f) => !term || f.symbol.includes(term));
    const { key, dir } = sort;
    return list.sort((a, b) => {
      const c = key === 'symbol' ? a.symbol.localeCompare(b.symbol) : (a[key] ?? -Infinity) - (b[key] ?? -Infinity);
      return (dir === 'asc' ? c : -c) || b.first - a.first;
    });
  }, [firsts, q, sort]);

  const repeat = firsts.filter((f) => f.count > 1).length;
  const toggle = (key) => setSort((s) => (s.key === key ? { key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: key === 'symbol' ? 'asc' : 'desc' }));
  const Th = ({ k, children, num }) => (
    <th className={num ? 'num' : ''}>
      <button onClick={() => toggle(k)}>
        {children}
        <span className="arrow">{sort.key === k ? (sort.dir === 'asc' ? '▲' : '▼') : ''}</span>
      </button>
    </th>
  );
  const label = wantDay === 'all' ? 'all days' : wantDay === today ? 'today' : dayLabel.format(new Date(`${wantDay}T00:00:00Z`));

  return (
    <>
      <section className="stats stats-4">
        <Tile label={`Stocks first hit ${wantDay === 'all' ? '(all days)' : wantDay === today ? 'today' : `on ${label}`}`} value={firsts.length} />
        <Tile label="Picked again later that day" value={repeat} />
        <Tile label="Latest first hit" value={view.length ? [...firsts].sort((a, b) => b.first - a.first)[0].symbol : '—'} mono />
        <Tile label="Scans in view" value={new Set(firsts.map((f) => f.scan).filter(Boolean)).size || '—'} />
      </section>

      <section className="card">
        <div className="filters">
          <input className="search" placeholder="Search stock" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="fgroup">
            <span className="flabel">Day</span>
            <select className="select" value={day} onChange={(e) => setDay(e.target.value)} aria-label="Day">
              <option value="today">Today</option>
              {days.filter((d) => d !== today).map((d) => (
                <option key={d} value={d}>{dayLabel.format(new Date(`${d}T00:00:00Z`))}</option>
              ))}
              <option value="all">All days (first hit per day)</option>
            </select>
          </div>
          <div className="fgroup">
            <span className="flabel">Scan</span>
            <select className="select" value={scan} onChange={(e) => setScan(e.target.value)} aria-label="Scan">
              <option value="">All scans</option>
              {scans.map((s) => <option key={s} value={s}>{s}</option>)}
              {hasNoScan && <option value={NO_SCAN}>(no scan name)</option>}
            </select>
          </div>
        </div>
        <div className="table-wrap">
          <table className="firsthits">
            <thead>
              <tr>
                <Th k="first">First hit</Th>
                <Th k="symbol">Stock</Th>
                <th className="plain-th">Scan</th>
                <Th k="price" num>Trigger ₹</Th>
                <Th k="count" num>Hits that day</Th>
                <th className="plain-th">Also picked by</th>
                <th className="plain-th" title="Buy or Sell when the price reaches your level (Equity Intraday paper trade)">Trade at price</th>
                <th className="plain-th" aria-label="Add to Ticker" />
              </tr>
            </thead>
            <tbody>
              {view.map((f) => (
                <tr key={f.key}>
                  <td title={f.firstIso}>
                    <span className="mono">{time.format(f.first)}</span>
                    {wantDay === 'all' && <span className="muted-cell fh-day"> · {dayLabel.format(new Date(`${f.day}T00:00:00Z`)).replace(/ \d{4}$/, '')}</span>}
                  </td>
                  <td><span className="sym">{f.symbol}</span></td>
                  <td className="scan" title={f.scan}>{f.scan || <span className="muted-dash">—</span>}</td>
                  <td className="num mono">{f.price != null ? price.format(f.price) : <span className="muted-dash">—</span>}</td>
                  <td className="num mono">{f.count > 1 ? <b>{f.count}</b> : 1}</td>
                  <td className="muted-cell fh-later" title={f.laterScans.join('\n')}>
                    {f.laterScans.length ? f.laterScans.join(', ') : <span className="muted-dash">—</span>}
                  </td>
                  <td className="fh-trade"><OrderButtons symbol={f.symbol} refPrice={f.price} /></td>
                  <td className="fh-add"><AddToTicker symbol={f.symbol} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && view.length === 0 && (
            <div className="empty">{rows.length ? `No first hits for ${label}${scan ? ' in this scan' : ''}.` : 'No hits yet. Stocks appear here when a Chartink alert fires.'}</div>
          )}
          {loading && <div className="empty">Loading…</div>}
        </div>
        <div className="foot">
          {view.length} {view.length === 1 ? 'stock' : 'stocks'} · each stock’s first hit of the day (Indian time)
          {scan ? ' within the selected scan' : ' across all scans'}
          {' '}· B / S: take an Equity Intraday paper trade when the price reaches your level
        </div>
      </section>
    </>
  );
}

function Tile({ label, value, mono }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${mono ? 'mono-val' : ''}`}>{value}</div>
    </div>
  );
}
