import { useCallback, useEffect, useMemo, useState } from 'react';
import { AddToTicker, OrderButtons } from './AddToTicker.jsx';
import { SECRET_KEY, api, price, store } from './Ticker.jsx';
import { SETUP_EVENT } from './liveFeed.js';
import { EMA_SCAN, PARAMS, STATUS_LABEL, isFirstCandleHit, istDate } from './emasetup.js';
import EmaBacktest from './EmaBacktest.jsx';

// Signals → EMA Rejection: stocks from the "Futures April 2025" Chartink screener
// (gap-down, red first candle; only stocks sent for the 09:15 candle) and whether the bounce got rejected at the 9 / 26 EMA on
// 5-minute candles. The feed server checks a few seconds after each 5-minute close.

const ORDER = { rejected: 0, touched: 1, watching: 2, waiting: 3, 'broke-out': 4, expired: 5, error: 6 };
const hhmm = (iso) => new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
const fmt = (v) => (v == null ? '—' : price.format(v));

export default function EmaSetups({ rows }) {
  const [view, setView] = useState('live');
  return (
    <>
      <div className="seg ema-views" role="group" aria-label="View">
        <button className={view === 'live' ? 'on' : ''} onClick={() => setView('live')}>Live</button>
        <button className={view === 'backtest' ? 'on' : ''} onClick={() => setView('backtest')}>Backtest</button>
      </div>
      {view === 'live' ? <EmaLive rows={rows} /> : <EmaBacktest />}
    </>
  );
}

function EmaLive({ rows }) {
  const today = istDate(Date.now());
  const [day, setDay] = useState(today);
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/stocks?setups=1&day=${day}`, { cache: 'no-store' });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setData(j);
      setErr('');
    } catch (e) {
      setErr(e.message);
    }
  }, [day]);

  useEffect(() => {
    load();
    const on = () => load(); // the feed server finished a check
    window.addEventListener(SETUP_EVENT, on);
    const t = setInterval(load, 60_000);
    return () => {
      window.removeEventListener(SETUP_EVENT, on);
      clearInterval(t);
    };
  }, [load]);

  // stocks the screener sent that day (also those not checked yet)
  const hitsOfDay = useMemo(() => {
    const m = new Map();
    for (const r of rows) {
      if (istDate(Date.parse(r.HitTime)) !== day || !isFirstCandleHit(Date.parse(r.HitTime))) continue;
      const prev = m.get(r.StockSymbol);
      if (!prev || Date.parse(r.HitTime) < Date.parse(prev.HitTime)) m.set(r.StockSymbol, r);
    }
    return m;
  }, [rows, day]);
  const days = useMemo(() => [...new Set([today, ...rows.map((r) => istDate(Date.parse(r.HitTime)))])].sort().reverse().slice(0, 30), [rows, today]);

  const list = useMemo(() => {
    const bySym = new Map((data?.setups || []).map((s) => [s.symbol, s]));
    for (const [sym, h] of hitsOfDay) if (!bySym.has(sym)) bySym.set(sym, { symbol: sym, hitTime: h.HitTime, triggerPrice: h.TriggerPrice, status: 'waiting', note: 'checked at the next 5-minute close' });
    return [...bySym.values()].sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9) || Date.parse(a.hitTime) - Date.parse(b.hitTime));
  }, [data, hitsOfDay]);

  const counts = useMemo(() => {
    const c = {};
    for (const s of list) c[s.status] = (c[s.status] || 0) + 1;
    return c;
  }, [list]);

  const secret = store.get(SECRET_KEY);
  const checkNow = async () => {
    setBusy(true);
    try {
      await api(secret, 'ema-setups-run');
      await load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="stats">
        <div className="stat"><div className="stat-label">Stocks from the screener</div><div className="stat-value">{list.length}</div><div className="stat-note">{EMA_SCAN}</div></div>
        <div className="stat"><div className="stat-label">Rejected → short</div><div className="stat-value neg">{counts.rejected || 0}</div><div className="stat-note">alerts {day === today ? 'today' : 'that day'}</div></div>
        <div className="stat"><div className="stat-label">At the EMA / watching</div><div className="stat-value">{(counts.touched || 0) + (counts.watching || 0) + (counts.waiting || 0)}</div><div className="stat-note">{counts.touched || 0} at the EMA now</div></div>
        <div className="stat"><div className="stat-label">Broke above 26 EMA</div><div className="stat-value">{counts['broke-out'] || 0}</div><div className="stat-note">skipped for the day</div></div>
      </section>

      <section className="card">
        <div className="filters">
          <label className="ema-day">
            <span>Day</span>
            <select className="select" value={day} onChange={(e) => setDay(e.target.value)}>
              {days.map((d) => <option key={d} value={d}>{d === today ? `Today (${d})` : d}</option>)}
            </select>
          </label>
          <span className="muted-cell">
            5-minute candles · 9 / 26 EMA · checked 8 s after each candle closes, 09:20–{PARAMS.cutoff}
            {data?.setups?.[0]?.checkedAt && day === today && <> · last check {hhmm(data.setups.reduce((a, s) => (s.checkedAt > a ? s.checkedAt : a), ''))}</>}
          </span>
          {secret && day === today && (
            <button className="btn push" onClick={checkNow} disabled={busy}>{busy ? 'Checking…' : 'Check now'}</button>
          )}
        </div>
        {err && <p className="status err tk-pos-msg">{err}</p>}
        <div className="table-wrap">
          <table className="journal ema-table">
            <thead>
              <tr>
                <th>Stock</th>
                <th>Status</th>
                <th className="num">Gap</th>
                <th className="num">Entry ↓</th>
                <th className="num">Stop loss</th>
                <th className="num">Target</th>
                <th className="num">R:R</th>
                <th className="num">9 / 26 EMA</th>
                <th>Times</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((s) => (
                <tr key={s.symbol} className={s.status === 'rejected' ? 'ema-alert' : ''}>
                  <td className="mono"><b>{s.symbol}</b></td>
                  <td>
                    <span className={`ema-st ${s.status}`}>{STATUS_LABEL[s.status] || s.status}</span>
                    {s.note && <div className="muted-cell ema-note">{s.note}</div>}
                  </td>
                  <td className={`num mono ${s.gapPct < 0 ? 'neg' : s.gapPct > 0 ? 'pos' : ''}`}>{s.gapPct == null ? '—' : `${s.gapPct > 0 ? '+' : ''}${s.gapPct.toFixed(2)}%`}</td>
                  <td className="num mono"><b>{fmt(s.entry)}</b></td>
                  <td className="num mono neg">{fmt(s.sl)}</td>
                  <td className="num mono pos">{fmt(s.target)}</td>
                  <td className="num mono">{s.rr == null ? '—' : `1 : ${s.rr}`}</td>
                  <td className="num mono muted-cell ema-emas">{s.ema9 == null ? '—' : <>{fmt(s.ema9)}<br />{fmt(s.ema26)}</>}</td>
                  <td className="mono muted-cell ema-times">
                    <div>hit {s.hitTime ? hhmm(s.hitTime) : '—'}</div>
                    {s.touchedAt && <div>EMA {s.touchedAt}</div>}
                    {s.alertAt && <div><b className="neg">alert {s.alertAt}</b></div>}
                    {s.brokeAt && <div>✗ {s.brokeAt}</div>}
                  </td>
                  <td>
                    <div className="ema-act">
                      {day === today && <OrderButtons symbol={s.symbol} refPrice={s.entry ?? s.triggerPrice} />}
                      <AddToTicker symbol={s.symbol} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!list.length && <div className="empty">No stocks from “{EMA_SCAN}” {day === today ? 'yet today' : 'that day'}.</div>}
        </div>
        <div className="foot">
          Short setup: after the gap-down first candle, the bounce reaches the 9 EMA (or up to the 26 EMA) and a red 5-minute candle then closes back below the 9 EMA and below the touching candle’s low, with the 26 EMA still falling. A close above the 26 EMA cancels it for the day. Entry below the alert candle’s low, stop above the bounce’s high, first target the day’s low (or 1:2 if the day’s low is above the entry). Only stocks the screener sends for the first 5-minute candle (09:15) are checked. Paper-trade it first.
        </div>
      </section>
    </>
  );
}
