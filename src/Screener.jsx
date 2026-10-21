import { Fragment, useMemo, useState } from 'react';

const num = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const pct = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2, signDisplay: 'exceptZero' });
const dateTime = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const fullDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

const PERIODS = [
  ['today', 'Today'],
  ['7d', '7 days'],
  ['30d', '30 days'],
  ['all', 'All time'],
];

function periodStart(period) {
  const now = new Date();
  if (period === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (period === '7d') return now.getTime() - 7 * 86400_000;
  if (period === '30d') return now.getTime() - 30 * 86400_000;
  return -Infinity;
}

const COLS = [
  { key: 'symbol', label: 'Stock', type: 'text' },
  { key: 'hits', label: 'Hits', type: 'num' },
  { key: 'lastHit', label: 'Last hit', type: 'num' },
  { key: 'firstHit', label: 'First hit', type: 'num' },
  { key: 'latestPrice', label: 'Last trigger ₹', type: 'num' },
  { key: 'priceMove', label: 'Since first hit', type: 'num' },
  { key: 'latestProfit', label: 'Potential profit', type: 'num' },
  { key: 'maxProfit', label: 'Best profit', type: 'num' },
  { key: 'scanCount', label: 'Scans', type: 'num' },
];

export default function Screener({ rows, total, loading, lastLoad }) {
  const [q, setQ] = useState('');
  const [scan, setScan] = useState('');
  const [period, setPeriod] = useState('all');
  const [minHits, setMinHits] = useState(1);
  const [sort, setSort] = useState({ key: 'lastHit', dir: 'desc' });
  const [open, setOpen] = useState(null);

  const scans = useMemo(
    () => [...new Set(rows.map((r) => r.ScanName).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [rows]
  );

  // Hits inside the chosen period and scan, grouped into one row per stock.
  const { stocks, hitsInView } = useMemo(() => {
    const from = periodStart(period);
    const hits = rows.filter(
      (r) => new Date(r.HitTime).getTime() >= from && (!scan || r.ScanName === scan)
    );
    const map = new Map();
    for (const h of hits) {
      let s = map.get(h.StockSymbol);
      if (!s) map.set(h.StockSymbol, (s = { symbol: h.StockSymbol, list: [] }));
      s.list.push(h);
    }
    const out = [];
    for (const s of map.values()) {
      s.list.sort((a, b) => new Date(b.HitTime) - new Date(a.HitTime));
      const latest = s.list[0];
      const first = s.list[s.list.length - 1];
      const profits = s.list.map((h) => h.PotentialProfit).filter((v) => typeof v === 'number');
      const latestPrice = typeof latest.TriggerPrice === 'number' ? latest.TriggerPrice : null;
      const firstPrice = typeof first.TriggerPrice === 'number' ? first.TriggerPrice : null;
      const scanSet = [...new Set(s.list.map((h) => h.ScanName).filter(Boolean))];
      out.push({
        symbol: s.symbol,
        list: s.list,
        hits: s.list.length,
        lastHit: new Date(latest.HitTime).getTime(),
        firstHit: new Date(first.HitTime).getTime(),
        latestPrice,
        priceMove: latestPrice != null && firstPrice && s.list.length > 1 ? ((latestPrice - firstPrice) / firstPrice) * 100 : null,
        latestProfit: latest.PotentialProfit,
        maxProfit: profits.length ? Math.max(...profits) : null,
        avgProfit: profits.length ? profits.reduce((a, b) => a + b, 0) / profits.length : null,
        scans: scanSet,
        scanCount: scanSet.length,
      });
    }
    return { stocks: out, hitsInView: hits.length };
  }, [rows, period, scan]);

  const visible = useMemo(() => {
    const term = q.trim().toUpperCase();
    const list = stocks.filter((s) => s.hits >= minHits && (!term || s.symbol.includes(term)));
    const { key, dir } = sort;
    const missing = dir === 'asc' ? Infinity : -Infinity; // blanks always sort last
    return list.sort((a, b) => {
      const x = a[key] ?? missing;
      const y = b[key] ?? missing;
      const c = typeof x === 'string' ? x.localeCompare(y) : x - y;
      return (dir === 'asc' ? c : -c) || b.lastHit - a.lastHit;
    });
  }, [stocks, q, minHits, sort]);

  const maxHits = Math.max(1, ...visible.map((s) => s.hits));
  const repeat = stocks.filter((s) => s.hits > 1).length;
  const top = stocks.reduce((a, b) => (!a || b.hits > a.hits ? b : a), null);

  const toggleSort = (key) =>
    setSort((s) => ({ key, dir: s.key === key ? (s.dir === 'desc' ? 'asc' : 'desc') : key === 'symbol' ? 'asc' : 'desc' }));

  const exportCsv = () => {
    const header = ['Stock', 'Hits', 'LastHit', 'FirstHit', 'LastTriggerPrice', 'PctSinceFirstHit', 'PotentialProfit', 'BestProfit', 'Scans'];
    const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const lines = visible.map((s) =>
      [
        s.symbol,
        s.hits,
        new Date(s.lastHit).toISOString(),
        new Date(s.firstHit).toISOString(),
        s.latestPrice ?? '',
        s.priceMove != null ? s.priceMove.toFixed(2) : '',
        s.latestProfit ?? '',
        s.maxProfit ?? '',
        s.scans.join(' | '),
      ].map(esc).join(',')
    );
    const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `screener-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <>
      <section className="stats stats-4">
        <Tile label="Stocks picked" value={stocks.length.toLocaleString()} />
        <Tile label="Hits in view" value={hitsInView.toLocaleString()} />
        <Tile label="Picked more than once" value={repeat.toLocaleString()} />
        <Tile label="Most picked" value={top ? top.symbol : '—'} note={top ? `${top.hits} hits` : ''} mono />
      </section>

      <section className="card">
        <div className="filters">
          <input className="search" placeholder="Search stock" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="seg" role="group" aria-label="Period">
            {PERIODS.map(([v, label]) => (
              <button key={v} className={period === v ? 'on' : ''} onClick={() => setPeriod(v)}>{label}</button>
            ))}
          </div>
          <select className="select" value={scan} onChange={(e) => setScan(e.target.value)}>
            <option value="">All scans</option>
            {scans.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <label className="minhits">
            Min hits
            <input type="number" min="1" value={minHits} onChange={(e) => setMinHits(Math.max(1, parseInt(e.target.value, 10) || 1))} />
          </label>
          <button className="btn push" onClick={exportCsv} disabled={!visible.length}>Export CSV</button>
        </div>

        <div className="table-wrap tall">
          <table className="screener">
            <thead>
              <tr>
                {COLS.map((c) => (
                  <th key={c.key} className={c.type === 'num' && c.key !== 'lastHit' && c.key !== 'firstHit' ? 'num' : ''}>
                    <button onClick={() => toggleSort(c.key)}>
                      {c.label}
                      <span className="arrow">{sort.key === c.key ? (sort.dir === 'asc' ? '▲' : '▼') : ''}</span>
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((s) => (
                <Fragment key={s.symbol}>
                  <tr className={`clickable ${open === s.symbol ? 'open' : ''}`} onClick={() => setOpen(open === s.symbol ? null : s.symbol)}>
                    <td>
                      <span className="caret">{open === s.symbol ? '▾' : '▸'}</span>
                      <span className="sym">{s.symbol}</span>
                    </td>
                    <td className="num">
                      <span className="hitbar"><span style={{ width: `${(s.hits / maxHits) * 100}%` }} /></span>
                      <span className="mono">{s.hits}</span>
                    </td>
                    <td title={fullDate.format(s.lastHit)}>{dateTime.format(s.lastHit)}</td>
                    <td title={fullDate.format(s.firstHit)} className="muted-cell">{dateTime.format(s.firstHit)}</td>
                    <td className="num mono">{s.latestPrice != null ? num.format(s.latestPrice) : <Dash />}</td>
                    <td className={`num mono ${s.priceMove > 0 ? 'pos' : s.priceMove < 0 ? 'neg' : ''}`}>
                      {s.priceMove != null ? `${pct.format(s.priceMove)}%` : <Dash />}
                    </td>
                    <td className={`num mono ${s.latestProfit >= 0 ? 'pos' : 'neg'}`}>{num.format(s.latestProfit)}</td>
                    <td className="num mono">{s.maxProfit != null ? num.format(s.maxProfit) : <Dash />}</td>
                    <td className="num" title={s.scans.join('\n')}>
                      {s.scanCount ? <span className="pill">{s.scanCount === 1 ? truncate(s.scans[0], 22) : `${s.scanCount} scans`}</span> : <Dash />}
                    </td>
                  </tr>
                  {open === s.symbol && (
                    <tr className="detail">
                      <td colSpan={COLS.length}>
                        <History stock={s} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
          {!loading && visible.length === 0 && (
            <div className="empty">
              {rows.length ? 'No stocks match these filters.' : 'No hits yet. Stocks appear here once a Chartink alert fires.'}
            </div>
          )}
          {loading && <div className="empty">Loading…</div>}
        </div>
        <div className="foot">
          {visible.length.toLocaleString()} stocks · from {total.toLocaleString()} stored hits
          {lastLoad && <> · updated {lastLoad.toLocaleTimeString()}</>}
        </div>
      </section>
    </>
  );
}

function History({ stock }) {
  return (
    <div className="history">
      <div className="history-head">
        <b>{stock.symbol}</b> — {stock.hits} {stock.hits === 1 ? 'hit' : 'hits'}
        {stock.avgProfit != null && <> · average potential profit {num.format(stock.avgProfit)}</>}
      </div>
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Scan</th>
            <th className="num">Trigger ₹</th>
            <th className="num">Potential profit</th>
            <th>StockID</th>
          </tr>
        </thead>
        <tbody>
          {stock.list.map((h) => (
            <tr key={`${h.StockID}|${h.HitTime}`}>
              <td>{fullDate.format(new Date(h.HitTime))}</td>
              <td className="muted-cell">{h.ScanName || '—'}</td>
              <td className="num mono">{typeof h.TriggerPrice === 'number' ? num.format(h.TriggerPrice) : '—'}</td>
              <td className={`num mono ${h.PotentialProfit >= 0 ? 'pos' : 'neg'}`}>{num.format(h.PotentialProfit)}</td>
              <td className="mono muted-cell small-id">{h.StockID}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Tile({ label, value, note, mono }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${mono ? 'mono-val' : ''}`}>{value}</div>
      {note && <div className="stat-note">{note}</div>}
    </div>
  );
}

const Dash = () => <span className="muted-dash">—</span>;
const truncate = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
