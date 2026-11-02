// /api/auth — sign in to the dashboard.
// GET  ?action=me                         { enabled, loggedIn, exp }
// POST {action:"login", password, remember}
// POST {action:"logout"}
// The password is APP_PASSWORD in Vercel → Settings → Environment Variables.
import { authEnabled, clearCookie, clearFails, clientIp, noteFail, passwordOk, readSession, sessionCookie, tooManyFails } from '../lib/auth.js';
import { HttpError, parseBody, sendError } from '../lib/http.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const body = req.method === 'POST' ? parseBody(req) || {} : {};
    const action = req.method === 'POST' ? body.action : req.query?.action;

    switch (`${req.method} ${action}`) {
      case 'GET me': {
        const s = readSession(req);
        return res.json({ ok: true, enabled: authEnabled(), loggedIn: Boolean(s), exp: s ? new Date(s.exp).toISOString() : null });
      }
      case 'POST login': {
        if (!authEnabled()) throw new HttpError(400, 'Sign-in is off: set APP_PASSWORD in Vercel first.');
        const ip = clientIp(req);
        const wait = tooManyFails(ip);
        if (wait) throw new HttpError(429, `Too many wrong passwords. Try again in ${wait} min.`);
        if (!passwordOk(body.password)) {
          noteFail(ip);
          await new Promise((r) => setTimeout(r, 800)); // slows down guessing
          throw new HttpError(401, 'Wrong password.');
        }
        clearFails(ip);
        const { header, exp } = sessionCookie(req, Boolean(body.remember));
        res.setHeader('Set-Cookie', header);
        return res.json({ ok: true, loggedIn: true, exp: new Date(exp).toISOString() });
      }
      case 'POST logout':
        res.setHeader('Set-Cookie', clearCookie(req));
        return res.json({ ok: true, loggedIn: false });
      default:
        throw new HttpError(400, `Unknown action "${action}"`);
    }
  } catch (err) {
    return sendError(res, err);
  }
}
