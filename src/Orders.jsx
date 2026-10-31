import { useEffect, useMemo, useRef, useState } from 'react';
import { api, price } from './Ticker.jsx';

// Trigger orders: "Buy SBIN when it reaches ₹820". Always Equity Intraday.
// The server watches the price and places the paper trade at the live price
// once it gets there (see lib/orders.js).

export const ORDERS_EVENT = 'stockhits:orders';
/** Tell the rest of the page about order changes: { events?, pending?, placed?, orders? } */
export const emitOrders = (detail) => window.dispatchEvent(new CustomEvent(ORDERS_EVENT, { detail }));

const istTime = new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
const istDay = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
const istDateOf = (t) => new Date(new Date(t).getTime() + 330 * 60_000).toISOString().slice(0, 10);
/** "3:30 pm today", or "Mon, 2 Nov, 3:30 pm" */
export function whenText(iso) {
  if (!iso) return '';
  const sameDay = istDateOf(iso) === istDateOf(Date.now());
  return `${sameDay ? '' : `${istDay.format(new Date(iso))}, `}${istTime.format(new Date(iso))}${sameDay ? ' today' : ''}`;
}
const fmt = (v) => (v == null ? '…' : `₹${price.format(v)}`);
const dirWord = (o) => (o.direction === 'up' ? 'rises to' : 'falls to');
export const orderLabel = (o) => `${o.side === 'BUY' ? 'Buy' : 'Sell'} ${o.qty.toLocaleString('en-IN')} ${o.symbol} when price ${dirWord(o)} ₹${price.format(o.triggerPrice)}`;

/** Toast / message text for an order that just changed. */
export function eventText(o) {
  if (o.status === 'FILLED') return `${o.side === 'BUY' ? 'Bought' : 'Sold'} ${o.qty.toLocaleString('en-IN')} ${o.symbol} at ₹${price.format(o.fillPrice)} — your trigger ₹${price.format(o.triggerPrice)} was reached.`;
  if (o.status === 'FAILED') return `${o.side === 'BUY' ? 'Buy' : 'Sell'} ${o.symbol} at ₹${price.format(o.triggerPrice)} triggered but wasn't placed: ${o.error}`;
  if (o.status === 'EXPIRED') return `${o.side === 'BUY' ? 'Buy' : 'Sell'} ${o.symbol} at ₹${price.format(o.triggerPrice)} expired at market close without reaching the price.`;
  return orderLabel(o);
}

// ------------------------------------------------------------------ the popup

export function OrderModal({ secret, symbol, initialSide = 'BUY', refPrice = null, onClose, onPlaced }) {
  const [side, setSide] = useState(initialSide);
  const [info, setInfo] = useState(null); // from ?action=resolve
  const [loadErr, setLoadErr] = useState('');
  const [trigger, setTrigger] = useState(refPrice != null ? String(refPrice) : '');
  const [qty, setQty] = useState('1');
  const [status, setStatus] = useState(null);
  const touched = useRef(refPrice != null);
  const box = useRef(null);

  // Instrument, live price and funds; refreshed every 5 s while open
  useEffect(() => {
    let alive = true;
    let timer;
    const load = async () => {
      try {
        const j = await api(secret, 'resolve', { params: { symbol } });
        if (!alive) return;
        setInfo(j);
        setLoadErr('');
        if (!touched.current && j.ltp != null) {
          setTrigger(String(j.ltp));
          touched.current = true;
        }
      } catch (e) {
        if (alive) setLoadErr(e.message);
      }
      if (alive) timer = setTimeout(load, 5000);
    };
    load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [secret, symbol]);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    box.current?.querySelector('input')?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const t = Number(trigger);
  const q = Math.floor(Number(qty) || 0);
  const ltp = info?.ltp ?? null;
  const lev = info?.product?.leverage ?? 4;
  const pct = info?.product?.brokeragePct ?? 0.025;
  const valid = t > 0 && q > 0;
  const value = valid ? t * q : 0;
  const margin = value / lev;
  const charges = (value * pct) / 100;
  const available = info?.account?.available ?? null;
  // Selling against a long (or buying against a short) frees margin instead
  const held = info?.position?.qty || 0;
  const closing = held && Math.sign(held) !== (side === 'BUY' ? 1 : -1) ? Math.min(q, Math.abs(held)) : 0;
  const need = ((q - closing) * t) / lev + charges;
  const short = valid && available != null && q - closing > 0 && need > available;
  const maxQty = available != null && t > 0 ? Math.max(0, Math.floor(available / (t / lev + (t * pct) / 100))) : null;
  const dir = ltp == null || !(t > 0) ? null : t >= ltp ? 'up' : 'down';
  const atTrigger = ltp != null && t > 0 && Math.abs(t - ltp) < 0.005;
  const busy = status?.kind === 'busy';

  const submit = async (e) => {
    e.preventDefault();
    if (!valid || busy) return;
    setStatus({ kind: 'busy', text: 'Placing order…' });
    try {
      const j = await api(secret, 'place-order', {
        method: 'POST',
        body: { symbol, side, qty: q, triggerPrice: t, refPrice, source: 'firsthit' },
      });
      emitOrders({ placed: j.order, orders: j.orders });
      onPlaced?.(j);
    } catch (err) {
      setStatus({ kind: 'err', text: err.message });
    }
  };

  const chip = (label, v) =>
    v != null && (
      <button type="button" className="om-chip" onClick={() => setTrigger(String(v))}>
        {label} ₹{price.format(v)}
      </button>
    );

  return (
    <div className="om-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form ref={box} noValidate className={`om ${side === 'BUY' ? 'is-buy' : 'is-sell'}`} onSubmit={submit} role="dialog" aria-modal="true" aria-label={`${side === 'BUY' ? 'Buy' : 'Sell'} ${symbol} at a price`}>
        <div className="om-head">
          <div>
            <div className="om-title">
              <span className="sym">{symbol}</span>
              <span className="tk-prod EQ_INTRADAY">INTRADAY {lev}×</span>
            </div>
            <div className="om-sub">
              {info?.inst?.name && info.inst.name !== symbol && <>{info.inst.name} · </>}
              Now <b className="mono">{fmt(ltp)}</b>
              {info?.changePct != null && (
                <span className={info.changePct > 0 ? 'pos' : info.changePct < 0 ? 'neg' : ''}> ({info.changePct > 0 ? '+' : ''}{info.changePct.toFixed(2)}%)</span>
              )}
              {info && !info.market.open && ' · market closed'}
            </div>
          </div>
          <button type="button" className="btn btn-close" onClick={onClose}>Close</button>
        </div>

        <div className="seg tk-side om-side" role="group" aria-label="Side">
          <button type="button" className={side === 'BUY' ? 'on buy' : ''} onClick={() => setSide('BUY')}>Buy</button>
          <button type="button" className={side === 'SELL' ? 'on sell' : ''} onClick={() => setSide('SELL')}>Sell</button>
        </div>

        <div className="om-fields">
          <label>
            <span>Take the trade at (₹)</span>
            <input
              type="number"
              inputMode="decimal"
              min="0.01"
              step="any"
              value={trigger}
              onChange={(e) => {
                touched.current = true;
                setTrigger(e.target.value);
                setStatus(null);
              }}
              aria-label="Trigger price"
              required
            />
          </label>
          <label>
            <span>Quantity (shares)</span>
            <input type="number" min="1" step="1" value={qty} onChange={(e) => (setQty(e.target.value), setStatus(null))} aria-label="Quantity" required />
          </label>
        </div>
        <div className="om-chips">
          {chip('Now', ltp)}
          {chip('First hit', refPrice)}
          {maxQty != null && maxQty > 0 && (
            <button type="button" className="om-chip" onClick={() => setQty(String(maxQty))}>Max qty {maxQty.toLocaleString('en-IN')}</button>
          )}
        </div>

        <p className={`om-when ${side === 'BUY' ? 'buy' : 'sell'}`}>
          {!(t > 0)
            ? 'Enter the price at which to take the trade.'
            : ltp == null
              ? `${side === 'BUY' ? 'Buys' : 'Sells'} when the price reaches ₹${price.format(t)}.`
              : atTrigger
                ? `The price is at ₹${price.format(t)} now, so this ${side === 'BUY' ? 'buys' : 'sells'} on the next check.`
                : <>
                    {side === 'BUY' ? 'Buys' : 'Sells'} {q > 0 ? q.toLocaleString('en-IN') : ''} when the price <b>{dir === 'up' ? 'rises' : 'falls'} to ₹{price.format(t)}</b>{' '}
                    (now ₹{price.format(ltp)}, {dir === 'up' ? '+' : '−'}{(Math.abs(t - ltp) / ltp * 100).toFixed(2)}% away)
                  </>}
        </p>

        <dl className="om-facts">
          <div><dt>Order value</dt><dd className="mono">{valid ? `₹${price.format(value)}` : '—'}</dd></div>
          <div><dt>Margin ({lev}×)</dt><dd className="mono">{valid ? `₹${price.format(margin)}` : '—'}</dd></div>
          <div><dt>Brokerage ({pct}%)</dt><dd className="mono">{valid ? `₹${price.format(charges)}` : '—'}</dd></div>
          <div><dt>Available</dt><dd className={`mono ${short ? 'neg' : ''}`}>{available != null ? `₹${price.format(available)}` : '…'}</dd></div>
        </dl>
        {held !== 0 && (
          <p className="om-note">You hold {held > 0 ? `+${held}` : held} @ ₹{price.format(info.position.avg)}{closing ? ` — this ${side === 'BUY' ? 'buy' : 'sell'} closes ${closing === Math.abs(held) ? 'it' : `${closing} of it`}.` : '.'}</p>
        )}
        <p className="om-note">
          Fills at the live price when the trigger is reached, as a paper Equity Intraday trade. Valid until {info ? whenText(info.validUntil) : '3:30 pm'}
          {info && !info.market.open && !info.ignoreHours && ' (watching starts when the market opens)'}. Funds are checked again when it fills.
          {' '}The stock is added to your Ticker.
        </p>

        {loadErr && <p className="status err">{loadErr}</p>}
        {short && <p className="status err">Not enough paper funds: needs ₹{price.format(need)} at this price.</p>}
        {status && status.kind !== 'busy' && <p className={`status ${status.kind}`}>{status.text}</p>}

        <div className="om-actions">
          <button className={`btn ${side === 'BUY' ? 'buy-btn' : 'sell-btn'}`} type="submit" disabled={!valid || busy || short}>
            {busy ? 'Placing…' : `Place ${side === 'BUY' ? 'Buy' : 'Sell'} order${valid ? ` · ${q.toLocaleString('en-IN')} @ ₹${price.format(t)}` : ''}`}
          </button>
        </div>
      </form>
    </div>
  );
}

// ------------------------------------------------------------------ Market › Orders

const STATUS = {
  PENDING: ['Waiting', 'pending'],
  FILLING: ['Filling…', 'pending'],
  FILLED: ['Filled', 'filled'],
  CANCELLED: ['Cancelled', 'muted'],
  EXPIRED: ['Expired', 'muted'],
  FAILED: ['Not placed', 'failed'],
};

export function OrdersCard({ secret, orders, quotes, market, onChange }) {
  const [show, setShow] = useState('open');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);
  const list = useMemo(
    () => (orders || []).filter((o) => (show === 'open' ? o.status === 'PENDING' || o.status === 'FILLING' : show === 'today' ? istDateOf(o.createdAt) === istDateOf(Date.now()) : true)),
    [orders, show]
  );
  const pending = (orders || []).filter((o) => o.status === 'PENDING').length;

  const cancel = async (o) => {
    setBusy(o.id);
    setMsg(null);
    try {
      const j = await api(secret, 'cancel-order', { method: 'POST', body: { id: o.id } });
      onChange(j.orders);
      emitOrders({ orders: j.orders });
      setMsg({ kind: 'ok', text: `Cancelled: ${orderLabel(o)}.` });
    } catch (e) {
      setMsg({ kind: 'err', text: e.message });
    } finally {
      setBusy('');
    }
  };

  return (
    <section className="card">
      <div className="card-head">
        <h2>Trigger orders</h2>
        <div className="seg" role="group" aria-label="Show">
          {[['open', `Waiting ${pending}`], ['today', 'Today'], ['all', 'All']].map(([v, l]) => (
            <button key={v} className={show === v ? 'on' : ''} onClick={() => setShow(v)}>{l}</button>
          ))}
        </div>
      </div>
      {msg && <p className={`status ${msg.kind} tk-pos-msg`}>{msg.text}</p>}
      {market && !market.open && pending > 0 && <p className="tk-note om-closed">Market is closed — waiting orders are checked again from 9:15 AM.</p>}
      <div className="table-wrap">
        <table className="ticker orders">
          <thead>
            <tr>
              <th>Placed</th>
              <th>Stock</th>
              <th>Side</th>
              <th className="num">Qty</th>
              <th className="num">Trigger</th>
              <th className="num">Now</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.map((o) => {
              const ltp = quotes?.[o.key]?.ltp ?? null;
              const away = ltp != null ? ((o.triggerPrice - ltp) / ltp) * 100 : null;
              const [label, tone] = STATUS[o.status] || [o.status, 'muted'];
              return (
                <tr key={o.id}>
                  <td className="mono" title={o.createdAt}>{whenText(o.createdAt).replace(' today', '')}</td>
                  <td>
                    <span className="sym">{o.symbol}</span>
                    {o.refPrice != null && <div className="tk-sub"><span>First hit ₹{price.format(o.refPrice)}</span></div>}
                  </td>
                  <td><span className={`side-pill ${o.side === 'BUY' ? 'buy' : 'sell'}`}>{o.side}</span></td>
                  <td className="num mono">{o.qty.toLocaleString('en-IN')}</td>
                  <td className="num mono" title={o.direction === 'up' ? 'Fills when the price rises to this' : 'Fills when the price falls to this'}>
                    <span className="om-arrow">{o.direction === 'up' ? '↑' : '↓'}</span> {price.format(o.triggerPrice)}
                  </td>
                  <td className="num mono">
                    {o.status === 'PENDING' ? (
                      ltp != null ? <>{price.format(ltp)} <small className="muted-cell">{away > 0 ? '+' : ''}{away.toFixed(2)}%</small></> : '…'
                    ) : <span className="muted-dash">—</span>}
                  </td>
                  <td className="om-status-cell">
                    <span className={`om-status ${tone}`}>{label}</span>
                    <small className="muted-cell">
                      {o.status === 'PENDING' && <> until {whenText(o.validUntil)}</>}
                      {o.status === 'FILLED' && <> @ ₹{price.format(o.fillPrice)} · {whenText(o.filledAt)}</>}
                      {o.status === 'FAILED' && <> {o.error}</>}
                      {(o.status === 'EXPIRED' || o.status === 'CANCELLED') && o.closedAt && <> {whenText(o.closedAt)}</>}
                    </small>
                  </td>
                  <td className="tk-x">
                    {o.status === 'PENDING' && (
                      <button className="btn btn-close" onClick={() => cancel(o)} disabled={busy === o.id}>
                        {busy === o.id ? 'Cancelling…' : 'Cancel'}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {list.length === 0 && (
          <div className="empty">
            {show === 'open' ? 'No orders waiting. Use Buy or Sell on Signals › First Hit to take a trade at your price.' : 'No orders here yet.'}
          </div>
        )}
      </div>
      <div className="foot">
        Equity Intraday paper orders. ↑ fills when the price rises to the trigger, ↓ when it falls to it; the fill is at the live price at that moment.
        Checked while this app is open (and by a scheduler, if you set one up). Unfilled orders expire at 3:30 PM.
      </div>
    </section>
  );
}
