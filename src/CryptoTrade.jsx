import { useEffect, useRef, useState } from 'react';
import { fmtPrice, lastPrices } from './binance.js';

// Floating crypto trade box (like the NSE Market one): Buy / Sell switch,
// leverage 1–10×, how much of your money to use (slider or ₹), market order.
// Drag it by its title bar; its position is remembered on this device.

const POS_KEY = 'stockhits.cryptoTradePos';
const LEV_KEY = 'stockhits.cpLev';
const W = 380;
const coin = (s) => s.replace(/USDT$/, '');
const qtyFmt = (q) => (q == null ? '—' : Math.abs(q).toLocaleString('en-US', { maximumSignificantDigits: 8 }));
const readPos = () => {
  try {
    const p = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return p;
  } catch {}
  return { x: Math.max(12, window.innerWidth - W - 40), y: 140 };
};
const clamp = (p, el) => {
  const w = el?.offsetWidth || W;
  const h = el?.offsetHeight || 300;
  return { x: Math.min(Math.max(8, p.x), window.innerWidth - w - 8), y: Math.min(Math.max(8, p.y), window.innerHeight - Math.min(h, 120)) };
};
const readLev = () => {
  try {
    const v = Number(localStorage.getItem(LEV_KEY));
    return v >= 1 && v <= 10 ? v : 3;
  } catch {
    return 3;
  }
};

export default function CryptoTrade({ symbol, book, post, onClose }) {
  const box = useRef(null);
  const drag = useRef(null);
  const [pos, setPos] = useState(readPos);
  const [side, setSide] = useState('BUY');
  const [lev, setLevState] = useState(readLev);
  const [amount, setAmount] = useState(''); // ₹ margin
  const [deploy, setDeploy] = useState(null); // % chosen with the slider
  const [closeAll, setCloseAll] = useState(false);
  const [price, setPrice] = useState(null);
  const [status, setStatus] = useState(null); // { kind, text }
  const busy = status?.kind === 'busy';

  const fx = book?.fx || 85;
  const feeRate = book?.feeRate ?? 0.0005;
  const maxLev = book?.maxLeverage || 10;
  const inr = (usdt, signed = false) => {
    if (usdt == null || !Number.isFinite(usdt)) return '—';
    const v = usdt * fx;
    const a = Math.abs(v);
    return `${v < 0 ? '−' : signed && v > 0 ? '+' : ''}₹${a.toLocaleString('en-IN', { maximumFractionDigits: a < 100 ? 2 : 0 })}`;
  };

  // Live price (same source the server fills at: perpetual, else spot)
  useEffect(() => {
    let alive = true;
    let t;
    const tick = async () => {
      const p = await lastPrices([symbol]).catch(() => ({}));
      if (alive && p[symbol] > 0) setPrice(p[symbol]);
      if (alive) t = setTimeout(tick, 3000);
    };
    setPrice(null);
    tick();
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [symbol]);

  useEffect(() => {
    setAmount('');
    setDeploy(null);
    setCloseAll(false);
    setStatus(null);
  }, [symbol]);

  const held = book?.positions?.find((p) => p.symbol === symbol) || null;
  const adding = held && (side === 'BUY') === held.qty > 0;
  const reducing = held && !adding;
  const useLev = adding ? held.leverage : lev; // a position keeps the leverage it opened with
  const sizeLev = held ? held.leverage : lev;

  // Money: available now (live P&L of other positions is checked by the server again)
  const avail = book ? Math.max(0, book.totals.available) + (reducing ? held.margin : 0) : null;
  const margin = Number(amount) / fx; // USDT
  const qty = closeAll && reducing ? Math.abs(held.qty) : price > 0 && margin > 0 ? (margin * sizeLev) / price : 0;
  const notional = price > 0 ? qty * price : 0;
  const fee = notional * feeRate;
  const liq = price > 0 && !reducing ? (side === 'BUY' ? price * (1 - 1 / useLev) : price * (1 + 1 / useLev)) : null;
  const opening = reducing ? Math.max(0, qty - Math.abs(held.qty)) : qty;
  const need = price > 0 ? (opening * price) / useLev + fee : 0;
  const short = avail != null && opening > 0 && need > avail + 1e-9;

  const usedPct = avail > 0 && margin > 0 ? Math.min(100, Math.round((margin / avail) * 100)) : 0;
  const sliderPct = deploy ?? usedPct;
  const pickPct = (p) => {
    setDeploy(p);
    setCloseAll(false);
    setStatus(null);
    const m = avail > 0 ? (avail * p) / 100 / (1 + sizeLev * feeRate) : 0; // leave room for the fee
    setAmount(m > 0 ? String(Math.floor(m * fx)) : '');
  };
  const setLev = (v) => {
    setLevState(v);
    try {
      localStorage.setItem(LEV_KEY, String(v));
    } catch {}
  };

  useEffect(() => {
    const on = () => setPos((p) => clamp(p, box.current));
    window.addEventListener('resize', on);
    on();
    return () => window.removeEventListener('resize', on);
  }, []);
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const startDrag = (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    if (e.target.closest('button')) return;
    drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const moveDrag = (e) => {
    if (!drag.current) return;
    setPos(clamp({ x: e.clientX - drag.current.dx, y: e.clientY - drag.current.dy }, box.current));
  };
  const endDrag = () => {
    if (!drag.current) return;
    drag.current = null;
    setPos((p) => {
      try {
        localStorage.setItem(POS_KEY, JSON.stringify(p));
      } catch {}
      return p;
    });
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!(qty > 0) || busy || short || !book) return;
    setStatus({ kind: 'busy', text: 'Placing…' });
    try {
      const j = await post('cp-trade', { symbol, side, qty: Number(qty.toPrecision(8)), leverage: useLev, price });
      const f = j.fill;
      setStatus({
        kind: 'ok',
        text: `${f.side === 'BUY' ? 'Bought' : 'Sold'} ${qtyFmt(f.qty)} ${coin(symbol)} @ ${fmtPrice(f.price)} · ${inr(f.notional)} at ${f.leverage}× · fee ${inr(f.fee)}${f.realized ? ` · booked ${inr(f.realized - f.fee, true)}` : ''}`,
      });
      setAmount('');
      setDeploy(null);
      setCloseAll(false);
    } catch (err) {
      setStatus({ kind: 'err', text: err.message });
    }
  };

  const action = closeAll && reducing
    ? `Close ${held.side.toLowerCase()}`
    : !held
      ? side === 'BUY' ? 'Buy / Long' : 'Sell / Short'
      : adding
        ? `Add to ${held.side.toLowerCase()}`
        : qty > Math.abs(held.qty) + 1e-12
          ? `Close & flip to ${side === 'BUY' ? 'long' : 'short'}`
          : `Reduce ${held.side.toLowerCase()}`;

  return (
    <form ref={box} className={`qt ct ${side === 'BUY' ? 'is-buy' : 'is-sell'}`} style={{ left: pos.x, top: pos.y }} onSubmit={submit} noValidate role="dialog" aria-label={`Paper trade ${coin(symbol)}`}>
      <div className="qt-head" onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} title="Drag to move">
        <span className="qt-grip" aria-hidden="true">⋮⋮</span>
        <b className="mono">{coin(symbol)}/USDT</b>
        <span className="mono qt-ltp">{price != null ? fmtPrice(price) : '…'}</span>
        <button type="button" className="qt-x" onClick={onClose} aria-label="Close trade box">×</button>
      </div>

      <div className="qt-body">
        <div className="qt-row">
          <button
            type="button"
            className={`qt-switch ${side === 'BUY' ? 'buy' : 'sell'}`}
            role="switch"
            aria-checked={side === 'SELL'}
            aria-label={`Side: ${side === 'BUY' ? 'Buy / Long' : 'Sell / Short'} (click to switch)`}
            onClick={() => (setSide((s) => (s === 'BUY' ? 'SELL' : 'BUY')), setStatus(null), setCloseAll(false))}
          >
            <span className={side === 'BUY' ? 'on' : ''}>Buy</span>
            <span className={side === 'SELL' ? 'on' : ''}>Sell</span>
            <i aria-hidden="true" />
          </button>
          <label className="qt-qty ct-amt">
            ₹
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              value={closeAll && reducing ? String(Math.round(held.margin * fx)) : amount}
              onChange={(e) => (setAmount(e.target.value), setDeploy(null), setCloseAll(false), setStatus(null))}
              placeholder="margin"
              aria-label="Margin in rupees (your money)"
            />
          </label>
        </div>

        <div className="ct-lev">
          <div className="qt-deploy-top">
            <span>Leverage <b>{useLev}×</b></span>
            {adding && <span className="muted-cell">fixed while the {held.side.toLowerCase()} is open</span>}
          </div>
          <div className="ct-levs" role="radiogroup" aria-label="Leverage">
            {Array.from({ length: maxLev }, (_, i) => i + 1).map((v) => (
              <button type="button" key={v} role="radio" aria-checked={useLev === v} className={useLev === v ? 'on' : ''} disabled={adding} onClick={() => setLev(v)}>
                {v}×
              </button>
            ))}
          </div>
        </div>

        <div className="qt-deploy">
          <div className="qt-deploy-top">
            <span>Use <b>{sliderPct}%</b> of your money</span>
            <span className="mono muted-cell">{avail != null ? `${inr((avail * sliderPct) / 100)} of ${inr(avail)}` : '…'}</span>
          </div>
          <input
            type="range"
            min="0"
            max="100"
            step="1"
            value={sliderPct}
            onChange={(e) => pickPct(Number(e.target.value))}
            disabled={!(avail > 0)}
            style={{ '--fill': `${sliderPct}%` }}
            aria-label="Percentage of available money to use"
          />
          <div className="qt-marks">
            {[10, 25, 50, 75, 100].map((p) => (
              <button type="button" key={p} className={deploy === p ? 'on' : ''} onClick={() => pickPct(p)} disabled={!(avail > 0)}>{p}%</button>
            ))}
            {held && (
              <button
                type="button"
                className="qt-exitall"
                onClick={() => (setSide(held.qty > 0 ? 'SELL' : 'BUY'), setCloseAll(true), setDeploy(null), setStatus(null))}
                title="Close your whole position"
              >
                Close all
              </button>
            )}
          </div>
        </div>

        {held && (
          <div className="qt-info">
            <span className={`cp-side ${held.side.toLowerCase()}`}>{held.side === 'LONG' ? 'Long' : 'Short'} {held.leverage}×</span>
            <span>{qtyFmt(held.qty)} {coin(symbol)} @ {fmtPrice(held.avg)}</span>
            {price != null && <span className={(price - held.avg) * held.qty >= 0 ? 'pos' : 'neg'}>{inr((price - held.avg) * held.qty, true)}</span>}
          </div>
        )}

        <dl className="qt-facts">
          <div><dt>Size</dt><dd className="mono">{qty > 0 ? inr(notional) : '—'}</dd></div>
          <div><dt>Qty</dt><dd className="mono">{qty > 0 ? qtyFmt(qty) : '—'}</dd></div>
          <div><dt>Fee</dt><dd className="mono">{qty > 0 ? inr(fee) : '—'}</dd></div>
          <div><dt>Liq. at</dt><dd className="mono">{qty > 0 && liq ? fmtPrice(liq) : '—'}</dd></div>
          <div><dt>Available</dt><dd className={`mono ${short ? 'neg' : ''}`}>{avail != null ? inr(avail) : '…'}</dd></div>
          <div><dt>Margin</dt><dd className="mono">{qty > 0 ? inr(opening > 0 ? (opening * price) / useLev : 0) : '—'}</dd></div>
        </dl>

        {short && <p className="status err">Not enough money: needs {inr(need)} (margin + fee).</p>}
        {status && status.kind !== 'busy' && <p className={`status ${status.kind}`}>{status.text}</p>}

        <button className={`btn qt-go ${side === 'BUY' ? 'buy-btn' : 'sell-btn'}`} type="submit" disabled={!(qty > 0) || busy || short || !(price > 0) || !book}>
          {busy ? 'Placing…' : `${action} at market`}
        </button>
      </div>
    </form>
  );
}
