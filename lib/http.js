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
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) return;
  const auth = String(req.headers['authorization'] || '');
  const given =
    req.headers['x-webhook-secret'] ||
    (auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '') ||
    req.query?.secret ||
    '';
  const a = Buffer.from(String(given));
  const b = Buffer.from(secret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new HttpError(401, 'Missing or wrong webhook secret');
  }
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
