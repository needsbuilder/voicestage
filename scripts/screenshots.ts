/**
 * Takes the screenshots in docs/screenshots with headless Chrome.
 *
 *   npm run screenshots -- --url http://localhost:4700 [--out docs/screenshots] [--only idle,hold]
 *
 * It expects a running stage with the Hold On example configuration
 * (see examples/holdon). Sound is off, so nothing depends on speech synthesis.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import puppeteer, { type Page } from 'puppeteer-core';
import type { StageSnapshot } from '../src/shared/types.js';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://localhost:4700' },
    out: { type: 'string', default: 'docs/screenshots' },
    only: { type: 'string' },
    chrome: { type: 'string' },
    width: { type: 'string', default: '1920' },
    height: { type: 'string', default: '1080' },
    scenario: { type: 'string', default: 'b-utility-bill' },
    prefix: { type: 'string', default: '' },
  },
});

const CHROME_PATHS = [
  values.chrome,
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter((path): path is string => Boolean(path));

const base = values.url!.replace(/\/$/, '');
const out = resolve(values.out!);
const only = values.only ? new Set(values.only.split(',')) : undefined;
const sleep = (ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

async function post(path: string, body: unknown = {}): Promise<unknown> {
  const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return response.json();
}

async function state(): Promise<StageSnapshot> {
  return (await (await fetch(`${base}/api/state`)).json()) as StageSnapshot;
}

async function until(what: string, test: (snapshot: StageSnapshot) => boolean, timeoutMs = 30_000): Promise<StageSnapshot> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshot = await state();
    if (test(snapshot)) return snapshot;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}. Run state: ${JSON.stringify(snapshot.run?.steps.map((step) => `${step.index}:${step.status}`))}`);
    await sleep(120);
  }
}

async function shoot(page: Page, name: string, settleMs = 900): Promise<void> {
  if (only && !only.has(name)) return;
  await sleep(settleMs);
  const file = join(out, `${values.prefix}${name}.png`);
  await page.screenshot({ path: file as `${string}.png` });
  console.log(`saved ${file}`);
}

/** Advance a step-by-step run by one step and wait until that step has finished. */
async function step(index: number): Promise<void> {
  await until(`the run to wait before step ${index + 1}`, (snapshot) => snapshot.run?.waitingForNext === true || snapshot.run?.status !== 'running');
  await post('/api/scenarios/next');
  await until(`step ${index + 1} to finish`, (snapshot) => {
    const status = snapshot.run?.steps[index]?.status;
    return status === 'passed' || status === 'failed';
  });
}

async function main(): Promise<void> {
  const executablePath = CHROME_PATHS.find((path) => existsSync(path));
  if (!executablePath) throw new Error('Chrome was not found. Pass --chrome <path> or set CHROME_PATH.');
  mkdirSync(out, { recursive: true });
  const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--hide-scrollbars', '--mute-audio'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: Number(values.width), height: Number(values.height), deviceScaleFactor: 1 });
    page.on('pageerror', (error) => console.error('page error:', error));
    page.on('console', (message) => {
      if (message.type() === 'error') console.error('console error:', message.text());
    });

    await post('/api/scenarios/stop').catch(() => undefined);
    await post('/api/reset');
    await sleep(300);

    // 1. Idle, without the inspector: the stage as an audience sees it.
    await page.goto(`${base}/?voice=0&inspector=0`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.device');
    await shoot(page, '01-idle');

    // 2. A scenario, one step at a time, with the inspector open.
    await page.goto(`${base}/?voice=0&inspector=1&tab=timeline&device=kitchen`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.device');
    await post(`/api/scenarios/${values.scenario}/play`, { mode: 'scripted', pacing: 'step' });

    await step(0); // Margaret asks; the request is checked and held.
    await shoot(page, '02-hold-on-display', 1600);

    await step(1); // Sarah's phone announces it and shows the approval card.
    await shoot(page, '03-hold-and-approval', 2200);

    await page.goto(`${base}/?voice=0&inspector=0`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.device');
    await shoot(page, '04-hold-and-approval-clean', 2200);

    await page.goto(`${base}/?voice=0&inspector=1&tab=timeline&device=phone`, { waitUntil: 'domcontentloaded' });
    await step(2); // Sarah decides.
    await step(3); // Margaret's display announces the decision.
    await shoot(page, '05-decision-announced', 2600);

    const snapshot = await state();
    if ((snapshot.run?.steps.length ?? 0) > 4) {
      await page.goto(`${base}/?voice=0&inspector=1&tab=scenario`, { waitUntil: 'domcontentloaded' });
      await step(4); // Margaret pays; the receipt is shown.
      await until('the run to finish', (current) => current.run?.status !== 'running');
      await shoot(page, '06-receipt', 2600);
      await page.goto(`${base}/?voice=0&inspector=0`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.device');
      await shoot(page, '07-receipt-clean', 2600);
      await page.goto(`${base}/?voice=0&inspector=1&tab=connections&device=kitchen`, { waitUntil: 'domcontentloaded' });
      await shoot(page, '08-inspector-connections', 1200);
    } else {
      await until('the run to finish', (current) => current.run?.status !== 'running');
    }
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
