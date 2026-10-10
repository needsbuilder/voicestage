import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/core/config.js';
import { McpConnection } from '../src/core/mcp.js';
import { loadScenarioFile } from '../src/core/scenario/schema.js';
import type { Stage } from '../src/core/stage.js';
import { startExampleServer, type ExampleServer } from '../src/example-server/server.js';
import type { ServerSnapshot } from '../src/shared/types.js';
import { ROOT, startStage, tools } from './helpers.js';

/**
 * A developer restarts their MCP server all the time. The stage must not need
 * restarting with it.
 */
describe('an MCP connection when the server goes away and comes back', () => {
  let server: ExampleServer | undefined;
  let connection: McpConnection | undefined;

  afterEach(async () => {
    await connection?.close();
    await server?.close();
    connection = undefined;
    server = undefined;
  });

  const title = async () => ((await connection!.callTool('find_recipe', { dish: 'pancakes' })).structuredContent as { title: string }).title;

  /** `idleCheckMs: 0` checks before every request; a large value never checks, so the request itself meets the restarted server. */
  async function connected(idleCheckMs = 0): Promise<{ port: number; reconnections: ServerSnapshot[] }> {
    server = await startExampleServer({ port: 0 });
    const reconnections: ServerSnapshot[] = [];
    connection = new McpConnection({ id: 'kitchen', url: server.url, idleCheckMs, onReconnect: (snapshot) => reconnections.push(snapshot) });
    await connection.connect();
    return { port: server.port, reconnections };
  }

  it('notices a restarted server before the next request and starts a new session', async () => {
    const { port, reconnections } = await connected();
    expect(await title()).toBe('Pancakes');
    const firstSession = connection!.snapshot().sessionId;
    expect(firstSession).toBeTruthy();

    await server!.close();
    server = await startExampleServer({ port });

    // The connection still believes in its old session.
    expect(connection!.snapshot().status).toBe('connected');
    expect(await title()).toBe('Pancakes');
    expect(reconnections).toHaveLength(1);
    expect(reconnections[0]).toMatchObject({ status: 'connected', protocolVersion: '2025-11-25' });
    expect(connection!.snapshot().sessionId).not.toBe(firstSession);
  });

  it('starts a new session and sends the request again when the server answers that the session is unknown', async () => {
    const { reconnections } = await connected(60_000);
    const firstSession = connection!.snapshot().sessionId!;
    // End the session behind the connection's back, as an expiry or a restart would.
    const ended = await fetch(server!.url, { method: 'DELETE', headers: { 'mcp-session-id': firstSession, 'mcp-protocol-version': '2025-11-25' } });
    expect(ended.ok).toBe(true);

    // No check comes first here (the idle time is a minute), so the request itself gets the 404.
    expect(await title()).toBe('Pancakes');
    expect(reconnections).toHaveLength(1);
    expect(connection!.snapshot().sessionId).not.toBe(firstSession);
  });

  it('says plainly that the server is unreachable, then connects again once it is back', async () => {
    const { port, reconnections } = await connected();
    await server!.close();
    server = undefined;

    await expect(title()).rejects.toThrow(/Could not reach http:\/\/localhost:\d+\/mcp \(E[A-Z]+\)\. Is the MCP server running\?/);
    expect(connection!.snapshot()).toMatchObject({ status: 'error', error: expect.stringContaining('Is the MCP server running?') });
    // Still down: the next request tries to connect, and reports the same thing.
    await expect(title()).rejects.toThrow(/Could not reach .*Is the MCP server running\?/);
    expect(reconnections).toHaveLength(0);

    server = await startExampleServer({ port });
    expect(await title()).toBe('Pancakes');
    expect(reconnections).toHaveLength(1);
    expect(connection!.snapshot().status).toBe('connected');
  });

  it('shares one reconnection between requests that fail together', async () => {
    const { port, reconnections } = await connected();
    await server!.close();
    server = await startExampleServer({ port });
    expect(await Promise.all([title(), title(), title()])).toEqual(['Pancakes', 'Pancakes', 'Pancakes']);
    expect(reconnections).toHaveLength(1);
  });

  it('connects before a turn when the server was not running at startup', async () => {
    server = await startExampleServer({ port: 0 });
    const { port, url } = server;
    await server.close();
    server = undefined;
    connection = new McpConnection({ id: 'kitchen', url });
    await expect(connection.connect()).rejects.toThrow(/Could not reach/);
    await connection.ensure(); // still down: no throw, status says why
    expect(connection.snapshot()).toMatchObject({ status: 'error', tools: [] });

    server = await startExampleServer({ port });
    await connection.ensure();
    expect(connection.snapshot()).toMatchObject({ status: 'connected' });
    expect(connection.snapshot().tools.map((tool) => tool.name).sort()).toEqual(['find_recipe', 'start_timer']);
  });

  it('stays closed after close()', async () => {
    await connected();
    await connection!.close();
    await connection!.ensure();
    expect(connection!.snapshot().status).toBe('closed');
    await expect(title()).rejects.toThrow(/Not connected to "kitchen"/);
  });
});

describe('a stage whose MCP server is restarted', () => {
  let server: ExampleServer | undefined;
  let stage: Stage | undefined;

  afterEach(async () => {
    await stage?.close();
    await server?.close();
    stage = undefined;
    server = undefined;
  });

  it('plays the same scenario again without being restarted itself', async () => {
    server = await startExampleServer({ port: 0 });
    const { port } = server;
    const config = resolveConfig(
      {
        name: 'Someone else\'s server',
        servers: { kitchen: { url: server.url, events: { url: server.eventsUrl, announce: [{ on: 'timer.done', devices: ['display'], say: 'Your {{timer.label}} timer is done.' }] } } },
        devices: [{ id: 'display', name: 'Kitchen display', kind: 'display', person: 'Alex', servers: ['kitchen'] }],
      },
      { baseDir: ROOT, env: {} },
    );
    ({ stage } = await startStage(config));
    const scenario = loadScenarioFile(join(ROOT, 'scenarios/example/pancakes.yaml'));
    const display = stage.device('display')!;
    const session = () => display.snapshot().servers[0]!.sessionId;

    expect((await (await stage.play(scenario, { mode: 'scripted', reset: true })).done).status).toBe('passed');
    const firstSession = session();

    await server.close();
    server = await startExampleServer({ port });

    const again = await (await stage.play(scenario, { mode: 'scripted', reset: true })).done;
    expect(again.status).toBe('passed');
    expect(session()).not.toBe(firstSession);
    const timeline = display.snapshot().timeline;
    // The inspector shows the new connection, and every tool call of the second run succeeded.
    expect(timeline.filter((entry) => entry.kind === 'connection' && entry.status === 'connected').length).toBeGreaterThanOrEqual(2);
    expect(tools(timeline).map((entry) => entry.status)).toEqual(['ok', 'ok']);
  });
});

