import { useEffect, useState } from 'react';
import { SECRET_KEY, api, store } from './Ticker.jsx';
import { CHARGES_TEXT } from './charges.js';
import { useLiveFeed } from './liveFeed.js';
import { POLL_CHOICES, setPolling, usePolling } from './settings.js';

// Tools → Settings: app-wide settings (saved on this device).
export default function Settings() {
  const polling = usePolling();
  const live = useLiveFeed(store.get(SECRET_KEY) || null);
  const streamText =
    live.live
      ? `Live — ${live.count} watchlist ${live.count === 1 ? 'instrument' : 'instruments'} streaming from the Dhan feed`
      : live.status === 'unavailable'
        ? 'Not set up (FEED_URL / FEED_SECRET missing in Vercel)'
        : live.status === 'open'
          ? 'Connected — not streaming right now (market closed or Dhan feed not live)'
          : live.status === 'connecting'
            ? 'Connecting…'
            : 'Not connected';

  return (
    <>
    <section className="card pad set-card">
      <h2>Price refresh (NSE)</h2>
      <p className="muted set-sub">How Market, the Running P&amp;L pill, Trades and P&amp;L get prices. Saved on this device.</p>

      <div className="set-row">
        <div className="set-label">
          <b>Live stream</b>
          <span className={`set-stream ${live.live ? 'on' : ''}`}>
            <i className={`tk-dot ${live.live ? 'on stream' : ''}`} /> {streamText}
          </span>
        </div>
      </div>

      <div className="set-row">
        <div className="set-label">
          <b>Price polling</b>
          <span className="muted">Also ask Dhan for prices on a timer — for instruments the stream doesn’t cover, and for everything when the stream is down or the market is closed.</span>
        </div>
        <div className="set-ctrl">
          <div className="seg" role="group" aria-label="Price polling">
            <button className={!polling.on ? 'on' : ''} onClick={() => setPolling({ on: false })}>Off</button>
            <button className={polling.on ? 'on' : ''} onClick={() => setPolling({ on: true })}>On</button>
          </div>
          <label className="set-every">
            <span>Every</span>
            <select className="select" value={polling.intervalMs} disabled={!polling.on} onChange={(e) => setPolling({ intervalMs: Number(e.target.value) })}>
              {POLL_CHOICES.map(([ms, label]) => (
                <option key={ms} value={ms}>{label}</option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <ul className="set-notes muted">
        {polling.on ? (
          <>
            <li>Watchlist prices still come from the live stream; polling every {POLL_CHOICES.find(([ms]) => ms === polling.intervalMs)?.[1]} covers the rest (at least every 30 seconds while the market is closed).</li>
            <li>Polling uses Dhan’s quote limit (1 request a second) — faster settings with many pages open can bring back “rate limit” messages.</li>
          </>
        ) : (
          <>
            <li>Watchlist prices update live from the stream. Instruments not in the watchlist get their price once when a page opens — add them to the watchlist to see them live.</li>
            <li>If the stream is down, prices don’t refresh until you reload the page or turn polling on.</li>
            <li>Orders at price, SL and TP are checked by the server either way.</li>
          </>
        )}
      </ul>
    </section>
    <PaperStops />
    </>
  );
}

const STOP_TYPES = [
  ['EQ_INTRADAY', 'Equity Intraday', '% from the entry price (long: below, short: above)'],
  ['IDX_OPT_BUY', 'Index Options Buying', '% of the premium paid'],
  ['STK_OPT_BUY', 'Equity Options Buying', '% of the premium paid'],
];

// Paper trading: a stop loss added automatically to every new position (saved on the server,
// so it applies on every device and to orders the server fills).
function PaperStops() {
  const secret = store.get(SECRET_KEY);
  const [stops, setStops] = useState(null);
  const [draft, setDraft] = useState({});
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!secret) return;
    api(secret, 'paper-stops').then((j) => setStops(j.stops)).catch((e) => setMsg({ ok: false, text: e.message }));
  }, [secret]);
  const save = async (patch) => {
    setBusy(true);
    setMsg(null);
    try {
      const j = await api(secret, 'paper-stops', { method: 'POST', body: patch });
      setStops(j.stops);
      setDraft({});
      setMsg({ ok: true, text: 'Saved — applies to new positions from now on.' });
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy(false);
    }
  };
  const changed = Object.keys(draft).length > 0;
  return (
    <section className="card pad set-card">
      <h2>Paper trading</h2>
      <p className="muted set-sub">Stop loss added automatically to every new paper position, and the charges used for P&amp;L. Saved on the server.</p>
      {!secret ? (
        <p className="muted">Sign in with your secret on the Market page to change these.</p>
      ) : !stops ? (
        <p className="muted">{msg?.text || 'Loading…'}</p>
      ) : (
        <>
          <div className="set-row">
            <div className="set-label">
              <b>Default stop loss</b>
              <span className="muted">When a trade opens a new position, a stop loss is placed for it. You can still move or remove it on the chart or in Positions. Adding to a position keeps its stop where it is.</span>
            </div>
            <div className="set-ctrl">
              <div className="seg" role="group" aria-label="Default stop loss">
                <button className={!stops.enabled ? 'on' : ''} disabled={busy} onClick={() => stops.enabled && save({ enabled: false })}>Off</button>
                <button className={stops.enabled ? 'on' : ''} disabled={busy} onClick={() => !stops.enabled && save({ enabled: true })}>On</button>
              </div>
            </div>
          </div>
          {STOP_TYPES.map(([k, label, hint]) => (
            <div className="set-row" key={k}>
              <div className="set-label">
                <b>{label}</b>
                <span className="muted">{hint}. 0 = no automatic stop.</span>
              </div>
              <div className="set-ctrl">
                <label className="set-every">
                  <input
                    className="select set-pct"
                    type="number"
                    min="0"
                    max="90"
                    step="0.1"
                    disabled={!stops.enabled || busy}
                    value={draft[k] ?? stops[k]}
                    onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
                  />
                  <span>%</span>
                </label>
              </div>
            </div>
          ))}
          <div className="set-row">
            <div className="set-label">
              <b>Charges</b>
              <span className="muted">{CHARGES_TEXT} Applied to all paper trades, past and new.</span>
            </div>
            <div className="set-ctrl">
              {changed && <button className="btn primary" disabled={busy} onClick={() => save(draft)}>Save stops</button>}
            </div>
          </div>
          {msg && <p className={`status ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</p>}
        </>
      )}
    </section>
  );
}
