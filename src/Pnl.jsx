import { useCallback, useEffect, useMemo, useState } from 'react';
import { SECRET_KEY, SecretGate, api, describe, fmtExpiry, kindOf, money, price, segLabel, signed, store } from './Ticker.jsx';

// Paper-trading P&L reports: daily and weekly booked P&L, plus live open P&L.

const dayFmt = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const dayFull = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const timeFmt = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Kolkata' });
const rupees = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const tone = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
const dateLabel = (d) => dayFmt.format(new Date(`${d}T00:00:00Z`));
const weekLabel = (d) => {
  const start = new Date(`${d}T00:00:00Z`);
  const end = new Date(start.getTime() + 6 * 86_400_000);
  return `${dayFull.format(start).replace(/ \d{4}$/, '')} – ${dayFull.format(end)}`;
};
const PAGE = 100;

export default function Pnl() {
  const [secret, setSecret] = useState(() => store.get(SECRET_KEY));
  const [checking, setChecking] = useState(Boolean(store.get(SECRET_KEY)));
  const [unlocked, setUnlocked] = useState(false);
  const [error, setError] = useState('');
  const [book, setBook] = useState(null);
  const [quotes, setQuotes] = useState({});
  const [view, setView] = useState('daily');
  const [dayFilter, setDayFilter] = useState('');
  const [shown, setShown] = useState(PAGE);
  const [resetStep, setResetStep] = useState(0);
  const [mode, setMode] = useState(''); // '' | 'edit' | 'reset'
  const [amount, setAmount] = useState('');
  const [acctMsg, setAcctMsg] = useState(null);

  const load = useCallback(async (s) => {
    try {
      setBook(await api(s, 'paper'));
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

  // Live prices for open positions (every 10 s) so today's / this week's totals include open P&L.
  const openKeys = useMemo(() => (book?.positions || []).filter((p) => p.qty).map((p) => p.key).join(','), [book]);
  useEffect(() => {
    if (!unlocked || !openKeys) return;
    let alive = true;
    let timer;
    const tick = async () => {
      try {
        const j = await api(secret, 'quotes', { params: { keys: openKeys } });
        if (alive) setQuotes((q) => ({ ...q, ...j.quotes }));
      } catch {
        /* open P&L just stays unknown */
      }
      if (alive && !document.hidden) timer = setTimeout(tick, 10_000);
      else if (alive) timer = setTimeout(tick, 30_000);
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [unlocked, openKeys, secret]);

  if (checking) return <p className="tk-note">Opening P&amp;L…</p>;
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

  const t = book.totals;
  const open = (book.positions || []).filter((p) => p.qty);
  const openPnl = open.reduce((s, p) => (quotes[p.key]?.ltp != null ? s + (quotes[p.key].ltp - p.avg) * p.qty : s), 0);
  const openKnown = open.every((p) => quotes[p.key]?.ltp != null);
  const closes = t.wins + t.losses;

  const acct = book.account;
  const accountValue = acct.startingCapital + acct.netBooked + openPnl;
  const returnPct = ((accountValue - acct.startingCapital) / acct.startingCapital) * 100;
  const amountNum = Number(String(amount).replace(/[,₹\s]/g, ''));

  const startMode = (m) => {
    setMode(m);
    setAmount(String(acct.startingCapital));
    setResetStep(0);
    setAcctMsg(null);
  };
  const saveAmount = async (e) => {
    e.preventDefault();
    try {
      setBook(await api(secret, 'paper-capital', { method: 'POST', body: { amount: amountNum } }));
      setMode('');
      setAcctMsg({ kind: 'ok', text: `Starting amount set to ₹${price.format(amountNum)}` });
    } catch (err) {
      setAcctMsg({ kind: 'err', text: err.message });
    }
  };
  const reset = async () => {
    try {
      setBook(await api(secret, 'paper-reset', { method: 'POST', body: { amount: amountNum } }));
      setQuotes({});
      setResetStep(0);
      setMode('');
      setAcctMsg({ kind: 'ok', text: `Account reset to ₹${price.format(amountNum)}` });
    } catch (err) {
      setAcctMsg({ kind: 'err', text: err.message });
    }
  };

  const trades = dayFilter ? book.trades.filter((x) => x.date === dayFilter) : book.trades;

  const exportCsv = () => {
    const head = ['Time (IST)', 'Instrument', 'Segment', 'Expiry', 'Side', 'Qty', 'Price', 'Value', 'Brokerage', 'Gross P&L', 'Net P&L'];
    const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const lines = trades.map((x) =>
      [timeFmt.format(new Date(x.at)), describe(x), x.segment, x.expiry || '', x.side, x.qty, x.price, (x.qty * x.price).toFixed(2), x.charges, x.realized, x.net].map(esc).join(',')
    );
    const blob = new Blob([[head.join(','), ...lines].join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `paper-trades${dayFilter ? `-${dayFilter}` : ''}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <>
      {error && <div className="alert">⚠ {error}</div>}

      <section className="card pad pnl-account">
        <div className="pnl-acct-head">
          <h2>Paper account</h2>
          <span className="form-actions">
            <button className="btn" onClick={() => startMode(mode === 'edit' ? '' : 'edit')}>Change starting amount</button>
            <button className="btn danger-outline" onClick={() => startMode(mode === 'reset' ? '' : 'reset')}>Reset account…</button>
          </span>
        </div>
        <dl className="pnl-acct">
          <div><dt>Starting amount</dt><dd className="mono">₹{price.format(acct.startingCapital)}{acct.isDefault && <span className="opt"> default</span>}</dd></div>
          <div>
            <dt>Account value</dt>
            <dd className="mono big">₹{price.format(accountValue)}</dd>
          </div>
          <div><dt>Return</dt><dd className={`mono ${tone(returnPct)}`}>{signed.format(returnPct)}%</dd></div>
          <div><dt>Available to trade</dt><dd className="mono">₹{price.format(acct.available)}</dd></div>
          <div><dt>In open positions</dt><dd className="mono">₹{price.format(acct.used)}</dd></div>
        </dl>
        {mode === 'edit' && (
          <form className="tk-conn-form pnl-acct-form" onSubmit={saveAmount}>
            <label>
              New starting amount (₹)
              <input inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
            </label>
            <button className="btn primary" type="submit" disabled={!(amountNum >= 1000)}>Save</button>
            <button type="button" className="link" onClick={() => setMode('')}>Cancel</button>
            <span className="muted small">Keeps your trades; only the starting amount changes.</span>
          </form>
        )}
        {mode === 'reset' && (
          <div className="tk-conn-form pnl-acct-form">
            <label>
              Start again with (₹)
              <input inputMode="numeric" value={amount} onChange={(e) => (setAmount(e.target.value), setResetStep(0))} autoFocus />
            </label>
            {resetStep === 0 ? (
              <button className="btn danger-outline" onClick={() => setResetStep(1)} disabled={!(amountNum >= 1000)}>Reset…</button>
            ) : (
              <>
                <span className="dp-ask">
                  Delete {book.trades.length.toLocaleString('en-IN')} trades and start with ₹{price.format(amountNum)}?
                </span>
                <button className="btn danger" onClick={reset}>Yes, reset</button>
              </>
            )}
            <button type="button" className="link" onClick={() => setMode('')}>Cancel</button>
            <span className="muted small">Clears every paper trade, position and report. Your watchlist and real Dhan account are not touched.</span>
          </div>
        )}
        {acctMsg && <p className={`status ${acctMsg.kind}`}>{acctMsg.text}</p>}
        <p className="muted small pnl-acct-note">
          Available = starting amount + net booked P&amp;L − value of open positions. Each open position uses its full value (no leverage or margin).
        </p>
      </section>

      <section className="stats pnl-tiles">
        <Tile
          label="Today's net P&L"
          value={t.netToday + openPnl}
          note={`Gross ${signed.format(t.realizedToday)} · brokerage −${price.format(t.chargesToday)}${open.length ? ` · open ${openKnown ? signed.format(openPnl) : '…'}` : ''}`}
        />
        <Tile
          label="This week (net)"
          value={t.netWeek + openPnl}
          note={`Since Mon, ${dayFull.format(new Date(`${t.thisWeek}T00:00:00Z`)).replace(/ \d{4}$/, '')} · brokerage −${price.format(t.chargesWeek)}${open.length ? ' · incl. open' : ''}`}
        />
        <Tile label="All-time net booked" value={t.netAll} note={`Gross ${signed.format(t.realizedAll)} · brokerage −${price.format(t.chargesAll)}`} />
        <div className="stat">
          <div className="stat-label">Win rate</div>
          <div className="stat-value">{closes ? `${Math.round((t.wins / closes) * 100)}%` : '—'}</div>
          <div className="stat-note">{closes ? `${t.wins} won · ${t.losses} lost, after brokerage` : 'No closed trades yet'}</div>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>P&amp;L report</h2>
          <div className="seg" role="group" aria-label="Report">
            <button className={view === 'daily' ? 'on' : ''} onClick={() => setView('daily')}>Daily</button>
            <button className={view === 'weekly' ? 'on' : ''} onClick={() => setView('weekly')}>Weekly</button>
          </div>
        </div>
        <ReportTable
          rows={view === 'daily' ? book.daily : book.weekly}
          labelKey={view === 'daily' ? 'date' : 'weekOf'}
          label={view === 'daily' ? dateLabel : weekLabel}
          current={view === 'daily' ? book.today : t.thisWeek}
          openPnl={open.length ? openPnl : null}
          onPickDay={view === 'daily' ? (d) => (setDayFilter(d), setShown(PAGE), document.getElementById('pnl-trades')?.scrollIntoView({ behavior: 'smooth' })) : null}
        />
        <div className="foot">
          Booked P&amp;L by {view === 'daily' ? 'trading day' : 'week, Monday to Sunday'}, Indian time. Net = gross − brokerage ({book.brokeragePct}% of trade value on every buy and sell). Bars and cumulative use net.
          {open.length > 0 && ' Open positions are shown separately for the current period.'}
        </div>
      </section>

      <section className="card" id="pnl-trades">
        <div className="filters">
          <h2 className="pnl-h">Trades</h2>
          <select className="select" value={dayFilter} onChange={(e) => (setDayFilter(e.target.value), setShown(PAGE))} aria-label="Day">
            <option value="">All days</option>
            {book.daily.map((d) => <option key={d.date} value={d.date}>{dateLabel(d.date)}</option>)}
          </select>
          <button className="btn push" onClick={exportCsv} disabled={!trades.length}>Export CSV</button>
        </div>
        <div className="table-wrap tall">
          <table className="ticker pnl-trades">
            <thead>
              <tr>
                <th>Time</th>
                <th>Instrument</th>
                <th>Side</th>
                <th className="num">Qty</th>
                <th className="num">Price</th>
                <th className="num">Value</th>
                <th className="num">Brokerage</th>
                <th className="num">Gross P&amp;L</th>
                <th className="num">Net P&amp;L</th>
              </tr>
            </thead>
            <tbody>
              {trades.slice(0, shown).map((x) => (
                <tr key={x.id}>
                  <td className="mono muted-cell">{timeFmt.format(new Date(x.at))}</td>
                  <td className="tk-inst">
                    <div className="tk-name">{describe(x)}</div>
                    <div className="tk-sub">
                      <span className={`tk-seg ${kindOf(x.segment)}`}>{segLabel(x.segment)}</span>
                      {x.expiry && <span>{fmtExpiry(x.expiry)}</span>}
                      {!x.marketOpen && <span title="Placed while the market was closed">after hours</span>}
                    </div>
                  </td>
                  <td><span className={`side-pill ${x.side === 'BUY' ? 'buy' : 'sell'}`}>{x.side}</span></td>
                  <td className="num mono">{x.qty.toLocaleString('en-IN')}</td>
                  <td className="num mono">{price.format(x.price)}</td>
                  <td className="num mono muted-cell">{rupees.format(x.qty * x.price)}</td>
                  <td className="num mono muted-cell">−{price.format(x.charges)}</td>
                  <td className={`num mono ${tone(x.realized)}`}>{x.closedQty ? signed.format(x.realized) : <span className="muted-dash">—</span>}</td>
                  <td className={`num mono ${tone(x.net)}`}>{signed.format(x.net)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!trades.length && <div className="empty">No paper trades{dayFilter ? ' on this day' : ' yet'}. Place one with Buy or Sell on the Ticker page.</div>}
        </div>
        <div className="foot">
          {trades.length > shown ? (
            <button className="link" onClick={() => setShown((n) => n + PAGE)}>Show {Math.min(PAGE, trades.length - shown)} more</button>
          ) : (
            `${trades.length.toLocaleString('en-IN')} trades`
          )}
        </div>
      </section>

    </>
  );
}

function Tile({ label, value, note }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className={`stat-value mono-num ${tone(value)}`}>{money(value)}</div>
      {note && <div className="stat-note">{note}</div>}
    </div>
  );
}

// Booked P&L per period with a diverging bar (profit right, loss left of zero).
function ReportTable({ rows, labelKey, label, current, openPnl, onPickDay }) {
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.net)));
  const cumulative = useMemo(() => {
    const out = new Map();
    let run = 0;
    for (const r of [...rows].reverse()) {
      run += r.net;
      out.set(r[labelKey], run);
    }
    return out;
  }, [rows, labelKey]);

  if (!rows.length) return <div className="empty">No paper trades yet. Reports appear after your first Buy or Sell.</div>;
  return (
    <div className="table-wrap tall">
      <table className="ticker pnl-report">
        <thead>
          <tr>
            <th>{labelKey === 'date' ? 'Day' : 'Week'}</th>
            <th className="num">Trades</th>
            <th className="num">Instruments</th>
            <th className="num">Turnover ₹</th>
            <th className="num">Won / lost</th>
            <th className="num">Gross P&amp;L</th>
            <th className="num">Brokerage</th>
            <th className="pnl-bar-h">Net P&amp;L</th>
            <th className="num">Cumulative</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const k = r[labelKey];
            const w = (Math.abs(r.net) / max) * 50;
            return (
              <tr key={k}>
                <td>
                  {onPickDay ? (
                    <button className="link pnl-day" onClick={() => onPickDay(k)} title="Show this day's trades">{label(k)}</button>
                  ) : (
                    label(k)
                  )}
                  {k === current && <span className="badge pnl-now">{labelKey === 'date' ? 'Today' : 'This week'}</span>}
                </td>
                <td className="num mono">{r.trades}</td>
                <td className="num mono">{r.instruments}</td>
                <td className="num mono muted-cell">{rupees.format(r.turnover)}</td>
                <td className="num mono">
                  {r.wins || r.losses ? (
                    <>
                      <span className="pos">{r.wins}</span> / <span className="neg">{r.losses}</span>
                    </>
                  ) : (
                    <span className="muted-dash">—</span>
                  )}
                </td>
                <td className={`num mono ${tone(r.realized)}`}>{signed.format(r.realized)}</td>
                <td className="num mono muted-cell">−{price.format(r.charges)}</td>
                <td className="pnl-bar-cell" title={`Net ${signed.format(r.net)} = gross ${signed.format(r.realized)} − brokerage ${price.format(r.charges)}`}>
                  <span className="pnl-bar">
                    <span className="pnl-zero" />
                    {r.net !== 0 && (
                      <span className={`pnl-fill ${r.net > 0 ? 'up' : 'down'}`} style={{ width: `${w}%`, [r.net > 0 ? 'left' : 'right']: '50%' }} />
                    )}
                  </span>
                  <span className={`mono pnl-val ${tone(r.net)}`}>{signed.format(r.net)}</span>
                  {k === current && openPnl != null && openPnl !== 0 && (
                    <span className={`pnl-open ${tone(openPnl)}`}>open {signed.format(openPnl)}</span>
                  )}
                </td>
                <td className={`num mono ${tone(cumulative.get(k))}`}>{signed.format(cumulative.get(k))}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
