/**
 * MCP Apps cards in a real browser: loaded through the sandbox proxy on a
 * second origin, as the MCP Apps specification requires of a web host.
 *
 * The example timer card counts the timers it has shown in `localStorage`.
 * That is the difference a card author sees: through the proxy the card has an
 * origin and storage works; in a plain sandboxed iframe (how Voicestage used
 * to load cards, and still does when it is started without the proxy) it has
 * no origin and storage throws.
 *
 * Needs Google Chrome (or CHROME_PATH). Skipped where there is none.
 */
import { join } from 'node:path';
import puppeteer, { type Browser, type Frame, type Page } from 'puppeteer-core';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Stage } from '../src/core/stage.js';
import { findChrome } from '../src/record/chrome.js';
import { createStageApp, listen, serveStage, type RunningStage } from '../src/server/app.js';
import type { ToolEntry } from '../src/shared/types.js';
import { exampleConfig, ROOT, startStage, tools } from './helpers.js';

const chrome = findChrome();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(what: string, probe: () => Promise<T | undefined | null | false> | T | undefined | null | false, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await sleep(60);
  }
}

describe.skipIf(!chrome)('cards in a browser', () => {
  let vite: ViteDevServer;
  let browser: Browser;
  const stages: Stage[] = [];
  const servers: RunningStage[] = [];

  beforeAll(async () => {
    vite = await createServer({ configFile: join(ROOT, 'vite.config.ts'), server: { middlewareMode: true }, appType: 'spa', logLevel: 'silent' });
    browser = await puppeteer.launch({ executablePath: chrome!, headless: true, args: ['--window-size=1500,950'], defaultViewport: { width: 1500, height: 950 } });
  }, 60_000);

  afterAll(async () => {
    await browser?.close().catch(() => undefined);
    await Promise.all(servers.map((server) => server.close().catch(() => undefined)));
    await Promise.all(stages.map((stage) => stage.close().catch(() => undefined)));
    await vite?.close().catch(() => undefined);
  });

  /** A stage in a browser tab, with the example timer card on the phone. */
  async function open(proxy: boolean): Promise<{ page: Page; stage: Stage; url: string; card: () => Promise<{ outer: Frame; card: Frame }> }> {
    const { stage } = await startStage(exampleConfig());
    stages.push(stage);
    const options = { stage, devMiddleware: vite.middlewares as never };
    const running = proxy ? await serveStage({ ...options, port: 0 }) : await listen(createStageApp(options), { port: 0 });
    servers.push(running);
    const page = await browser.newPage();
    await page.goto(`${running.url}/?voice=0&inspector=0`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-device="phone"]', { timeout: 30_000 });
    await stage.device('phone')!.callTool('start_timer', { label: 'tea', seconds: 1 }, 'inspector', null);
    await page.waitForSelector('[data-device="phone"] .app-card--ready', { timeout: 15_000 });
    const card = async () => {
      const iframe = await page.$('[data-device="phone"] .app-card iframe');
      const outer = (await iframe!.contentFrame())!;
      // Through the proxy the card is one frame further in.
      return { outer, card: proxy ? await until('the card inside the proxy', () => outer.childFrames()[0]) : outer };
    };
    return { page, stage, url: running.url, card };
  }

  const storage = (frame: Frame) =>
    frame.evaluate(() => {
      try {
        localStorage.setItem('probe', 'kept');
        return localStorage.getItem('probe');
      } catch (error) {
        return (error as Error).name;
      }
    });

  it('loads a card through the sandbox proxy: its own origin, working storage, no way to the stage', async () => {
    const { page, stage, url, card } = await open(true);
    const { outer, card: view } = await card();
    const pageOrigin = new URL(url).origin;
    const sandboxOrigin = `http://127.0.0.1:${stage.sandboxPort}`;

    // Host -> proxy (another origin) -> card.
    expect(new URL(outer.url()).origin).toBe(sandboxOrigin);
    expect(sandboxOrigin).not.toBe(pageOrigin);
    expect(await page.$eval('[data-device="phone"] .app-card iframe', (node) => node.getAttribute('sandbox'))).toBe('allow-scripts allow-same-origin allow-forms');
    expect(view.url()).toBe('about:srcdoc');
    expect(await view.evaluate(() => window.origin)).toBe(sandboxOrigin);

    // The handshake, the tool input and the tool result all arrived through the proxy.
    expect(await view.$eval('#label', (node) => node.textContent)).toBe('tea');

    // The card has storage, and used it.
    expect(await storage(view)).toBe('kept');
    expect(await view.$eval('#count', (node) => [(node as HTMLElement).hidden, node.textContent])).toEqual([false, 'The first timer started from this browser.']);

    // It cannot reach the stage's page, storage or API, and loads nothing it did not declare.
    const reach = (expression: string) => view.evaluate(`(async () => { try { return String(await (${expression})); } catch (error) { return error.name; } })()`);
    expect(await reach('window.top.document.title')).toBe('SecurityError');
    expect(await reach('window.top.localStorage.length')).toBe('SecurityError');
    expect(await reach(`fetch(${JSON.stringify(`${url}/api/state`)}).then((response) => response.status)`)).toBe('TypeError');
    expect(await reach('fetch("https://example.com/").then((response) => response.status)')).toBe('TypeError');

    // A real pointer click on the card's button makes the card call the tool through the host.
    await until('the timer to run out', async () => (await view.$eval('#status', (node) => node.textContent)) === 'Done.');
    const corner = await page.$eval('[data-device="phone"] .app-card iframe', (node) => {
      const box = node.getBoundingClientRect();
      return { x: box.x, y: box.y, zoom: Number(getComputedStyle(node).zoom) || 1 };
    });
    const button = await view.$eval('#again', (node) => {
      const box = node.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    });
    await page.mouse.click(corner.x + button.x * corner.zoom, corner.y + button.y * corner.zoom);
    const pressed = await until('the call from the card', () => tools(stage.device('phone')!.snapshot().timeline).find((entry: ToolEntry) => entry.origin === 'card' && entry.status === 'ok'));
    expect(pressed).toMatchObject({ name: 'start_timer', arguments: { label: 'tea', seconds: 1 } });
    await until('the card to count the second timer', async () => (await view.$eval('#count', (node) => node.textContent)) === 'Timer 2 started from this browser.');
    await page.close();
  }, 60_000);

  it('shows the difference: without the proxy the same card has no origin and no storage', async () => {
    const { page, stage, card } = await open(false);
    expect(stage.sandboxPort).toBeUndefined();
    const { card: view } = await card();
    expect(await page.$eval('[data-device="phone"] .app-card iframe', (node) => node.getAttribute('sandbox'))).toBe('allow-scripts allow-forms');
    expect(await view.evaluate(() => window.origin)).toBe('null');
    // The card still works...
    expect(await view.$eval('#label', (node) => node.textContent)).toBe('tea');
    // ...but storage throws, and the card leaves its count out.
    expect(await storage(view)).toBe('SecurityError');
    expect(await view.$eval('#count', (node) => (node as HTMLElement).hidden)).toBe(true);
    await page.close();
  }, 60_000);
});
