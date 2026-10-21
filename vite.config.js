import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';

// On Vercel, files in /api become serverless functions automatically.
// This plugin runs those same files during `npm run dev`, so the webhook
// works locally without the Vercel CLI.
function vercelApiInDev() {
  return {
    name: 'vercel-api-in-dev',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url, 'http://localhost');
        if (!url.pathname.startsWith('/api/')) return next();

        const name = url.pathname.slice('/api/'.length).replace(/\/$/, '');
        const file = path.resolve('api', `${name}.js`);
        if (!/^[\w-]+$/.test(name) || !fs.existsSync(file)) {
          res.statusCode = 404;
          return res.end(JSON.stringify({ ok: false, error: 'Not found' }));
        }

        // Mimic Vercel's Node.js request/response helpers.
        const raw = await new Promise((resolve, reject) => {
          const chunks = [];
          req.on('data', (c) => chunks.push(c));
          req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
          req.on('error', reject);
        });
        req.query = Object.fromEntries(url.searchParams);
        const isJson = String(req.headers['content-type'] || '').includes('application/json');
        try {
          req.body = isJson && raw ? JSON.parse(raw) : raw || undefined;
        } catch {
          req.body = raw; // handler reports the bad JSON
        }
        res.status = (code) => ((res.statusCode = code), res);
        res.json = (obj) => {
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify(obj));
          return res;
        };
        res.send = (data) => (res.end(data), res);

        try {
          const mod = await server.ssrLoadModule(file);
          await mod.default(req, res);
        } catch (err) {
          server.config.logger.error(err.stack || String(err));
          if (!res.headersSent) res.status(500).json({ ok: false, error: err.message });
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // Make .env / .env.local values (WEBHOOK_SECRET, DB_DRIVER, Blob credentials)
  // visible to the API handlers in dev, as they are on Vercel.
  Object.assign(process.env, { ...loadEnv(mode, process.cwd(), ''), ...process.env });
  return { plugins: [react(), vercelApiInDev()] };
});
