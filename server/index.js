import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { renderChunk, CHUNK_MS, RATE } from './audio.js';

export function createPanelServer({ key, directory, origins, now = Date.now, render = renderChunk }) {
  if (!key || key.length < 32) throw new Error('LISTEN_KEY must contain at least 32 characters');
  const digest = value => createHash('sha256').update(value).digest();
  const keyHash = digest(key);
  const allowed = new Set(origins);
  const assets = new Map(['/','/index.html','/app.js','/style.css'].map(path => [path, readFileSync(new URL(`../public/${path === '/' ? 'index.html' : path.slice(1)}`, import.meta.url))]));
  let cache;
  const limits = new Map();
  const server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const origin = req.headers.origin;
    if (origin && !allowed.has(origin)) { res.writeHead(403).end(); return; }
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Expose-Headers', 'X-Audio-Start, X-Audio-End, X-Audio-Voice, X-Audio-Rate');
    }
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) {
      const asset = assets.get(url.pathname);
      if (!asset) { res.writeHead(404).end(); return; }
      res.setHeader('Content-Type', url.pathname.endsWith('.js') ? 'text/javascript; charset=utf-8' : url.pathname.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8');
      res.end(asset); return;
    }
    // Caddy overwrites X-Forwarded-For. The service only binds to loopback.
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const time = now();
    let limit = limits.get(ip);
    if (!limit || limit.until <= time) { limit = { until: time + 60000, count: 0 }; limits.set(ip, limit); }
    if (limits.size > 1000) for (const [id, item] of limits) if (item.until <= time) limits.delete(id);
    if (++limit.count > 180) { res.writeHead(429).end(); return; }
    const token = req.headers.authorization?.replace(/^Bearer /, '') || '';
    if (!timingSafeEqual(digest(token), keyHash)) { res.writeHead(401).end(); return; }
    if (url.pathname === '/api/status') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ now: time, sampleRate: RATE, chunkMs: CHUNK_MS })); return;
    }
    if (url.pathname !== '/api/live') { res.writeHead(404).end(); return; }
    const end = Math.floor((time - 800) / CHUNK_MS) * CHUNK_MS;
    const after = Number(url.searchParams.get('after') || 0);
    if (!Number.isFinite(after)) { res.writeHead(400).end(); return; }
    if (after >= end) { res.writeHead(204).end(); return; }
    try {
      if (cache?.end !== end) cache = { ...render(directory, end - CHUNK_MS, end), end };
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('X-Audio-Start', String(end - CHUNK_MS));
      res.setHeader('X-Audio-End', String(end));
      res.setHeader('X-Audio-Voice', cache.packets ? '1' : '0');
      res.setHeader('X-Audio-Rate', String(RATE));
      res.end(cache.pcm);
    } catch { console.error('Audio buffer read failed'); res.writeHead(503).end(); }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createPanelServer({ key: process.env.LISTEN_KEY, directory: process.env.AUDIO_DIRECTORY || '/opt/afk-bot/data/audio-buffer', origins: (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean) });
  server.listen(Number(process.env.PORT || 8787), '127.0.0.1', () => console.log('Listen panel ready on loopback'));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
}
