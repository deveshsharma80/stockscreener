// TEMPORARY debug endpoint — delete this file once the secret works.
//
// Open in a browser or Postman (GET or POST):
//   https://YOUR-DOMAIN/api/debug?secret=YOUR_SECRET
//
// It never shows the secret. It shows its length, first/last character and a
// short fingerprint for both the value Vercel has and the value you sent.
// If the two fingerprints are the same, the secrets match.
import { createHash } from 'node:crypto';
import { cors } from '../lib/http.js';

const clean = (v) => String(v ?? '').trim().replace(/^(['"])(.*)\1$/, '$2').trim();

function describe(raw) {
  if (raw === undefined || raw === null || raw === '') return { present: false };
  const value = clean(raw);
  return {
    present: true,
    length: value.length,
    rawLength: String(raw).length, // differs from length if spaces/quotes were stripped
    firstChar: value.slice(0, 1),
    lastChar: value.slice(-1),
    fingerprint: createHash('sha256').update(value).digest('hex').slice(0, 8),
  };
}

export default function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const expected = describe(process.env.WEBHOOK_SECRET);
  const auth = String(req.headers['authorization'] || '');
  const received = {
    query_secret: describe([].concat(req.query?.secret ?? [])[0]),
    header_x_webhook_secret: describe(req.headers['x-webhook-secret']),
    header_authorization_bearer: describe(auth.toLowerCase().startsWith('bearer ') ? auth.slice(7) : ''),
  };
  const match = Object.values(received).some(
    (r) => r.present && expected.present && r.fingerprint === expected.fingerprint
  );

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    verdict: !expected.present
      ? 'WEBHOOK_SECRET is NOT available to this deployment. Check its environment (Production) and redeploy.'
      : match
        ? 'MATCH: the secret you sent is the same as WEBHOOK_SECRET.'
        : 'NO MATCH: compare length / first / last character below.',
    vercel_env: process.env.VERCEL_ENV || 'local', // should be "production"
    deployment_url: process.env.VERCEL_URL || null,
    expected_WEBHOOK_SECRET: expected,
    received,
    query_param_names: Object.keys(req.query || {}), // should include "secret"
  });
}
