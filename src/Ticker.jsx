import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// Live market table for instruments you pick, fed by Dhan's Quote API through
// /api/ticker (your Dhan token stays on the server).

const SECRET_KEY = 'stockhits.secret';
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

const price = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: 'exceptZero' });
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

const store = {
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

const kindOf = (seg) => (seg === 'IDX_I' ? 'idx' : seg.endsWith('FNO') ? 'fno' : 'eq');
const segLabel = (seg) => ({ IDX_I: 'INDEX', NSE_EQ: 'NSE', BSE_EQ: 'BSE', NSE_FNO: 'NFO', BSE_FNO: 'BFO' })[seg] || seg;
const fmtExpiry = (e) => {
  if (!e) return '';
  const [y, m, d] = e.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y.slice(2)}`;
};
const fmtTime = (t) => {
  if (!t) return '';
  if (typeof t === 'number') return new Date(t * (t < 1e12 ? 1000 : 1)).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
  const m = /(\d{1,2}:\d{2}:\d{2})/.exec(String(t));
  return m ? m[1] : String(t);
};
function describe(row) {
  if (row.instrument?.startsWith('OPT')) return `${row.underlying || row.symbol.split('-')[0]} ${row.strike} ${row.optionType}`;
  if (row.instrument?.startsWith('FUT')) return `${row.underlying || row.symbol.split('-')[0]} FUT`;
  return row.symbol || row.name;
}

async function api(secret, action, { method = 'GET', params = {}, body } = {}) {
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

  // Initial load: check secret, Dhan connection and the saved list.
  const loadAll = useCallback(async (s) => {
    setPageError('');
    try {
      const [st, wl] = await Promise.all([api(s, 'status', { params: { check: '1' } }), api(s, 'watchlist')]);
      setConn(st);
      setMarket(st.market);
      setRows(wl.rows);
      setUnlocked(true);
      if (!st.connected || st.problem) setShowConn(true);
      return true;
    } catch (e) {
      if (e.kind === 'secret' || e.status === 401 || e.status === 403) setUnlocked(false);
      setPageError(e.message);
      return false;
    }
  }, []);

  useEffect(() => {
    if (secret) loadAll(secret);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const on = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);

  // ---- live polling (one request at a time, never overlapping)
  const keys = useMemo(() => rows.map((r) => r.key).join(','), [rows]);
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
    } catch (e) {
      setPageError(e.message);
    } finally {
      setBusyKey('');
    }
  };

  // ---- view
  const counts = useMemo(() => {
    const c = { all: rows.length, eq: 0, fno: 0, idx: 0 };
    for (const r of rows) c[kindOf(r.segment)]++;
    return c;
  }, [rows]);

  const view = useMemo(() => {
    const list = rows.map((r, i) => ({ ...r, order: i, q: quotes[r.key] || null })).filter((r) => tab === 'all' || kindOf(r.segment) === tab);
    if (sort.key === 'order') return list;
    const val = (r) => (sort.key === 'name' ? describe(r) : r.q?.[sort.key] ?? null);
    return list.sort((a, b) => {
      const x = val(a);
      const y = val(b);
      if (x === null && y === null) return a.order - b.order;
      if (x === null) return 1;
      if (y === null) return -1;
      const c = typeof x === 'string' ? x.localeCompare(y) : x - y;
      return sort.dir === 'asc' ? c : -c;
    });
  }, [rows, quotes, tab, sort]);

  const showOI = view.some((r) => kindOf(r.segment) === 'fno');

  if (!unlocked) {
    return (
      <SecretGate
        initial={secret}
        error={pageError}
        onSubmit={async (s, remember) => {
          setSecret(s);
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
                    : !rows.length
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
      {market && !market.open && conn?.connected && rows.length > 0 && !feedError && (
        <p className="tk-note">Market is closed, so prices refresh every 30 s and show the last traded values.</p>
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
        </div>
        <div className="table-wrap tall">
          <table className="ticker">
            <thead>
              <tr>
                <Th k="name">Instrument</Th>
                <Th k="ltp" className="num">LTP</Th>
                <Th k="change" className="num">Chg</Th>
                <Th k="changePct" className="num">Chg %</Th>
                <Th k="bid" className="num">Bid</Th>
                <Th k="ask" className="num">Ask</Th>
                <Th k="open" className="num">Open</Th>
                <Th k="high" className="num">High</Th>
                <Th k="low" className="num">Low</Th>
                <Th k="prevClose" className="num">Prev close</Th>
                <Th k="volume" className="num">Volume</Th>
                {showOI && <Th k="oi" className="num">OI</Th>}
                <th className="tk-time-h">Last trade</th>
                <th aria-label="Remove" />
              </tr>
            </thead>
            <tbody>
              {view.map((r) => (
                <TickerRow key={r.key} row={r} showOI={showOI} busy={busyKey === r.key} onRemove={() => remove(r.key)} />
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
    </>
  );
}

// ------------------------------------------------------------------ row with tick flash

function TickerRow({ row, showOI, busy, onRemove }) {
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
  const P = (v) => (v == null || (v === 0 && kind !== 'fno') ? <span className="muted-dash">—</span> : price.format(v));

  return (
    <tr>
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
      <td className="num mono tk-bidask" title={q?.bidQty ? `Qty ${q.bidQty}` : undefined}>{P(q?.bid)}</td>
      <td className="num mono tk-bidask" title={q?.askQty ? `Qty ${q.askQty}` : undefined}>{P(q?.ask)}</td>
      <td className="num mono">{P(q?.open)}</td>
      <td className="num mono">{P(q?.high)}</td>
      <td className="num mono">{P(q?.low)}</td>
      <td className="num mono muted-cell">{P(q?.prevClose)}</td>
      <td className="num mono" title={q?.volume ? q.volume.toLocaleString('en-IN') : undefined}>
        {q?.volume ? compact.format(q.volume) : <span className="muted-dash">—</span>}
      </td>
      {showOI && (
        <td className="num mono" title={q?.oi ? q.oi.toLocaleString('en-IN') : undefined}>
          {kind === 'fno' && q?.oi ? compact.format(q.oi) : <span className="muted-dash">—</span>}
        </td>
      )}
      <td className="mono muted-cell tk-time">{fmtTime(q?.lastTradeTime)}</td>
      <td className="tk-x">
        <button className="icon-btn" onClick={onRemove} disabled={busy} aria-label={`Remove ${describe(row)}`} title="Remove">
          ×
        </button>
      </td>
    </tr>
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
    if (!r || have.has(r.key)) return;
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

function SecretGate({ initial, error, onSubmit }) {
  const [value, setValue] = useState(initial || '');
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
      {error && <p className="status err">{error}</p>}
    </section>
  );
}
