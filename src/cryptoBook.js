// Shared crypto paper-trading book: one copy for every page and popup.
// Any component that loads or changes the book publishes it, and all others
// that use the hook update at once (Coins popup, Positions, Paper Trading).
import { useCallback, useEffect, useState } from 'react';

const EVT = 'stockhits:cbook';
let shared = null;

async function call(secret, action, { method = 'GET', body } = {}) {
  const r = await fetch(`/api/crypto${method === 'GET' ? `?action=${action}` : ''}`, {
    method,
    cache: 'no-store',
    headers: { 'X-Webhook-Secret': secret, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify({ action, ...body }) : undefined,
  });
  const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
  if (!j.ok) throw Object.assign(new Error(j.error || `HTTP ${r.status}`), { status: r.status });
  return j;
}

const publish = (b) => {
  shared = b;
  window.dispatchEvent(new CustomEvent(EVT, { detail: b }));
};

/**
 * { book, error, liquidated, clearLiquidated, load, post }.
 * With autoload, loads now and every 30 s (the server also checks liquidations then).
 */
export function useCryptoBook(secret, { autoload = true } = {}) {
  const [book, setBook] = useState(shared);
  const [error, setError] = useState('');
  const [liquidated, setLiquidated] = useState([]);

  useEffect(() => {
    const on = (e) => setBook(e.detail);
    window.addEventListener(EVT, on);
    return () => window.removeEventListener(EVT, on);
  }, []);

  const load = useCallback(async () => {
    if (!secret) return null;
    try {
      const j = await call(secret, 'cp-book');
      if (j.liquidated?.length) setLiquidated(j.liquidated);
      publish(j);
      setError('');
      return j;
    } catch (e) {
      setError(e.message);
      throw e;
    }
  }, [secret]);

  useEffect(() => {
    if (!autoload || !secret) return;
    load().catch(() => {});
    const t = setInterval(() => !document.hidden && load().catch(() => {}), 30_000);
    return () => clearInterval(t);
  }, [autoload, secret, load]);

  /** Every cp-* POST answers with the whole book. */
  const post = useCallback(
    async (action, body) => {
      const j = await call(secret, action, { method: 'POST', body });
      publish(j);
      return j;
    },
    [secret]
  );

  return { book, error, liquidated, clearLiquidated: () => setLiquidated([]), load, post };
}
