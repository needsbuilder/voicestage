/**
 * The sandbox proxy for MCP Apps cards: the page a card is loaded through, on
 * an origin of its own. What happens inside a browser is in cards.browser.test.ts.
 */
import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { localOrigin, sandboxPage, startSandbox, type RunningSandbox } from '../src/server/sandbox.js';

let sandbox: RunningSandbox | undefined;
afterEach(async () => {
  await sandbox?.close();
  sandbox = undefined;
});

function get(port: number, path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('the sandbox proxy', () => {
  it('serves one page, to local hosts only, with a policy that lets a card load nothing it did not declare', async () => {
    sandbox = await startSandbox({ port: 0 });
    const page = await get(sandbox.port, `/sandbox?host=${encodeURIComponent('http://localhost:4700')}`);
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toMatch(/text\/html/);
    const policy = String(page.headers['content-security-policy']);
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("connect-src 'none'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("base-uri 'self'");
    // Only the stage page that asked may embed it.
    expect(policy).toContain('frame-ancestors http://localhost:4700');
    // The page listens to that origin and to no other.
    expect(page.body).toContain('const HOST = "http://localhost:4700";');
    expect(page.body).toContain('ui/notifications/sandbox-proxy-ready');

    expect((await get(sandbox.port, '/')).status).toBe(404);
    expect((await get(sandbox.port, '/sandbox')).status).toBe(400);
    expect((await get(sandbox.port, `/sandbox?host=${encodeURIComponent('https://attacker.example')}`)).status).toBe(400);
    expect((await get(sandbox.port, `/sandbox?host=${encodeURIComponent('http://localhost:4700')}`, { Host: 'attacker.example' })).status).toBe(403);
    expect((await get(sandbox.port, `/sandbox?host=${encodeURIComponent('http://localhost:4700')}`, {}, 'POST')).status).toBe(405);
  });

  it('turns what a card declares into the policy, and nothing else', async () => {
    sandbox = await startSandbox({ port: 0 });
    const csp = JSON.stringify({ connectDomains: ['https://api.example.com', "'unsafe-eval'; script-src *"], resourceDomains: ['https://cdn.example.com'], frameDomains: ['https://player.example.com'] });
    const page = await get(sandbox.port, `/sandbox?host=${encodeURIComponent('http://127.0.0.1:4700')}&csp=${encodeURIComponent(csp)}`);
    const policy = String(page.headers['content-security-policy']);
    expect(policy).toContain('connect-src https://api.example.com;');
    expect(policy).toContain("script-src 'unsafe-inline' https://cdn.example.com;");
    expect(policy).toContain('frame-src https://player.example.com;');
    expect(policy).not.toContain('unsafe-eval');
    expect(policy).toContain('frame-ancestors http://127.0.0.1:4700');
    // Something that is not a description of sources is ignored, not trusted.
    const odd = await get(sandbox.port, `/sandbox?host=${encodeURIComponent('http://localhost:4700')}&csp=${encodeURIComponent('{"connectDomains":"*"}')}`);
    expect(String(odd.headers['content-security-policy'])).toContain("connect-src 'none'");
  });

  it('takes the next free port when the one it wanted is taken', async () => {
    sandbox = await startSandbox({ port: 0 });
    const second = await startSandbox({ port: sandbox.port });
    try {
      expect(second.port).toBeGreaterThan(sandbox.port);
    } finally {
      await second.close();
    }
  });

  it('knows a local origin from any other', () => {
    expect(localOrigin('http://localhost:4700')).toBe('http://localhost:4700');
    expect(localOrigin('http://127.0.0.1:4700/some/page')).toBe('http://127.0.0.1:4700');
    expect(localOrigin('http://[::1]:4700')).toBe('http://[::1]:4700');
    expect(localOrigin('https://localhost.attacker.example')).toBeUndefined();
    expect(localOrigin('javascript:alert(1)')).toBeUndefined();
    expect(localOrigin('')).toBeUndefined();
    expect(localOrigin(null)).toBeUndefined();
  });

  it('builds a page that speaks for the host it was given, safely quoted', () => {
    expect(sandboxPage('http://localhost:4700')).toContain('const HOST = "http://localhost:4700";');
    expect(sandboxPage('http://localhost:4700')).toContain("view.setAttribute('sandbox'");
  });
});
