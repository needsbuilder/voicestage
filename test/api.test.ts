/**
 * The stage server's HTTP API and event stream, as the browser UI uses them.
 */
import { request } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Stage } from '../src/core/stage.js';
import { createStageApp, listen, type RunningStage } from '../src/server/app.js';
import type { StageEvent, StageSnapshot, ToolResult } from '../src/shared/types.js';
import { exampleConfig, startStage } from './helpers.js';

let stage: Stage;
let running: RunningStage;
let closeStream: (() => void) | undefined;

beforeEach(async () => {
  ({ stage } = await startStage(exampleConfig()));
  running = await listen(createStageApp({ stage }), { port: 0 });
});
afterEach(async () => {
  closeStream?.();
  closeStream = undefined;
  await stage.close();
  await running.close();
});

const post = async (path: string, body: unknown = {}) => {
  const response = await fetch(`${running.url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
};

/** Read the event stream the way a browser tab does, acknowledging speech and cues at once. */
async function watch(): Promise<StageEvent[]> {
  const events: StageEvent[] = [];
  const controller = new AbortController();
  closeStream = () => controller.abort();
  const response = await fetch(`${running.url}/api/stream`, { signal: controller.signal });
  expect(response.headers.get('content-type')).toMatch(/text\/event-stream/);
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let index: number;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const data = block.split('\n').find((line) => line.startsWith('data: '));
          if (!data) continue;
          const event = JSON.parse(data.slice(6)) as StageEvent;
          events.push(event);
          if (event.type === 'speech') void post(`/api/devices/${event.deviceId}/speech/${event.id}/done`);
          if (event.type === 'cue') void post(`/api/cues/${event.id}/done`);
        }
      }
    } catch {
      // The test closed the stream.
    }
  })();
  await expect.poll(() => events.length).toBeGreaterThan(0);
  return events;
}

describe('stage server', () => {
  it('describes the stage', async () => {
    const snapshot = (await (await fetch(`${running.url}/api/state`)).json()) as StageSnapshot;
    expect(snapshot).toMatchObject({ name: 'Test stage', run: null });
    expect(snapshot.devices.map((device) => [device.id, device.kind, device.person.name, device.provider.id])).toEqual([
      ['display', 'display', 'Alex', 'scripted'],
      ['phone', 'phone', 'Sam', 'scripted'],
    ]);
    expect(snapshot.devices[0]!.servers[0]).toMatchObject({ protocolVersion: '2025-11-25', status: 'connected' });
    expect(snapshot.devices[0]!.hints).toEqual(['How do I make pancakes?', 'Set a timer for the pancakes.']);
    expect(snapshot.scenarios).toMatchObject([
      { id: 'pancakes', name: 'Pancakes and a timer', devices: ['display'] },
      { id: 'soup-and-tea', name: 'Soup and a tea timer', devices: ['phone'] },
    ]);
    // Each device suggests the lines written for it, which is what a scripted device can answer.
    expect(snapshot.devices[1]!.hints).toEqual(['How do I make tomato soup?', 'Set a timer for the tea.']);
  });

  it('streams a turn: transcript, timeline, screen and speech', async () => {
    const events = await watch();
    expect(events[0]).toMatchObject({ type: 'snapshot', stage: { name: 'Test stage' } });

    expect(await post('/api/devices/display/say', { text: 'How do I make pancakes?', source: 'voice' })).toMatchObject({ status: 202 });
    await expect.poll(() => events.some((event) => event.type === 'speech')).toBe(true);
    await expect.poll(() => events.findLast((event) => event.type === 'device' && event.patch.status !== undefined)).toMatchObject({ patch: { status: 'idle' } });

    const of = <T extends StageEvent['type']>(type: T) => events.filter((event): event is Extract<StageEvent, { type: T }> => event.type === type);
    expect(of('transcript').map((event) => [event.line.role, event.line.source])).toEqual([
      ['user', 'voice'],
      ['assistant', 'reply'],
    ]);
    const kinds = of('timeline').map((event) => `${event.entry.kind}${event.entry.kind === 'tool' ? `:${event.entry.status}` : ''}`);
    expect(kinds).toEqual(expect.arrayContaining(['utterance', 'model', 'skill', 'tool:running', 'tool:ok', 'speech']));
    expect(of('device').some((event) => event.patch.progress?.message === 'Opening the cookbook')).toBe(true);
    expect(of('device').find((event) => event.patch.screen)).toMatchObject({ deviceId: 'display', patch: { screen: { tool: { name: 'find_recipe' }, result: { structuredContent: { title: 'Pancakes' } } } } });
    expect(of('speech')[0]).toMatchObject({ deviceId: 'display', reason: 'reply', text: expect.stringMatching(/Pancakes takes about 20 minutes/) });
  });

  it('lets a card call tools and read resources on its own server only', async () => {
    const called = await post('/api/devices/phone/tool', { server: 'kitchen', name: 'start_timer', arguments: { label: 'tea', seconds: 30 } });
    expect(called.status).toBe(200);
    expect((called.body as ToolResult).structuredContent).toMatchObject({ label: 'tea', seconds: 30, status: 'running' });
    expect(stage.device('phone')!.snapshot().timeline.at(-1)).toMatchObject({ kind: 'tool', origin: 'card', name: 'start_timer' });

    const elsewhere = await post('/api/devices/phone/tool', { server: 'other', name: 'start_timer' });
    expect((elsewhere.body as ToolResult).isError).toBe(true);
    expect(await post('/api/devices/phone/tool', { name: 'start_timer' })).toMatchObject({ status: 400 });

    const resource = await post('/api/devices/phone/resource', { server: 'kitchen', uri: 'ui://example/timer-card.html' });
    expect(resource.body.contents[0]).toMatchObject({ mimeType: 'text/html;profile=mcp-app' });
    expect(await post('/api/devices/phone/resource', { server: 'kitchen', uri: 'ui://example/missing.html' })).toMatchObject({ status: 502 });

    await post('/api/devices/phone/card-event', { action: 'open-link', detail: { url: 'https://example.com' }, uri: 'ui://example/timer-card.html' });
    expect(stage.device('phone')!.snapshot().timeline.at(-1)).toMatchObject({ kind: 'card', action: 'open-link' });
  });

  it('plays a scenario step by step and reports each step on the stream', async () => {
    const events = await watch();
    const started = await post('/api/scenarios/pancakes/play', { mode: 'scripted', pacing: 'step' });
    expect(started.status).toBe(202);
    expect(await post('/api/scenarios/pancakes/play', { mode: 'scripted' })).toMatchObject({ status: 409, body: { error: expect.stringMatching(/still playing/) } });

    const run = () => events.findLast((event) => event.type === 'scenario')?.run;
    for (let step = 0; step < 3; step += 1) {
      await expect.poll(() => run()?.waitingForNext, { timeout: 15_000 }).toBe(true);
      await post('/api/scenarios/next');
      await expect.poll(() => run()?.steps[step]?.status, { timeout: 15_000 }).toBe('passed');
    }
    await expect.poll(() => run()?.status, { timeout: 15_000 }).toBe('passed');
    // Each spoken line of a person was cued first, so the UI could show (and voice) it being said.
    // That includes the spoken answer to the server's question.
    expect(events.filter((event) => event.type === 'cue').map((event) => (event.type === 'cue' ? event.text : ''))).toEqual(['How do I make pancakes?', 'Set a timer for the pancakes.', 'Three seconds']);
    expect((await (await fetch(`${running.url}/api/state`)).json()).run).toMatchObject({ status: 'passed' });

    await post('/api/reset');
    const after = (await (await fetch(`${running.url}/api/state`)).json()) as StageSnapshot;
    expect(after.run).toBeNull();
    expect(after.devices[0]).toMatchObject({ transcript: [], screen: null });
  });

  it('answers unknown things with JSON errors', async () => {
    expect(await post('/api/devices/nope/say', { text: 'hi' })).toMatchObject({ status: 404, body: { error: 'No device "nope".' } });
    expect(await post('/api/devices/display/say', {})).toMatchObject({ status: 400 });
    expect(await post('/api/scenarios/nope/play')).toMatchObject({ status: 404 });
    expect(await post('/api/devices/display/elicitation/none', { action: 'accept' })).toMatchObject({ status: 409 });
    expect((await fetch(`${running.url}/api/nope`)).status).toBe(404);
  });

  it('only answers requests addressed to this machine', async () => {
    const status = (headers: Record<string, string>) =>
      new Promise<number>((resolve, reject) => {
        const req = request(`${running.url}/api/state`, { headers }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on('error', reject);
        req.end();
      });
    expect(await status({})).toBe(200);
    // A page on another site cannot reach the API, whether by a rebinding host name or by a cross-origin request.
    expect(await status({ Host: 'attacker.example' })).toBe(403);
    expect(await status({ Origin: 'https://attacker.example' })).toBe(403);
    // Nor can another page on this machine. Cards run on such an origin (the sandbox proxy's), and must not have the API.
    expect(await status({ Origin: 'http://localhost:5173' })).toBe(403);
    expect(await status({ Origin: `http://127.0.0.1:${running.port + 1}` })).toBe(403);
    expect(await status({ 'Sec-Fetch-Site': 'same-site' })).toBe(403);
    expect(await status({ 'Sec-Fetch-Site': 'cross-site' })).toBe(403);
    // The stage's own page can.
    expect(await status({ Origin: `http://localhost:${running.port}`, 'Sec-Fetch-Site': 'same-origin' })).toBe(200);
    expect(await status({ Origin: `http://127.0.0.1:${running.port}`, Host: `127.0.0.1:${running.port}` })).toBe(200);
  });
});
