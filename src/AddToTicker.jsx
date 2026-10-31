import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { SECRET_KEY, api, price, store } from './Ticker.jsx';
import { ORDERS_EVENT, OrderModal, eventText, orderLabel } from './Orders.jsx';

// "Add to Ticker" for the Signals pages: adds a Chartink stock (NSE symbol)
// to the Market watchlist. Needs the webhook secret (asked once, then kept on
// this device like the Ticker page does).
//
// Also the Buy / Sell trigger-order buttons (First Hit): a popup to pick the
// price; the order is watched by the server and filled when the price gets there.

const Ctx = createContext(null);

export function TickerLinkProvider({ children }) {
  const [secret, setSecret] = useState(() => store.get(SECRET_KEY));
  const [inTicker, setInTicker] = useState(() => new Set()); // symbols already in the watchlist
  const [busy, setBusy] = useState(() => new Set());
  const [pending, setPending] = useState(null); // { symbol, verb, run(secret) } waiting for the secret
  const [msg, setMsg] = useState(null); // { kind, text, link? }
  const [orders, setOrders] = useState([]);
  const [modal, setModal] = useState(null); // { symbol, side, refPrice }

  const remember = (rows) =>
    setInTicker(new Set(rows.filter((r) => r.segment === 'NSE_EQ' || r.segment === 'BSE_EQ').map((r) => String(r.symbol).toUpperCase())));

  // Which stocks are already in the Ticker, and the trigger orders (only if the secret is known)
  useEffect(() => {
    if (!secret) return;
    api(secret, 'watchlist')
      .then((j) => remember(j.rows))
      .catch(() => {});
    api(secret, 'orders')
      .then((j) => setOrders(j.orders))
      .catch(() => {});
  }, [secret]);

  // Orders filled / expired by the background watcher
  useEffect(() => {
    const on = (e) => {
      const d = e.detail || {};
      if (d.orders) setOrders(d.orders);
      else if (d.events?.length) {
        const byId = new Map(d.events.map((o) => [o.id, o]));
        setOrders((list) => list.map((o) => byId.get(o.id) || o));
      }
    };
    window.addEventListener(ORDERS_EVENT, on);
    return () => window.removeEventListener(ORDERS_EVENT, on);
  }, []);

  const add = useCallback(
    async (symbol, withSecret = secret) => {
      const sym = String(symbol).toUpperCase();
      if (!withSecret) {
        setPending({ symbol: sym, verb: 'add', run: (s) => add(sym, s) });
        return;
      }
      setBusy((b) => new Set(b).add(sym));
      setMsg(null);
      try {
        const j = await api(withSecret, 'add-symbol', { method: 'POST', body: { symbol: sym } });
        remember(j.rows);
        setMsg({ kind: 'ok', text: `${sym} added to the Ticker.` });
      } catch (e) {
        if (e.kind === 'secret' || e.status === 401 || e.status === 403) {
          store.set(SECRET_KEY, '');
          setSecret('');
          setPending({ symbol: sym, verb: 'add', run: (s) => add(sym, s) });
          setMsg({ kind: 'err', text: 'That secret didn’t work. Enter the current webhook secret.' });
        } else {
          setMsg({ kind: 'err', text: e.message });
        }
      } finally {
        setBusy((b) => {
          const n = new Set(b);
          n.delete(sym);
          return n;
        });
      }
    },
    [secret]
  );

  const unlock = async (s, keep) => {
    const job = pending;
    setPending(null);
    setSecret(s);
    if (keep) store.set(SECRET_KEY, s);
    if (job) await job.run(s);
  };

  // Buy / Sell at a price: opens the order popup (asks for the secret first if needed)
  const openOrder = useCallback(
    (symbol, side, refPrice) => {
      const sym = String(symbol).toUpperCase();
      const job = { symbol: sym, side, refPrice: typeof refPrice === 'number' ? refPrice : null };
      if (!secret) return setPending({ symbol: sym, verb: side === 'BUY' ? 'buy' : 'sell', run: () => setModal(job) });
      setMsg(null);
      setModal(job);
    },
    [secret]
  );

  const placed = (j) => {
    setModal(null);
    setOrders(j.orders);
    if (j.rows) remember(j.rows);
    setMsg({
      kind: 'ok',
      text: `Order placed: ${orderLabel(j.order)}.${j.rows ? ` ${j.order.symbol} is in your Ticker.` : ''}${j.watchNote ? ` ${j.watchNote}` : ''}`,
      link: ['#/market/orders', 'View orders'],
    });
  };

  // Waiting + today's finished orders, per symbol
  const ordersBySymbol = useMemo(() => {
    const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
    const m = new Map();
    for (const o of orders) {
      const recent = new Date(new Date(o.createdAt).getTime() + 330 * 60_000).toISOString().slice(0, 10) === today;
      if (!(o.status === 'PENDING' || o.status === 'FILLING' || recent)) continue;
      if (o.status === 'CANCELLED') continue;
      const k = String(o.symbol).toUpperCase();
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(o);
    }
    return m;
  }, [orders]);

  const value = useMemo(
    () => ({
      has: (s) => inTicker.has(String(s).toUpperCase()),
      isBusy: (s) => busy.has(String(s).toUpperCase()),
      add,
      openOrder,
      ordersFor: (s) => ordersBySymbol.get(String(s).toUpperCase()) || [],
    }),
    [inTicker, busy, add, openOrder, ordersBySymbol]
  );

  return (
    <Ctx.Provider value={value}>
      {pending && <SecretBar symbol={pending.symbol} verb={pending.verb} onSubmit={unlock} onCancel={() => setPending(null)} />}
      {msg && (
        <div className={`alert ${msg.kind === 'ok' ? 'soft ok-msg' : ''}`} role="status">
          {msg.kind === 'ok' ? '✓' : '⚠'} {msg.text}{' '}
          {msg.kind === 'ok' && (msg.link ? <a className="link" href={msg.link[0]}>{msg.link[1]}</a> : <a className="link" href="#/market/watchlist">Open Ticker</a>)}{' '}
          <button className="link" onClick={() => setMsg(null)}>Dismiss</button>
        </div>
      )}
      {modal && secret && (
        <OrderModal
          secret={secret}
          symbol={modal.symbol}
          initialSide={modal.side}
          refPrice={modal.refPrice}
          onClose={() => setModal(null)}
          onPlaced={placed}
        />
      )}
      {children}
    </Ctx.Provider>
  );
}

const VERBS = { add: 'add', buy: 'place a Buy order for', sell: 'place a Sell order for' };

function SecretBar({ symbol, verb = 'add', onSubmit, onCancel }) {
  const [value, setValue] = useState('');
  const [keep, setKeep] = useState(true);
  return (
    <form
      className="card pad secret-bar"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) onSubmit(value.trim(), keep);
      }}
    >
      <span>
        To {VERBS[verb] || 'add'} <b className="mono">{symbol}</b>{verb === 'add' ? ' to the Ticker' : ''}, enter your webhook secret (the one set in Vercel).
      </span>
      <input type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder="Webhook secret" autoFocus aria-label="Webhook secret" />
      <label className="switch small">
        <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
        <span>Remember on this device</span>
      </label>
      <button className="btn primary" type="submit" disabled={!value.trim()}>{verb === 'add' ? 'Add' : 'Continue'}</button>
      <button className="btn btn-close" type="button" onClick={onCancel}>Close</button>
    </form>
  );
}

/** Small button for a table row: "+ Ticker", or a check when already added. */
export function AddToTicker({ symbol }) {
  const ctx = useContext(Ctx);
  if (!ctx || !symbol) return null;
  if (ctx.has(symbol)) {
    return (
      <a className="ticker-added" href="#/market/watchlist" title="Already in your Ticker — open it">
        ✓ In Ticker
      </a>
    );
  }
  const busy = ctx.isBusy(symbol);
  return (
    <button
      className="btn add-ticker"
      onClick={(e) => {
        e.stopPropagation();
        ctx.add(symbol);
      }}
      disabled={busy}
      title={`Add ${symbol} to the Ticker`}
    >
      {busy ? 'Adding…' : '+ Ticker'}
    </button>
  );
}

/** Buy / Sell icons for a row: open the "take the trade at my price" popup. */
export function OrderButtons({ symbol, refPrice }) {
  const ctx = useContext(Ctx);
  if (!ctx || !symbol) return null;
  const list = ctx.ordersFor(symbol);
  const open = (side) => (e) => {
    e.stopPropagation();
    ctx.openOrder(symbol, side, refPrice);
  };
  return (
    <span className="ob">
      <span className="tk-bs">
        <button className="bs buy ob-btn" onClick={open('BUY')} title={`Buy ${symbol} when it reaches your price (Equity Intraday)`} aria-label={`Buy ${symbol} at a price`}>B</button>
        <button className="bs sell ob-btn" onClick={open('SELL')} title={`Sell ${symbol} when it reaches your price (Equity Intraday)`} aria-label={`Sell ${symbol} at a price`}>S</button>
      </span>
      {list.map((o) => <OrderChip key={o.id} o={o} />)}
    </span>
  );
}

function OrderChip({ o }) {
  const tone = o.status === 'FILLED' ? 'filled' : o.status === 'FAILED' ? 'failed' : o.status === 'EXPIRED' ? 'muted' : 'pending';
  const text =
    o.status === 'FILLED'
      ? `${o.side === 'BUY' ? 'Bought' : 'Sold'} @ ${price.format(o.fillPrice)}`
      : o.status === 'FAILED'
        ? 'Not placed'
        : o.status === 'EXPIRED'
          ? 'Expired'
          : `${o.side === 'BUY' ? 'Buy' : 'Sell'} ${o.direction === 'up' ? '↑' : '↓'}${price.format(o.triggerPrice)}`;
  return (
    <a className={`om-status ${tone} ob-chip`} href="#/market/orders" title={eventText(o)} onClick={(e) => e.stopPropagation()}>
      {text}
    </a>
  );
}
