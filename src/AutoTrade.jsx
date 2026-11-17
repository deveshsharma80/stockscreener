import { useCallback, useEffect, useMemo, useState } from 'react';
import { SECRET_KEY, SecretGate, api, money, price, store } from './Ticker.jsx';
import { ORDERS_EVENT, QUOTES_EVENT } from './Orders.jsx';
import { SETUP_EVENT, useLiveFeed } from './liveFeed.js';

// NSE Market → Auto Trading: paper shorts placed automatically from EMA Rejection alerts,
// with their own money (separate from Paper Trading). The server does the trading
// (lib/autotrade.js, run by the feed server every minute and on live ticks); this page shows
// it and holds the settings.

const tone = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
const pct = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`);
const hhmm = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }) : '');
const dayFmt = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const dateLabel = (d) => dayFmt.format(new Date(`${d}T00:00:00Z`));
const fmt = (v) => (v == null ? '—' : price.format(v));
const lakh = (v) => (v >= 1e5 ? `₹${(v / 1e5).toLocaleString('en-IN', { maximumFractionDigits: 2 })} L` : `₹${price.format(v)}`);

// same as the server (Dhan equity intraday)
function charges(buy, sell) {
  const b = Math.min(20, buy * 0.0003) + Math.min(20, sell * 0.0003);
  const ex = (buy + sell) * 0.0000297;
  const sebi = (buy + sell) * 0.000001;
  return sell * 0.00025 + ex + sebi + buy * 0.00003 + (b + ex + sebi) * 0.18 + b;
}

const STATUS = {
  PENDING: ['Waiting for entry', 'touched'],
  OPEN: ['Short open', 'rejected'],
  CLOSED: ['Closed', 'watching'],
  CANCELLED: ['Cancelled', 'expired'],
  SKIPPED: ['Skipped', 'expired'],
};
const REASON = { stop: 'stop loss', target: '1:2 target', time: '15:15 exit', manual: 'by you' };

export default function AutoTrade({ tab = 'today' }) {
  const [secret, setSecret] = useState(() => store.get(SECRET_KEY));
  const [unlocked, setUnlocked] = useState(false);
  const [error, setError] = useState('');
  const [data, setData] = useState(null);
  const [ltp, setLtp] = useState({});
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);
  const [amount, setAmount] = useState('');
  const [step, setStep] = useState(0);
  const live = useLiveFeed(unlocked ? secret : null);

  const load = useCallback(async (s = secret) => {
    try {
      const j = await api(s, 'auto');
      setData(j);
      setLtp((p) => ({ ...p, ...Object.fromEntries(Object.entries(j.ltp || {}).filter(([, v]) => v > 0)) }));
      setUnlocked(true);
      setError('');
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    }
  }, [secret]);

  useEffect(() => {
    if (secret) load(secret).then((ok) => !ok && (store.set(SECRET_KEY, ''), setSecret('')));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const active = (data?.trades || []).some((t) => t.status === 'OPEN' || t.status === 'PENDING');
  const marketOpen = data?.market?.open;
  // refresh: fast while shorts are live in market hours, slow otherwise; instantly on server events
  useEffect(() => {
    if (!unlocked) return;
    const t = setInterval(() => load(), active && marketOpen ? (live.live ? 30_000 : 10_000) : 60_000);
    const onOrders = (e) => e.detail?.events?.some?.((x) => x.kind === 'AUTO') && load();
    const onSetups = () => setTimeout(() => load(), 1500);
    window.addEventListener(ORDERS_EVENT, onOrders);
    window.addEventListener(SETUP_EVENT, onSetups);
    return () => {
      clearInterval(t);
      window.removeEventListener(ORDERS_EVENT, onOrders);
      window.removeEventListener(SETUP_EVENT, onSetups);
    };
  }, [unlocked, active, marketOpen, live.live, load]);
  // live prices from the stream
  useEffect(() => {
    const on = (e) => {
      const q = e.detail?.quotes;
      if (q) setLtp((p) => ({ ...p, ...Object.fromEntries(Object.entries(q).filter(([, v]) => v?.ltp > 0).map(([k, v]) => [k, v.ltp])) }));
    };
    window.addEventListener(QUOTES_EVENT, on);
    return () => window.removeEventListener(QUOTES_EVENT, on);
  }, []);

  const act = async (what, body, ok) => {
    setBusy(what);
    setMsg(null);
    try {
      const j = await api(secret, what, { method: 'POST', body });
      if (j.book) setData((d) => ({ ...d, ...j }));
      await load();
      if (ok) setMsg({ ok: true, text: ok });
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy('');
      setStep(0);
    }
  };

  const today = data?.today;
  const trades = data?.trades || [];
  const acct = data?.account;
  const book = data?.book;
  const rules = data?.rules;
  const mtm = (t) => (t.status === 'OPEN' && ltp[t.key] > 0 ? (t.fillPrice - ltp[t.key]) * t.qty - charges(ltp[t.key] * t.qty, t.fillPrice * t.qty) : null);
  const openPnl = useMemo(() => trades.filter((t) => t.status === 'OPEN').reduce((s, t) => s + (mtm(t) ?? 0), 0), [trades, ltp]); // eslint-disable-line react-hooks/exhaustive-deps
  const period = (t) => !acct?.resetAt || t.createdAt >= acct.resetAt;
  const todays = trades.filter((t) => t.day === today);
  const closed = trades.filter((t) => t.status === 'CLOSED' && period(t));

  if (!unlocked) {
    return <SecretGate error={error} notice="" onSubmit={async (s, remember) => { setSecret(s); if (await load(s)) store.set(SECRET_KEY, remember ? s : ''); }} />;
  }
  if (!data) return <div className="empty">Loading…</div>;

  const value = book.equity + openPnl;
  const amountNum = Number(String(amount).replace(/[,₹\s]/g, ''));
  const todayNet = closed.filter((t) => t.day === today).reduce((s, t) => s + t.net, 0) + openPnl;

  return (
    <>
      <section className="stats">
        <div className="stat">
          <div className="stat-label">Account value</div>
          <div className={`stat-value ${tone(value - book.amount)}`}>₹{price.format(Math.round(value))}</div>
          <div className="stat-note">{pct(((value - book.amount) / book.amount) * 100)} on ₹{price.format(book.amount)}{openPnl ? ` · open ${money(Math.round(openPnl))}` : ''}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Today</div>
          <div className={`stat-value ${tone(todayNet)}`}>{money(Math.round(todayNet))}</div>
          <div className="stat-note">{book.today.filled} / {rules.maxPerDay} shorts taken today</div>
        </div>
        <div className="stat">
          <div className="stat-label">Booked (after charges)</div>
          <div className={`stat-value ${tone(book.booked)}`}>{money(Math.round(book.booked))}</div>
          <div className="stat-note">{book.trades} trades · {book.winRate == null ? 'no closed trades yet' : `${book.winRate}% won`} · charges ₹{price.format(Math.round(book.charges))}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Size per short</div>
          <div className="stat-value">{lakh(book.perTrade)}</div>
          <div className="stat-note">₹{price.format(Math.round(book.equity))} × {rules.leverage} ÷ {rules.maxPerDay} · margin used {lakh(book.usedMargin)}</div>
        </div>
      </section>

      <section className="card">
        <div className="filters auto-controls">
          <button className={`btn ${acct.enabled ? 'primary' : ''}`} disabled={!!busy} onClick={() => act('auto-settings', { enabled: !acct.enabled }, acct.enabled ? 'Automation off: waiting orders cancelled; open shorts still exit on their stop / at 15:15.' : 'Automation on.')}>
            {acct.enabled ? '● Automation ON' : '○ Automation OFF'}
          </button>
          <span className="muted-cell">Exit</span>
          <div className="seg" role="group" aria-label="Exit">
            <button className={acct.exitMode === 'hold' ? 'on' : ''} disabled={!!busy} onClick={() => acct.exitMode !== 'hold' && act('auto-settings', { exitMode: 'hold' })}>Hold to {rules.exitTime}</button>
            <button className={acct.exitMode === '2R' ? 'on' : ''} disabled={!!busy} onClick={() => acct.exitMode !== '2R' && act('auto-settings', { exitMode: '2R' })}>Fixed 1:2</button>
          </div>
          <span className="push" />
          <label className="ema-day">
            <span>Amount (₹)</span>
            <input className="auto-amount" inputMode="numeric" placeholder={price.format(book.amount)} value={amount} onChange={(e) => (setAmount(e.target.value), setStep(0))} />
          </label>
          {step === 0 ? (
            <button className="btn danger-outline" disabled={!(amountNum >= 10000) || !!busy} onClick={() => setStep(1)}>Set &amp; reset…</button>
          ) : (
            <>
              <span className="dp-ask">Start again from now with ₹{price.format(amountNum)}? Past trades stay in History.</span>
              <button className="btn danger" disabled={!!busy} onClick={() => act('auto-reset', { amount: amountNum }, `Started again with ₹${price.format(amountNum)}.`).then(() => setAmount(''))}>Yes, reset</button>
              <button className="link" onClick={() => setStep(0)}>Cancel</button>
            </>
          )}
        </div>
        {msg && <p className={`status ${msg.ok ? 'ok' : 'err'} tk-pos-msg`}>{msg.text}</p>}
        <p className="muted-cell auto-rules">
          Paper money, separate from Paper Trading{acct.isDefault ? ' (₹5,00,000 until you set an amount)' : ''}. On each <b>EMA Rejection</b> alert: short below the alert candle’s low, stop loss above the bounce,
          {acct.exitMode === '2R' ? ' target 1:2,' : ''} everything covered at {rules.exitTime}. At most <b>{rules.maxPerDay} shorts a day</b>, each = account × {rules.leverage} ÷ {rules.maxPerDay} (the full {rules.leverage}× intraday leverage over {rules.maxPerDay} trades). No new entries after {rules.lastEntry}. Charges at Dhan intraday rates.
          {!live.live && marketOpen && ' Live prices are off right now, so checks run once a minute.'}
        </p>
      </section>

      {tab === 'today' ? (
        <section className="card">
          <div className="filters">
            <b>{dateLabel(today)}</b>
            <span className="muted-cell">{marketOpen ? 'market open' : 'market closed'}{live.live ? ' · live prices' : ''}</span>
          </div>
          <TradeTable rows={todays} ltp={ltp} mtm={mtm} busy={busy} onClose={(t) => act('auto-close', { id: t.id }, t.status === 'OPEN' ? `${t.symbol} covered.` : `${t.symbol} order cancelled.`)} live />
          {!todays.length && <div className="empty">No alerts yet today. Shorts are placed automatically when EMA Rejection fires (09:20–13:30).</div>}
        </section>
      ) : (
        <>
          <section className="card">
            <div className="filters"><b>By day</b><span className="muted-cell">since {acct.resetAt ? dateLabel(acct.resetAt.slice(0, 10)) : 'the start'}</span></div>
            <div className="table-wrap">
              <table className="journal">
                <thead>
                  <tr><th>Day</th><th className="num">Trades</th><th className="num">Won</th><th className="num">Gross</th><th className="num">Charges</th><th className="num">Net</th><th className="num">% of account</th></tr>
                </thead>
                <tbody>
                  {book.daily.map((d) => (
                    <tr key={d.day}>
                      <td>{dateLabel(d.day)}</td>
                      <td className="num mono">{d.trades}</td>
                      <td className="num mono">{d.wins}</td>
                      <td className={`num mono ${tone(d.gross)}`}>{money(Math.round(d.gross))}</td>
                      <td className="num mono muted-cell">₹{price.format(Math.round(d.charges))}</td>
                      <td className={`num mono ${tone(d.net)}`}><b>{money(Math.round(d.net))}</b></td>
                      <td className={`num mono ${tone(d.pctOfEquity)}`}>{pct(d.pctOfEquity)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!book.daily.length && <div className="empty">No closed trades yet.</div>}
            </div>
          </section>
          <section className="card">
            <div className="filters"><b>All automated orders</b><span className="muted-cell">newest first, including earlier periods</span></div>
            <TradeTable rows={trades} ltp={ltp} mtm={mtm} showDay />
          </section>
        </>
      )}
    </>
  );
}

function TradeTable({ rows, ltp, mtm, busy, onClose, live, showDay }) {
  if (!rows.length) return null;
  return (
    <div className="table-wrap">
      <table className="journal ema-table">
        <thead>
          <tr>
            {showDay && <th>Day</th>}
            <th>Stock</th>
            <th>Status</th>
            <th className="num">Qty</th>
            <th className="num">Entry ↓</th>
            <th className="num">Stop</th>
            <th className="num">{live ? 'LTP' : 'Exit'}</th>
            <th className="num">P&amp;L</th>
            <th>Times</th>
            {live && <th />}
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => {
            const [label, cls] = STATUS[t.status] || [t.status, ''];
            const pnl = t.status === 'CLOSED' ? t.net : mtm(t);
            return (
              <tr key={t.id} className={t.status === 'OPEN' ? 'ema-alert' : ''}>
                {showDay && <td className="mono">{dateLabel(t.day)}</td>}
                <td className="mono"><b>{t.symbol}</b></td>
                <td>
                  <span className={`ema-st ${cls}`}>{label}</span>
                  {t.status === 'CLOSED' && <div className="muted-cell ema-note">{REASON[t.exitReason] || t.exitReason}{t.r != null ? ` · ${t.r > 0 ? '+' : ''}${t.r}R` : ''}</div>}
                  {t.note && <div className="muted-cell ema-note">{t.note}</div>}
                </td>
                <td className="num mono">{t.qty?.toLocaleString('en-IN')}<div className="muted-cell ema-note">{t.value ? `₹${(t.value / 1e5).toFixed(2)} L` : ''}</div></td>
                <td className="num mono"><b>{fmt(t.fillPrice ?? t.entry)}</b>{t.fillPrice != null && t.fillPrice !== t.entry && <div className="muted-cell ema-note">level {fmt(t.entry)}</div>}</td>
                <td className="num mono neg">{fmt(t.sl)}{t.exitMode === '2R' && <div className="muted-cell ema-note">tgt {fmt(t.target)}</div>}</td>
                <td className="num mono">{live && t.status !== 'CLOSED' ? fmt(ltp[t.key]) : fmt(t.exitPrice)}</td>
                <td className={`num mono ${tone(pnl)}`}>{pnl == null ? '—' : <b>{money(Math.round(pnl))}</b>}</td>
                <td className="mono muted-cell ema-times">
                  <div>alert {t.alertAt}</div>
                  {t.filledAt && <div>in {hhmm(t.filledAt)}</div>}
                  {t.exitAt && <div>out {hhmm(t.exitAt)}</div>}
                </td>
                {live && (
                  <td>
                    {(t.status === 'OPEN' || t.status === 'PENDING') && (
                      <button className="btn" disabled={!!busy} onClick={() => onClose(t)}>{t.status === 'OPEN' ? 'Cover now' : 'Cancel'}</button>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
