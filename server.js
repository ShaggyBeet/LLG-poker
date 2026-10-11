'use strict';
// Zero-dependency server: static files + server-sent events (table state) + JSON POST (actions).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Table } = require('./game');
const { Stats } = require('./stats');

const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png' };
const rooms = new Map();
const stats = new Stats(process.env.STATS_FILE || path.join(__dirname, 'data', 'stats.json'));

function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c;
  do { c = Array.from({ length: 4 }, () => A[crypto.randomInt(A.length)]).join(''); } while (rooms.has(c));
  return c;
}

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise(resolve => {
    let b = '';
    req.on('data', d => { b += d; if (b.length > 10000) { req.destroy(); resolve({}); } });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve({}); } });
  });
}

const int = (v, lo, hi, dflt) => { v = Math.floor(Number(v)); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt; };
const validPid = s => typeof s === 'string' && /^[a-zA-Z0-9]{16,64}$/.test(s);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/healthz') return json(res, 200, { ok: true, rooms: rooms.size });

  if (req.method === 'GET' && url.pathname === '/api/leaderboard') return json(res, 200, { rows: stats.rows() });

  if (req.method === 'GET' && url.pathname === '/api/events') {
    const t = rooms.get((url.searchParams.get('room') || '').toUpperCase());
    const pid = url.searchParams.get('pid');
    if (!t || !t.find(pid)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    t.attach(pid, res);
    req.on('close', () => t.detach(pid, res));
    return;
  }

  if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
    const cmd = url.pathname.slice(5);
    const b = await readBody(req);
    if (cmd === 'join') {
      if (!validPid(b.pid)) return json(res, 400, { err: 'Bad session id' });
      const name = String(b.name || '').trim().slice(0, 16);
      if (!name) return json(res, 400, { err: 'Enter a name' });
      let t;
      if (b.create) {
        if (rooms.size >= 200) return json(res, 503, { err: 'Server is busy' });
        const sb = int(b.sb, 1, 100000, 10);
        t = new Table(newCode(), { chips: int(b.chips, 20, 10000000, 1000), sb, bb: sb * 2, onHand: r => stats.recordHand(r) });
        rooms.set(t.code, t);
      } else {
        t = rooms.get(String(b.room || '').trim().toUpperCase());
        if (!t) return json(res, 404, { err: 'No table with that code' });
      }
      const err = t.join(b.pid, name);
      if (err) return json(res, 400, { err });
      t.broadcast();
      return json(res, 200, { room: t.code });
    }
    const t = rooms.get(String(b.room || '').toUpperCase());
    if (!t || !t.find(b.pid)) return json(res, 404, { err: 'Table not found' });
    const err = t.handle(cmd, b);
    return json(res, err ? 400 : 200, { err: err || undefined });
  }

  // static files
  if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
  let p = decodeURIComponent(url.pathname);
  if (!path.extname(p)) p = '/index.html';
  const file = path.normalize(path.join(PUB, p));
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// keep SSE connections alive through proxies
setInterval(() => {
  for (const t of rooms.values()) for (const r of t.clients.values()) { try { r.write(': ping\n\n'); } catch (e) { /* closed */ } }
}, 20000);

// drop abandoned tables
setInterval(() => {
  for (const [code, t] of rooms) {
    if (t.clients.size === 0 && Date.now() - t.lastActive > 2 * 3600 * 1000) { clearTimeout(t.turnTimer); clearTimeout(t.nextTimer); rooms.delete(code); }
  }
}, 10 * 60 * 1000);

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stats.saveNow(); process.exit(0); });

server.listen(PORT, '0.0.0.0', () => console.log(`Poker table server on http://localhost:${PORT}`));
