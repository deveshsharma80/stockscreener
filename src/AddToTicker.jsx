import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { SECRET_KEY, api, store } from './Ticker.jsx';

// "Add to Ticker" for the Signals pages: adds a Chartink stock (NSE symbol)
// to the Market watchlist. Needs the webhook secret (asked once, then kept on
// this device like the Ticker page does).

const Ctx = createContext(null);

export function TickerLinkProvider({ children }) {
  const [secret, setSecret] = useState(() => store.get(SECRET_KEY));
  const [inTicker, setInTicker] = useState(() => new Set()); // symbols already in the watchlist
  const [busy, setBusy] = useState(() => new Set());
  const [pending, setPending] = useState(null); // symbol waiting for the secret
  const [msg, setMsg] = useState(null); // { kind, text }

  const remember = (rows) =>
    setInTicker(new Set(rows.filter((r) => r.segment === 'NSE_EQ' || r.segment === 'BSE_EQ').map((r) => String(r.symbol).toUpperCase())));

  // Which stocks are already in the Ticker (only if the secret is known)
  useEffect(() => {
    if (!secret) return;
    api(secret, 'watchlist')
      .then((j) => remember(j.rows))
      .catch(() => {});
  }, [secret]);

  const add = useCallback(
    async (symbol, withSecret = secret) => {
      const sym = String(symbol).toUpperCase();
      if (!withSecret) {
        setPending(sym);
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
          setPending(sym);
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
    const sym = pending;
    setPending(null);
    setSecret(s);
    if (keep) store.set(SECRET_KEY, s);
    if (sym) await add(sym, s);
  };

  const value = useMemo(
    () => ({ has: (s) => inTicker.has(String(s).toUpperCase()), isBusy: (s) => busy.has(String(s).toUpperCase()), add }),
    [inTicker, busy, add]
  );

  return (
    <Ctx.Provider value={value}>
      {pending && <SecretBar symbol={pending} onSubmit={unlock} onCancel={() => setPending(null)} />}
      {msg && (
        <div className={`alert ${msg.kind === 'ok' ? 'soft ok-msg' : ''}`} role="status">
          {msg.kind === 'ok' ? '✓' : '⚠'} {msg.text}{' '}
          {msg.kind === 'ok' && <a className="link" href="#/market/watchlist">Open Ticker</a>}{' '}
          <button className="link" onClick={() => setMsg(null)}>Dismiss</button>
        </div>
      )}
      {children}
    </Ctx.Provider>
  );
}

function SecretBar({ symbol, onSubmit, onCancel }) {
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
        To add <b className="mono">{symbol}</b> to the Ticker, enter your webhook secret (the one set in Vercel).
      </span>
      <input type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder="Webhook secret" autoFocus aria-label="Webhook secret" />
      <label className="switch small">
        <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
        <span>Remember on this device</span>
      </label>
      <button className="btn primary" type="submit" disabled={!value.trim()}>Add</button>
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
