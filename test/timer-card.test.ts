/**
 * The example server's MCP Apps card, driven by the official host
 * implementation (`AppBridge`), the same one the Voicestage UI uses. The card
 * runs in jsdom; its tool call goes to a real example server.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { AppBridge } from '@modelcontextprotocol/ext-apps/app-bridge';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startExampleServer, type ExampleServer } from '../src/example-server/server.js';
import { withCsp } from '../src/shared/card-html.js';

let server: ExampleServer;
let client: Client;
let dom: JSDOM | undefined;

beforeEach(async () => {
  server = await startExampleServer({ port: 0 });
  client = new Client({ name: 'card-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
});
afterEach(async () => {
  dom?.window.close();
  dom = undefined;
  await client.close();
  await server.close();
});

async function until(test: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!test()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('example timer card', () => {
  it('is served as an MCP Apps resource and linked from start_timer', async () => {
    const tool = (await client.listTools()).tools.find((candidate) => candidate.name === 'start_timer')!;
    expect((tool._meta as { ui: { resourceUri: string } }).ui.resourceUri).toBe('ui://example/timer-card.html');
    const resource = await client.readResource({ uri: 'ui://example/timer-card.html' });
    expect(resource.contents[0]).toMatchObject({ mimeType: 'text/html;profile=mcp-app' });
    const html = (resource.contents[0] as { text: string }).text;
    // Self-contained: nothing is fetched, linked or framed.
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/<link|<img|<iframe|\bfetch\(|XMLHttpRequest/i);
  });

  it('shakes hands with the host bridge, shows a tool result, and calls start_timer through the host', async () => {
    const html = ((await client.readResource({ uri: 'ui://example/timer-card.html' })).contents[0] as { text: string }).text;
    const fromCard: unknown[] = [];
    let deliver: ((message: unknown) => void) | undefined;
    // The same document the UI loads: the card with the sandbox policy in its head.
    dom = new JSDOM(withCsp(html, undefined), {
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      url: 'https://card.invalid/',
      beforeParse(window) {
        // In jsdom the top window is its own parent, so what the card posts to its host arrives here.
        window.addEventListener('message', (event: MessageEvent) => {
          if (event.source) return;
          if (deliver) deliver(event.data);
          else fromCard.push(event.data);
        });
      },
    });
    const { window } = dom;
    const transport = {
      onmessage: undefined as ((message: unknown) => void) | undefined,
      onclose: undefined as (() => void) | undefined,
      onerror: undefined as ((error: Error) => void) | undefined,
      async start() {
        deliver = (message) => this.onmessage?.(message);
        fromCard.splice(0).forEach((message) => this.onmessage?.(message));
      },
      async send(message: unknown) {
        window.dispatchEvent(new window.MessageEvent('message', { data: message, source: window.parent }));
      },
      async close() {
        deliver = undefined;
      },
    };

    const calls: Array<{ name: string; arguments?: unknown }> = [];
    const sizes: Array<{ width?: number; height?: number }> = [];
    const bridge = new AppBridge(null, { name: 'test-host', version: '1.0.0' }, { serverTools: {} });
    bridge.oncalltool = async (params) => {
      calls.push({ name: params.name, arguments: params.arguments });
      return (await client.callTool({ name: params.name, arguments: params.arguments })) as never;
    };
    bridge.onsizechange = (params) => void sizes.push(params);
    const initialized = new Promise<void>((resolve) => {
      bridge.oninitialized = () => resolve();
    });
    await bridge.connect(transport as never);
    await initialized;
    expect(bridge.getAppVersion()).toMatchObject({ name: 'example-timer-card' });

    const started = await client.callTool({ name: 'start_timer', arguments: { label: 'tea', seconds: 1 } });
    await bridge.sendToolResult(started as never);
    const text = (id: string) => window.document.getElementById(id)!.textContent;
    await until(() => text('label') === 'tea', 'the card to show the timer');
    expect(text('status')).toBe('Running');
    expect(text('time')).toMatch(/^00:0[01]$/);
    const again = window.document.getElementById('again') as HTMLButtonElement;
    expect(again.hidden).toBe(true);

    await until(() => text('status') === 'Done.', 'the countdown to finish');
    expect(again.hidden).toBe(false);
    again.click();
    await until(() => text('status') === 'Running', 'the timer to start again');
    expect(calls).toEqual([{ name: 'start_timer', arguments: { label: 'tea', seconds: 1 } }]);
    expect(sizes.length).toBeGreaterThan(0);

    // A tool error is shown as text rather than a broken card.
    await bridge.sendToolResult({ isError: true, content: [{ type: 'text', text: 'Error (no_duration): No timer was started.' }] } as never);
    await until(() => text('label') === 'No timer', 'the error state');
    expect(text('status')).toBe('Error (no_duration): No timer was started.');
  });
});
