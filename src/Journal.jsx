import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PRODUCT_LABEL, PRODUCT_SHORT, SECRET_KEY, SecretGate, api, describe, money, price, signed, store } from './Ticker.jsx';
import { BOOK_EVENT } from './Orders.jsx';

// Trades: every paper trade from entry to exit, with P&L, timing and your
// journal notes (saved on the server, table "trade_journal").

const PAGE_SIZES = [20, 50, 100];
const dayFmt = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
const dayShort = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
const timeFmt = new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
const shortTime = new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
const stamp = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
const istDate = (iso) => new Date(Date.parse(iso) + 330 * 60_000).toISOString().slice(0, 10);
const tone = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
const pctText = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`);

function held(ms) {
  if (ms == null) return null;
  const m = Math.round(ms / 60_000);
  if (m < 1) return '<1 min';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ${m % 60} min`;
  const d = Math.floor(h / 24);
  return `${d} d ${h % 24} h`;
}

const PERIODS = [
  ['today', 'Today'],
  ['7d', '7 days'],
  ['30d', '30 days'],
  ['all', 'All'],
];

export default function Journal({ subview = 'all' }) {
  const [secret, setSecret] = useState(() => store.get(SECRET_KEY));
  const [checking, setChecking] = useState(Boolean(store.get(SECRET_KEY)));
  const [unlocked, setUnlocked] = useState(false);
  const [error, setError] = useState('');
  const [data, setData] = useState(null); // { trips, notes }
  const [quotes, setQuotes] = useState({});
  const [q, setQ] = useState('');
  const [period, setPeriod] = useState('all');
  const [type, setType] = useState('');
  const [result, setResult] = useState(''); // '' | win | loss | open
  const [sort, setSort] = useState({ key: 'openedAt', dir: 'desc' });
  const [pageSize, setPageSize] = useState(20);
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState(null); // expanded row
  const [editId, setEditId] = useState(null); // row whose note is being edited
  const [selected, setSelected] = useState(() => new Set()); // trade ids ticked for deleting
  const [confirmDel, setConfirmDel] = useState(false);
  const [delMsg, setDelMsg] = useState(null); // { kind, text }

  const load = useCallback(async (s) => {
    try {
      setData(await api(s, 'journal'));
      setUnlocked(true);
      setError('');
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

  // A position was exited from the running P&L pill → reload the trades
  useEffect(() => {
    if (!unlocked) return;
    const on = (e) => e.detail?.source === 'livepnl' && load(secret);
    window.addEventListener(BOOK_EVENT, on);
    return () => window.removeEventListener(BOOK_EVENT, on);
  }, [unlocked, secret, load]);

  // Live price for trades still open (every 5 s; slower when the tab is hidden)
  const openKeys = useMemo(() => [...new Set((data?.trips || []).filter((t) => t.status === 'OPEN').map((t) => t.key))].join(','), [data]);
  useEffect(() => {
    if (!unlocked || !openKeys) return;
    let alive = true;
    let timer;
    const tick = async () => {
      try {
        const j = await api(secret, 'quotes', { params: { keys: openKeys } });
        if (alive) setQuotes((x) => ({ ...x, ...j.quotes }));
        if (alive && j.orders?.events?.length) load(secret); // a trigger order filled
      } catch {
        /* open P&L stays unknown */
      }
      if (alive) timer = setTimeout(tick, document.hidden ? 30_000 : 5_000);
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [unlocked, openKeys, secret, load]);

  const notes = data?.notes || {};
  const today = istDate(new Date().toISOString());

  const rows = useMemo(() => {
    const from = period === 'today' ? today : period === '7d' ? istDate(new Date(Date.now() - 6 * 86_400_000).toISOString()) : period === '30d' ? istDate(new Date(Date.now() - 29 * 86_400_000).toISOString()) : '';
    const term = q.trim().toUpperCase();
    return (data?.trips || [])
      .map((t) => {
        const ltp = t.status === 'OPEN' ? quotes[t.key]?.ltp ?? null : null;
        const live = ltp != null ? t.openQty * (ltp - t.avgOpen) * (t.side === 'LONG' ? 1 : -1) : null;
        const total = t.status === 'OPEN' ? (live != null ? t.net + live : null) : t.net;
        // Open trades: running P&L % on the money deployed (entry value ÷ leverage), like closed ones
        const deployed = t.entryValue / (t.leverage || 1);
        const marginPct = t.status === 'OPEN' ? (total != null && deployed > 0 ? Math.round((total / deployed) * 10_000) / 100 : null) : t.marginPct;
        return { ...t, ltp, live, total, marginPct, note: notes[t.id] || null, date: istDate(t.openedAt) };
      })
      .filter((t) => !from || t.date >= from)
      .filter((t) => !type || t.product === type)
      .filter((t) => (result === 'win' ? t.status === 'CLOSED' && t.net > 0 : result === 'loss' ? t.status === 'CLOSED' && t.net <= 0 : result === 'open' ? t.status === 'OPEN' : true))
      .filter((t) => subview !== 'notes' || t.note)
      .filter((t) => !term || describe(t).toUpperCase().includes(term) || t.symbol.toUpperCase().includes(term) || (t.note?.note || '').toUpperCase().includes(term));
  }, [data, quotes, notes, period, type, result, q, subview, today]);

  const sorted = useMemo(() => {
    const { key, dir } = sort;
    const val = (t) => (key === 'symbol' ? describe(t) : t[key]);
    return [...rows].sort((a, b) => {
      const x = val(a);
      const y = val(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      const c = typeof x === 'string' ? x.localeCompare(y) : x - y;
      return dir === 'asc' ? c : -c;
    });
  }, [rows, sort]);

  useEffect(() => setPage(1), [q, period, type, result, sort, pageSize, subview]);
  const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const cur = Math.min(page, pages);
  const shown = sorted.slice((cur - 1) * pageSize, cur * pageSize);

  // Summary of what the filters show
  const sum = useMemo(() => {
    const closed = rows.filter((t) => t.status === 'CLOSED');
    const wins = closed.filter((t) => t.net > 0);
    const net = rows.reduce((s, t) => s + t.net, 0);
    const pcts = closed.map((t) => t.marginPct).filter((v) => v != null);
    const openRows = rows.filter((t) => t.status === 'OPEN');
    return {
      count: rows.length,
      open: rows.length - closed.length,
      closed: closed.length,
      winRate: closed.length ? (wins.length / closed.length) * 100 : null,
      wins: wins.length,
      net,
      charges: rows.reduce((s, t) => s + t.charges, 0),
      avgPct: pcts.length ? pcts.reduce((s, v) => s + v, 0) / pcts.length : null,
      best: closed.reduce((a, t) => (!a || t.net > a.net ? t : a), null),
      worst: closed.reduce((a, t) => (!a || t.net < a.net ? t : a), null),
      noted: rows.filter((t) => t.note).length,
      running: openRows.length ? (openRows.some((t) => t.live == null) ? null : openRows.reduce((s, t) => s + t.live, 0)) : undefined,
    };
  }, [rows]);

  const saveNote = async (id, text) => {
    const j = await api(secret, 'journal-note', { method: 'POST', body: { id, note: text } });
    setData((d) => {
      const n = { ...d.notes };
      if (j.note) n[id] = j.note;
      else delete n[id];
      return { ...d, notes: n };
    });
    return j.note;
  };

  // Delete closed trades (their fills and notes). Removes their P&L from reports and balances.
  const deleteTrips = async (ids) => {
    setDelMsg({ kind: 'busy', text: 'Deleting…' });
    try {
      const j = await api(secret, 'journal-delete', { method: 'POST', body: { ids } });
      setData((d) => ({ ...d, trips: j.trips, notes: j.notes }));
      setSelected(new Set());
      setConfirmDel(false);
      setOpenId(null);
      setDelMsg({ kind: 'ok', text: `Deleted ${j.deleted} ${j.deleted === 1 ? 'trade' : 'trades'}.` });
      return true;
    } catch (e) {
      setDelMsg({ kind: 'err', text: e.message });
      return false;
    }
  };
  const toggleSel = (id) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const exportCsv = () => {
    const head = ['Date', 'Instrument', 'Type', 'Side', 'Qty', 'EntryTime', 'AvgEntry', 'ExitTime', 'AvgExit', 'Status', 'Held', 'GrossPnL', 'Brokerage', 'NetPnL', 'PnLPctOnMoneyDeployed', 'PnLPctOnPositionValue', 'Source', 'Note'];
    const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const lines = sorted.map((t) =>
      [t.date, describe(t), PRODUCT_LABEL[t.product] || t.product, t.side, t.qty, t.openedAt, t.avgEntry, t.closedAt || '', t.avgExit ?? '', t.status, held(t.holdMs) || '', t.gross, t.charges, t.net, t.marginPct ?? '', t.pnlPct ?? '', t.viaOrder ? 'Trigger order' : 'Manual', t.note?.note || '']
        .map(esc)
        .join(',')
    );
    const blob = new Blob([[head.join(','), ...lines].join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `trade-journal-${today}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  if (checking) return <p className="tk-note">Opening trades…</p>;
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

  const toggleSort = (key) => setSort((s) => (s.key === key ? { key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: key === 'symbol' ? 'asc' : 'desc' }));
  const Th = ({ k, children, className = '' }) => (
    <th className={className}>
      <button onClick={() => toggleSort(k)}>
        {children}
        <span className="arrow">{sort.key === k ? (sort.dir === 'asc' ? '▲' : '▼') : ''}</span>
      </button>
    </th>
  );
  const COLS = 12;
  const pageClosed = shown.filter((t) => t.status === 'CLOSED');
  const allPageSel = pageClosed.length > 0 && pageClosed.every((t) => selected.has(t.id));
  const selTrips = (data?.trips || []).filter((t) => selected.has(t.id));
  const selNet = selTrips.reduce((a, t) => a + t.net, 0);

  return (
    <>
      <section className="stats stats-4">
        <div className="stat">
          <div className="stat-label">Trades</div>
          <div className="stat-value">{sum.count}</div>
          <div className="stat-note">{sum.closed} closed{sum.open ? ` · ${sum.open} open` : ''}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Win rate</div>
          <div className="stat-value">{sum.winRate != null ? `${sum.winRate.toFixed(0)}%` : '—'}</div>
          <div className="stat-note">{sum.closed ? `${sum.wins} won · ${sum.closed - sum.wins} lost (after brokerage)` : 'no closed trades'}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Net P&amp;L (booked)</div>
          <div className={`stat-value ${tone(sum.net)}`}>{money(sum.net)}</div>
          <div className="stat-note">after ₹{price.format(sum.charges)} brokerage · avg {pctText(sum.avgPct)} per trade</div>
          {sum.running !== undefined && (
            <div className="stat-note jr-running-note">
              <span className="jr-live-dot" aria-hidden="true" /> {sum.open} open: <b className={tone(sum.running)}>{sum.running != null ? money(sum.running) : '…'}</b> running
            </div>
          )}
        </div>
        <div className="stat">
          <div className="stat-label">Best / worst</div>
          <div className="stat-value jr-bw">
            <span className="pos">{sum.best ? money(sum.best.net) : '—'}</span>
            <span className="neg">{sum.worst ? money(sum.worst.net) : '—'}</span>
          </div>
          <div className="stat-note">{sum.best ? `${describe(sum.best)} / ${describe(sum.worst)}` : ''}</div>
        </div>
      </section>

      <section className="card">
        <div className="filters">
          <input className="search" placeholder="Search stock or note" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="seg" role="group" aria-label="Period">
            {PERIODS.map(([v, l]) => (
              <button key={v} className={period === v ? 'on' : ''} onClick={() => setPeriod(v)}>{l}</button>
            ))}
          </div>
          <select className="select" value={type} onChange={(e) => setType(e.target.value)} aria-label="Trade type">
            <option value="">All trade types</option>
            <option value="EQ_INTRADAY">Equity Intraday</option>
            <option value="IDX_OPT_BUY">Index Options Buying</option>
            <option value="STK_OPT_BUY">Equity Options Buying</option>
            {data?.trips?.some((t) => t.product === 'OTHER') && <option value="OTHER">Other</option>}
          </select>
          <select className="select" value={result} onChange={(e) => setResult(e.target.value)} aria-label="Result">
            <option value="">Wins, losses &amp; open</option>
            <option value="win">Winners</option>
            <option value="loss">Losers</option>
            <option value="open">Still open</option>
          </select>
          <button className="btn push" onClick={exportCsv} disabled={!sorted.length}>Export CSV</button>
        </div>
        {(selected.size > 0 || delMsg) && (
          <div className={`jr-selbar ${selected.size ? 'on' : ''}`}>
            {selected.size > 0 && (
              <>
                <b>{selected.size} selected</b>
                <span className="muted-cell">net {signed.format(selNet)}</span>
                {confirmDel ? (
                  <>
                    <span className="dp-ask">Delete {selected.size === 1 ? 'this trade' : `these ${selected.size} trades`}? {selected.size === 1 ? 'Its' : 'Their'} P&amp;L leaves your reports{selTrips.some((t) => t.note) ? (selected.size === 1 ? ' and its note is deleted' : ' and their notes are deleted') : ''}. This can’t be undone.</span>
                    <button className="btn danger" onClick={() => deleteTrips([...selected])} disabled={delMsg?.kind === 'busy'}>Yes, delete</button>
                    <button className="link" onClick={() => setConfirmDel(false)}>Cancel</button>
                  </>
                ) : (
                  <>
                    <button className="btn danger-outline" onClick={() => setConfirmDel(true)}>Delete…</button>
                    <button className="link" onClick={() => (setSelected(new Set()), setConfirmDel(false))}>Clear selection</button>
                  </>
                )}
              </>
            )}
            {delMsg && delMsg.kind !== 'busy' && <span className={`status ${delMsg.kind}`}>{delMsg.text} <button className="link" onClick={() => setDelMsg(null)}>×</button></span>}
          </div>
        )}

        <div className="table-wrap">
          <table className="journal">
            <thead>
              <tr>
                <th className="jr-sel">
                  <input
                    type="checkbox"
                    checked={allPageSel}
                    disabled={!pageClosed.length}
                    onChange={() =>
                      setSelected((s) => {
                        const n = new Set(s);
                        pageClosed.forEach((t) => (allPageSel ? n.delete(t.id) : n.add(t.id)));
                        return n;
                      })
                    }
                    aria-label="Select all closed trades on this page"
                    title="Select all closed trades on this page"
                  />
                </th>
                <Th k="openedAt">Date</Th>
                <Th k="symbol">Stock</Th>
                <th className="plain-th">Side</th>
                <Th k="qty" className="num">Qty</Th>
                <th className="plain-th">Entry</th>
                <th className="plain-th">Exit</th>
                <Th k="holdMs">Held</Th>
                <Th k="total" className="num">Net P&amp;L</Th>
                <Th k="marginPct" className="num">P&amp;L %</Th>
                <th className="plain-th jr-note-h">Notes</th>
                <th aria-label="Details" />
              </tr>
            </thead>
            <tbody>
              {shown.map((t) => (
                <Fragment key={t.id}>
                  <tr className={`clickable ${openId === t.id ? 'open' : ''} ${selected.has(t.id) ? 'jr-picked' : ''}`} onClick={() => setOpenId(openId === t.id ? null : t.id)}>
                    <td className="jr-sel" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selected.has(t.id)}
                        disabled={t.status !== 'CLOSED'}
                        onChange={() => (toggleSel(t.id), setConfirmDel(false))}
                        aria-label={`Select ${describe(t)} trade`}
                        title={t.status !== 'CLOSED' ? 'Open trades can’t be deleted — exit first' : 'Select to delete'}
                      />
                    </td>
                    <td>
                      <div className="jr-day">{dayShort.format(new Date(t.openedAt))}</div>
                      {t.date.slice(0, 4) !== today.slice(0, 4) && <div className="tk-sub"><span>{t.date.slice(0, 4)}</span></div>}
                    </td>
                    <td className="tk-inst">
                      <div className="tk-name">{describe(t)}</div>
                      <div className="tk-sub">
                        <span className={`tk-prod ${t.product}`}>{PRODUCT_SHORT[t.product] || t.product}</span>
                        {t.viaOrder && <span className="jr-src" title="Opened by a trigger order">Trigger</span>}
                      </div>
                    </td>
                    <td><span className={`side-pill ${t.side === 'LONG' ? 'buy' : 'sell'}`}>{t.side}</span></td>
                    <td className="num mono">{t.qty.toLocaleString('en-IN')}</td>
                    <td className="jr-leg">
                      <span className="mono">{shortTime.format(new Date(t.openedAt))}</span>
                      <small className="mono">@ {price.format(t.avgEntry)}</small>
                    </td>
                    <td className="jr-leg">
                      {t.status === 'CLOSED' ? (
                        <>
                          <span className="mono">{shortTime.format(new Date(t.closedAt))}{istDate(t.closedAt) !== t.date && <small> +{Math.round((Date.parse(`${istDate(t.closedAt)}T00:00:00Z`) - Date.parse(`${t.date}T00:00:00Z`)) / 86_400_000)}d</small>}</span>
                          <small className="mono">@ {price.format(t.avgExit)}</small>
                        </>
                      ) : (
                        <>
                          <span className="om-status pending">Open {t.openQty.toLocaleString('en-IN')}</span>
                          {t.ltp != null && <small className="mono">LTP {price.format(t.ltp)}</small>}
                        </>
                      )}
                    </td>
                    <td className="muted-cell">
                      {t.status === 'OPEN' ? <span title="Still open">{held(Date.now() - Date.parse(t.openedAt))}</span> : held(t.holdMs) || <span className="muted-dash">—</span>}
                    </td>
                    <td className={`num mono ${tone(t.total)}`} title={`Gross ${signed.format(t.gross)} − brokerage ${price.format(t.charges)}${t.status === 'OPEN' ? ` + open ${t.live != null ? signed.format(t.live) : '…'}` : ''}`}>
                      {t.total != null ? <b>{signed.format(t.total)}</b> : '…'}
                      {t.status === 'OPEN' && (
                        <small className="jr-running">
                          <span className="jr-live-dot" aria-hidden="true" /> Running
                          {t.gross ? <span className="muted-cell"> · booked {signed.format(t.gross)}</span> : null}
                        </small>
                      )}
                    </td>
                    <td className={`num mono ${tone(t.marginPct)}`} title={t.marginPct != null ? `On the money you deployed${t.leverage > 1 ? ` (margin, ${t.leverage}× leverage) · ${pctText(t.pnlPct)} on full position value` : ''}` : undefined}>
                      {pctText(t.marginPct)}
                    </td>
                    <td className="jr-note-cell" onClick={(e) => e.stopPropagation()}>
                      {t.note ? (
                        <button className="jr-note-text" onClick={() => (setOpenId(t.id), setEditId(t.id))} title={t.note.note}>
                          {t.note.note}
                        </button>
                      ) : (
                        <button className="btn jr-add" onClick={() => (setOpenId(t.id), setEditId(t.id))}>✎ Add note</button>
                      )}
                    </td>
                    <td className="caret-cell"><span className="caret">{openId === t.id ? '▾' : '▸'}</span></td>
                  </tr>
                  {openId === t.id && (
                    <tr className="detail">
                      <td colSpan={COLS}>
                        <TradeDetail
                          t={t}
                          editing={editId === t.id}
                          onEdit={() => setEditId(t.id)}
                          onDone={() => setEditId(null)}
                          onSave={(text) => saveNote(t.id, text)}
                          onDelete={() => deleteTrips([t.id])}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
          {sorted.length === 0 && (
            <div className="empty">
              {data?.trips?.length
                ? subview === 'notes' && !q && !result && !type && period === 'all'
                  ? 'No notes yet. Open any trade and click “Add note”.'
                  : 'No trades match these filters.'
                : 'No paper trades yet. Trades appear here once you Buy / Sell on the Market pages or a trigger order fills.'}
            </div>
          )}
        </div>

        <div className="foot jr-foot">
          <span>
            {sorted.length ? `${(cur - 1) * pageSize + 1}–${Math.min(cur * pageSize, sorted.length)} of ${sorted.length}` : '0'} trades · {sum.noted} with notes
          </span>
          <span className="jr-pager">
            <label>
              Per page{' '}
              <select className="select" value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}>
                {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <button className="btn" onClick={() => setPage(cur - 1)} disabled={cur <= 1}>‹ Prev</button>
            <span>Page {cur} of {pages}</span>
            <button className="btn" onClick={() => setPage(cur + 1)} disabled={cur >= pages}>Next ›</button>
          </span>
        </div>
        <div className="foot">
          A trade runs from entry until the position is back to zero (adding and partial exits included). P&amp;L % = net P&amp;L after brokerage ÷ entry value; hover it for the return on margin.
        </div>
      </section>

      <OrphanNotes notes={notes} trips={data?.trips || []} onRemove={(id) => saveNote(id, '')} />
    </>
  );
}

function TradeDetail({ t, editing, onEdit, onDone, onSave, onDelete }) {
  const [ask, setAsk] = useState(false);
  const [err, setErr] = useState('');
  return (
    <div className="jr-detail">
      <div className="jr-del">
        {t.status !== 'CLOSED' ? (
          <span className="muted-cell">Open trades can’t be deleted — exit the position first.</span>
        ) : ask ? (
          <>
            <span className="dp-ask">Delete this trade? Its P&amp;L ({signed.format(t.net)}) leaves your reports{t.note ? ' and its note is deleted' : ''}. This can’t be undone.</span>
            <button className="btn danger" onClick={async () => { setErr(''); if (!(await onDelete())) setAsk(false); }}>Yes, delete</button>
            <button className="link" onClick={() => setAsk(false)}>Cancel</button>
          </>
        ) : (
          <button className="btn danger-outline" onClick={() => setAsk(true)}>Delete trade</button>
        )}
        {err && <span className="status err">{err}</span>}
      </div>
      <div className="jr-facts">
        <Fact label="Entry" value={`${timeFmt.format(new Date(t.openedAt))} · avg ₹${price.format(t.avgEntry)}`} sub={dayFmt.format(new Date(t.openedAt))} />
        <Fact
          label="Exit"
          value={t.status === 'CLOSED' ? `${timeFmt.format(new Date(t.closedAt))} · avg ₹${price.format(t.avgExit)}` : t.exitQty ? `Partly exited (${t.exitQty}) · avg ₹${price.format(t.avgExit)}` : 'Still open'}
          sub={t.closedAt ? dayFmt.format(new Date(t.closedAt)) : `${t.openQty} open @ ₹${price.format(t.avgOpen)}`}
        />
        <Fact label="Trade value" value={`₹${price.format(t.entryValue)}`} sub={t.leverage > 1 ? `margin ≈ ₹${price.format(t.entryValue / t.leverage)} (${t.leverage}×)` : PRODUCT_LABEL[t.product]} />
        <Fact label="Gross / brokerage" value={`${signed.format(t.gross)} / −${price.format(t.charges)}`} sub={`Net ${signed.format(t.net)}`} tone={tone(t.net)} />
        <Fact label="Price move" value={pctText(t.movePct)} sub={t.marginPct != null ? `${pctText(t.marginPct)} on money deployed` : ''} tone={tone(t.movePct)} />
      </div>

      <div className="jr-cols">
        <div className="jr-fills">
          <h4>Fills</h4>
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Side</th>
                <th className="num">Qty</th>
                <th className="num">Price</th>
                <th className="num">Brokerage</th>
                <th className="num">P&amp;L</th>
              </tr>
            </thead>
            <tbody>
              {t.fills.map((f, i) => (
                <tr key={`${f.id}-${i}`}>
                  <td className="mono">
                    {stamp.format(new Date(f.at))}
                    {f.orderId && <span className="jr-src" title={`Trigger order ${f.orderId}`}>Trigger</span>}
                  </td>
                  <td><span className={`side-pill ${f.side === 'BUY' ? 'buy' : 'sell'}`}>{f.side}</span></td>
                  <td className="num mono">{f.qty}</td>
                  <td className="num mono">{price.format(f.price)}</td>
                  <td className="num mono muted-cell">{price.format(f.charges)}</td>
                  <td className={`num mono ${tone(f.realized)}`}>{f.role === 'exit' ? signed.format(f.realized) : <span className="muted-dash">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <NoteEditor note={t.note} editing={editing} onEdit={onEdit} onDone={onDone} onSave={onSave} />
      </div>
    </div>
  );
}

function Fact({ label, value, sub, tone: tn = '' }) {
  return (
    <div className="jr-fact">
      <div className="jr-fact-l">{label}</div>
      <div className={`jr-fact-v mono ${tn}`}>{value}</div>
      {sub && <div className="jr-fact-s">{sub}</div>}
    </div>
  );
}

const PROMPTS = ['Why I took it', 'Followed my plan?', 'What went well', 'Mistake / lesson'];

function NoteEditor({ note, editing, onEdit, onDone, onSave }) {
  const [text, setText] = useState(note?.note || '');
  const [status, setStatus] = useState(null);
  const box = useRef(null);
  useEffect(() => {
    if (editing) {
      setText(note?.note || '');
      setTimeout(() => {
        const el = box.current;
        if (el) {
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        }
      }, 0);
    }
  }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setStatus({ kind: 'busy', text: 'Saving…' });
    try {
      await onSave(text);
      setStatus({ kind: 'ok', text: text.trim() ? 'Saved' : 'Note deleted' });
      onDone();
    } catch (e) {
      setStatus({ kind: 'err', text: e.message });
    }
  };
  const addPrompt = (p) => {
    setText((v) => `${v}${v && !v.endsWith('\n') ? '\n' : ''}${p}: `);
    box.current?.focus();
  };

  return (
    <div className="jr-notes">
      <h4>
        Journal
        {note && !editing && <small className="muted-cell"> · edited {stamp.format(new Date(note.updatedAt))}</small>}
      </h4>
      {editing ? (
        <>
          <div className="om-chips">
            {PROMPTS.map((p) => (
              <button key={p} type="button" className="om-chip" onClick={() => addPrompt(p)}>+ {p}</button>
            ))}
          </div>
          <textarea
            ref={box}
            value={text}
            maxLength={4000}
            rows={6}
            placeholder="Why you took the trade, how you managed it, what you'd do differently…"
            onChange={(e) => (setText(e.target.value), setStatus(null))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save();
              if (e.key === 'Escape') onDone();
            }}
          />
          <div className="jr-note-actions">
            <small className="muted-cell">{text.length}/4000 · Ctrl+Enter to save</small>
            {status && <span className={`status ${status.kind}`}>{status.text}</span>}
            <button className="btn" type="button" onClick={onDone}>Cancel</button>
            <button className="btn primary" type="button" onClick={save} disabled={status?.kind === 'busy' || text.trim() === (note?.note || '')}>
              Save note
            </button>
          </div>
        </>
      ) : note ? (
        <>
          <p className="jr-note-body">{note.note}</p>
          <div className="jr-note-actions">
            {status && <span className={`status ${status.kind}`}>{status.text}</span>}
            <button className="btn" onClick={onEdit}>✎ Edit note</button>
          </div>
        </>
      ) : (
        <div className="jr-note-empty">
          {status && <span className={`status ${status.kind}`}>{status.text} </span>}
          <button className="btn" onClick={onEdit}>✎ Add note</button>
        </div>
      )}
    </div>
  );
}

/** Notes whose trade no longer exists (e.g. deleted by an older version's Reset): text kept so it isn't lost. */
function OrphanNotes({ notes, trips, onRemove }) {
  const [busy, setBusy] = useState('');
  const ids = new Set(trips.map((t) => t.id));
  const list = Object.values(notes)
    .filter((n) => !ids.has(n.id))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (!list.length) return null;
  return (
    <section className="card orphan-notes">
      <div className="card-head">
        <h2>Notes from deleted trades ({list.length})</h2>
        <span className="muted small">The trades were removed by an earlier Reset; your notes were kept. Copy anything you need, then remove them.</span>
      </div>
      <ul>
        {list.map((n) => (
          <li key={n.id}>
            <div className="orphan-meta muted-cell">
              Written {stamp.format(new Date(n.createdAt))}
              {n.updatedAt !== n.createdAt && <> · edited {stamp.format(new Date(n.updatedAt))}</>}
            </div>
            <p className="jr-note-body">{n.note}</p>
            <div className="jr-note-actions">
              <button className="btn" onClick={() => navigator.clipboard?.writeText(n.note)}>Copy</button>
              <button
                className="btn danger-outline"
                disabled={busy === n.id}
                onClick={async () => {
                  setBusy(n.id);
                  try {
                    await onRemove(n.id);
                  } finally {
                    setBusy('');
                  }
                }}
              >
                Remove
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
