// App-wide settings kept on this device (Tools → Settings).
//
// Price polling: whether NSE pages also ask Dhan for prices on a timer.
//   Off (default) — prices come from the live stream (Market watchlist); anything the
//                   stream doesn't cover gets its price once when a page opens.
//   On            — pages also poll every N seconds for what the stream doesn't cover,
//                   and for everything when the stream is down or the market is closed.
import { useEffect, useState } from 'react';

const KEY = 'stockhits.pricePolling';
export const POLLING_EVENT = 'stockhits:polling';
export const POLL_CHOICES = [
  [2000, '2 seconds'],
  [5000, '5 seconds'],
  [10000, '10 seconds'],
  [30000, '30 seconds'],
  [60000, '1 minute'],
];
export const CLOSED_MIN_MS = 30_000; // outside market hours prices barely move
const DEFAULT = { on: false, intervalMs: 5000 };

export function getPolling() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || 'null');
    const out = { ...DEFAULT, ...(v && typeof v === 'object' ? v : {}) };
    if (!POLL_CHOICES.some(([ms]) => ms === out.intervalMs)) out.intervalMs = DEFAULT.intervalMs;
    out.on = Boolean(out.on);
    return out;
  } catch {
    return { ...DEFAULT };
  }
}

export function setPolling(patch) {
  const v = { ...getPolling(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch {}
  window.dispatchEvent(new CustomEvent(POLLING_EVENT, { detail: v }));
}

/** The polling setting, re-rendering when it changes (also from another tab). */
export function usePolling() {
  const [p, setP] = useState(getPolling);
  useEffect(() => {
    const on = () => setP(getPolling());
    const onStorage = (e) => e.key === KEY && on();
    window.addEventListener(POLLING_EVENT, on);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(POLLING_EVENT, on);
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  return p;
}
