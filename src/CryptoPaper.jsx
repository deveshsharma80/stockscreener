import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SECRET_KEY, SecretGate, store } from './Ticker.jsx';
import { fmtPrice, lastPrices, useProxy } from './binance.js';
import { cryptoApi } from './Crypto.jsx';

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

/** Rupee formatting for USDT amounts (× rate). */
function useInr(fx) {
  return useMemo(() => {
    const f = (usdt, { signed = false } = {}) => {
      if (usdt == null || !Number.isFinite(usdt)) return '—';
      const v = usdt * fx;
      const a = Math.abs(v);
      const s = a.toLocaleString('en-IN', { maximumFractionDigits: a < 100 ? 2 : 0 });
      return `${v < 0 ? '−' : signed && v > 0 ? '+' : ''}₹${s}`;
    };
    return f;
  }, [fx]);
}
const pct = (v) => (v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`);
const qtyFmt = (q) => (q == null ? '—' : Math.abs(q).toLocaleString('en-US', { maximumSignificantDigits: 8 }));

export default function CryptoPaper({ tab }) {
  const [secret, setSecret] = useState(() => store.get(SECRET_KEY));
  const [checking, setChecking] = useState(Boolean(store.get(SECRET_KEY)));
  const [unlocked, setUnlocked] = useState(false);
  const [error, setError] = useState('');
  const [book, setBook] = useState(null);
  const [prices, setPrices] = useState({});
  const [notice, setNotice] = useState(null); // { kind, text }

  const load = useCallback(async (s) => {
    try {
      const j = await cryptoApi(s, 'cp-book');
      setBook(j);
      if (j.liquidated?.length) {
        setNotice({ kind: 'err', text: `Liquidated: ${j.liquidated.map((l) => `${coin(l.symbol)} ${l.side.toLowerCase()} at ${fmtPrice(l.price)}`).join(', ')}. The margin was lost.` });
      }
      setUnlocked(true);
      setError('');
      useProxy(s);
      return true;
    } catch (e) {
      setError(e.message);
      return e.status !== 401 && e.status !== 403 ? (setUnlocked(true), true) : false;
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

  // Refresh the book every 30 s (also runs the server's liquidation check)
  useEffect(() => {
    if (!unlocked) return;
    const t = setInterval(() => !document.hidden && load(secret), 30_000);
    return () => clearInterval(t);
  }, [unlocked, secret, load]);

  const [ticketSym, setTicketSym] = useState(() => symbolFromHash() || 'BTCUSDT');
  useEffect(() => {
    const on = () => symbolFromHash() && setTicketSym(symbolFromHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  // Live prices for open positions and the ticket's coin
  const watch = useMemo(() => [...new Set([...(book?.positions || []).map((p) => p.symbol), ticketSym].filter(Boolean))], [book, ticketSym]);
  const watchKey = watch.join(',');
  const liqAsked = useRef(0);
  useEffect(() => {
    if (!unlocked || !watch.length) return;
    let alive = true;
    let timer;
    const tick = async () => {
      if (!document.hidden) {
        const p = await lastPrices(watch).catch(() => ({}));
        if (!alive) return;
        setPrices((x) => ({ ...x, ...p }));
        // A position crossed its liquidation price → let the server check and settle it
        const crossed = (book?.positions || []).some((pos) => p[pos.symbol] > 0 && (pos.qty > 0 ? p[pos.symbol] <= pos.liqPrice : p[pos.symbol] >= pos.liqPrice));
        if (crossed && Date.now() - liqAsked.current > 10_000) {
          liqAsked.current = Date.now();
          load(secret);
        }
      }
      if (alive) timer = setTimeout(tick, POLL_MS);
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [unlocked, watchKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (checking) return <p className="tk-note">Opening Paper Trading…</p>;
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
  if (!book) return <p className="status err">{error || 'Loading…'}</p>;

  const post = async (action, body) => {
    const j = await cryptoApi(secret, action, { method: 'POST', body });
    setBook(j); // every cp-* POST answers with the whole book
    return j;
  };

  return (
    <>
      {notice && (
        <p className={`status ${notice.kind} cp-notice`}>
          {notice.text}{' '}
          <button className="icon-btn" onClick={() => setNotice(null)} aria-label="Dismiss">×</button>
        </p>
      )}
      {error && <p className="status err">{error}</p>}
      {tab === 'reports' ? (
        <Reports book={book} />
      ) : tab === 'fills' ? (
        <Fills book={book} />
      ) : (
        <Overview book={book} prices={prices} post={post} sym={ticketSym} setSym={setTicketSym} setNotice={setNotice} />
      )}
    </>
  );
}

// ------------------------------------------------------------------ overview

function Overview({ book, prices, post, sym, setSym, setNotice }) {
  const inr = useInr(book.fx);
  const t = book.totals;
  // Live unrealised P&L from the page's prices (the server's figure is from its last read)
  const rows = book.positions.map((p) => {
    const price = prices[p.symbol] ?? p.price;
    const upnl = price != null ? (price - p.avg) * p.qty : null;
    return { ...p, price, upnl, roe: upnl != null ? (upnl / p.margin) * 100 : null, toLiq: price ? ((p.liqPrice - price) / price) * 100 : null };
  });
  const upnl = rows.every((r) => r.upnl != null) ? rows.reduce((s, r) => s + r.upnl, 0) : null;
  const equity = upnl != null ? t.balance + upnl : null;
  const available = t.balance - t.usedMargin - Math.max(0, -(upnl ?? 0));
  const periodNet = t.realized - t.fees;

  return (
    <>
      <section className="stats cp-stats">
        <Stat label="Equity" value={inr(equity ?? t.balance)} note={`started ${inr(t.capital)}`} />
        <Stat label="Open P&L" value={inr(upnl, { signed: true })} tone={tone(upnl)} note={`${rows.length} open`} />
        <Stat label="Booked P&L (this period)" value={inr(periodNet, { signed: true })} tone={tone(periodNet)} note={`after ${inr(t.fees)} fees`} />
        <Stat label="Available" value={inr(Math.max(0, available))} note={`margin in use ${inr(t.usedMargin)}`} />
        <Stat label="Return" value={pct(((equity ?? t.balance) / t.capital - 1) * 100)} tone={tone((equity ?? t.balance) - t.capital)} note={`₹${book.fx} per USDT`} />
      </section>
      <div className="cp-grid">
        <Ticket book={book} prices={prices} post={post} sym={sym} setSym={setSym} available={available} setNotice={setNotice} />
        <AccountCard book={book} post={post} setNotice={setNotice} />
      </div>
      <section className="card">
        <div className="card-head">
          <h2>Open positions</h2>
        </div>
        {!rows.length ? (
          <div className="empty">No open positions. Use the ticket above to open a long or short.</div>
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
                  <th className="num">Margin</th>
                  <th className="num">P&amp;L</th>
                  <th className="num">ROE</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.symbol}>
                    <td className="tk-inst">
                      <div className="tk-name">
                        <button className="cp-link" onClick={() => setSym(p.symbol)} title="Trade this coin">{coin(p.symbol)}</button>
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
                    <td className="num mono">{inr(p.margin)}</td>
                    <td className={`num mono ${tone(p.upnl)}`}><b>{inr(p.upnl, { signed: true })}</b></td>
                    <td className="num">
                      <span className={`tk-pnlpct ${p.roe > 0 ? 'up' : p.roe < 0 ? 'down' : 'flat'}`}>{pct(p.roe)}</span>
                    </td>
                    <td className="lp-act">
                      <CloseBtn
                        onClose={async () => {
                          const j = await post('cp-close', { symbol: p.symbol, price: p.price });
                          setNotice({ kind: 'ok', text: `Closed ${coin(p.symbol)} at ${fmtPrice(j.fill.price)}: ${inr(j.fill.realized - j.fill.fee, { signed: true })} on this exit (after fee).` });
                        }}
                        onError={(m) => setNotice({ kind: 'err', text: m })}
                      />
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
    </>
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

function Ticket({ book, prices, post, sym, setSym, available, setNotice }) {
  const inr = useInr(book.fx);
  const [draft, setDraft] = useState(coin(sym));
  useEffect(() => setDraft(coin(sym)), [sym]);
  const [side, setSide] = useState('BUY');
  const [lev, setLev] = useState(() => Number(store.get('stockhits.cpLev')) || 3);
  const [marginInr, setMarginInr] = useState('');
  const [closeAll, setCloseAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const price = prices[sym] ?? null;
  const pos = book.positions.find((p) => p.symbol === sym);
  const adding = pos && (side === 'BUY') === pos.qty > 0;
  const reducing = pos && !adding;
  const useLev = adding ? pos.leverage : lev; // leverage for a new / flipped position
  const sizeLev = pos ? pos.leverage : lev; // ₹ margin → position size

  const margin = Number(marginInr) / book.fx; // USDT
  const qty = closeAll && reducing ? Math.abs(pos.qty) : price > 0 && margin > 0 ? (margin * sizeLev) / price : 0;
  const notional = price > 0 ? qty * price : 0;
  const fee = notional * book.feeRate;
  const liq = price > 0 ? (side === 'BUY' ? price * (1 - 1 / useLev) : price * (1 + 1 / useLev)) : null;
  const canUse = Math.max(0, available) + (reducing ? pos.margin : 0);
  const setPct = (p) => {
    const m = (canUse * p) / 100 / (1 + sizeLev * book.feeRate); // leave room for the fee
    setCloseAll(false);
    setMarginInr(String(Math.floor(m * book.fx)));
  };

  const submit = async () => {
    if (!(qty > 0)) return;
    setBusy(true);
    try {
      const j = await post('cp-trade', { symbol: sym, side, qty: Number(qty.toPrecision(8)), leverage: useLev, price });
      const f = j.fill;
      setNotice({
        kind: 'ok',
        text: `${f.side === 'BUY' ? 'Bought' : 'Sold'} ${qtyFmt(f.qty)} ${coin(sym)} at ${fmtPrice(f.price)} (${inr(f.notional)}, ${f.leverage}×)${f.realized ? ` · booked ${inr(f.realized - f.fee, { signed: true })}` : ''}${f.priceSource === 'browser' ? ' · price from this page (server couldn’t reach Binance)' : ''}.`,
      });
      setMarginInr('');
      setCloseAll(false);
    } catch (e) {
      setNotice({ kind: 'err', text: e.message });
    }
    setBusy(false);
  };

  const pickSym = () => {
    const s = draft.trim().toUpperCase().replace(/[^A-Z0-9\u0080-￿]/g, '');
    if (s) setSym(s.endsWith('USDT') ? s : `${s}USDT`);
  };

  const action = closeAll && reducing ? `Close ${pos.side.toLowerCase()}` : !pos ? (side === 'BUY' ? 'Open long' : 'Open short') : adding ? `Add to ${pos.side.toLowerCase()}` : qty > Math.abs(pos.qty) ? `Close & flip to ${side === 'BUY' ? 'long' : 'short'}` : `Reduce ${pos.side.toLowerCase()}`;

  return (
    <section className="card cp-ticket">
      <div className="card-head">
        <h2>Trade</h2>
        <span className="muted-cell">market order</span>
      </div>
      <div className="cp-ticket-body">
        <div className="cp-row">
          <label className="cp-sym">
            <span>Coin</span>
            <input value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={pickSym} onKeyDown={(e) => e.key === 'Enter' && pickSym()} aria-label="Coin" spellCheck={false} />
            <span className="muted-cell">/USDT</span>
          </label>
          <div className="cp-price">
            <b className="mono">{price != null ? fmtPrice(price) : '…'}</b>
            <span className="muted-cell">{price != null ? `${inr(price)} per coin` : 'loading price'}</span>
          </div>
        </div>
        <div className="seg cp-side-seg" role="group" aria-label="Direction">
          <button className={side === 'BUY' ? 'on buy' : ''} onClick={() => setSide('BUY')}>Buy / Long</button>
          <button className={side === 'SELL' ? 'on sell' : ''} onClick={() => setSide('SELL')}>Sell / Short</button>
        </div>
        <label className="cp-lev">
          <span>
            Leverage <b className="mono">{useLev}×</b>
            {adding && <small className="muted-cell"> (fixed while the position is open)</small>}
          </span>
          <input
            type="range"
            min="1"
            max={book.maxLeverage}
            step="1"
            value={useLev}
            disabled={adding}
            onChange={(e) => {
              setLev(Number(e.target.value));
              store.set('stockhits.cpLev', e.target.value);
            }}
            aria-label="Leverage"
          />
        </label>
        <label className="cp-amt">
          <span>Margin (your money)</span>
          <div className="cp-amt-in">
            <span>₹</span>
            <input type="number" inputMode="decimal" min="0" step="any" value={closeAll && reducing ? String(Math.round(pos.margin * book.fx)) : marginInr} onChange={(e) => (setCloseAll(false), setMarginInr(e.target.value))} placeholder="0" aria-label="Margin in rupees" />
          </div>
        </label>
        <div className="cp-chips">
          {[10, 25, 50, 100].map((p) => (
            <button key={p} className="cp-chip" onClick={() => setPct(p)}>{p}%</button>
          ))}
          {pos && (
            <button className={`cp-chip ${closeAll && reducing ? 'on' : ''}`} onClick={() => (setSide(pos.qty > 0 ? 'SELL' : 'BUY'), setCloseAll(true))}>
              Close all {qtyFmt(pos.qty)}
            </button>
          )}
        </div>
        <dl className="cp-facts">
          <dt>Position size</dt>
          <dd className="mono">{notional ? `${inr(notional)} · ${qtyFmt(qty)} ${coin(sym)}` : '—'}</dd>
          <dt>Fee</dt>
          <dd className="mono">{notional ? inr(fee) : '—'}</dd>
          {!reducing && (
            <>
              <dt>Liquidation at</dt>
              <dd className="mono">{notional && liq ? `${fmtPrice(liq)} (${(100 / useLev).toFixed(1)}% ${side === 'BUY' ? 'down' : 'up'})` : '—'}</dd>
            </>
          )}
          <dt>Available</dt>
          <dd className="mono">{inr(canUse)}</dd>
        </dl>
        <button className={`btn cp-go ${side === 'BUY' ? 'buy' : 'sell'}`} onClick={submit} disabled={busy || !(qty > 0) || !(price > 0)}>
          {busy ? 'Placing…' : action}
        </button>
        {pos && (
          <p className="muted-cell cp-small">
            You hold {pos.side === 'LONG' ? 'a long' : 'a short'} of {qtyFmt(pos.qty)} {coin(sym)} at {pos.leverage}×. {reducing ? 'This order reduces it' : 'This order adds to it'}; the ₹ amount is margin at {pos.leverage}×.
          </p>
        )}

      </div>
    </section>
  );
}

function AccountCard({ book, post, setNotice }) {
  const inr = useInr(book.fx);
  const [amount, setAmount] = useState(String(book.account.capitalInr));
  const [fx, setFx] = useState(String(book.fx));
  const [busy, setBusy] = useState(false);
  const open = book.positions.length > 0;
  const reset = async () => {
    setBusy(true);
    try {
      await post('cp-reset', { capitalInr: Number(amount), fx: Number(fx) });
      setNotice({ kind: 'ok', text: `New period started with ₹${Number(amount).toLocaleString('en-IN')}. Earlier trades stay in Reports (All time).` });
    } catch (e) {
      setNotice({ kind: 'err', text: e.message });
    }
    setBusy(false);
  };
  return (
    <section className="card cp-account">
      <div className="card-head">
        <h2>Paper money</h2>
      </div>
      <div className="cp-ticket-body">
        <p className="muted-cell cp-small">
          Current period started {book.account.resetAt ? when(book.account.resetAt) : 'with your first trade'} with ₹{book.account.capitalInr.toLocaleString('en-IN')} ({inr(book.totals.capital)} = {book.totals.capital.toLocaleString('en-US', { maximumFractionDigits: 2 })} USDT).
        </p>
        <label className="cp-amt">
          <span>Start a new period with</span>
          <div className="cp-amt-in">
            <span>₹</span>
            <input type="number" min="1000" step="1000" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="New amount in rupees" />
          </div>
        </label>
        <label className="cp-amt">
          <span>Rate (₹ per USDT)</span>
          <div className="cp-amt-in">
            <span>₹</span>
            <input type="number" min="1" step="0.01" value={fx} onChange={(e) => setFx(e.target.value)} aria-label="Rupees per USDT" />
          </div>
        </label>
        <button className="btn" onClick={reset} disabled={busy || open} title={open ? 'Close open positions first' : ''}>
          {busy ? 'Saving…' : 'Reset paper money'}
        </button>
        <p className="muted-cell cp-small">{open ? 'Close open positions before resetting. ' : ''}Resetting keeps every past trade for Reports.</p>
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
