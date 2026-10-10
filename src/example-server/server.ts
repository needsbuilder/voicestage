/**
 * The built-in example MCP server: "Kitchen helper".
 *
 * Two toy tools, so Voicestage has something to talk to out of the box, and so
 * there is a short, readable example of each feature the simulator supports:
 *
 *   start_timer   returns structured output and links an MCP Apps card;
 *                 asks "how long?" by form elicitation when no duration is
 *                 given; when the timer ends, sends a `timer.done` event on
 *                 /events and a logging notification on the MCP connection
 *   find_recipe   sends progress notifications, returns structured output
 *                 with no card (the simulator draws its default card)
 *
 * Streamable HTTP at /mcp. Protocol 2025-11-25 with sessions, and 2026-07-28
 * statelessly. No authentication: it only listens on localhost.
 */
import { randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { NodeStreamableHTTPServerTransport, toNodeHandler, toWebRequest } from '@modelcontextprotocol/node';
import { createMcpHandler, inputRequired, inputResponse, isInitializeRequest, isLegacyRequest, McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { TIMER_CARD_HTML, TIMER_CARD_URI } from './timer-card.js';

interface Timer {
  timer_id: string;
  label: string;
  seconds: number;
  started_at: string;
  ends_at: string;
  status: 'running' | 'done';
}

interface Recipe {
  title: string;
  serves: number;
  minutes: number;
  ingredients: string[];
  steps: string[];
}

const COOKBOOK: Record<string, Recipe> = {
  pancakes: {
    title: 'Pancakes',
    serves: 4,
    minutes: 20,
    ingredients: ['1 1/2 cups flour', '1 tablespoon baking powder', '1 tablespoon sugar', '1 1/4 cups milk', '1 egg', '3 tablespoons melted butter', 'A pinch of salt'],
    steps: ['Whisk the dry ingredients together.', 'Stir in the milk, egg and butter until just combined.', 'Cook a ladleful at a time over medium heat, about 3 minutes a side.'],
  },
  'tomato soup': {
    title: 'Tomato soup',
    serves: 4,
    minutes: 35,
    ingredients: ['2 tablespoons olive oil', '1 onion, chopped', '2 cloves garlic', '2 cans whole tomatoes', '2 cups vegetable stock', 'Salt and pepper'],
    steps: ['Soften the onion and garlic in the oil.', 'Add the tomatoes and stock and simmer for 20 minutes.', 'Blend until smooth and season to taste.'],
  },
  'soft-boiled eggs': {
    title: 'Soft-boiled eggs',
    serves: 2,
    minutes: 10,
    ingredients: ['4 eggs', 'Water', 'Salt'],
    steps: ['Bring a pan of water to a gentle boil.', 'Lower the eggs in and cook for 6 minutes.', 'Cool under running water for 30 seconds, then peel.'],
  },
};

const DURATION_OPTIONS = [
  { const: '3', title: '3 seconds' },
  { const: '60', title: '1 minute' },
  { const: '180', title: '3 minutes' },
  { const: '300', title: '5 minutes' },
  { const: '600', title: '10 minutes' },
];

function spoken(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes} minute${minutes === 1 ? '' : 's'}${rest ? ` and ${rest} second${rest === 1 ? '' : 's'}` : ''}`;
}

function ok(structured: object, text: string): CallToolResult {
  return { content: [{ type: 'text', text }], structuredContent: structured as Record<string, unknown> };
}

function fail(code: string, message: string): CallToolResult {
  return { content: [{ type: 'text', text: `Error (${code}): ${message}` }], isError: true };
}

export interface ExampleServerOptions {
  port?: number;
  host?: string;
  log?: (line: string) => void;
}

export interface ExampleServer {
  url: string;
  eventsUrl: string;
  port: number;
  close(): Promise<void>;
}

export async function startExampleServer(options: ExampleServerOptions = {}): Promise<ExampleServer> {
  const host = options.host ?? '127.0.0.1';
  const log = options.log ?? (() => undefined);
  const timers = new Map<string, Timer>();
  const pendingTimeouts = new Set<NodeJS.Timeout>();
  const streams = new Set<Response>();
  const sessions = new Map<string, { transport: NodeStreamableHTTPServerTransport; server: McpServer }>();
  let eventId = 0;

  const broadcast = (name: string, data: unknown): void => {
    eventId += 1;
    for (const stream of streams) stream.write(`id: ${eventId}\nevent: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    // The same news as an MCP logging notification, for clients that listen on the connection instead.
    for (const session of sessions.values()) {
      void session.server.sendLoggingMessage({ level: 'info', logger: 'kitchen-helper', data: { event: name, ...(data as object) } }).catch(() => undefined);
    }
  };

  const startTimer = (label: string, seconds: number): Timer => {
    const now = Date.now();
    const timer: Timer = { timer_id: `timer_${randomUUID().slice(0, 8)}`, label, seconds, started_at: new Date(now).toISOString(), ends_at: new Date(now + seconds * 1000).toISOString(), status: 'running' };
    timers.set(timer.timer_id, timer);
    const timeout = setTimeout(() => {
      pendingTimeouts.delete(timeout);
      timer.status = 'done';
      log(`timer done: ${timer.label}`);
      broadcast('timer.done', { timer });
    }, seconds * 1000);
    pendingTimeouts.add(timeout);
    return timer;
  };

  const buildServer = (): McpServer => {
    const server = new McpServer(
      { name: 'kitchen-helper', title: 'Kitchen helper', version: '0.1.0', description: 'A tiny example MCP server that ships with Voicestage: a timer and a three-recipe cookbook.' },
      {
        capabilities: { tools: {}, resources: {}, logging: {} },
        instructions: 'Kitchen helper sets timers and looks up recipes from a very small cookbook. Use start_timer for anything about timing. If the person gives no duration, leave seconds out and the tool will ask them. Use find_recipe for how to cook something.',
      },
    );

    registerAppTool(
      server,
      'start_timer',
      {
        title: 'Start a timer',
        description: 'Start a kitchen timer. Give the duration in seconds; leave it out if the person did not say how long, and the tool will ask them. When the timer ends, the server sends a "timer.done" event.',
        inputSchema: z.object({
          label: z.string().trim().min(1).max(40).optional().describe('What the timer is for, for example "pasta". Defaults to "kitchen".'),
          seconds: z.number().int().min(1).max(7200).optional().describe('Duration in seconds. 3 minutes is 180.'),
        }),
        outputSchema: z.object({
          timer_id: z.string(),
          label: z.string(),
          seconds: z.number(),
          started_at: z.string(),
          ends_at: z.string(),
          status: z.enum(['running', 'done']),
          say_to_user: z.string(),
        }),
        annotations: { title: 'Start a timer', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        _meta: { ui: { resourceUri: TIMER_CARD_URI } },
      },
      async (args, ctx) => {
        let seconds = args.seconds;
        if (seconds === undefined) {
          const answer = inputResponse(ctx.mcpReq.inputResponses, 'duration');
          if (answer.kind === 'elicit') {
            const chosen = answer.action === 'accept' ? Number((answer.content as Record<string, unknown> | undefined)?.duration) : Number.NaN;
            if (!Number.isFinite(chosen) || chosen <= 0) return fail('no_duration', 'No timer was started, because no duration was given.');
            seconds = chosen;
          } else {
            const elicitation = server.server.getClientCapabilities()?.elicitation;
            const canAsk = elicitation !== undefined && (Object.keys(elicitation).length === 0 || 'form' in elicitation);
            if (!canAsk) return fail('duration_required', 'How long should the timer run? Ask the person, then call start_timer again with seconds.');
            // MCP form elicitation: one question with a fixed list of answers.
            return inputRequired({
              inputRequests: {
                duration: inputRequired.elicit({
                  message: 'How long should the timer run?',
                  requestedSchema: { type: 'object', properties: { duration: { type: 'string', title: 'Duration', oneOf: DURATION_OPTIONS } }, required: ['duration'] },
                }),
              },
            });
          }
        }
        const timer = startTimer(args.label ?? 'kitchen', seconds);
        const say = `Your ${timer.label} timer is set for ${spoken(timer.seconds)}.`;
        return ok({ ...timer, say_to_user: say }, `${say}\n\ntimer_id: ${timer.timer_id} | ends_at: ${timer.ends_at}`);
      },
    );

    server.registerTool(
      'find_recipe',
      {
        title: 'Find a recipe',
        description: `Look up a recipe in the cookbook. It only knows: ${Object.keys(COOKBOOK).join(', ')}.`,
        inputSchema: z.object({ dish: z.string().trim().min(1).describe('What to cook, for example "pancakes".') }),
        outputSchema: z.object({ title: z.string(), serves: z.number(), minutes: z.number(), ingredients: z.array(z.string()), steps: z.array(z.string()), say_to_user: z.string() }),
        annotations: { title: 'Find a recipe', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (args, ctx) => {
        const progressToken = ctx.mcpReq._meta?.progressToken;
        const stages = ['Opening the cookbook', 'Looking through the index', 'Reading the recipe'];
        for (const [index, message] of stages.entries()) {
          if (progressToken !== undefined) {
            await ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken, progress: index + 1, total: stages.length, message } }).catch(() => undefined);
          }
          await new Promise((resolve) => setTimeout(resolve, 180));
        }
        const wanted = args.dish.toLowerCase();
        const key = Object.keys(COOKBOOK).find((name) => wanted.includes(name) || name.includes(wanted) || wanted.includes(name.split(' ').at(-1)!.replace(/s$/, '')));
        if (!key) return fail('not_found', `The cookbook has no recipe for "${args.dish}". It only knows: ${Object.keys(COOKBOOK).join(', ')}.`);
        const recipe = COOKBOOK[key]!;
        const say = `${recipe.title} takes about ${recipe.minutes} minutes and serves ${recipe.serves}. I've put the recipe on the screen.`;
        return ok({ ...recipe, say_to_user: say }, `${say}\n\nIngredients: ${recipe.ingredients.join('; ')}\nSteps: ${recipe.steps.join(' ')}`);
      },
    );

    registerAppResource(
      server,
      'Timer card',
      TIMER_CARD_URI,
      { description: 'A countdown for one timer, with a button that starts it again through the host.', _meta: { ui: { prefersBorder: false } } },
      () => ({ contents: [{ uri: TIMER_CARD_URI, mimeType: RESOURCE_MIME_TYPE, text: TIMER_CARD_HTML, _meta: { ui: { prefersBorder: false } } }] }),
    );
    return server;
  };

  const app = createMcpExpressApp({ host, jsonLimit: '256kb' });
  app.disable('x-powered-by');

  app.get('/', (_req, res) => {
    res.json({ name: 'Kitchen helper', about: 'Example MCP server that ships with Voicestage.', mcp: '/mcp', events: '/events' });
  });

  app.get('/events', (req: Request, res: Response) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
    res.write(`retry: 2000\n\nevent: ready\ndata: ${JSON.stringify({ server: 'kitchen-helper', time: new Date().toISOString() })}\n\n`);
    const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
    streams.add(res);
    req.on('close', () => {
      clearInterval(heartbeat);
      streams.delete(res);
    });
  });

  const modern = createMcpHandler(() => buildServer(), { legacy: 'reject', onerror: (error) => log(`mcp: ${error.message}`) });
  const modernNode = toNodeHandler(modern, { onerror: (error) => log(`mcp: ${error.message}`) });

  app.all('/mcp', async (req: Request, res: Response) => {
    try {
      const body: unknown = req.method === 'POST' ? req.body : undefined;
      if (!(await isLegacyRequest(await toWebRequest(req, body), body))) {
        await modernNode(req, res, body);
        return;
      }
      // 2025-era clients: one transport and one server per session.
      const header = req.headers['mcp-session-id'];
      const sid = Array.isArray(header) ? header[0] : header;
      let session = sid ? sessions.get(sid) : undefined;
      if (sid && !session) {
        res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found. Send a new initialize request.' }, id: null });
        return;
      }
      if (!session) {
        const messages = Array.isArray(body) ? body : [body];
        if (req.method !== 'POST' || !messages.some((message) => isInitializeRequest(message))) {
          res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Start with an initialize request, then send the Mcp-Session-Id header it returns.' }, id: null });
          return;
        }
        const server = buildServer();
        const transport = new NodeStreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, created);
          },
          onsessionclosed: (id) => {
            sessions.delete(id);
          },
        });
        const created = { transport, server };
        session = created;
        await server.connect(transport);
      }
      await session.transport.handleRequest(req, res, body);
    } catch (error) {
      log(`mcp: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error.' }, id: null });
    }
  });

  const http: HttpServer = await new Promise((resolve, reject) => {
    const listening = app.listen(options.port ?? 4701, host, () => resolve(listening));
    listening.once('error', reject);
  });
  const { port } = http.address() as AddressInfo;
  const base = `http://localhost:${port}`;
  return {
    url: `${base}/mcp`,
    eventsUrl: `${base}/events`,
    port,
    async close() {
      for (const timeout of pendingTimeouts) clearTimeout(timeout);
      for (const stream of streams) stream.end();
      streams.clear();
      const open = [...sessions.values()];
      sessions.clear();
      await Promise.allSettled(open.map((session) => session.server.close()));
      await modern.close().catch(() => undefined);
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
