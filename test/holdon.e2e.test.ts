/**
 * End to end with Hold On, the money-safety MCP server this simulator was
 * built alongside: start a real Hold On server on a free port, connect two
 * devices to it with the real MCP client (Margaret's display as `member`,
 * Sarah's phone as `contact`), and play the three shipped scenarios in
 * scripted mode.
 *
 * Hold On is a separate repository. The test looks for it in HOLDON_DIR, or
 * next to this one (../holdon), and is skipped when it is not there or has
 * not been built (`npm install && npm run build` in that repository).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfigFile } from '../src/core/config.js';
import { loadScenarioFile } from '../src/core/scenario/schema.js';
import { Stage } from '../src/core/stage.js';
import type { ScenarioRunState } from '../src/shared/types.js';
import { questions, ROOT, speech, tools } from './helpers.js';

const holdonDir = resolve(process.env.HOLDON_DIR ?? join(ROOT, '..', 'holdon'));
const available = existsSync(join(holdonDir, 'dist', 'index.js')) && existsSync(join(holdonDir, 'dist', 'ui', 'hold-card.html')) && existsSync(join(holdonDir, 'node_modules'));

let server: ChildProcess | undefined;
let url = '';
let dataDir = '';
let stage: Stage | undefined;
const log: string[] = [];

/** A fresh database for every test, on the server that is already running. */
function reseed(): void {
  const seeded = spawnSync(process.execPath, [join(holdonDir, 'dist', 'seed.js'), '--reset'], { cwd: holdonDir, env: { ...process.env, HOLDON_DB: join(dataDir, 'holdon.db') }, encoding: 'utf8' });
  if (seeded.status !== 0) throw new Error(`Could not seed Hold On: ${seeded.stderr || seeded.stdout}`);
}

beforeAll(async () => {
  if (!available) return;
  dataDir = mkdtempSync(join(tmpdir(), 'voicestage-holdon-'));
  reseed();
  // PORT=0 lets the system pick a free port; the server prints the address it got.
  server = spawn(process.execPath, [join(holdonDir, 'dist', 'index.js')], {
    cwd: holdonDir,
    env: { ...process.env, PORT: '0', HOLDON_DB: join(dataDir, 'holdon.db'), HOLDON_SECRET: 'voicestage-test-secret-0123456789', HOLDON_PROGRESS_INTERVAL_MS: '50' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  url = await new Promise<string>((resolveUrl, reject) => {
    const timer = setTimeout(() => reject(new Error(`Hold On did not start:\n${log.join('')}`)), 15_000);
    const read = (chunk: Buffer) => {
      log.push(chunk.toString());
      const match = /Hold On is listening on (http:\/\/\S+)/.exec(log.join(''));
      if (match) {
        clearTimeout(timer);
        resolveUrl(match[1]!);
      }
    };
    server!.stdout!.on('data', read);
    server!.stderr!.on('data', read);
    server!.once('exit', (code) => reject(new Error(`Hold On exited with code ${code}:\n${log.join('')}`)));
  });
});

afterAll(async () => {
  server?.kill('SIGTERM');
  await new Promise((resolveExit) => (server && server.exitCode === null ? server.once('exit', resolveExit) : resolveExit(undefined)));
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  if (!available) return;
  reseed();
  const config = loadConfigFile(join(ROOT, 'examples/holdon/voicestage.config.yaml'), { HOLDON_URL: url, HOLDON_DIR: holdonDir });
  stage = new Stage(config, { env: {}, provider: 'scripted' });
  await stage.start();
  await Promise.all([...stage.devices.values()].map((device) => device.eventsReady()));
});

afterEach(async () => {
  await stage?.close();
  stage = undefined;
});

async function play(file: string): Promise<ScenarioRunState> {
  const scenario = loadScenarioFile(join(ROOT, 'examples/holdon/scenarios', file));
  const run = await stage!.play(scenario, { mode: 'scripted', reset: true });
  const state = await run.done;
  const problems = state.steps.flatMap((step) => [step.error ? `step ${step.index + 1}: ${step.error}` : undefined, ...step.checks.filter((check) => !check.ok).map((check) => `step ${step.index + 1}: ${check.label}: ${check.detail}`)]).filter(Boolean);
  expect(problems, `${scenario.name}\n${log.slice(-5).join('')}`).toEqual([]);
  expect(state.status).toBe('passed');
  return state;
}

const called = (deviceId: string) => tools(stage!.device(deviceId)!.snapshot().timeline).map((entry) => `${entry.name}${entry.origin === 'assistant' ? '' : ` (${entry.origin})`}`);
const said = (deviceId: string) => speech(stage!.device(deviceId)!.snapshot().timeline).map((entry) => entry.text);
const call = async (deviceId: string, name: string, args: Record<string, unknown> = {}) => (await stage!.device(deviceId)!.callTool(name, args, 'inspector', null, { show: false })).result;

describe.skipIf(!available)('Hold On, end to end', () => {
  it('connects each person with their own token and role over MCP 2025-11-25', () => {
    const kitchen = stage!.device('kitchen')!.snapshot();
    const phone = stage!.device('phone')!.snapshot();
    for (const device of [kitchen, phone]) {
      expect(device.servers[0]).toMatchObject({ id: 'holdon', status: 'connected', protocolVersion: '2025-11-25', era: 'legacy', serverInfo: { name: 'holdon', title: 'Hold On' }, events: { status: 'open' } });
      expect(device.servers[0]!.sessionId).toBeTruthy();
      expect(device.skills).toMatchObject([{ name: 'holdon-money-safety', active: false }]);
    }
    // The server gives each role its own tools: the member cannot decide, the contact cannot pay.
    expect(kitchen.servers[0]!.tools.map((tool) => tool.name).sort()).toEqual(['holdon_cancel_hold', 'holdon_check_request', 'holdon_get_hold', 'holdon_list_holds', 'holdon_pay', 'holdon_place_hold', 'holdon_verify_payee', 'holdon_wait_for_decision']);
    expect(phone.servers[0]!.tools.map((tool) => tool.name).sort()).toEqual(['holdon_family_decide', 'holdon_family_inbox', 'holdon_get_circle', 'holdon_update_policy']);
    expect(kitchen.servers[0]!.tools.find((tool) => tool.name === 'holdon_place_hold')!.uiResourceUri).toBe('ui://holdon/hold-card.html');
    expect(phone.servers[0]!.tools.find((tool) => tool.name === 'holdon_family_inbox')!.uiResourceUri).toBe('ui://holdon/approval-card.html');
  });

  it('(a) an "IRS agent" demands gift cards: stopped, the family is told, Sarah denies, nothing can be paid', async () => {
    await play('a-irs-gift-cards.yaml');
    expect(called('kitchen')).toEqual(['holdon_check_request', 'holdon_place_hold', 'holdon_get_hold (announcement)']);
    expect(called('phone')).toEqual(['holdon_family_inbox (announcement)', 'holdon_family_decide']);

    const vars = stage!.vars as { check: any; hold: any };
    expect(vars.check).toMatchObject({ verdict: 'stop', policy: { blocked: true }, payee: { status: 'mismatch', registry_id: 'irs' } });
    expect(vars.check.risk_signals.map((signal: { id: string }) => signal.id)).toContain('gift-card-payment-demand');

    // Margaret heard the stop, that Sarah was told, then Sarah's answer with her note.
    const heard = said('kitchen').join(' ');
    expect(heard).toMatch(/Let's pause here\. I won't send any money for this\./);
    expect(heard).toMatch(/I've let Sarah know/);
    expect(heard).toMatch(/Sarah Ellis has answered\. Sarah looked at this and asked that it not be paid\. Sarah added a note: "Mom, the real IRS sends letters\. I'll call you tonight\."/);
    expect(said('phone')[0]).toBe('Hold On stopped a payment request from Margaret Ellis. The details are on your screen.');

    // The screens: Margaret's hold card (now denied), Sarah's approval card.
    const kitchenScreen = stage!.device('kitchen')!.currentScreen()!;
    expect(kitchenScreen.card).toMatchObject({ uri: 'ui://holdon/hold-card.html', mimeType: 'text/html;profile=mcp-app' });
    expect(kitchenScreen.result.structuredContent).toMatchObject({ status: 'denied', blocked: true, decision: { by: 'Sarah Ellis' } });
    expect(stage!.device('phone')!.currentScreen()!.card!.uri).toBe('ui://holdon/approval-card.html');

    // Final state on the server: denied, and no path pays it.
    expect((await call('kitchen', 'holdon_get_hold', { hold_id: vars.hold.hold_id })).structuredContent).toMatchObject({ status: 'denied', next_step: 'none' });
    const pay = await call('kitchen', 'holdon_pay', { hold_id: vars.hold.hold_id });
    expect(pay.isError).toBe(true);
    const approve = await call('phone', 'holdon_family_decide', { hold_id: vars.hold.hold_id, decision: 'approve' });
    expect(approve.isError).toBe(true);
    expect((await call('phone', 'holdon_family_inbox', {})).structuredContent).toMatchObject({ count: 0 });
  });

  it('(b) a genuine electric bill: verified, held, approved by Sarah, paid (simulated), receipt shown', async () => {
    await play('b-utility-bill.yaml');
    expect(called('kitchen')).toEqual(['holdon_check_request', 'holdon_place_hold', 'holdon_get_hold (announcement)', 'holdon_pay']);
    // Sarah approves with a press on the card. With no browser there is no card to press, so the scenario makes the card's call itself.
    expect(called('phone')).toEqual(['holdon_family_inbox (announcement)', 'holdon_family_decide (scenario)']);

    const vars = stage!.vars as { check: any; hold: any; receipt: any };
    expect(vars.check).toMatchObject({ verdict: 'verified', risk_signals: [], payee: { status: 'verified', registry_id: 'con-edison' } });
    expect(vars.receipt).toMatchObject({ amount_usd: 182.4, payee: 'Con Edison', method: 'card', simulated: true });
    expect(vars.receipt.confirmation).toMatch(/^SIM-/);

    const screen = stage!.device('kitchen')!.currentScreen()!;
    expect(screen.card!.uri).toBe('ui://holdon/receipt-card.html');
    expect(screen.result.structuredContent).toMatchObject({ receipt_id: vars.receipt.receipt_id });
    expect(said('kitchen').at(-1)).toMatch(/\$182\.40 was paid to Con Edison.*simulated/);
    expect(said('kitchen').join(' ')).toMatch(/Sarah said yes to the \$182\.40 payment to Con Edison\. I can make the payment whenever you're ready\./);

    expect((await call('kitchen', 'holdon_get_hold', { hold_id: vars.hold.hold_id })).structuredContent).toMatchObject({ status: 'paid', receipt: { simulated: true } });
    expect((await call('kitchen', 'holdon_list_holds', { status: 'paid' })).structuredContent).toMatchObject({ count: 1 });
  });

  it('(c) an unknown contractor: not in the registry, held, Sarah vouches and approves, paid, payee remembered', async () => {
    await play('c-contractor-deposit.yaml');
    expect(called('kitchen')).toEqual(['holdon_check_request', 'holdon_place_hold', 'holdon_get_hold (announcement)', 'holdon_pay']);
    expect(called('phone')).toEqual(['holdon_update_policy (scenario)', 'holdon_family_inbox (announcement)', 'holdon_family_decide']);

    const vars = stage!.vars as { check: any; hold: any; decision: any; receipt: any };
    expect(vars.check).toMatchObject({ verdict: 'unknown', payee: { status: 'not_in_registry', name: 'Greenleaf Roofing' } });
    expect(vars.check.payee.official).toBeUndefined();
    expect(vars.decision).toMatchObject({ status: 'approved', trusted_payee_added: true, payee_status: 'family_trusted' });
    expect(vars.receipt).toMatchObject({ amount_usd: 1500, payee: 'Greenleaf Roofing', method: 'check', simulated: true });
    expect(said('kitchen')[0]).toMatch(/I couldn't find "Greenleaf Roofing" on my list of official payees/);
    expect(((await call('phone', 'holdon_get_circle', {})).structuredContent as any).circle.trusted_payees.map((payee: { name: string }) => payee.name)).toEqual(['Greenleaf Roofing']);

    // The scenario starts by forgetting the payee, so it gives the same result when played again.
    await play('c-contractor-deposit.yaml');
  });

  it('asks the one question Hold On needs, by voice, and the answer changes the verdict', async () => {
    const kitchen = stage!.device('kitchen')!;
    kitchen.queueAnswer('Someone called me');
    const record = await kitchen.hear('Someone from Social Security says I have to repay an overpayment of $400 by card.', {
      source: 'scenario',
      script: [{ call: 'holdon_check_request', args: { description: 'Someone from Social Security says I have to repay an overpayment of benefits.', payee_name: 'Social Security', amount_usd: 400, payment_method: 'card' }, save: 'check' }, { say: '{{check.say_to_user}}' }],
    });
    expect(questions(record.entries)).toMatchObject([{ status: 'accept', answeredBy: 'scenario', content: { contact_channel: 'phone_call' }, message: expect.stringMatching(/how did this request to pay reach you/) }]);
    expect(speech(record.entries)[0]).toMatchObject({ reason: 'question', text: expect.stringMatching(/You can say: Someone called me, I got a text message/) });
    expect(stage!.vars.check).toMatchObject({ verdict: 'stop', clarification: { field: 'contact_channel', status: 'answered', answer: 'phone_call' } });
  });

  it('shows progress while waiting for the family, and returns when Sarah answers', async () => {
    const kitchen = stage!.device('kitchen')!;
    const check = (await call('kitchen', 'holdon_check_request', { description: 'My Con Edison electric bill came in the mail.', payee_name: 'Con Edison', amount_usd: 182.4, payment_method: 'card', contact_channel: 'mail' })).structuredContent as { check_id: string };
    const hold = (await call('kitchen', 'holdon_place_hold', { check_id: check.check_id, summary: 'Electric bill' })).structuredContent as { hold_id: string };
    setTimeout(() => void call('phone', 'holdon_family_decide', { hold_id: hold.hold_id, decision: 'approve' }), 300);
    const waited = await kitchen.callTool('holdon_wait_for_decision', { hold_id: hold.hold_id, timeout_seconds: 10 }, 'inspector', null);
    expect(waited.result.structuredContent).toMatchObject({ status: 'approved', timed_out: false });
    expect(waited.entry!.progress.length).toBeGreaterThanOrEqual(2);
    expect(waited.entry!.progress[0]).toMatchObject({ total: 10, message: 'Waiting for the trusted contact to answer. Nothing has been paid.' });
  });
});

describe.skipIf(available)('Hold On, end to end (skipped)', () => {
  it(`needs a built Hold On checkout at ${holdonDir} (set HOLDON_DIR)`, () => {
    expect(available).toBe(false);
  });
});
