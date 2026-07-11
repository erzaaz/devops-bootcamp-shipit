import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { Roster, sanitizeEvent } from './room.js';
import { parse, rosterMsg } from './messages.js';

const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

function send(ws, msg) { try { if (ws.readyState === 1) ws.send(msg); } catch { /* ignore */ } }
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

// Constant-time bearer check.
function authorized(req, token) {
  const m = /^Bearer (.+)$/.exec(req.headers['authorization'] || '');
  if (!m) return false;
  const a = Buffer.from(m[1]), b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > limit) req.destroy(new Error('too large')); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export function createServer({ port = 3000, token = null, publicDir = DIST } = {}) {
  const roster = new Roster();
  const clients = new Set();
  let dirty = false;

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'POST' && req.url === '/api/event') {
        if (token && !authorized(req, token)) return json(res, 401, { error: 'unauthorized' });
        const event = sanitizeEvent(parse(await readBody(req)) || {});
        if (!event) return json(res, 400, { error: 'invalid event: need callsign + known stage/status' });
        roster.upsert(event);
        dirty = true;
        return json(res, 202, { ok: true });
      }
      // static: serve the Vite-built client
      let rel = decodeURIComponent((req.url || '/').split('?')[0]);
      if (rel === '/' || rel === '') rel = '/index.html';
      const file = path.join(publicDir, path.normalize(rel));
      if (!file.startsWith(publicDir)) { res.writeHead(403); return res.end('forbidden'); }
      const buf = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(buf);
    } catch { res.writeHead(404); res.end('not found'); }
  });

  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => {
    clients.add(ws);
    // Snapshot goes out on the next dirty-tick rather than synchronously here:
    // a same-tick send can land in the same TCP read as the WS handshake
    // response, racing the client's own post-'open' listener setup.
    dirty = true;
    const drop = () => clients.delete(ws);
    ws.on('close', drop);
    ws.on('error', drop);
    // spectators are read-only; inbound messages ignored
  });

  const tick = setInterval(() => {
    if (!dirty) return;
    dirty = false;
    const msg = rosterMsg(roster.list());
    for (const ws of clients) send(ws, msg);
  }, 50);

  server.listen(port);
  return {
    get port() { const a = server.address(); return a && typeof a === 'object' ? a.port : port; },
    roster, server, wss,
    close() { clearInterval(tick); wss.close(); return new Promise((r) => server.close(r)); },
  };
}
