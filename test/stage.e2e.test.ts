/**
 * End to end against the built-in example MCP server: a real MCP client over
 * Streamable HTTP, no model. Covers the protocol version, tool calls with
 * structured output, progress, form elicitation, an MCP Apps card, a
 * proactive announcement, skills and the scenario runner.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { loadScenarioFile } from '../src/core/scenario/schema.js';
import type { Stage } from '../src/core/stage.js';
import { join } from 'node:path';
import { exampleConfig, questions, ROOT, speech, startStage, tools } from './helpers.js';

let stage: Stage | undefined;
afterEach(async () => {
  await stage?.close();
  stage = undefined;
});

describe('a stage on the example server', () => {
  it('connects each device over Streamable HTTP and negotiates protocol 2025-11-25 with a session', async () => {
    ({ stage } = await startStage(exampleConfig()));
    for (const device of stage.devices.values()) {
      const [server] = device.snapshot().servers;
      expect(server).toMatchObject({ id: 'kitchen', status: 'connected', protocolVersion: '2025-11-25', era: 'legacy', serverInfo: { name: 'kitchen-helper', title: 'Kitchen helper' } });
      expect(server!.sessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(server!.tools.map((tool) => tool.name)).toEqual(['start_timer', 'find_recipe']);
      expect(server!.tools[0]).toMatchObject({ uiResourceUri: 'ui://example/timer-card.html', readOnly: false });
      expect(server!.tools[1]!.uiResourceUri).toBeUndefined();
      expect(server!.resources).toEqual([{ uri: 'ui://example/timer-card.html', name: 'Timer card', mimeType: 'text/html;profile=mcp-app' }]);
      expect(server!.instructions).toMatch(/Kitchen helper sets timers/);
      expect(server!.events).toMatchObject({ status: 'open' });
      const connection = device.snapshot().timeline.find((entry) => entry.kind === 'connection');
      expect(connection).toMatchObject({ status: 'connected', protocolVersion: '2025-11-25', toolCount: 2 });
    }
    // Two devices, two sessions.
    const sessions = [...stage.devices.values()].map((device) => device.snapshot().servers[0]!.sessionId);
    expect(new Set(sessions).size).toBe(2);
    expect(stage.device('display')!.snapshot().skills).toMatchObject([{ name: 'kitchen-helper', active: false }]);
    expect(stage.device('phone')!.snapshot().skills).toEqual([]);
  });

  it('can also negotiate 2026-07-28 when a server entry asks for "auto"', async () => {
    ({ stage } = await startStage(exampleConfig({ protocol: 'auto' })));
    const [server] = stage.device('display')!.snapshot().servers;
    expect(server).toMatchObject({ status: 'connected', protocolVersion: '2026-07-28', era: 'modern' });
    const { result } = await stage.device('display')!.callTool('find_recipe', { dish: 'tomato soup' }, 'inspector', null);
    expect(result.structuredContent).toMatchObject({ title: 'Tomato soup' });
  });

  it('plays the example scenario: recipe, question, timer card, announcement', async () => {
    ({ stage } = await startStage(exampleConfig()));
    const scenario = loadScenarioFile(join(ROOT, 'scenarios/example/pancakes.yaml'));
    const run = await stage.play(scenario, { mode: 'scripted', reset: true });
    const state = await run.done;
    expect(state.steps.flatMap((step) => [step.error, ...step.checks.filter((check) => !check.ok).map((check) => `${check.label}: ${check.detail}`)]).filter(Boolean)).toEqual([]);
    expect(state.status).toBe('passed');

    const timeline = stage.device('display')!.snapshot().timeline;
    // The skill was loaded on demand, as a model would with load_skill.
    expect(timeline.find((entry) => entry.kind === 'skill')).toMatchObject({ name: 'kitchen-helper', action: 'loaded' });
    expect(stage.device('display')!.snapshot().skills[0]!.active).toBe(true);

    // find_recipe: structured output, progress notifications, no card.
    const [recipe, timer] = tools(timeline);
    expect(recipe).toMatchObject({ name: 'find_recipe', server: 'kitchen', origin: 'assistant', status: 'ok', arguments: { dish: 'pancakes' } });
    expect(recipe!.result!.structuredContent).toMatchObject({ title: 'Pancakes', serves: 4, minutes: 20 });
    expect(recipe!.progress.map((item) => [item.progress, item.total, item.message])).toEqual([
      [1, 3, 'Opening the cookbook'],
      [2, 3, 'Looking through the index'],
      [3, 3, 'Reading the recipe'],
    ]);
    expect(recipe!.durationMs).toBeGreaterThanOrEqual(500);

    // start_timer had no duration: the server asked by form elicitation, and the scenario answered by voice.
    expect(questions(timeline)).toMatchObject([{ server: 'kitchen', message: 'How long should the timer run?', status: 'accept', content: { duration: '3' }, answeredBy: 'scenario', heard: 'Three seconds' }]);
    expect(questions(timeline)[0]!.requestedSchema).toMatchObject({ type: 'object', required: ['duration'] });
    expect(timer).toMatchObject({ name: 'start_timer', status: 'ok', uiResourceUri: 'ui://example/timer-card.html' });
    expect(timer!.result!.structuredContent).toMatchObject({ label: 'pancakes', seconds: 3, status: 'running' });

    // The card was read from the server as an MCP Apps resource and put on the screen with the tool result.
    expect(timeline.find((entry) => entry.kind === 'resource')).toMatchObject({ uri: 'ui://example/timer-card.html', mimeType: 'text/html;profile=mcp-app' });
    const screen = stage.device('display')!.currentScreen()!;
    expect(screen.card).toMatchObject({ uri: 'ui://example/timer-card.html', mimeType: 'text/html;profile=mcp-app' });
    expect(screen.card!.html).toContain('ui/initialize');
    expect(screen.result.structuredContent).toMatchObject({ label: 'pancakes' });

    // The timer finished: a server-sent event became a spoken announcement, on the display only.
    const event = timeline.find((entry) => entry.kind === 'event' && entry.name === 'timer.done');
    expect(event).toMatchObject({ channel: 'sse', server: 'kitchen', matched: 'timer.done' });
    expect(speech(timeline).filter((entry) => entry.reason === 'announcement').map((entry) => entry.text)).toEqual(['Your pancakes timer is done.']);
    expect(speech(timeline).map((entry) => entry.reason)).toEqual(['reply', 'question', 'reply', 'announcement']);
    // The phone gets the same event on its own stream, but no rule tells it to announce it.
    await expect.poll(() => stage!.device('phone')!.snapshot().timeline.some((entry) => entry.kind === 'event' && entry.name === 'timer.done')).toBe(true);
    expect(speech(stage.device('phone')!.snapshot().timeline)).toEqual([]);
    // The same news also arrived as a notification on the MCP connection itself.
    await expect
      .poll(() => stage!.device('display')!.snapshot().timeline.find((entry) => entry.kind === 'event' && entry.channel === 'mcp'))
      .toMatchObject({ name: 'notifications/message', data: { level: 'info', data: { event: 'timer.done' } } });
  });

  it('answers free speech in scripted mode by matching the lines of loaded scenarios', async () => {
    ({ stage } = await startStage(exampleConfig()));
    const phone = stage.device('phone')!;
    // The line was written for the display; the phone has the same tools, so it can replay it.
    const record = await phone.hear('how do i make pancakes');
    expect(tools(record.entries).map((entry) => entry.name)).toEqual(['find_recipe']);
    expect(speech(record.entries)[0]!.text).toMatch(/Pancakes takes about 20 minutes/);
    expect(phone.currentScreen()).toMatchObject({ tool: { name: 'find_recipe' } });
    // No card is linked from find_recipe, so the screen draws its default card.
    expect(phone.currentScreen()!.card).toBeUndefined();

    const lost = await phone.hear('What is the meaning of life?');
    expect(tools(lost.entries)).toEqual([]);
    expect(speech(lost.entries)[0]!.text).toMatch(/I'm running without a model/);
  });

  it('declines a question when nobody is there to answer, and reports tool errors without throwing', async () => {
    ({ stage } = await startStage(exampleConfig()));
    const display = stage.device('display')!;
    const unanswered = await display.callTool('start_timer', { label: 'tea' }, 'inspector', null);
    expect(unanswered.result.isError).toBe(true);
    expect(unanswered.outcome.text).toMatch(/no duration was given/);
    expect(questions(display.snapshot().timeline)).toMatchObject([{ status: 'decline', answeredBy: 'timeout' }]);

    const missing = await display.callTool('find_recipe', { dish: 'lasagne' }, 'inspector', null);
    expect(missing.entry).toMatchObject({ status: 'error' });
    expect(missing.outcome).toMatchObject({ isError: true, text: expect.stringMatching(/no recipe for "lasagne"/) });

    const unknown = await display.callTool('launch_rocket', {}, 'inspector', null);
    expect(unknown.outcome.text).toMatch(/no tool called "launch_rocket". Available tools: start_timer, find_recipe/);

    const invalid = await display.callTool('start_timer', { seconds: 'soon' }, 'inspector', null);
    expect(invalid.outcome.isError).toBe(true);
  });

  it('takes an answer given on the screen, and lets a card call tools on its own server', async () => {
    ({ stage } = await startStage(exampleConfig()));
    // A browser is watching, so a question waits for a person.
    stage.subscribe(() => undefined, { speaks: true });
    const display = stage.device('display')!;
    const turn = display.hear('Set a timer for the pancakes.', { scripted: true });
    await expect.poll(() => display.snapshot().elicitation?.message).toBe('How long should the timer run?');
    expect(display.snapshot().status).toBe('asking');
    const pending = display.snapshot().elicitation!;
    expect(display.answerElicitation('not-this-one', { action: 'accept', content: {} })).toBe(false);
    expect(display.answerElicitation(pending.id, { action: 'accept', content: { duration: '60' } })).toBe(true);
    // The device is "speaking" until a browser says it has finished each line.
    const drain = setInterval(() => display.snapshot().transcript.forEach((line) => display.speechDone(line.id)), 10);
    const record = await turn;
    clearInterval(drain);
    expect(questions(record.entries)[0]).toMatchObject({ status: 'accept', answeredBy: 'screen', content: { duration: '60' } });
    expect(tools(record.entries)[0]!.result!.structuredContent).toMatchObject({ seconds: 60 });
    const shown = display.currentScreen()!;
    expect(shown.card!.uri).toBe('ui://example/timer-card.html');

    // The card's "Start again" button: a tools/call through the host, on the card's server.
    const again = await display.callServerTool('kitchen', 'start_timer', { label: 'pancakes', seconds: 2 }, 'card');
    expect(again.structuredContent).toMatchObject({ label: 'pancakes', seconds: 2 });
    const cardCall = tools(display.snapshot().timeline).at(-1)!;
    expect(cardCall).toMatchObject({ name: 'start_timer', origin: 'card', status: 'ok' });
    // The card keeps the screen; its state is remembered under the same screen id.
    expect(display.currentScreen()).toMatchObject({ id: shown.id, result: { structuredContent: { seconds: 2 } } });
    expect((await display.callServerTool('kitchen', 'nope', {}, 'card')).isError).toBe(true);
    const read = (await display.readResource('kitchen', 'ui://example/timer-card.html')) as { contents: Array<{ mimeType: string }> };
    expect(read.contents[0]!.mimeType).toBe('text/html;profile=mcp-app');
  });

  it('holds an announcement behind the indicator until asked, when a device is set up that way', async () => {
    const config = exampleConfig({
      devices: [{ id: 'speaker', kind: 'speaker', person: 'Jo', servers: ['kitchen'], announcements: { mode: 'indicator' } }],
      announce: [{ on: 'timer.done', say: 'Your {{timer.label}} timer is done.' }],
    });
    ({ stage } = await startStage(config));
    stage.subscribe(() => undefined, { speaks: true });
    const speaker = stage.device('speaker')!;
    const drain = setInterval(() => speaker.snapshot().transcript.forEach((line) => speaker.speechDone(line.id)), 10);
    await speaker.callTool('start_timer', { label: 'tea', seconds: 1 }, 'inspector', null);
    // A speaker has no screen.
    expect(speaker.currentScreen()).toBeNull();
    await expect.poll(() => speaker.snapshot().notification?.state, { timeout: 4000 }).toBe('pending');
    expect(speech(speaker.snapshot().timeline)).toEqual([]);
    // It can still be used while the notification waits.
    const other = await speaker.hear('How do I make pancakes?', { scripted: true });
    expect(tools(other.entries).map((entry) => entry.name)).toEqual(['find_recipe']);
    expect(speaker.snapshot().notification?.state).toBe('pending');

    const played = await speaker.hear('What are my notifications?');
    clearInterval(drain);
    expect(speech(played.entries).map((entry) => [entry.reason, entry.text])).toEqual([['announcement', 'Your tea timer is done.']]);
    expect(speaker.snapshot().notification?.state).toBe('done');
  });

  it('reports a server that is not there, and carries on', async () => {
    const config = exampleConfig();
    config.devices[1]!.servers = [{ id: 'gone', url: 'http://127.0.0.1:9/mcp', protocol: 'legacy', headers: {} }];
    ({ stage } = await startStage(config));
    expect(stage.device('display')!.snapshot().servers[0]!.status).toBe('connected');
    const [server] = stage.device('phone')!.snapshot().servers;
    expect(server).toMatchObject({ status: 'error', error: expect.stringMatching(/Could not reach http:\/\/127\.0\.0\.1:9\/mcp\. Is the MCP server running\?/) });
    expect(stage.device('phone')!.snapshot().timeline.find((entry) => entry.kind === 'connection')).toMatchObject({ status: 'error' });
  });

  it('fails a live scenario clearly when no model provider is configured', async () => {
    ({ stage } = await startStage(exampleConfig()));
    const scenario = loadScenarioFile(join(ROOT, 'scenarios/example/pancakes.yaml'));
    const state = await (await stage.play(scenario, { mode: 'live' })).done;
    expect(state.status).toBe('failed');
    expect(state.steps[0]!.error).toMatch(/Live mode needs a model provider, but this device uses "scripted"/);
    expect(state.steps.slice(1).every((step) => step.status === 'skipped')).toBe(true);
  });

  it('tells the person when the configured provider cannot run', async () => {
    const config = exampleConfig();
    config.devices[0]!.assistant = { provider: 'openai-compatible' };
    ({ stage } = await startStage(config));
    const display = stage.device('display')!;
    expect(display.snapshot().provider).toMatchObject({ id: 'openai-compatible', ready: false, error: expect.stringMatching(/needs a base URL/) });
    const record = await display.hear('Hello?');
    expect(record.error).toMatch(/needs a base URL/);
    expect(speech(record.entries)[0]!.text).toMatch(/needs a base URL/);
    // A scripted scenario still plays on that device.
    const scenario = loadScenarioFile(join(ROOT, 'scenarios/example/pancakes.yaml'));
    expect((await (await stage.play(scenario, { mode: 'scripted', reset: true })).done).status).toBe('passed');
  });
});
