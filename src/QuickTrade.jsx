import { useEffect, useRef, useState } from 'react';
import { PRODUCT_LABEL, describe, kindOf, price, productFor } from './Ticker.jsx';

// Small floating Buy / Sell box for the chart. Drag it by its title bar to
// keep the candles in view; its position is remembered on this device.

const POS_KEY = 'stockhits.quickTradePos';
const W = 290;
const readPos = () => {
  try {
    const p = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return p;
  } catch {}
  return { x: Math.max(12, window.innerWidth - W - 40), y: 150 };
};
const clamp = (p, el) => {
  const w = el?.offsetWidth || W;
  const h = el?.offsetHeight || 260;
  return { x: Math.min(Math.max(8, p.x), window.innerWidth - w - 8), y: Math.min(Math.max(8, p.y), window.innerHeight - Math.min(h, 120)) };
};

export default function QuickTrade({ row, quote, position, account, products, onPlace, onClose }) {
  const box = useRef(null);
  const drag = useRef(null);
  const [pos, setPos] = useState(readPos);
  const [side, setSide] = useState('BUY');
  const [units, setUnits] = useState('1');
  const [status, setStatus] = useState(null); // { kind, text }

  const product = productFor(row);
  const fno = kindOf(row.segment) === 'fno';
  const lot = Number(row.lotSize) || 1;
  const n = Math.max(0, Math.floor(Number(units) || 0));
  const qty = fno ? n * lot : n;
  const ltp = quote?.ltp ?? null;
  const lev = products?.[product]?.leverage ?? (product === 'EQ_INTRADAY' ? 4 : 1);
  const pct = products?.[product]?.brokeragePct ?? (product === 'EQ_INTRADAY' ? 0.025 : 1);
  const optBuy = product === 'IDX_OPT_BUY' || product === 'STK_OPT_BUY';

  // Funds (the server checks again at the fill price)
  const held = position?.qty || 0;
  const signedQty = side === 'BUY' ? qty : -qty;
  const closing = held && Math.sign(held) !== Math.sign(signedQty) ? Math.min(qty, Math.abs(held)) : 0;
  const opening = qty - closing;
  const value = ltp != null ? ltp * qty : null;
  const need = ltp != null ? (opening * ltp) / lev + (qty * ltp * pct) / 100 : null;
  const pot = account?.buckets?.[product];
  const avail = pot ? pot.available : account?.available;
  const released = closing && ltp != null && position ? closing * Math.abs(position.avg) / lev + closing * (ltp - position.avg) * Math.sign(held) : 0;
  const short = account && need != null && opening > 0 && need > (avail ?? 0) + released;
  const rule = !product
    ? 'This instrument can’t be paper traded (only stocks and options).'
    : optBuy && side === 'SELL' && held <= 0
      ? 'Options Buying: you can only sell options you hold.'
      : optBuy && side === 'SELL' && qty > held
        ? `You hold ${held}; sell at most ${held}.`
        : '';
  const busy = status?.kind === 'busy';

  // Keep it on screen when the window is resized
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
    if (!qty || busy || rule || short) return;
    setStatus({ kind: 'busy', text: 'Placing…' });
    try {
      const t = await onPlace(side, qty, product);
      setStatus({ kind: 'ok', text: `${t.side === 'BUY' ? 'Bought' : 'Sold'} ${t.qty.toLocaleString('en-IN')} @ ${price.format(t.price)} · brokerage ₹${price.format(t.charges)}` });
    } catch (err) {
      setStatus({ kind: 'err', text: err.message });
    }
  };

  return (
    <form
      ref={box}
      className={`qt ${side === 'BUY' ? 'is-buy' : 'is-sell'}`}
      style={{ left: pos.x, top: pos.y }}
      onSubmit={submit}
      role="dialog"
      aria-label={`Trade ${describe(row)}`}
    >
      <div className="qt-head" onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} title="Drag to move">
        <span className="qt-grip" aria-hidden="true">⋮⋮</span>
        <b className="mono">{describe(row)}</b>
        <span className="mono qt-ltp">{ltp != null ? price.format(ltp) : '…'}</span>
        <button type="button" className="qt-x" onClick={onClose} aria-label="Close trade box">×</button>
      </div>

      <div className="qt-body">
        <div className="qt-row">
          <button
            type="button"
            className={`qt-switch ${side === 'BUY' ? 'buy' : 'sell'}`}
            role="switch"
            aria-checked={side === 'SELL'}
            aria-label={`Side: ${side === 'BUY' ? 'Buy' : 'Sell'} (click to switch)`}
            onClick={() => (setSide((s) => (s === 'BUY' ? 'SELL' : 'BUY')), setStatus(null))}
          >
            <span className={side === 'BUY' ? 'on' : ''}>Buy</span>
            <span className={side === 'SELL' ? 'on' : ''}>Sell</span>
            <i aria-hidden="true" />
          </button>
          <label className="qt-qty">
            {fno ? 'Lots' : 'Qty'}
            <input type="number" min="1" step="1" value={units} onChange={(e) => (setUnits(e.target.value), setStatus(null))} aria-label={fno ? 'Lots' : 'Quantity'} />
          </label>
        </div>

        <div className="qt-info">
          {product && <span className={`tk-prod ${product}`}>{PRODUCT_LABEL[product]}{lev > 1 ? ` ${lev}×` : ''}</span>}
          {fno && <span>= {qty.toLocaleString('en-IN')} qty</span>}
          {held ? <span>Holding {held > 0 ? `+${held}` : held} @ {price.format(position.avg)}</span> : null}
        </div>
        {value != null && qty > 0 && (
          <dl className="qt-facts">
            <div><dt>Value</dt><dd className="mono">₹{price.format(value)}</dd></div>
            <div><dt>{lev > 1 ? 'Margin' : 'Needs'}</dt><dd className="mono">₹{price.format(opening ? (opening * ltp) / lev : 0)}</dd></div>
            <div><dt>Brokerage</dt><dd className="mono">₹{price.format((value * pct) / 100)}</dd></div>
            <div><dt>Available</dt><dd className={`mono ${short ? 'neg' : ''}`}>{avail != null ? `₹${price.format(avail)}` : '…'}</dd></div>
          </dl>
        )}

        {rule && <p className="status err">{rule}</p>}
        {!rule && short && <p className="status err">Not enough {PRODUCT_LABEL[product]} money: needs ₹{price.format(need)}.</p>}
        {status && status.kind !== 'busy' && <p className={`status ${status.kind}`}>{status.text}</p>}

        <button className={`btn qt-go ${side === 'BUY' ? 'buy-btn' : 'sell-btn'}`} type="submit" disabled={!qty || busy || Boolean(rule) || short}>
          {busy ? 'Placing…' : `${side === 'BUY' ? 'Buy' : 'Sell'} ${qty ? qty.toLocaleString('en-IN') : ''} at market`}
        </button>
      </div>
    </form>
  );
}
