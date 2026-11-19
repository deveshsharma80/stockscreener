// Talks to the scan service on the Vultr server (server/history/history.mjs serve) through
// https://feed.<domain>/history/…, with the same 12-hour token as the live price stream.
import { api } from './Ticker.jsx';

let cached = null;
async function token(secret) {
  if (cached && cached.exp - Date.now() > 10 * 60_000) return cached;
  const j = await api(secret, 'feed-token');
  if (!j.stream?.base) throw new Error('The Vultr server is not set up for the app (FEED_URL / FEED_SECRET in Vercel).');
  cached = j.stream;
  return cached;
}

export async function historyCall(secret, path, body) {
  const t = await token(secret);
  let res;
  try {
    res = await fetch(`${t.base}/history/${path}?token=${encodeURIComponent(t.token)}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  } catch {
    throw new Error('Could not reach the Vultr server — is the scan service installed (setup-history.sh) and running?');
  }
  const j = await res.json().catch(() => ({}));
  if (res.status === 401) cached = null;
  if (!res.ok || j.ok === false) throw new Error(j.error || `Server error ${res.status}${res.status === 404 || res.status === 502 ? ' — re-run setup-history.sh on the server' : ''}`);
  return j;
}
