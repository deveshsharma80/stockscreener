import { SECRET_KEY, store } from './Ticker.jsx';
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
  );
}
