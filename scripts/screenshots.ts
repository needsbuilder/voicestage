/**
 * Takes the screenshots in docs/screenshots with headless Chrome.
 *
 *   npm run screenshots -- --set holdon  --url http://localhost:4700
 *   npm run screenshots -- --set example --url http://localhost:4700
 *
 * `holdon` expects a stage started with examples/holdon/voicestage.config.yaml
 * (and a freshly seeded Hold On server); `example` expects
 * examples/three-devices.config.yaml. Sound is off, so nothing depends on
 * speech synthesis: lines are shown for as long as they would take to say.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import puppeteer, { type Page } from 'puppeteer-core';
import type { StageSnapshot } from '../src/shared/types.js';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://localhost:4700' },
    set: { type: 'string', default: 'holdon' },
    out: { type: 'string', default: 'docs/screenshots' },
    chrome: { type: 'string' },
    width: { type: 'string', default: '1920' },
    height: { type: 'string', default: '1080' },
    dark: { type: 'boolean', default: false },
  },
});

const CHROME_PATHS = [values.chrome, process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(
  (path): path is string => Boolean(path),
);

const base = values.url!.replace(/\/$/, '');
const out = resolve(values.out!);
const sleep = (ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

async function post(path: string, body: unknown = {}): Promise<unknown> {
  const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return response.json();
}

async function state(): Promise<StageSnapshot> {
  return (await (await fetch(`${base}/api/state`)).json()) as StageSnapshot;
}

async function until(what: string, test: (snapshot: StageSnapshot) => boolean, timeoutMs = 90_000): Promise<StageSnapshot> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshot = await state();
    if (test(snapshot)) return snapshot;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}. Run: ${JSON.stringify(snapshot.run?.steps.map((step) => `${step.index}:${step.status}`))}`);
    await sleep(120);
  }
}

async function open(page: Page, query: string): Promise<void> {
  await page.goto(`${base}/?voice=0&${query}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.device');
}

async function shoot(page: Page, name: string, settleMs = 1200): Promise<void> {
  await sleep(settleMs);
  const file = join(out, `${name}.png`);
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

async function startOver(): Promise<void> {
  await post('/api/scenarios/stop').catch(() => undefined);
  await post('/api/reset');
  await sleep(300);
}

async function holdon(page: Page): Promise<void> {
  await startOver();
  // The stage as an audience sees it: no inspector.
  await open(page, 'inspector=0');
  await shoot(page, '01-idle');

  // A genuine bill, one step at a time.
  await open(page, 'inspector=1&tab=timeline&device=kitchen');
  await post('/api/scenarios/b-utility-bill/play', { mode: 'scripted', pacing: 'step' });
  await step(0); // Margaret asks; the request is checked and held.
  await shoot(page, '02-hold-with-inspector', 1800);
  await step(1); // Sarah's phone announces it and shows the approval card.
  await open(page, 'inspector=0');
  await shoot(page, '03-hold-and-approval', 2400);
  await open(page, 'inspector=1&tab=timeline&device=phone');
  await shoot(page, '04-hold-and-approval-inspector', 2400);
  await step(2); // Sarah approves.
  await step(3); // Margaret's display announces the decision.
  await open(page, 'inspector=0');
  await shoot(page, '05-approved', 2400);
  await step(4); // Margaret pays; the receipt is shown.
  await until('the run to finish', (snapshot) => snapshot.run?.status !== 'running');
  await open(page, 'inspector=0');
  await shoot(page, '06-receipt', 2400);
  await open(page, 'inspector=1&tab=scenario');
  await shoot(page, '07-receipt-scenario-results', 2400);
  await open(page, 'inspector=1&tab=connections&device=kitchen');
  await shoot(page, '08-inspector-connections', 1500);

  // The scam: stopped, and it can only be denied.
  await startOver();
  await open(page, 'inspector=0');
  await post('/api/scenarios/a-irs-gift-cards/play', { mode: 'scripted', pacing: 'step' });
  await step(0);
  await step(1);
  await open(page, 'inspector=0');
  await shoot(page, '09-stopped-request', 2400);
  await step(2); // Sarah denies.
  await step(3); // Margaret hears it.
  await until('the run to finish', (snapshot) => snapshot.run?.status !== 'running');
  await open(page, 'inspector=0');
  await shoot(page, '10-denied', 2400);
}

async function example(page: Page): Promise<void> {
  await startOver();
  await open(page, 'inspector=0');
  // A recipe on the display: structured output with no card, drawn as the default card.
  await post('/api/devices/display/say', { text: 'How do I make pancakes?' });
  await until('the recipe', (snapshot) => snapshot.devices.find((device) => device.id === 'display')?.screen?.tool.name === 'find_recipe');
  // A timer with no duration, on the phone and on the speaker: the server asks (form elicitation).
  await post('/api/devices/phone/say', { text: 'Set a timer for the pancakes.' });
  await post('/api/devices/speaker/say', { text: 'Set a timer for the pancakes.' });
  await until('the question on both devices', (snapshot) => snapshot.devices.filter((device) => device.elicitation).length === 2);
  await shoot(page, '11-three-devices-question', 6000);
  // Answer by tapping on the phone, and by voice on the speaker.
  const choices = await page.$$('.device--phone .question__choices button');
  await choices[1]!.click();
  await post('/api/devices/speaker/say', { text: 'three seconds' });
  await until('the timer card', (snapshot) => snapshot.devices.find((device) => device.id === 'phone')?.screen?.card?.uri === 'ui://example/timer-card.html');
  // The speaker is set to hold announcements behind its indicator.
  await until('the notification on the speaker', (snapshot) => snapshot.devices.find((device) => device.id === 'speaker')?.notification?.state === 'pending');
  await shoot(page, '12-timer-card-and-notification', 1500);
}

async function main(): Promise<void> {
  const executablePath = CHROME_PATHS.find((path) => existsSync(path));
  if (!executablePath) throw new Error('Chrome was not found. Pass --chrome <path> or set CHROME_PATH.');
  mkdirSync(out, { recursive: true });
  const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--hide-scrollbars', '--mute-audio'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: Number(values.width), height: Number(values.height), deviceScaleFactor: 1 });
    if (values.dark) await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    page.on('pageerror', (error) => console.error('page error:', error));
    page.on('console', (message) => {
      if (message.type() === 'error') console.error('console error:', message.text());
    });
    if (values.set === 'holdon') await holdon(page);
    else if (values.set === 'example') await example(page);
    else throw new Error(`Unknown --set "${values.set}". Use "holdon" or "example".`);
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
