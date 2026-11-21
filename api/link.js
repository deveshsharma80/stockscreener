// /api/link — for the Strategy Lab (backend.devtradingapp.com), a separate app with its
// own sign-in. The lab has no database and no Dhan or Vultr secrets of its own; it asks
// this app for what it needs, server to server, with the shared LAB_LINK_SECRET:
//
//   X-Link-Secret: <LAB_LINK_SECRET>       (set the same value in both Vercel projects)
//
//   GET  ?action=dhan                       { clientId, accessToken, expiresAt }
//   POST {action:"resolve", symbols:[…]}    { instruments: { SYMBOL: {segment, securityId, instrument} | null } }
//   GET  ?action=history-token              { stream: {base, token, exp} | null }   (Vultr scan service)
//   GET  ?action=scanners                   { scanners }
//   POST {action:"scanner-save", scanner}   { scanner }
//   POST {action:"scanner-delete", id}
//
// Without LAB_LINK_SECRET in Vercel this endpoint is switched off (answers 404).
import { timingSafeEqual } from 'node:crypto';
import { findEquityBySymbol, getCredentials } from '../lib/dhan.js';
import { streamToken } from '../lib/feed.js';
import { HttpError, parseBody, sendError } from '../lib/http.js';
import { deleteScanner, readScanners, saveScanner } from '../lib/scanners.js';

const clean = (v) => String(v ?? '').trim().replace(/^(['"])(.*)\1$/, '$2').trim();

function linkOk(req) {
  const want = clean(process.env.LAB_LINK_SECRET);
  const got = clean(req.headers?.['x-link-secret']);
  if (!want || want.length < 16) throw new HttpError(404, 'Not found');
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new HttpError(401, 'Wrong link secret');
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    linkOk(req);
    const body = req.method === 'POST' ? parseBody(req) || {} : {};
    const action = req.method === 'POST' ? body.action : req.query?.action;

    switch (`${req.method} ${action}`) {
      case 'GET dhan': {
        const c = await getCredentials();
        if (!c?.accessToken) throw new HttpError(400, 'Dhan is not connected in the trading app (Dhan connection → paste access token).');
        return res.json({ ok: true, clientId: c.clientId, accessToken: c.accessToken, expiresAt: c.expiresAt || null });
      }
      case 'POST resolve': {
        const symbols = (Array.isArray(body.symbols) ? body.symbols : []).map((s) => String(s).trim().toUpperCase().slice(0, 40)).filter(Boolean).slice(0, 500);
        const instruments = {};
        for (const s of symbols) {
          const r = await findEquityBySymbol(s);
          instruments[s] = r ? { segment: r.segment, securityId: r.securityId, instrument: r.instrument, symbol: r.symbol } : null;
        }
        return res.json({ ok: true, instruments });
      }
      case 'GET history-token': {
        const t = streamToken();
        return res.json({ ok: true, stream: t ? { base: t.base, token: t.token, exp: t.exp } : null });
      }
      case 'GET scanners':
        return res.json({ ok: true, scanners: await readScanners() });
      case 'POST scanner-save':
        return res.json({ ok: true, scanner: await saveScanner(body.scanner) });
      case 'POST scanner-delete':
        await deleteScanner(String(body.id || ''));
        return res.json({ ok: true });
      default:
        throw new HttpError(400, `Unknown action "${action}"`);
    }
  } catch (err) {
    return sendError(res, err);
  }
}
