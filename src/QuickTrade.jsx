import { dhanCharges } from './charges.js';
import { useEffect, useRef, useState } from 'react';
import { PRODUCT_LABEL, describe, kindOf, price, productFor } from './Ticker.jsx';

// Small floating Buy / Sell box for the chart. Drag it by its title bar to
// keep the candles in view; its position is remembered on this device.
// "Market" trades now; "At price" sets an order that the app places by itself
// when the price reaches yours (valid until today's close), with optional SL / TP.

const POS_KEY = 'stockhits.quickTradePos';
const W = 360;
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

export default function QuickTrade({ row, quote, position, account, products, chargeModel = 'dhan', onPlace, onOrder, onClose }) {
  const box = useRef(null);
  const drag = useRef(null);
  const [pos, setPos] = useState(readPos);
  const [side, setSide] = useState('BUY');
  const [units, setUnits] = useState('1');
  const [status, setStatus] = useState(null); // { kind, text }
  const [deploy, setDeploy] = useState(null); // % of available money chosen with the slider (null = typed qty)
  const [mode, setMode] = useState('market'); // 'market' | 'price'
  const [trigger, setTrigger] = useState('');
  const [sl, setSl] = useState('');
  const [tp, setTp] = useState('');

  const product = productFor(row);
  const fno = kindOf(row.segment) === 'fno';
  const lot = Number(row.lotSize) || 1;
  const n = Math.max(0, Math.floor(Number(units) || 0));
  const qty = fno ? n * lot : n;
  const live = quote?.ltp ?? null;
  const atPrice = mode === 'price' && Boolean(onOrder);
  const trig = Number(trigger);
  const trigOk = atPrice && trig > 0;
  // everything below is worked out at your order price, or the live price for a market trade
  const ltp = atPrice ? (trigOk ? trig : null) : live;
  const cond = trigOk && live > 0 ? (trig > live ? 'above' : trig < live ? 'below' : null) : null;
  const lev = products?.[product]?.leverage ?? (product === 'EQ_INTRADAY' ? 4 : 1);
  const pct = products?.[product]?.brokeragePct ?? (product === 'EQ_INTRADAY' ? 0.025 : 1);
  // charges for an order of this value: Dhan's real charges (or the old flat %)
  const fee = (val) => (val == null ? null : chargeModel === 'flat' ? (val * pct) / 100 : dhanCharges({ side, value: val, segment: row.segment, product }));
  const optBuy = product === 'IDX_OPT_BUY' || product === 'STK_OPT_BUY';

  // Funds (the server checks again at the fill price)
  const held = position?.qty || 0;
  const signedQty = side === 'BUY' ? qty : -qty;
  const closing = held && Math.sign(held) !== Math.sign(signedQty) ? Math.min(qty, Math.abs(held)) : 0;
  const opening = qty - closing;
  const value = ltp != null ? ltp * qty : null;
  const need = ltp != null ? (opening * ltp) / lev + fee(qty * ltp) : null;
  const pot = account?.buckets?.[product];
  const avail = pot ? pot.available : account?.available;
  const released = closing && ltp != null && position ? closing * Math.abs(position.avg) / lev + closing * (ltp - position.avg) * Math.sign(held) : 0;
  const short = account && need != null && opening > 0 && need > (avail ?? 0) + released;

  // Money per share / lot when opening: margin (value ÷ leverage) + brokerage
  const mult = fno ? lot : 1;
  // per share / lot: margin + charges at the rate of a ₹1 L order (Dhan's ₹20 is per order, not per unit)
  const unitCost = ltp != null ? (ltp * mult) / lev + (ltp * mult * fee(100000)) / 100000 : null;
  const unitsFor = (p) => (unitCost && avail > 0 ? Math.floor(((avail * p) / 100) / unitCost) : 0);
  const usedPct = need != null && avail > 0 ? Math.min(100, (need / avail) * 100) : 0;
  const sliderPct = deploy ?? Math.round(usedPct);
  const pickPct = (p) => {
    setDeploy(p);
    setUnits(String(unitsFor(p)));
    setStatus(null);
  };
  const exitQty = held && (side === 'BUY' ? held < 0 : held > 0) ? Math.abs(held) : 0;
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
    const ro = typeof ResizeObserver !== 'undefined' && box.current ? new ResizeObserver(on) : null;
    ro?.observe(box.current); // e.g. switching to "At price" makes the box taller
    on();
    return () => {
      window.removeEventListener('resize', on);
      ro?.disconnect();
    };
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
    if (atPrice) {
      if (!qty || busy || rule || short || !cond) return;
      setStatus({ kind: 'busy', text: 'Setting order…' });
      try {
        const o = await onOrder({ side, qty, product, triggerPrice: trig, sl: sl === '' ? null : Number(sl), tp: tp === '' ? null : Number(tp) });
        const until = o.validUntil ? new Date(o.validUntil).toLocaleString('en-IN', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : 'the close';
        setStatus({
          kind: 'ok',
          text: `Order set: ${o.side === 'BUY' ? 'buy' : 'sell'} ${o.qty.toLocaleString('en-IN')} when the price ${o.direction === 'up' ? 'rises to' : 'falls to'} ₹${price.format(o.triggerPrice)}${o.sl != null ? ` · SL ₹${price.format(o.sl)}` : ''}${o.tp != null ? ` · TP ₹${price.format(o.tp)}` : ''}. Valid until ${until}. See Market → Orders.`,
        });
        setSl('');
        setTp('');
      } catch (err) {
        setStatus({ kind: 'err', text: err.message });
      }
      return;
    }
    if (!qty || busy || rule || short) return;
    setStatus({ kind: 'busy', text: 'Placing…' });
    try {
      const t = await onPlace(side, qty, product);
      setStatus({ kind: 'ok', text: `${t.side === 'BUY' ? 'Bought' : 'Sold'} ${t.qty.toLocaleString('en-IN')} @ ${price.format(t.price)} · charges ₹${price.format(t.charges)}${t.defaultStop ? ` · stop loss ₹${price.format(t.defaultStop)} added` : ''}` });
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
        <span className="mono qt-ltp">{live != null ? price.format(live) : '…'}</span>
        <button type="button" className="qt-x" onClick={onClose} aria-label="Close trade box">×</button>
      </div>

      <div className="qt-body">
        {onOrder && (
          <div className="seg ct-mode" role="group" aria-label="Order type">
            <button type="button" className={!atPrice ? 'on' : ''} onClick={() => (setMode('market'), setStatus(null))}>Market</button>
            <button
              type="button"
              className={atPrice ? 'on' : ''}
              onClick={() => {
                setMode('price');
                setStatus(null);
                if (!trigger && live > 0) setTrigger(String(live));
              }}
            >
              At price
            </button>
          </div>
        )}

        {atPrice && (
          <div className="ct-trig">
            <label className="ct-trig-main">
              <span>{side === 'BUY' ? 'Buy' : 'Sell'} when price reaches (₹)</span>
              <input type="number" inputMode="decimal" min="0" step="any" value={trigger} onChange={(e) => (setTrigger(e.target.value), setStatus(null))} placeholder="price" aria-label="Order price" />
            </label>
            <div className="ct-trig-note">
              {!trigOk ? (
                'Enter the price.'
              ) : !cond ? (
                'That is the current price — use Market instead.'
              ) : (
                <>
                  Fires when the price {cond === 'above' ? 'rises to' : 'falls to'} <b className="mono">₹{price.format(trig)}</b>
                  {live > 0 && <> ({((trig / live - 1) * 100).toFixed(2)}% from ₹{price.format(live)})</>} · fills at the market price then · valid until today’s close
                </>
              )}
            </div>
            {!(optBuy && side === 'SELL') && (
              <div className="ct-sltp">
                <label>
                  <span>Stop loss (₹)</span>
                  <input type="number" inputMode="decimal" min="0" step="any" value={sl} onChange={(e) => setSl(e.target.value)} placeholder="optional" aria-label="Stop loss" />
                </label>
                <label>
                  <span>Take profit (₹)</span>
                  <input type="number" inputMode="decimal" min="0" step="any" value={tp} onChange={(e) => setTp(e.target.value)} placeholder="optional" aria-label="Take profit" />
                </label>
              </div>
            )}
          </div>
        )}

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
            <input type="number" min="1" step="1" value={units} onChange={(e) => (setUnits(e.target.value), setDeploy(null), setStatus(null))} aria-label={fno ? 'Lots' : 'Quantity'} />
          </label>
        </div>

        <div className="qt-deploy">
          <div className="qt-deploy-top">
            <span>Use <b>{sliderPct}%</b> of {PRODUCT_LABEL[product] || ''} money</span>
            <span className="mono muted-cell">{avail != null ? `₹${price.format((avail * sliderPct) / 100)} of ₹${price.format(avail)}` : '…'}</span>
          </div>
          <input
            type="range"
            min="0"
            max="100"
            step="1"
            value={sliderPct}
            onChange={(e) => pickPct(Number(e.target.value))}
            disabled={!unitCost || !(avail > 0)}
            style={{ '--fill': `${sliderPct}%` }}
            aria-label="Percentage of available money to use"
          />
          <div className="qt-marks">
            {[10, 25, 50, 75, 100].map((p) => (
              <button type="button" key={p} className={deploy === p ? 'on' : ''} onClick={() => pickPct(p)} disabled={!unitCost || !(avail > 0)}>{p}%</button>
            ))}
            {exitQty > 0 && !atPrice && (
              <button type="button" className="qt-exitall" onClick={() => (setUnits(String(fno ? Math.ceil(exitQty / lot) : exitQty)), setDeploy(null), setStatus(null))} title="Quantity that closes your whole position">
                Close all {exitQty.toLocaleString('en-IN')}
              </button>
            )}
          </div>
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
            <div><dt>Charges</dt><dd className="mono">₹{price.format(fee(value) ?? 0)}</dd></div>
            <div><dt>Available</dt><dd className={`mono ${short ? 'neg' : ''}`}>{avail != null ? `₹${price.format(avail)}` : '…'}</dd></div>
          </dl>
        )}

        {deploy != null && deploy > 0 && n === 0 && unitCost != null && (
          <p className="status err">
            {deploy}% (₹{price.format(((avail || 0) * deploy) / 100)}) isn’t enough for 1 {fno ? 'lot' : 'share'} — that needs ₹{price.format(unitCost)}
            {unitsFor(100) > 0 ? `; try ${Math.ceil(((unitCost / avail) * 100))}% or more.` : '.'}
          </p>
        )}
        {rule && <p className="status err">{rule}</p>}
        {!rule && short && <p className="status err">Not enough {PRODUCT_LABEL[product]} money: needs ₹{price.format(need)}.</p>}
        {status && status.kind !== 'busy' && <p className={`status ${status.kind}`}>{status.text}</p>}

        {atPrice ? (
          <button className={`btn qt-go ${side === 'BUY' ? 'buy-btn' : 'sell-btn'}`} type="submit" disabled={!qty || busy || Boolean(rule) || short || !cond}>
            {busy ? 'Setting…' : trigOk && cond ? `${side === 'BUY' ? 'Buy' : 'Sell'} ${qty ? qty.toLocaleString('en-IN') : ''} when ${cond === 'above' ? '≥' : '≤'} ₹${price.format(trig)}` : 'Set order'}
          </button>
        ) : (
          <button className={`btn qt-go ${side === 'BUY' ? 'buy-btn' : 'sell-btn'}`} type="submit" disabled={!qty || busy || Boolean(rule) || short}>
            {busy ? 'Placing…' : `${side === 'BUY' ? 'Buy' : 'Sell'} ${qty ? qty.toLocaleString('en-IN') : ''} at market`}
          </button>
        )}
      </div>
    </form>
  );
}
