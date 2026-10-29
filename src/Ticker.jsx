import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// Live market table for instruments you pick, fed by Dhan's Quote API through
// /api/ticker (your Dhan token stays on the server).

export const SECRET_KEY = 'stockhits.secret';
const INTERVAL_KEY = 'stockhits.tickerInterval';
const INTERVALS = [
  [1000, '1s'],
  [2000, '2s'],
  [5000, '5s'],
  [10000, '10s'],
];
const CLOSED_INTERVAL = 30_000; // outside market hours prices barely move
const TABS = [
  ['all', 'All'],
  ['eq', 'Equity'],
  ['fno', 'F&O'],
  ['idx', 'Index'],
];

export const price = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// +₹1,234.50 / −₹56.00
export const money = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}₹${price.format(Math.abs(v))}`;
export const signed = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: 'exceptZero' });
const two = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
// Indian short form: 4.5K, 12.35L, 9.88Cr (browsers disagree on Intl's compact labels)
const compact = {
  format(v) {
    const a = Math.abs(v);
    if (a >= 1e7) return `${two.format(v / 1e7)}Cr`;
    if (a >= 1e5) return `${two.format(v / 1e5)}L`;
    if (a >= 1e3) return `${two.format(v / 1e3)}K`;
    return two.format(v);
  },
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const store = {
  get(k) {
    try {
      return localStorage.getItem(k) || '';
    } catch {
      return '';
    }
  },
  set(k, v) {
    try {
      if (v) localStorage.setItem(k, v);
      else localStorage.removeItem(k);
    } catch {}
  },
};

export const kindOf = (seg) => (seg === 'IDX_I' ? 'idx' : seg.endsWith('FNO') ? 'fno' : 'eq');
export const segLabel = (seg) => ({ IDX_I: 'INDEX', NSE_EQ: 'NSE', BSE_EQ: 'BSE', NSE_FNO: 'NFO', BSE_FNO: 'BFO' })[seg] || seg;
export const fmtExpiry = (e) => {
  if (!e) return '';
  const [y, m, d] = e.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y.slice(2)}`;
};
// Paper trade types (mirrors lib/paper.js)
export const PRODUCT_LABEL = { OPT_BUY: 'Options Buying', EQ_INTRADAY: 'Equity Intraday', OTHER: 'Other' };
export const PRODUCT_SHORT = { OPT_BUY: 'OPT BUY', EQ_INTRADAY: 'INTRADAY', OTHER: 'OTHER' };
export const productFor = (r) =>
  String(r.instrument || '').startsWith('OPT') ? 'OPT_BUY' : r.segment === 'NSE_EQ' || r.segment === 'BSE_EQ' ? 'EQ_INTRADAY' : null;

export function describe(row) {
  if (row.instrument?.startsWith('OPT')) return `${row.underlying || row.symbol.split('-')[0]} ${row.strike} ${row.optionType}`;
  if (row.instrument?.startsWith('FUT')) return `${row.underlying || row.symbol.split('-')[0]} FUT`;
  return row.symbol || row.name;
}

export async function api(secret, action, { method = 'GET', params = {}, body } = {}) {
  const qs = new URLSearchParams(method === 'GET' ? { action, ...params } : {}).toString();
  const r = await fetch(`/api/ticker${qs ? `?${qs}` : ''}`, {
    method,
    cache: 'no-store',
    headers: { 'X-Webhook-Secret': secret, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify({ action, ...body }) : undefined,
  });
  let j;
  try {
    j = await r.json();
  } catch {
    j = { ok: false, error: `HTTP ${r.status}` };
  }
  if (!j.ok) {
    const e = new Error(j.error || `HTTP ${r.status}`);
    e.kind = r.status === 401 && !j.kind ? 'secret' : j.kind;
    e.status = r.status;
    throw e;
  }
  return j;
}

// ------------------------------------------------------------------ page

export default function Ticker() {
  const [secret, setSecret] = useState(() => store.get(SECRET_KEY));
  const [unlocked, setUnlocked] = useState(false);
  const [conn, setConn] = useState(null);
  const [rows, setRows] = useState([]);
  const [quotes, setQuotes] = useState({});
  const [feedError, setFeedError] = useState(null);
  const [lastAt, setLastAt] = useState(null);
  const [market, setMarket] = useState(null);
  const [intervalMs, setIntervalMs] = useState(() => Number(store.get(INTERVAL_KEY)) || 2000);
  const [paused, setPaused] = useState(false);
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.hidden);
  const [tab, setTab] = useState('all');
  const [sort, setSort] = useState({ key: 'order', dir: 'asc' });
  const [showConn, setShowConn] = useState(false);
  const [busyKey, setBusyKey] = useState('');
  const [pageError, setPageError] = useState('');
  const [book, setBook] = useState(null); // paper trading: positions, trades, reports
  const [ticket, setTicket] = useState(null); // { key, side } — open Buy/Sell ticket

  // Initial load: check secret, Dhan connection, the saved list and paper book.
  const loadAll = useCallback(async (s) => {
    setPageError('');
    try {
      const [st, wl, pb] = await Promise.all([api(s, 'status', { params: { check: '1' } }), api(s, 'watchlist'), api(s, 'paper')]);
      setConn(st);
      setMarket(st.market);
      setRows(wl.rows);
      setBook(pb);
      setUnlocked(true);
      if (!st.connected || st.problem) setShowConn(true);
      return true;
    } catch (e) {
      if (e.kind === 'secret' || e.status === 401 || e.status === 403) setUnlocked(false);
      setPageError(e.message);
      return false;
    }
  }, []);

  // Try the secret saved on this device. If it's out of date (e.g. the secret
  // was changed in Vercel), forget it so the user can type the current one.
  const [savedFailed, setSavedFailed] = useState(false);
  const [checking, setChecking] = useState(Boolean(secret));
  useEffect(() => {
    if (!secret) return;
    loadAll(secret).then((ok) => {
      setChecking(false);
      if (ok) return;
      store.set(SECRET_KEY, '');
      setSecret('');
      setSavedFailed(true);
      setPageError('');
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const on = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);

  // ---- live polling (one request at a time, never overlapping). Open paper
  // positions are always priced, even if removed from the watchlist.
  const positions = book?.positions || [];
  const posByKey = useMemo(() => new Map(positions.map((p) => [p.key, p])), [positions]);
  const keys = useMemo(
    () => [...new Set([...rows.map((r) => r.key), ...positions.filter((p) => p.qty !== 0).map((p) => p.key)])].join(','),
    [rows, positions]
  );
  const stoppedFor = feedError && (feedError.kind === 'auth' || feedError.kind === 'plan') ? feedError.kind : null;
  const running = unlocked && conn?.connected && !paused && !hidden && keys && !stoppedFor;
  const effectiveInterval = market && !market.open ? Math.max(intervalMs, CLOSED_INTERVAL) : intervalMs;

  useEffect(() => {
    if (!running) return;
    let alive = true;
    let timer;
    const tick = async () => {
      let wait = effectiveInterval;
      try {
        const j = await api(secret, 'quotes', { params: { keys } });
        if (!alive) return;
        setQuotes((prev) => ({ ...prev, ...j.quotes }));
        setMarket(j.market);
        setLastAt(new Date(j.at));
        setFeedError(null);
      } catch (e) {
        if (!alive) return;
        setFeedError({ message: e.message, kind: e.kind });
        if (e.kind === 'rate') wait = Math.max(wait, 3000);
        else wait = Math.max(wait, 5000);
      }
      if (alive) timer = setTimeout(tick, wait);
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [running, keys, secret, effectiveInterval]);

  // ---- watchlist actions
  const add = async (key) => {
    setBusyKey(key);
    try {
      const j = await api(secret, 'add', { method: 'POST', body: { key } });
      setRows(j.rows);
      return true;
    } catch (e) {
      setPageError(e.message);
      return false;
    } finally {
      setBusyKey('');
    }
  };
  const remove = async (key) => {
    setBusyKey(key);
    try {
      const j = await api(secret, 'remove', { method: 'POST', body: { key } });
      setRows(j.rows);
      if (ticket?.key === key) setTicket(null);
    } catch (e) {
      setPageError(e.message);
    } finally {
      setBusyKey('');
    }
  };

  // ---- paper trades (filled server-side at the live LTP)
  const placeTrade = async (key, side, qty, product) => {
    const j = await api(secret, 'trade', { method: 'POST', body: { key, side, qty, product } });
    setBook(j);
    return j.trade;
  };

  // ---- view
  const counts = useMemo(() => {
    const c = { all: rows.length, eq: 0, fno: 0, idx: 0 };
    for (const r of rows) c[kindOf(r.segment)]++;
    return c;
  }, [rows]);

  const view = useMemo(() => {
    const list = rows
      .map((r, i) => {
        const q = quotes[r.key] || null;
        const p = posByKey.get(r.key);
        const openPnl = p && p.qty && q?.ltp != null ? (q.ltp - p.avg) * p.qty : null;
        return { ...r, order: i, q, pos: p || null, openPnl };
      })
      .filter((r) => tab === 'all' || kindOf(r.segment) === tab);
    if (sort.key === 'order') return list;
    const val = (r) => (sort.key === 'name' ? describe(r) : sort.key === 'openPnl' ? r.openPnl : sort.key === 'posQty' ? r.pos?.qty || null : r.q?.[sort.key] ?? null);
    return list.sort((a, b) => {
      const x = val(a);
      const y = val(b);
      if (x === null && y === null) return a.order - b.order;
      if (x === null) return 1;
      if (y === null) return -1;
      const c = typeof x === 'string' ? x.localeCompare(y) : x - y;
      return sort.dir === 'asc' ? c : -c;
    });
  }, [rows, quotes, tab, sort, posByKey]);

  const showOI = view.some((r) => kindOf(r.segment) === 'fno');
  const colCount = 9 + (showOI ? 1 : 0);

  if (checking) return <p className="tk-note">Opening ticker…</p>;
  if (!unlocked) {
    return (
      <SecretGate
        error={pageError}
        notice={savedFailed ? 'The secret saved on this device no longer matches (it may have been changed in Vercel). Enter the current one.' : ''}
        onSubmit={async (s, remember) => {
          setSecret(s);
          setSavedFailed(false);
          const ok = await loadAll(s);
          if (ok) store.set(SECRET_KEY, remember ? s : '');
        }}
      />
    );
  }

  const toggleSort = (key) =>
    setSort((s) => (s.key === key ? (s.dir === 'desc' ? { key, dir: 'asc' } : { key: 'order', dir: 'asc' }) : { key, dir: key === 'name' ? 'asc' : 'desc' }));
  const Th = ({ k, children, className = '' }) => (
    <th className={className}>
      <button onClick={() => toggleSort(k)}>
        {children}
        <span className="arrow">{sort.key === k ? (sort.dir === 'asc' ? '▲' : '▼') : ''}</span>
      </button>
    </th>
  );
  const openTicket = (key, side) => setTicket((t) => (t?.key === key && t.side === side ? null : { key, side }));

  return (
    <>
      <div className="tk-bar">
        <ConnChip conn={conn} onClick={() => setShowConn((v) => !v)} open={showConn} />
        {market && <span className={`tk-market ${market.open ? 'open' : ''}`}><i />{market.label}</span>}
        <div className="tk-live">
          <span className={`tk-dot ${running ? 'on' : ''}`} />
          <span className="tk-live-text">
            {!conn?.connected
              ? 'Not connected'
              : stoppedFor
                ? 'Stopped'
                : paused
                  ? 'Paused'
                  : hidden
                    ? 'Paused while tab is hidden'
                    : !keys
                      ? 'Add an instrument'
                      : lastAt
                        ? `Updated ${lastAt.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })}`
                        : 'Connecting…'}
          </span>
          <select
            className="select tk-int"
            value={intervalMs}
            onChange={(e) => {
              setIntervalMs(Number(e.target.value));
              store.set(INTERVAL_KEY, e.target.value);
            }}
            aria-label="Refresh every"
          >
            {INTERVALS.map(([v, l]) => <option key={v} value={v}>Every {l}</option>)}
          </select>
          <button className="btn" onClick={() => setPaused((p) => !p)} disabled={!conn?.connected}>
            {paused ? 'Resume' : 'Pause'}
          </button>
        </div>
      </div>

      {showConn && (
        <ConnectionPanel
          secret={secret}
          conn={conn}
          onChange={(c) => {
            setConn((old) => ({ ...old, ...c }));
            setFeedError(null);
          }}
          onClose={() => setShowConn(false)}
        />
      )}

      {pageError && (
        <div className="alert" role="alert">
          ⚠ {pageError} <button className="link" onClick={() => setPageError('')}>Dismiss</button>
        </div>
      )}
      {feedError && (
        <div className={`alert ${feedError.kind === 'rate' ? 'soft' : ''}`} role="status">
          ⚠ {feedError.message}
          {(feedError.kind === 'auth' || feedError.kind === 'plan') && (
            <> <button className="link" onClick={() => setShowConn(true)}>Open Dhan connection</button></>
          )}
          {feedError.kind === 'rate' && ' Retrying in a few seconds.'}
        </div>
      )}
      {market && !market.open && conn?.connected && keys && !feedError && (
        <p className="tk-note">Market is closed, so prices refresh every 30 s and show the last traded values. Paper trades fill at the last traded price.</p>
      )}

      <section className="card">
        <div className="card-head">
          <h2>Ticker</h2>
          <AddInstrument secret={secret} existing={rows} onAdd={add} disabled={!unlocked} />
        </div>
        <div className="filters">
          <div className="seg" role="group" aria-label="Show">
            {TABS.map(([v, l]) => (
              <button key={v} className={tab === v ? 'on' : ''} onClick={() => setTab(v)}>
                {l} <span className="seg-count">{counts[v]}</span>
              </button>
            ))}
          </div>
          {sort.key !== 'order' && (
            <button className="link" onClick={() => setSort({ key: 'order', dir: 'asc' })}>Back to my order</button>
          )}
          <span className="tk-paper-tag">Buy / Sell are paper trades — no real orders</span>
        </div>
        <div className="table-wrap tall">
          <table className="ticker">
            <thead>
              <tr>
                <Th k="name">Instrument</Th>
                <Th k="ltp" className="num">LTP</Th>
                <Th k="change" className="num">Chg</Th>
                <Th k="changePct" className="num">Chg %</Th>
                <Th k="volume" className="num">Volume</Th>
                {showOI && <Th k="oi" className="num">OI</Th>}
                <Th k="posQty" className="num">Position</Th>
                <Th k="openPnl" className="num">Open P&amp;L</Th>
                <th className="tk-trade-h">Trade</th>
                <th aria-label="Remove" />
              </tr>
            </thead>
            <tbody>
              {view.map((r) => (
                <TickerRow
                  key={r.key}
                  row={r}
                  showOI={showOI}
                  colCount={colCount}
                  busy={busyKey === r.key}
                  ticket={ticket?.key === r.key ? ticket.side : null}
                  onTicket={(side) => openTicket(r.key, side)}
                  onCloseTicket={() => setTicket(null)}
                  onPlace={(side, qty, product) => placeTrade(r.key, side, qty, product)}
                  brokeragePct={book?.brokeragePct ?? 1}
                  account={book?.account}
                  products={book?.products}
                  onRemove={() => remove(r.key)}
                />
              ))}
            </tbody>
          </table>
          {view.length === 0 && (
            <div className="empty">
              {rows.length ? 'Nothing in this tab.' : 'Your ticker is empty. Search above for a stock, index, future or option — e.g. "RELIANCE", "NIFTY 25000 CE".'}
            </div>
          )}
        </div>
        <div className="foot">
          {rows.length} {rows.length === 1 ? 'instrument' : 'instruments'} · data from Dhan Quote API
          {conn?.connected && effectiveInterval !== intervalMs && ' · 30 s refresh while market is closed'}
        </div>
      </section>

      <PositionsCard book={book} quotes={quotes} onExit={(p) => placeTrade(p.key, p.qty > 0 ? 'SELL' : 'BUY', Math.abs(p.qty))} />
    </>
  );
}

// ------------------------------------------------------------------ row with tick flash + trade ticket

function TickerRow({ row, showOI, colCount, busy, ticket, onTicket, onCloseTicket, onPlace, onRemove, brokeragePct, account, products }) {
  const q = row.q;
  const prev = useRef(null);
  const [flash, setFlash] = useState({ dir: '', n: 0 });
  useEffect(() => {
    const ltp = q?.ltp;
    if (ltp == null) return;
    if (prev.current != null && ltp !== prev.current) setFlash((f) => ({ dir: ltp > prev.current ? 'up' : 'down', n: f.n + 1 }));
    prev.current = ltp;
  }, [q?.ltp]);

  const tone = q?.change > 0 ? 'pos' : q?.change < 0 ? 'neg' : '';
  const kind = kindOf(row.segment);
  const product = productFor(row);
  const tradable = Boolean(product);
  const P = (v) => (v == null || (v === 0 && kind !== 'fno') ? <span className="muted-dash">—</span> : price.format(v));
  const pos = row.pos;

  return (
    <>
      <tr className={ticket ? 'tk-has-ticket' : ''}>
        <td className="tk-inst">
          <div className="tk-name">{describe(row)}</div>
          <div className="tk-sub">
            <span className={`tk-seg ${kind}`}>{segLabel(row.segment)}</span>
            {row.expiry && <span>{fmtExpiry(row.expiry)}</span>}
            {kind === 'fno' && <span>Lot {row.lotSize}</span>}
            {kind !== 'fno' && row.name && row.name !== row.symbol && <span className="tk-full">{row.name}</span>}
          </div>
        </td>
        <td className="num mono tk-ltp">
          <span key={flash.n} className={`tk-flash ${flash.dir}`}>{q ? P(q.ltp) : <span className="muted-dash">…</span>}</span>
        </td>
        <td className={`num mono ${tone}`}>{q?.change != null ? signed.format(q.change) : <span className="muted-dash">—</span>}</td>
        <td className="num">
          {q?.changePct != null ? <span className={`tk-pct ${tone}`}>{signed.format(q.changePct)}%</span> : <span className="muted-dash">—</span>}
        </td>
        <td className="num mono" title={q?.volume ? q.volume.toLocaleString('en-IN') : undefined}>
          {q?.volume ? compact.format(q.volume) : <span className="muted-dash">—</span>}
        </td>
        {showOI && (
          <td className="num mono" title={q?.oi ? q.oi.toLocaleString('en-IN') : undefined}>
            {kind === 'fno' && q?.oi ? compact.format(q.oi) : <span className="muted-dash">—</span>}
          </td>
        )}
        <td className="num mono">
          {pos?.qty ? (
            <span className="tk-posq">
              <b className={pos.qty > 0 ? 'long' : 'short'}>{pos.qty > 0 ? `+${pos.qty}` : pos.qty}</b>
              <span className="muted-cell"> @ {price.format(pos.avg)}</span>
            </span>
          ) : (
            <span className="muted-dash">—</span>
          )}
        </td>
        <td className={`num mono ${row.openPnl > 0 ? 'pos' : row.openPnl < 0 ? 'neg' : ''}`}>
          {row.openPnl != null ? signed.format(row.openPnl) : <span className="muted-dash">—</span>}
        </td>
        <td className="tk-trade">
          {tradable ? (
            <span className="tk-bs">
              <button className={`bs buy ${ticket === 'BUY' ? 'on' : ''}`} onClick={() => onTicket('BUY')} aria-expanded={ticket === 'BUY'}>Buy</button>
              <button className={`bs sell ${ticket === 'SELL' ? 'on' : ''}`} onClick={() => onTicket('SELL')} aria-expanded={ticket === 'SELL'}>Sell</button>
            </span>
          ) : (
            <span className="muted-dash" title={kind === 'idx' ? "Indices can't be traded" : 'Paper trading supports Options Buying and Equity Intraday only'}>—</span>
          )}
        </td>
        <td className="tk-x">
          <button className="icon-btn" onClick={onRemove} disabled={busy} aria-label={`Remove ${describe(row)}`} title="Remove">
            ×
          </button>
        </td>
      </tr>
      {ticket && (
        <tr className="tk-ticket-row">
          <td colSpan={colCount}>
            <TradeTicket row={row} initialSide={ticket} onPlace={onPlace} onClose={onCloseTicket} pct={brokeragePct} account={account} products={products} />
          </td>
        </tr>
      )}
    </>
  );
}

function TradeTicket({ row, initialSide, onPlace, onClose, pct, account, products }) {
  const fno = kindOf(row.segment) === 'fno';
  const allowed = productFor(row); // each instrument has exactly one valid trade type
  const [product, setProduct] = useState(allowed);
  const lev = (p) => products?.[p]?.leverage ?? (p === 'EQ_INTRADAY' ? 4 : 1);
  const L = lev(product);
  const lot = Number(row.lotSize) || 1;
  const [side, setSide] = useState(initialSide);
  const [units, setUnits] = useState('1'); // lots for F&O, shares for equity
  const [status, setStatus] = useState(null);
  useEffect(() => setSide(initialSide), [initialSide]);

  const n = Math.max(0, Math.floor(Number(units) || 0));
  const qty = fno ? n * lot : n;
  const ltp = row.q?.ltp;
  const pos = row.pos;
  const busy = status?.kind === 'busy';

  // Funds check (the server checks again at the fill price).
  const held = pos?.qty || 0;
  const signedQty = side === 'BUY' ? qty : -qty;
  const closing = held && Math.sign(held) !== Math.sign(signedQty) ? Math.min(qty, Math.abs(held)) : 0;
  const opening = qty - closing;
  const need = ltp != null ? (opening * ltp) / L + (qty * ltp * pct) / 100 : null;
  const released = closing && ltp != null ? (closing * pos.avg) / lev(pos.product) + closing * (ltp - pos.avg) * Math.sign(held) : 0;
  const canAfford = !account || need == null || opening === 0 || need <= account.available + released;
  // Rules (the server enforces them too)
  const ruleError =
    product !== allowed
      ? `This instrument can only be traded as ${PRODUCT_LABEL[allowed]}.`
      : product === 'OPT_BUY' && side === 'SELL' && held <= 0
        ? "Options Buying: you can only sell options you hold — option writing isn't allowed."
        : product === 'OPT_BUY' && side === 'SELL' && qty > held
          ? `Options Buying: you hold ${held}; sell at most ${held}.`
          : '';

  const submit = async (e) => {
    e.preventDefault();
    if (!qty) return;
    setStatus({ kind: 'busy', text: 'Placing…' });
    try {
      const t = await onPlace(side, qty, product);
      setStatus({
        kind: 'ok',
        text: `${t.side === 'BUY' ? 'Bought' : 'Sold'} ${t.qty} @ ${price.format(t.price)} · brokerage ₹${price.format(t.charges)}${t.marketOpen ? '' : ' (market closed — last price)'}`,
      });
    } catch (err) {
      setStatus({ kind: 'err', text: err.message });
    }
  };

  return (
    <form className={`tk-ticket ${side === 'BUY' ? 'is-buy' : 'is-sell'}`} onSubmit={submit} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="seg tk-product" role="group" aria-label="Trade type">
        {['OPT_BUY', 'EQ_INTRADAY'].map((p) => (
          <button
            key={p}
            type="button"
            className={product === p ? 'on' : ''}
            onClick={() => setProduct(p)}
            disabled={p !== allowed}
            title={p !== allowed ? `Not available for this instrument — it can only be traded as ${PRODUCT_LABEL[allowed]}` : undefined}
          >
            {PRODUCT_LABEL[p]}
            {p === 'EQ_INTRADAY' && <span className="tk-lev">{lev('EQ_INTRADAY')}×</span>}
          </button>
        ))}
      </div>
      <div className="seg tk-side" role="group" aria-label="Side">
        <button type="button" className={side === 'BUY' ? 'on buy' : ''} onClick={() => setSide('BUY')}>Buy</button>
        <button type="button" className={side === 'SELL' ? 'on sell' : ''} onClick={() => setSide('SELL')}>Sell</button>
      </div>
      <label className="tk-qty">
        {fno ? 'Lots' : 'Qty'}
        <input type="number" min="1" step="1" value={units} onChange={(e) => (setUnits(e.target.value), setStatus(null))} autoFocus />
      </label>
      <span className="tk-ticket-info">
        {fno && <>= {qty.toLocaleString('en-IN')} qty · </>}
        Market ≈ {ltp != null ? price.format(ltp) : '…'}
        {ltp != null && qty > 0 && (
          <>
            {' '}· Value ≈ ₹{price.format(ltp * qty)}
            {L > 1 && opening > 0 && <> · Margin ≈ ₹{price.format((ltp * opening) / L)} ({L}×)</>}
            {' '}· Brokerage ≈ ₹{price.format((ltp * qty * pct) / 100)} ({pct}%)
          </>
        )}
        {pos?.qty ? <> · Holding {pos.qty > 0 ? `+${pos.qty}` : pos.qty} @ {price.format(pos.avg)}</> : null}
        {account && (
          <>
            {' '}· Available ₹{price.format(account.available)}
            {L > 1 && <> (buying power ₹{price.format(account.available * L)})</>}
          </>
        )}
      </span>
      {ruleError && <span className="status err">{ruleError}</span>}
      {!ruleError && !canAfford && <span className="status err">Not enough funds: needs ₹{price.format(need)}</span>}
      <button className={`btn ${side === 'BUY' ? 'buy-btn' : 'sell-btn'}`} type="submit" disabled={busy || !qty || !canAfford || Boolean(ruleError)}>
        {side === 'BUY' ? 'Buy' : 'Sell'} {qty ? qty.toLocaleString('en-IN') : ''} at market
      </button>
      <button type="button" className="link tk-ticket-close" onClick={onClose}>Close</button>
      {status && <span className={`status ${status.kind}`}>{status.text}</span>}
    </form>
  );
}

// ------------------------------------------------------------------ positions

function PositionsCard({ book, quotes, onExit }) {
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);
  const list = (book?.positions || []).map((p) => {
    const ltp = quotes[p.key]?.ltp ?? null;
    const open = p.qty && ltp != null ? (ltp - p.avg) * p.qty : p.qty ? null : 0;
    return { ...p, ltp, open, total: open == null ? null : open + p.realizedToday - p.chargesToday };
  });
  const openSum = list.reduce((s, p) => s + (p.open || 0), 0);
  const bookedToday = book?.totals?.realizedToday ?? 0;
  const chargesToday = book?.totals?.chargesToday ?? 0;
  const dayTotal = openSum + bookedToday - chargesToday;
  const pct = book?.brokeragePct ?? 1;
  const tone = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');

  const exit = async (p) => {
    setBusy(p.key);
    setMsg(null);
    try {
      const t = await onExit(p);
      setMsg({ kind: 'ok', text: `Exited ${describe(p)}: ${t.side === 'BUY' ? 'bought' : 'sold'} ${t.qty} @ ${price.format(t.price)} · brokerage ₹${price.format(t.charges)}` });
    } catch (e) {
      setMsg({ kind: 'err', text: e.message });
    } finally {
      setBusy('');
    }
  };

  return (
    <section className="card tk-positions">
      <div className="card-head">
        <h2>Paper positions</h2>
        <div className="tk-pos-sum">
          <span>Booked <b className={`mono ${tone(bookedToday)}`}>{signed.format(bookedToday)}</b></span>
          <span>Open <b className={`mono ${tone(openSum)}`}>{signed.format(openSum)}</b></span>
          <span>Brokerage <b className="mono neg">{chargesToday ? `−${price.format(chargesToday)}` : '0.00'}</b></span>
          <span className="tk-day-total">Today's net P&amp;L <b className={`mono ${tone(dayTotal)}`}>{money(dayTotal)}</b></span>
          <a className="btn" href="#/pnl">P&amp;L reports →</a>
        </div>
      </div>
      {book?.account && (
        <div className="tk-funds">
          <span>Available <b className="mono">₹{price.format(book.account.available)}</b></span>
          {book.account.buyingPower && (
            <span>Intraday buying power <b className="mono">₹{price.format(book.account.buyingPower.EQ_INTRADAY)}</b></span>
          )}
          <span>Margin used <b className="mono">₹{price.format(book.account.used)}</b></span>
          <span>Starting amount <b className="mono">₹{price.format(book.account.startingCapital)}</b>{book.account.isDefault && ' (default)'}</span>
          <a className="link" href="#/pnl">Change or reset amount</a>
        </div>
      )}
      {msg && <p className={`status ${msg.kind} tk-pos-msg`}>{msg.text}</p>}
      {list.length ? (
        <div className="table-wrap">
          <table className="ticker tk-pos-table">
            <thead>
              <tr>
                <th>Instrument</th>
                <th className="num">Qty</th>
                <th className="num">Avg price</th>
                <th className="num">LTP</th>
                <th className="num">Open P&amp;L</th>
                <th className="num">Booked today</th>
                <th className="num">Brokerage today</th>
                <th className="num">Net today</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((p) => (
                <tr key={p.key} className={p.qty ? '' : 'tk-closed'}>
                  <td className="tk-inst">
                    <div className="tk-name">{describe(p)}</div>
                    <div className="tk-sub">
                      <span className={`tk-seg ${kindOf(p.segment)}`}>{segLabel(p.segment)}</span>
                      {p.expiry && <span>{fmtExpiry(p.expiry)}</span>}
                      <span className={`tk-prod ${p.product}`}>{PRODUCT_SHORT[p.product] || p.product}</span>
                      {!p.qty && <span>Closed</span>}
                      {p.carried && <span className="tk-carried" title="Intraday positions should be closed the same day">Not squared off</span>}
                    </div>
                  </td>
                  <td className="num mono">
                    {p.qty ? <b className={p.qty > 0 ? 'long' : 'short'}>{p.qty > 0 ? `+${p.qty}` : p.qty}</b> : '0'}
                  </td>
                  <td className="num mono">{p.qty ? price.format(p.avg) : <span className="muted-dash">—</span>}</td>
                  <td className="num mono">{p.ltp != null ? price.format(p.ltp) : <span className="muted-dash">{p.qty ? '…' : '—'}</span>}</td>
                  <td className={`num mono ${tone(p.open)}`}>{p.qty ? (p.open != null ? signed.format(p.open) : '…') : <span className="muted-dash">—</span>}</td>
                  <td className={`num mono ${tone(p.realizedToday)}`}>{signed.format(p.realizedToday)}</td>
                  <td className="num mono muted-cell">{p.chargesToday ? `−${price.format(p.chargesToday)}` : '0.00'}</td>
                  <td className={`num mono ${tone(p.total)}`}>{p.total != null ? <b>{signed.format(p.total)}</b> : '…'}</td>
                  <td className="tk-x">
                    {p.qty !== 0 && (
                      <button className="btn tk-exit" onClick={() => exit(p)} disabled={busy === p.key}>
                        {busy === p.key ? 'Exiting…' : 'Exit'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty">No paper positions yet. Use Buy or Sell on any row above to place a dummy trade at the live price.</div>
      )}
      <div className="foot">
        Brokerage of {pct}% of trade value is charged on every buy and every sell when the trade is placed. Net = booked + open − brokerage.
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ add instrument (search)

function AddInstrument({ secret, existing, onAdd, disabled }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [state, setState] = useState(''); // '' | loading | slow | error message
  const box = useRef(null);
  const seq = useRef(0);
  const have = useMemo(() => new Set(existing.map((r) => r.key)), [existing]);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setResults([]);
      setState('');
      return;
    }
    const my = ++seq.current;
    setState('loading');
    const slow = setTimeout(() => my === seq.current && setState('slow'), 1500);
    const t = setTimeout(async () => {
      try {
        const j = await api(secret, 'search', { params: { q: term } });
        if (my !== seq.current) return;
        setResults(j.results);
        setActive(0);
        setOpen(true);
        setState('');
      } catch (e) {
        if (my === seq.current) setState(e.message);
      } finally {
        clearTimeout(slow);
      }
    }, 250);
    return () => {
      clearTimeout(t);
      clearTimeout(slow);
    };
  }, [q, secret]);

  useEffect(() => {
    const close = (e) => box.current && !box.current.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const choose = async (r) => {
    if (!r) return;
    if (have.has(r.key)) {
      // Already in the ticker: just close the list.
      setQ('');
      setResults([]);
      setOpen(false);
      return;
    }
    if (await onAdd(r.key)) {
      setQ('');
      setResults([]);
      setOpen(false);
    }
  };

  const onKey = (e) => {
    if (!open || !results.length) return;
    if (e.key === 'ArrowDown') (e.preventDefault(), setActive((a) => Math.min(results.length - 1, a + 1)));
    else if (e.key === 'ArrowUp') (e.preventDefault(), setActive((a) => Math.max(0, a - 1)));
    else if (e.key === 'Enter') (e.preventDefault(), choose(results[active]));
    else if (e.key === 'Escape') setOpen(false);
  };

  return (
    <div className="tk-add" ref={box}>
      <input
        className="search tk-search"
        placeholder="Add: RELIANCE, NIFTY 25000 CE, BANKNIFTY FUT…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => results.length && setOpen(true)}
        onKeyDown={onKey}
        disabled={disabled}
        aria-label="Search instruments to add"
        aria-expanded={open}
        aria-controls="tk-results"
        role="combobox"
      />
      {state === 'loading' && <span className="tk-hint">Searching…</span>}
      {state === 'slow' && <span className="tk-hint">Loading Dhan's instrument list (first search of the day can take ~10 s)…</span>}
      {state && state !== 'loading' && state !== 'slow' && <span className="tk-hint err">{state}</span>}
      {open && q.trim().length >= 2 && !state && (
        <ul className="tk-results" id="tk-results" role="listbox">
          {results.length === 0 && <li className="tk-none">No match. Try the trading symbol, e.g. "NIFTY 25000 CE" or "SBIN".</li>}
          {results.map((r, i) => {
            const added = have.has(r.key);
            return (
              <li
                key={r.key}
                role="option"
                aria-selected={i === active}
                className={`${i === active ? 'active' : ''} ${added ? 'added' : ''}`}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => (e.preventDefault(), choose(r))}
              >
                <span className={`tk-seg ${kindOf(r.segment)}`}>{segLabel(r.segment)}</span>
                <span className="tk-r-main">
                  <b>{describe(r)}</b>
                  <span className="tk-r-sub">
                    {r.expiry ? `${fmtExpiry(r.expiry)} · Lot ${r.lotSize}` : r.name !== r.symbol ? r.name : r.underlying}
                  </span>
                </span>
                <span className="tk-r-act">{added ? 'Added' : 'Add'}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ connection

function timeLeft(iso) {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'expired';
  const h = Math.floor(ms / 3600_000);
  const m = Math.floor((ms % 3600_000) / 60_000);
  return h ? `${h} h ${m} m left` : `${m} min left`;
}

function ConnChip({ conn, onClick, open }) {
  const left = timeLeft(conn?.expiresAt);
  const bad = !conn?.connected || conn?.problem || left === 'expired';
  return (
    <button className={`tk-conn ${bad ? 'bad' : 'good'} ${open ? 'pressed' : ''}`} onClick={onClick} aria-expanded={open}>
      <i />
      {!conn?.connected ? 'Dhan not connected' : bad ? 'Dhan token needs attention' : `Dhan connected${left ? ` · ${left}` : ''}`}
    </button>
  );
}

function ConnectionPanel({ secret, conn, onChange, onClose }) {
  const [token, setToken] = useState('');
  const [clientId, setClientId] = useState('');
  const [status, setStatus] = useState(null);
  const busy = status?.kind === 'busy';

  const run = async (label, fn) => {
    setStatus({ kind: 'busy', text: label });
    try {
      const msg = await fn();
      setStatus({ kind: 'ok', text: msg });
    } catch (e) {
      setStatus({ kind: 'err', text: e.message });
    }
  };

  const save = (e) => {
    e.preventDefault();
    run('Checking token with Dhan…', async () => {
      const j = await api(secret, 'connect', { method: 'POST', body: { accessToken: token.trim(), clientId: clientId.trim() } });
      onChange({ ...j, problem: null });
      setToken('');
      return `Connected${j.profile?.dataPlan ? ` · Data plan: ${j.profile.dataPlan}` : ''}`;
    });
  };
  const renew = () =>
    run('Renewing…', async () => {
      const j = await api(secret, 'renew', { method: 'POST', body: {} });
      onChange({ ...j, problem: null });
      return `Renewed · ${timeLeft(j.expiresAt) || 'new token saved'}`;
    });
  const disconnect = () =>
    run('Removing…', async () => {
      await api(secret, 'disconnect', { method: 'POST', body: {} });
      onChange({ connected: false, expiresAt: null, problem: null, profile: null, clientId: '' });
      return 'Token removed from the app';
    });

  const left = timeLeft(conn?.expiresAt);

  return (
    <section className="card pad tk-conn-panel">
      <div className="ck-head">
        <h2>Dhan connection</h2>
        <button className="link dp-close" onClick={onClose}>Close</button>
      </div>

      {conn?.connected ? (
        <dl className="tk-facts">
          <div><dt>Client ID</dt><dd className="mono">{conn.clientId || '—'}</dd></div>
          <div><dt>Token</dt><dd className={left === 'expired' ? 'neg' : ''}>{left || 'expiry unknown'}{conn.source === 'env' && ' (from Vercel env)'}</dd></div>
          {conn.profile?.dataPlan && <div><dt>Data plan</dt><dd className={conn.profile.dataPlan === 'Active' ? 'pos' : 'neg'}>{conn.profile.dataPlan}</dd></div>}
          {conn.profile?.dataValidity && <div><dt>Data plan valid till</dt><dd>{String(conn.profile.dataValidity).replace(/\.0$/, '')}</dd></div>}
        </dl>
      ) : (
        <p className="muted">Paste a Dhan access token to start the live feed.</p>
      )}
      {conn?.problem && <div className="alert">⚠ {conn.problem}</div>}

      <form className="tk-conn-form" onSubmit={save}>
        <label className="grow">
          {conn?.connected ? 'Replace access token' : 'Access token'}
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="eyJ…" autoComplete="off" required />
        </label>
        <label>
          <span>Client ID <span className="opt">optional</span></span>
          <input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="read from token" inputMode="numeric" />
        </label>
        <button className="btn primary" type="submit" disabled={busy || !token.trim()}>Save &amp; connect</button>
      </form>
      <div className="form-actions tk-conn-actions">
        {conn?.connected && conn.source === 'saved' && (
          <button className="btn" onClick={renew} disabled={busy}>Renew token now</button>
        )}
        {conn?.connected && conn.source === 'saved' && (
          <button className="btn danger-outline" onClick={disconnect} disabled={busy}>Remove token</button>
        )}
        {status && <span className={`status ${status.kind}`}>{status.text}</span>}
      </div>
      <p className="muted small tk-help">
        Get a token at <b>web.dhan.co → My Profile → Access DhanHQ APIs</b>. Tokens last 24 hours. While the
        page is in use, the app renews the token automatically in its last hour; if it lapses, paste a new one
        here — no redeploy needed. The token is stored privately in your Vercel Blob store and never sent to the browser.
      </p>
    </section>
  );
}

// ------------------------------------------------------------------ secret gate

export function SecretGate({ error, notice, onSubmit }) {
  const [value, setValue] = useState('');
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  return (
    <section className="card pad tk-gate">
      <h2>Unlock the ticker</h2>
      <p className="muted">Live prices use your Dhan account, so this page needs your webhook secret (the same one you set in Vercel).</p>
      <form
        className="tk-conn-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          await onSubmit(value.trim(), remember);
          setBusy(false);
        }}
      >
        <label className="grow">
          Webhook secret
          <input type="password" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" required autoFocus />
        </label>
        <button className="btn primary" type="submit" disabled={busy || !value.trim()}>{busy ? 'Checking…' : 'Open ticker'}</button>
      </form>
      <label className="switch small tk-remember">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        <span>Remember on this device</span>
      </label>
      {notice && !error && <p className="status err">{notice}</p>}
      {error && <p className="status err">{error}</p>}
    </section>
  );
}
