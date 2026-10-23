import { timingSafeEqual } from 'node:crypto';
import { DbConfigError } from './db.js';

export function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Webhook-Secret');
}

/** Vercel parses JSON bodies for us; plain-text bodies arrive as strings. */
export function parseBody(req) {
  let body = req.body;
  if (Buffer.isBuffer(body)) body = body.toString('utf8');
  if (typeof body === 'string') {
    if (!body.trim()) return undefined;
    try {
      return JSON.parse(body);
    } catch {
      throw new HttpError(400, 'Body is not valid JSON');
    }
  }
  return body;
}

/**
 * If WEBHOOK_SECRET is set, the caller must send it as one of:
 *   X-Webhook-Secret: <secret>
 *   Authorization: Bearer <secret>
 *   ?secret=<secret>   (for senders that cannot set headers)
 */
export function checkSecret(req) {
  const secret = cleanSecret(process.env.WEBHOOK_SECRET);
  if (!secret) return;

  const auth = String(req.headers['authorization'] || '');
  const fromQuery = [].concat(req.query?.secret ?? []);
  const candidates = [
    req.headers['x-webhook-secret'],
    auth.toLowerCase().startsWith('bearer ') ? auth.slice(7) : '',
    ...fromQuery,
  ]
    .map(cleanSecret)
    .filter(Boolean);

  if (!candidates.length) {
    throw new HttpError(401, 'No webhook secret received. Add ?secret=YOUR_SECRET to the URL.');
  }
  // Accept if any place the caller put a secret matches (e.g. Postman may add
  // its own Authorization header while the real secret is in the URL).
  if (!candidates.some((c) => safeEqual(c, secret))) {
    throw new HttpError(
      401,
      'Wrong webhook secret. The value in the URL does not match WEBHOOK_SECRET in Vercel ' +
        '(it is case-sensitive). After changing it in Vercel, redeploy.'
    );
  }
}

// Ignore spaces/newlines and wrapping quotes that often sneak in when pasting.
function cleanSecret(v) {
  return String(v ?? '').trim().replace(/^(['"])(.*)\1$/, '$2').trim();
}

function safeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export function sendError(res, err) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ ok: false, error: err.message, ...err.extra });
  }
  if (err instanceof DbConfigError) {
    return res.status(503).json({ ok: false, error: err.message });
  }
  console.error(err);
  return res.status(500).json({ ok: false, error: 'Internal error', detail: err?.message });
}
