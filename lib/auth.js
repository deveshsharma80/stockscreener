// Sign-in for the dashboard: one password (APP_PASSWORD in Vercel), a signed
// session cookie, and a per-IP limit on wrong passwords.
//
// The cookie is HttpOnly (page scripts can't read it), SameSite=Lax (other
// sites can't use it to call the API) and Secure on HTTPS. It is signed with
// a key derived from APP_PASSWORD + WEBHOOK_SECRET, so changing either one in
// Vercel signs everyone out.
//
// Automatic callers (Chartink, cron-job.org) keep using WEBHOOK_SECRET.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const COOKIE = 'sh_session';
const SHORT_HOURS = 12; // without "keep me signed in"
const LONG_DAYS = 30;
const MAX_FAILS = 8; // wrong passwords per IP …
const FAIL_WINDOW_MS = 15 * 60_000; // … per 15 minutes

const password = () => String(process.env.APP_PASSWORD ?? '').trim();
export const authEnabled = () => Boolean(password());

const key = () => createHash('sha256').update(`stockhits-session|${password()}|${String(process.env.WEBHOOK_SECRET ?? '').trim()}`).digest();
const sign = (payload) => createHmac('sha256', key()).update(payload).digest('base64url');
const same = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

/** True if the password matches APP_PASSWORD (compared in constant time). */
export function passwordOk(input) {
  if (!authEnabled()) return false;
  const h = (s) => createHash('sha256').update(String(s ?? '')).digest();
  return timingSafeEqual(h(input), h(password()));
}

function cookies(req) {
  const out = {};
  for (const part of String(req.headers?.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** The signed-in session from the request's cookie, or null. */
export function readSession(req) {
  if (!authEnabled()) return null;
  const raw = cookies(req)[COOKIE];
  if (!raw || !raw.includes('.')) return null;
  const [payload, sig] = raw.split('.');
  if (!same(sig, sign(payload))) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return s.exp > Date.now() ? s : null;
  } catch {
    return null;
  }
}

const secureFlag = (req) => (process.env.VERCEL || String(req.headers?.['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '');

/** Set-Cookie value for a new session. */
export function sessionCookie(req, remember) {
  const exp = Date.now() + (remember ? LONG_DAYS * 86_400_000 : SHORT_HOURS * 3_600_000);
  const payload = Buffer.from(JSON.stringify({ exp, iat: Date.now() })).toString('base64url');
  const maxAge = remember ? `; Max-Age=${LONG_DAYS * 86_400}` : ''; // otherwise ends when the browser closes
  return { exp, header: `${COOKIE}=${payload}.${sign(payload)}; Path=/; HttpOnly; SameSite=Lax${maxAge}${secureFlag(req)}` };
}

export const clearCookie = (req) => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureFlag(req)}`;

// ---- wrong-password limit (per server instance; Vercel's Firewall can add more)
const fails = new Map(); // ip -> { count, first }
export const clientIp = (req) => String(req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress || '?').split(',')[0].trim();

export function tooManyFails(ip) {
  const f = fails.get(ip);
  if (!f) return 0;
  if (Date.now() - f.first > FAIL_WINDOW_MS) {
    fails.delete(ip);
    return 0;
  }
  return f.count >= MAX_FAILS ? Math.ceil((f.first + FAIL_WINDOW_MS - Date.now()) / 60_000) : 0;
}
export function noteFail(ip) {
  const f = fails.get(ip);
  if (!f || Date.now() - f.first > FAIL_WINDOW_MS) fails.set(ip, { count: 1, first: Date.now() });
  else f.count++;
  if (fails.size > 5000) fails.clear();
}
export const clearFails = (ip) => fails.delete(ip);
