/**
 * Minimal HTTP front-end for tests: real middleware + real route modules behind node:http.
 * Run as its own process to act as an independent SOLIVY server (e.g. the online hub).
 *   node --require tests/setup/register.cjs --import tsx tests/helpers/server.ts <port>
 */
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { NextRequest } from 'next/server';

const ROOT = path.resolve(__dirname, '..', '..');
const port = Number(process.argv[2] || 0);
const routes = new Map<string, any>();

const server = http.createServer(async (inc, out) => {
  try {
    const chunks: Buffer[] = [];
    for await (const c of inc) chunks.push(c as Buffer);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const url = new URL(inc.url || '/', `http://127.0.0.1:${(server.address() as any).port}`);
    // Test-only static files (UI harness bundles), served before middleware like Next's /_next assets.
    if (url.pathname.startsWith('/__ui/') && process.env.SOLIVY_UI_DIR) {
      const f = path.join(process.env.SOLIVY_UI_DIR, path.basename(url.pathname));
      if (fs.existsSync(f)) { out.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html' : 'text/javascript' }); out.end(fs.readFileSync(f)); return; }
    }
    // Test-harness only: serve the bundled UI at the application paths so client-side navigation works.
    if (process.env.SOLIVY_UI_ROOT === '1' && process.env.SOLIVY_UI_DIR && (url.pathname === '/' || url.pathname === '/login')) {
      out.writeHead(200, { 'content-type': 'text/html' }); out.end(fs.readFileSync(path.join(process.env.SOLIVY_UI_DIR, 'index.html'))); return;
    }
    // Test-harness only: drop this instance's bridge cache and working copies (fresh-instance test).
    if (url.pathname === '/__fresh' && process.env.SOLIVY_UI_DIR) {
      (globalThis as any).__solivyBridgeCache?.clear?.();
      const dir = process.env.FINANCE_DATA_DIR;
      if (dir && fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
      out.writeHead(200, { 'content-type': 'application/json' }); out.end('{"ok":true}'); return;
    }
    // Test-harness only: PostgreSQL socket byte counters (set up by tests/bench/pg-instrument.cjs).
    if (url.pathname === '/__pgstats' && process.env.SOLIVY_UI_DIR) {
      const f = (globalThis as any).__pgBytes; const b = f ? f() : { read: 0, written: 0 };
      out.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); out.end(JSON.stringify(b)); return;
    }
    const headers = new Headers();
    for (const [k, v] of Object.entries(inc.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
    if (!headers.has('origin') && inc.method !== 'GET') headers.set('origin', url.origin);
    const { middleware } = await import(path.join(ROOT, 'middleware.ts'));
    const mw: any = await middleware(new NextRequest(url, { method: inc.method, headers, body: body ? new Uint8Array(body) : undefined }));
    let res: Response = mw;
    if (mw.__next) {
      if (!routes.has(url.pathname)) routes.set(url.pathname, await import(path.join(ROOT, 'app', url.pathname, 'route.ts')));
      const handler = routes.get(url.pathname)[String(inc.method).toUpperCase()];
      res = handler ? await handler(new Request(url, { method: inc.method, headers: mw.__requestHeaders || headers, body: body ? new Uint8Array(body) : undefined })) : new Response('Method not allowed', { status: 405 });
    }
    const outHeaders: Record<string, string | string[]> = {};
    res.headers.forEach((v, k) => { outHeaders[k] = k === 'set-cookie' ? (res.headers as any).getSetCookie?.() || v : v; });
    out.writeHead(res.status, outHeaders);
    out.end(Buffer.from(await res.arrayBuffer()));
  } catch (e: any) {
    out.writeHead(500, { 'content-type': 'application/json' });
    out.end(JSON.stringify({ error: String(e?.message || e) }));
  }
});
server.listen(port, '127.0.0.1', () => { process.stdout.write(`LISTENING ${(server.address() as any).port}\n`); });
