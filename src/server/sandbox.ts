/**
 * The sandbox proxy for MCP Apps cards.
 *
 * The MCP Apps specification (2026-01-26, "Sandbox proxy") says a host that is
 * a web page must not load a card directly. It loads a small page from a
 * *different origin*, the sandbox proxy, and that page loads the card in an
 * iframe of its own and passes messages between card and host. A card then
 * has a real origin (so storage works) that is not the host's (so it cannot
 * reach the host's page, storage or API).
 *
 * This is that proxy: a second listener on another localhost port, serving one
 * page. The page's Content-Security-Policy is built from what the card's
 * resource declares, and the card's document inherits it.
 */
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cardCsp } from '../shared/card-html.js';
import type { CardResource } from '../shared/types.js';

export const SANDBOX_PATH = '/sandbox';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** `http://localhost:4700` and the like: the only pages that may embed the proxy. */
export function localOrigin(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return LOCAL_HOSTS.has(url.hostname) || LOCAL_HOSTS.has(`[${url.hostname}]`) ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

function parseCsp(value: string | null): CardResource['csp'] {
  if (!value || value.length > 8000) return undefined;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const list = (key: string) => (Array.isArray(parsed[key]) ? (parsed[key] as unknown[]).filter((item): item is string => typeof item === 'string').slice(0, 50) : undefined);
    return { connectDomains: list('connectDomains'), resourceDomains: list('resourceDomains'), frameDomains: list('frameDomains'), baseUriDomains: list('baseUriDomains') };
  } catch {
    return undefined;
  }
}

/**
 * The proxy page. `host` is the origin of the page that embeds it: the only
 * origin it listens to, and the only one it posts to.
 */
export function sandboxPage(host: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="light dark">
<title>Voicestage card sandbox</title>
<style>
  html, body { height: 100%; margin: 0; background: transparent; }
  iframe { display: block; width: 100%; height: 100%; border: 0; background: transparent; }
  p { margin: 2em; font: 15px/1.5 system-ui, sans-serif; }
</style>
</head>
<body>
<script>
(() => {
  const HOST = ${JSON.stringify(host)};
  const host = window.parent;
  if (host === window) {
    document.body.innerHTML = '<p>This page is the sandbox that Voicestage loads MCP Apps cards in. It does nothing on its own.</p>';
    return;
  }
  const SANDBOX_PREFIX = 'ui/notifications/sandbox-';
  let view = null;

  function load(params) {
    if (view) view.remove();
    view = document.createElement('iframe');
    view.title = 'Card';
    view.setAttribute('sandbox', typeof params.sandbox === 'string' ? params.sandbox : 'allow-scripts allow-same-origin allow-forms');
    const asked = params.permissions || {};
    const allow = [];
    if (asked.camera) allow.push('camera');
    if (asked.microphone) allow.push('microphone');
    if (asked.geolocation) allow.push('geolocation');
    if (asked.clipboardWrite) allow.push('clipboard-write');
    if (allow.length > 0) view.setAttribute('allow', allow.join('; '));
    view.srcdoc = String(params.html || '');
    document.body.append(view);
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    const method = typeof message.method === 'string' ? message.method : '';
    if (event.source === host) {
      // Only the page that embedded this one is listened to.
      if (event.origin !== HOST) return;
      if (method === 'ui/notifications/sandbox-resource-ready') return load(message.params || {});
      if (method.startsWith(SANDBOX_PREFIX)) return;
      if (view && view.contentWindow) view.contentWindow.postMessage(message, '*');
    } else if (view && event.source === view.contentWindow) {
      // The card may not speak for the proxy.
      if (method.startsWith(SANDBOX_PREFIX)) return;
      host.postMessage(message, HOST);
    }
  });

  host.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/sandbox-proxy-ready', params: {} }, HOST);
})();
</script>
</body>
</html>
`;
}

export interface RunningSandbox {
  port: number;
  close(): Promise<void>;
}

/**
 * Start the proxy on a localhost port of its own. Falls forward to the next
 * free port when the wanted one is taken.
 */
export async function startSandbox(options: { port?: number; log?: (line: string) => void } = {}): Promise<RunningSandbox> {
  const log = options.log ?? (() => undefined);
  const handler = (url: URL, headers: Record<string, string | string[] | undefined>): { status: number; headers: Record<string, string>; body: string } => {
    const plain = (status: number, body: string) => ({ status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }, body });
    const requestHost = typeof headers.host === 'string' ? headers.host : '';
    if (!localOrigin(`http://${requestHost}`)) return plain(403, 'The Voicestage card sandbox only answers requests from this machine.');
    if (url.pathname !== SANDBOX_PATH) return plain(404, 'Nothing here. This port only serves the Voicestage card sandbox.');
    const host = localOrigin(url.searchParams.get('host'));
    if (!host) return plain(400, 'The sandbox needs to know which local page embeds it (?host=http://localhost:PORT).');
    // The card's document is a srcdoc iframe of this page and inherits this policy; only that host may frame the page.
    const policy = `${cardCsp(parseCsp(url.searchParams.get('csp')))}; frame-ancestors ${host}`;
    return {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': policy, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' },
      body: sandboxPage(host),
    };
  };
  const wanted = options.port ?? 0;
  let server: HttpServer | undefined;
  for (let port = wanted, attempts = 0; !server; port += 1, attempts += 1) {
    try {
      server = await new Promise<HttpServer>((resolve, reject) => {
        const listening = createServer((req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405, { Allow: 'GET, HEAD' }).end();
            return;
          }
          let answer: ReturnType<typeof handler>;
          try {
            answer = handler(new URL(req.url ?? '/', 'http://sandbox.invalid'), req.headers);
          } catch (error) {
            log(`sandbox: ${error instanceof Error ? error.message : String(error)}`);
            answer = { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'Bad request.' };
          }
          res.writeHead(answer.status, answer.headers).end(req.method === 'HEAD' ? undefined : answer.body);
        });
        listening.once('error', reject);
        listening.listen(port, '127.0.0.1', () => resolve(listening));
      });
    } catch (error) {
      const inUse = (error as NodeJS.ErrnoException).code === 'EADDRINUSE';
      if (!inUse || wanted === 0 || attempts >= 20) throw error;
    }
  }
  const http = server;
  return {
    port: (http.address() as AddressInfo).port,
    async close() {
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
