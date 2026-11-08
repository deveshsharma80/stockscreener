import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SECRET_KEY, SecretGate, store } from './Ticker.jsx';
import { fmtPrice, lastPrices, useProxy } from './binance.js';
import { cryptoApi } from './Crypto.jsx';
import { triggerHit, useCryptoBook } from './cryptoBook.js';
import CryptoTrade from './CryptoTrade.jsx';

// Crypto paper trading (Binance-Futures style): long / short with 1–10× leverage,
// 0.05 % fee per side, liquidation when the margin is used up. Money is entered
// and shown in rupees at the account's fixed rate (₹85 per USDT by default);
// coin prices stay in USDT. The book lives on the server (/api/crypto cp-*).

const POLL_MS = 3000;
const coin = (s) => s.replace(/USDT$/, '');
const tone = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
const symbolFromHash = () => (window.location.hash.split('?')[1] || '').match(/(?:^|&)s=([^&]+)/)?.[1] || '';
const istFmt = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
const dayFmt = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
const when = (t) => (t ? istFmt.format(new Date(t)) : '—');
const istDay = (t) => new Date(Date.parse(t) + 330 * 60_000).toISOString().slice(0, 10);
const held = (ms) => {
  if (ms == null) return '—';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h ${m % 60} min` : `${Math.floor(h / 24)} d ${h % 24} h`;
};

/** Rupee formatting for USDT amounts (× rate). Plain function, safe anywhere. */
function useInrStatic(fx) {
  return (usdt, { signed = false } = {}) => {
    if (usdt == null || !Number.isFinite(usdt)) return '—';
    const v = usdt * fx;
    const a = Math.abs(v);
    const s = a.toLocaleString('en-IN', { maximumFractionDigits: a < 100 ? 2 : 0 });
    return `${v < 0 ? '−' : signed && v > 0 ? '+' : ''}₹${s}`;
  };
}
const useInr = useInrStatic;
const pct = (v) => (v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`);
const qtyFmt = (q) => (q == null ? '—' : Math.abs(q).toLocaleString('en-US', { maximumSignificantDigits: 8 }));

/** Sign-in gate shared by the crypto paper pages; renders children(secret). */
function Gate({ label, children }) {
  const [secret, setSecret] = useState(() => store.get(SECRET_KEY));
  const [checking, setChecking] = useState(Boolean(store.get(SECRET_KEY)));
  const [ok, setOk] = useState(false);
  const [error, setError] = useState('');
  const check = useCallback(async (s) => {
    try {
      await cryptoApi(s, 'cp-book');
      setOk(true);
      setError('');
      useProxy(s);
      return true;
    } catch (e) {
      setError(e.message);
      return e.status !== 401 && e.status !== 403 ? (setOk(true), true) : false;
    }
  }, []);
  useEffect(() => {
    if (!secret) return;
    check(secret).then((good) => {
      setChecking(false);
      if (!good) {
        store.set(SECRET_KEY, '');
        setSecret('');
      }
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (checking) return <p className="tk-note">Opening {label}…</p>;
  if (!ok) {
    return (
      <SecretGate
        error={error}
        notice=""
        onSubmit={async (s, remember) => {
          setSecret(s);
          if (await check(s)) store.set(SECRET_KEY, remember ? s : '');
        }}
      />
    );
  }
  return children(secret);
}

function Liquidations({ cb }) {
  return (
    <>
      {cb.liquidated.length > 0 && (
        <p className="status err cp-notice">
          Liquidated: {cb.liquidated.map((l) => `${coin(l.symbol)} ${l.side.toLowerCase()} at ${fmtPrice(l.price)}`).join(', ')}. The margin was lost.{' '}
          <button className="icon-btn" onClick={cb.clearLiquidated} aria-label="Dismiss">×</button>
        </p>
      )}
      {cb.exited.length > 0 && (
        <p className="status ok cp-notice">
          {cb.exited.map((x) => `${x.kind === 'SL' ? 'Stop loss' : 'Take profit'} hit: ${coin(x.symbol)} ${x.side.toLowerCase()} closed at ${fmtPrice(x.price)} (level ${fmtPrice(x.level)})`).join(' · ')}.{' '}
          <button className="icon-btn" onClick={cb.clearExited} aria-label="Dismiss">×</button>
        </p>
      )}
    </>
  );
}

/** Live prices for the open positions; asks the server to check when a liquidation / SL / TP price is reached. */
function useLivePrices(book, checkNow, extra = []) {
  const [prices, setPrices] = useState({});
  const syms = [...new Set([...(book?.positions || []).map((p) => p.symbol), ...extra].filter(Boolean))];
  const key = syms.join(',');
  const asked = useRef(0);
  useEffect(() => {
    if (!syms.length) return;
    let alive = true;
    let timer;
    const tick = async () => {
      if (!document.hidden) {
        const p = await lastPrices(syms).catch(() => ({}));
        if (!alive) return;
        setPrices((x) => ({ ...x, ...p }));
        const crossed = (book?.positions || []).some((pos) => triggerHit(pos, p[pos.symbol]));
        if (crossed && Date.now() - asked.current > 10_000) {
          asked.current = Date.now();
          checkNow(p).catch(() => {});
        }
      }
      if (alive) timer = setTimeout(tick, POLL_MS);
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return prices;
}

/** Totals with live unrealised P&L. */
function liveTotals(book, prices) {
  const t = book.totals;
  const rows = book.positions.map((p) => {
    const price = prices[p.symbol] ?? p.price;
    const upnl = price != null ? (price - p.avg) * p.qty : null;
    return { ...p, price, upnl, roe: upnl != null ? (upnl / p.margin) * 100 : null, toLiq: price ? ((p.liqPrice - price) / price) * 100 : null };
  });
  const upnl = rows.every((r) => r.upnl != null) ? rows.reduce((s, r) => s + r.upnl, 0) : null;
  const equity = upnl != null ? t.balance + upnl : null;
  return { rows, upnl, equity, available: t.balance - t.usedMargin - Math.max(0, -(upnl ?? 0)), net: t.realized - t.fees };
}

function SummaryStats({ book, live }) {
  const inr = useInr(book.fx);
  const t = book.totals;
  const eq = live.equity ?? t.balance;
  return (
    <section className="stats cp-stats">
      <Stat label="Equity" value={inr(eq)} note={`started ${inr(t.capital)}`} />
      <Stat label="Open P&L" value={inr(live.upnl, { signed: true })} tone={tone(live.upnl)} note={`${live.rows.length} open`} />
      <Stat label="Booked P&L (this period)" value={inr(live.net, { signed: true })} tone={tone(live.net)} note={`after ${inr(t.fees)} fees`} />
      <Stat label="Available" value={inr(Math.max(0, live.available))} note={`margin in use ${inr(t.usedMargin)}`} />
      <Stat label="Return" value={pct((eq / t.capital - 1) * 100)} tone={tone(eq - t.capital)} note={`₹${book.fx} per USDT`} />
    </section>
  );
}

function Stat({ label, value, note, tone: t = '' }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${t}`}>{value}</div>
      {note && <div className="stat-note">{note}</div>}
    </div>
  );
}

/** Close → "Confirm close" (4 s) → done. */
function CloseBtn({ onClose, onError }) {
  const [stage, setStage] = useState('idle');
  useEffect(() => {
    if (stage !== 'confirm') return;
    const t = setTimeout(() => setStage('idle'), 4000);
    return () => clearTimeout(t);
  }, [stage]);
  if (stage === 'idle') return <button className="btn lp-exit" onClick={() => setStage('confirm')}>Close</button>;
  return (
    <button
      className="btn tk-exit-confirm lp-exit"
      disabled={stage === 'busy'}
      onClick={async () => {
        setStage('busy');
        try {
          await onClose();
        } catch (e) {
          onError(e.message);
          setStage('idle');
        }
      }}
    >
      {stage === 'busy' ? 'Closing…' : 'Confirm close'}
    </button>
  );
}

// ------------------------------------------------------------------ Positions (left menu: Crypto → Positions)

export function CryptoPositions() {
  return <Gate label="Positions">{(secret) => <PositionsPage secret={secret} />}</Gate>;
}

function PositionsPage({ secret }) {
  const cb = useCryptoBook(secret);
  const [tradeSym, setTradeSym] = useState(null);
  const [notice, setNotice] = useState(null);
  const prices = useLivePrices(cb.book, cb.checkNow);
  if (!cb.book) return <p className={cb.error ? 'status err' : 'tk-note'}>{cb.error || 'Loading positions…'}</p>;
  const book = cb.book;
  const inr = useInrStatic(book.fx);
  const live = liveTotals(book, prices);
  return (
    <>
      <Liquidations cb={cb} />
      {notice && (
        <p className={`status ${notice.kind} cp-notice`}>
          {notice.text} <button className="icon-btn" onClick={() => setNotice(null)} aria-label="Dismiss">×</button>
        </p>
      )}
      <SummaryStats book={book} live={live} />
      <section className="card">
        <div className="card-head">
          <h2>Open positions</h2>
          <a className="link" href="#/crypto/watchlist">Trade from Futures →</a>
        </div>
        {!live.rows.length ? (
          <div className="empty">No open positions. Use the Trade button on a coin in Futures to open a long or short.</div>
        ) : (
          <div className="table-wrap">
            <table className="ticker cp-table">
              <thead>
                <tr>
                  <th>Coin</th>
                  <th className="num">Size</th>
                  <th className="num">Entry</th>
                  <th className="num">Price</th>
                  <th className="num">Liq. price</th>
                  <th className="num">SL / TP</th>
                  <th className="num">Margin</th>
                  <th className="num">P&amp;L</th>
                  <th className="num">ROE</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {live.rows.map((p) => (
                  <tr key={p.symbol}>
                    <td className="tk-inst">
                      <div className="tk-name">
                        <a className="link" href={`#/crypto/chart?s=${p.symbol}`}>{coin(p.symbol)}</a>
                      </div>
                      <div className="tk-sub">
                        <span className={`cp-side ${p.side.toLowerCase()}`}>{p.side === 'LONG' ? 'Long' : 'Short'} {p.leverage}×</span>
                        <span>since {when(p.openedAt)}</span>
                      </div>
                    </td>
                    <td className="num mono">
                      {qtyFmt(p.qty)} <span className="muted-cell">{coin(p.symbol)}</span>
                      <div className="muted-cell">{inr(p.notional)}</div>
                    </td>
                    <td className="num mono">{fmtPrice(p.avg)}</td>
                    <td className="num mono"><b>{fmtPrice(p.price)}</b></td>
                    <td className="num mono">
                      {fmtPrice(p.liqPrice)}
                      {p.toLiq != null && <div className={`cp-toliq ${Math.abs(p.toLiq) < 3 ? 'near' : ''}`}>{Math.abs(p.toLiq).toFixed(1)}% away</div>}
                    </td>
                    <td className="num mono cp-sltp">
                      {p.sl == null && p.tp == null ? (
                        <a className="link" href={`#/crypto/chart?s=${p.symbol}`} title="Set stop loss / take profit on the chart">Set on chart</a>
                      ) : (
                        <>
                          <div className="sl">{p.sl != null ? `SL ${fmtPrice(p.sl)}` : '—'}</div>
                          <div className="tp">{p.tp != null ? `TP ${fmtPrice(p.tp)}` : '—'}</div>
                        </>
                      )}
                    </td>
                    <td className="num mono">{inr(p.margin)}</td>
                    <td className={`num mono ${tone(p.upnl)}`}><b>{inr(p.upnl, { signed: true })}</b></td>
                    <td className="num">
                      <span className={`tk-pnlpct ${p.roe > 0 ? 'up' : p.roe < 0 ? 'down' : 'flat'}`}>{pct(p.roe)}</span>
                    </td>
                    <td className="lp-act">
                      <div className="cp-acts">
                      <button className="btn tk-row-trade" onClick={() => setTradeSym((s) => (s === p.symbol ? null : p.symbol))}>Trade</button>
                      <CloseBtn
                        onClose={async () => {
                          const j = await cb.post('cp-close', { symbol: p.symbol, price: p.price });
                          setNotice({ kind: 'ok', text: `Closed ${coin(p.symbol)} at ${fmtPrice(j.fill.price)}: ${inr(j.fill.realized - j.fill.fee, { signed: true })} on this exit (after fee).` });
                        }}
                        onError={(m) => setNotice({ kind: 'err', text: m })}
                      />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="foot">
          Prices: Binance last price (perpetual, else spot), refreshed every 3 s · liquidation when the loss reaches the margin · fee {(book.feeRate * 100).toFixed(2)}% per side
        </div>
      </section>
      {tradeSym && <CryptoTrade symbol={tradeSym} book={book} post={cb.post} onClose={() => setTradeSym(null)} />}
    </>
  );
}

// ------------------------------------------------------------------ Paper Trading (account, reports, fills)

export default function CryptoPaper({ tab }) {
  return <Gate label="Paper Trading">{(secret) => <PaperPage secret={secret} tab={tab} />}</Gate>;
}

function PaperPage({ secret, tab }) {
  const cb = useCryptoBook(secret);
  const [notice, setNotice] = useState(null);
  const prices = useLivePrices(tab === 'account' ? cb.book : null, cb.checkNow);
  if (!cb.book) return <p className={cb.error ? 'status err' : 'tk-note'}>{cb.error || 'Loading…'}</p>;
  const book = cb.book;
  return (
    <>
      <Liquidations cb={cb} />
      {notice && (
        <p className={`status ${notice.kind} cp-notice`}>
          {notice.text} <button className="icon-btn" onClick={() => setNotice(null)} aria-label="Dismiss">×</button>
        </p>
      )}
      {tab === 'reports' ? (
        <Reports book={book} />
      ) : tab === 'fills' ? (
        <Fills book={book} />
      ) : (
        <>
          <SummaryStats book={book} live={liveTotals(book, prices)} />
          <AccountCard book={book} post={cb.post} setNotice={setNotice} prices={prices} />
        </>
      )}
    </>
  );
}

function AccountCard({ book, post, setNotice, prices = {} }) {
  const inr = useInr(book.fx);
  const [amount, setAmount] = useState(String(book.account.capitalInr));
  const [fx, setFx] = useState(String(book.fx));
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const open = book.positions.length;
  useEffect(() => {
    if (!confirm) return;
    const t = setTimeout(() => setConfirm(false), 6000);
    return () => clearTimeout(t);
  }, [confirm]);
  const reset = async () => {
    if (!confirm) return setConfirm(true);
    setConfirm(false);
    setBusy(true);
    try {
      await post('cp-reset', { capitalInr: Number(amount), fx: Number(fx), closeOpen: open > 0, prices });
      setNotice({ kind: 'ok', text: `${open ? `Closed ${open} position${open === 1 ? '' : 's'} at market and started` : 'Started'} a new period with ₹${Number(amount).toLocaleString('en-IN')}. Earlier trades stay in Reports (All time).` });
    } catch (e) {
      setNotice({ kind: 'err', text: e.message });
    }
    setBusy(false);
  };
  const label = open ? `Close ${open} position${open === 1 ? '' : 's'} & reset` : 'Reset paper money';
  return (
    <section className="card cp-account">
      <div className="card-head">
        <h2>Paper money</h2>
      </div>
      <div className="cp-ticket-body">
        <p className="muted-cell cp-small">
          Current period {book.account.resetAt ? `started ${when(book.account.resetAt)}` : 'started with your first trade'} with ₹{book.account.capitalInr.toLocaleString('en-IN')} ({book.totals.capital.toLocaleString('en-US', { maximumFractionDigits: 2 })} USDT at ₹{book.fx}). Balance now {inr(book.totals.balance)}.
        </p>
        <label className="cp-amt">
          <span>Amount to paper trade</span>
          <div className="cp-amt-in">
            <span>₹</span>
            <input type="number" min="1000" step="1000" value={amount} onChange={(e) => (setAmount(e.target.value), setConfirm(false))} aria-label="Amount in rupees" />
          </div>
        </label>
        <div className="cp-chips">
          {[50000, 100000, 500000, 1000000].map((v) => (
            <button key={v} className={`cp-chip ${Number(amount) === v ? 'on' : ''}`} onClick={() => (setAmount(String(v)), setConfirm(false))}>₹{v.toLocaleString('en-IN')}</button>
          ))}
        </div>
        <label className="cp-amt">
          <span>Rate (₹ per USDT)</span>
          <div className="cp-amt-in">
            <span>₹</span>
            <input type="number" min="1" step="0.01" value={fx} onChange={(e) => (setFx(e.target.value), setConfirm(false))} aria-label="Rupees per USDT" />
          </div>
        </label>
        <button className={`btn ${confirm ? 'danger' : 'primary'}`} onClick={reset} disabled={busy || !(Number(amount) >= 1000)}>
          {busy ? 'Saving…' : confirm ? `Confirm: ${label.toLowerCase()}` : label}
        </button>
        <p className="muted-cell cp-small">
          Resetting starts a new period with this amount{open ? ' after closing your open positions at market' : ''}. Every past trade stays in Reports (All time).
        </p>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ reports

function Reports({ book }) {
  const inr = useInr(book.fx);
  const [scope, setScope] = useState('period');
  const since = book.account.resetAt ? Date.parse(book.account.resetAt) : 0;
  const trips = book.trips.filter((t) => t.status === 'CLOSED' && (scope === 'all' || Date.parse(t.openedAt) >= since));
  const s = useMemo(() => {
    const net = trips.reduce((a, t) => a + t.net, 0);
    const fees = trips.reduce((a, t) => a + t.fees, 0);
    const wins = trips.filter((t) => t.net > 0);
    const losses = trips.filter((t) => t.net < 0);
    const best = trips.reduce((b, t) => (!b || t.net > b.net ? t : b), null);
    const worst = trips.reduce((b, t) => (!b || t.net < b.net ? t : b), null);
    const avgWin = wins.length ? wins.reduce((a, t) => a + t.net, 0) / wins.length : null;
    const avgLoss = losses.length ? losses.reduce((a, t) => a + t.net, 0) / losses.length : null;
    const byCoin = {};
    const byDay = {};
    for (const t of trips) {
      const c = (byCoin[t.symbol] ||= { symbol: t.symbol, n: 0, wins: 0, net: 0 });
      c.n++;
      c.wins += t.net > 0 ? 1 : 0;
      c.net += t.net;
      const d = (byDay[istDay(t.closedAt)] ||= { day: istDay(t.closedAt), n: 0, wins: 0, net: 0 });
      d.n++;
      d.wins += t.net > 0 ? 1 : 0;
      d.net += t.net;
    }
    return {
      net,
      fees,
      wins: wins.length,
      winRate: trips.length ? (wins.length / trips.length) * 100 : null,
      best,
      worst,
      avgWin,
      avgLoss,
      liquidations: trips.filter((t) => t.liquidated).length,
      byCoin: Object.values(byCoin).sort((a, b) => b.net - a.net),
      byDay: Object.values(byDay).sort((a, b) => (a.day < b.day ? 1 : -1)),
    };
  }, [trips]);

  return (
    <>
      <div className="seg cd-views" role="group" aria-label="Which trades">
        <button className={scope === 'period' ? 'on' : ''} onClick={() => setScope('period')}>This period</button>
        <button className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')}>All time</button>
      </div>
      <section className="stats cp-stats">
        <Stat label="Net P&L (booked)" value={inr(s.net, { signed: true })} tone={tone(s.net)} note={`after ${inr(s.fees)} fees`} />
        <Stat label="Return on capital" value={scope === 'period' ? pct((s.net / book.totals.capital) * 100) : '—'} tone={tone(s.net)} note={scope === 'period' ? `on ${inr(book.totals.capital)}` : 'per period only'} />
        <Stat label="Win rate" value={s.winRate == null ? '—' : `${Math.round(s.winRate)}%`} note={`${s.wins} won · ${trips.length - s.wins} lost`} />
        <Stat label="Avg win / loss" value={`${inr(s.avgWin)} / ${inr(s.avgLoss)}`} note={`${trips.length} closed trades`} />
        <Stat label="Liquidations" value={s.liquidations} tone={s.liquidations ? 'neg' : ''} note={s.best ? `best ${coin(s.best.symbol)} ${inr(s.best.net, { signed: true })}` : '—'} />
      </section>
      <EquityCurve trips={trips} inr={inr} />
      <div className="cp-grid">
        <section className="card">
          <div className="card-head"><h2>By coin</h2></div>
          <SmallTable rows={s.byCoin} first={(r) => <b>{coin(r.symbol)}</b>} inr={inr} empty="No closed trades yet." />
        </section>
        <section className="card">
          <div className="card-head"><h2>By day (IST)</h2></div>
          <SmallTable rows={s.byDay} first={(r) => dayFmt.format(new Date(`${r.day}T12:00:00+05:30`))} inr={inr} empty="No closed trades yet." />
        </section>
      </div>
      <section className="card">
        <div className="card-head"><h2>Closed trades</h2></div>
        {!trips.length ? (
          <div className="empty">No closed trades {scope === 'period' ? 'in this period' : 'yet'}.</div>
        ) : (
          <div className="table-wrap">
            <table className="ticker cp-table">
              <thead>
                <tr>
                  <th>Coin</th>
                  <th>Opened → closed</th>
                  <th>Held</th>
                  <th className="num">Qty</th>
                  <th className="num">Entry</th>
                  <th className="num">Exit</th>
                  <th className="num">Fees</th>
                  <th className="num">Net P&amp;L</th>
                  <th className="num">ROE</th>
                </tr>
              </thead>
              <tbody>
                {trips.map((t) => (
                  <tr key={t.id}>
                    <td className="tk-inst">
                      <div className="tk-name">{coin(t.symbol)}</div>
                      <div className="tk-sub">
                        <span className={`cp-side ${t.side.toLowerCase()}`}>{t.side === 'LONG' ? 'Long' : 'Short'} {t.leverage}×</span>
                        {t.liquidated && <span className="ind-tag cp-liq">Liquidated</span>}
                        {t.exitBy && <span className={`ind-tag cp-${t.exitBy.toLowerCase()}`}>{t.exitBy === 'SL' ? 'Stop loss' : 'Take profit'}</span>}
                      </div>
                    </td>
                    <td className="muted-cell">{when(t.openedAt)} → {when(t.closedAt)}</td>
                    <td className="muted-cell">{held(t.holdMs)}</td>
                    <td className="num mono">{qtyFmt(t.qty)}</td>
                    <td className="num mono">{fmtPrice(t.entry)}</td>
                    <td className="num mono">{fmtPrice(t.exit)}</td>
                    <td className="num mono muted-cell">{inr(t.fees)}</td>
                    <td className={`num mono ${tone(t.net)}`}><b>{inr(t.net, { signed: true })}</b></td>
                    <td className="num"><span className={`tk-pnlpct ${t.roe > 0 ? 'up' : t.roe < 0 ? 'down' : 'flat'}`}>{pct(t.roe)}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="foot">ROE = net P&amp;L ÷ margin used (your money in the trade) · amounts at ₹{book.fx} per USDT</div>
      </section>
    </>
  );
}

function SmallTable({ rows, first, inr, empty }) {
  if (!rows.length) return <div className="empty">{empty}</div>;
  return (
    <div className="table-wrap">
      <table className="ticker cp-table">
        <thead>
          <tr>
            <th />
            <th className="num">Trades</th>
            <th className="num">Win rate</th>
            <th className="num">Net P&amp;L</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td className="mono">{first(r)}</td>
              <td className="num mono">{r.n}</td>
              <td className="num mono">{Math.round((r.wins / r.n) * 100)}%</td>
              <td className={`num mono ${tone(r.net)}`}><b>{inr(r.net, { signed: true })}</b></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Cumulative booked P&L after each closed trade (oldest → newest). */
function EquityCurve({ trips, inr }) {
  const pts = trips.slice().sort((a, b) => Date.parse(a.closedAt) - Date.parse(b.closedAt));
  if (pts.length < 2) return null;
  let run = 0;
  const ys = [0, ...pts.map((t) => (run += t.net))];
  const W = 1000;
  const Hh = 160;
  const min = Math.min(0, ...ys);
  const max = Math.max(0, ...ys);
  const span = max - min || 1;
  const x = (i) => (i / (ys.length - 1)) * W;
  const y = (v) => Hh - 8 - ((v - min) / span) * (Hh - 16);
  const d = ys.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const last = ys[ys.length - 1];
  return (
    <section className="card cp-curve">
      <div className="card-head">
        <h2>Booked P&amp;L over trades</h2>
        <b className={`mono ${tone(last)}`}>{inr(last, { signed: true })}</b>
      </div>
      <svg viewBox={`0 0 ${W} ${Hh}`} preserveAspectRatio="none" role="img" aria-label={`Cumulative booked P&L across ${pts.length} closed trades, ending at ${inr(last, { signed: true })}`}>
        <line x1="0" x2={W} y1={y(0)} y2={y(0)} className="cp-zero" />
        <path d={d} className={`cp-line ${last >= 0 ? 'up' : 'down'}`} vectorEffect="non-scaling-stroke" />
      </svg>
    </section>
  );
}

// ------------------------------------------------------------------ fills

function Fills({ book }) {
  const inr = useInr(book.fx);
  const fills = book.fills;
  return (
    <section className="card">
      <div className="card-head"><h2>Fills</h2></div>
      {!fills.length ? (
        <div className="empty">No trades yet.</div>
      ) : (
        <div className="table-wrap">
          <table className="ticker cp-table">
            <thead>
              <tr>
                <th>Time (IST)</th>
                <th>Coin</th>
                <th>Side</th>
                <th className="num">Qty</th>
                <th className="num">Price</th>
                <th className="num">Value</th>
                <th className="num">Fee</th>
                <th className="num">Booked</th>
              </tr>
            </thead>
            <tbody>
              {fills.map((f) => (
                <tr key={f.id}>
                  <td className="muted-cell">{when(f.at)}</td>
                  <td className="mono"><b>{coin(f.symbol)}</b></td>
                  <td>
                    <span className={`cp-side ${f.side === 'BUY' ? 'long' : 'short'}`}>{f.side === 'BUY' ? 'Buy' : 'Sell'} {f.leverage}×</span>
                    {f.kind === 'liquidation' && <span className="ind-tag cp-liq">Liquidation</span>}
                    {(f.kind === 'sl' || f.kind === 'tp') && <span className={`ind-tag cp-${f.kind}`}>{f.kind === 'sl' ? 'Stop loss' : 'Take profit'}</span>}
                  </td>
                  <td className="num mono">{qtyFmt(f.qty)}</td>
                  <td className="num mono">{fmtPrice(f.price)}</td>
                  <td className="num mono">{inr(f.notional)}</td>
                  <td className="num mono muted-cell">{inr(f.fee)}</td>
                  <td className={`num mono ${tone(f.realized)}`}>{f.realized ? inr(f.realized, { signed: true }) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="foot">{fills.length} fills, all periods · amounts at ₹{book.fx} per USDT</div>
    </section>
  );
}
