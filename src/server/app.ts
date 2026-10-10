/**
 * The HTTP side of a stage: a small JSON API, one server-sent events stream
 * that carries everything a UI needs, and the UI itself.
 *
 * It only ever listens on localhost. Requests are checked for a local `Host`
 * (and `Origin`, when a browser sends one), because the API can make tool
 * calls with the tokens in your configuration.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { JsonObject, StageEvent, ToolOrigin, UtteranceSource } from '../shared/types.js';
import { estimateSpeechMs } from '../core/device.js';
import { errorMessage } from '../core/mcp.js';
import type { Stage } from '../core/stage.js';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function isLocal(value: string | undefined, isOrigin: boolean): boolean {
  if (!value) return !isOrigin;
  try {
    const hostname = isOrigin ? new URL(value).hostname : new URL(`http://${value}`).hostname;
    return LOCAL_HOSTS.has(hostname) || LOCAL_HOSTS.has(`[${hostname}]`);
  } catch {
    return false;
  }
}

export interface StageAppOptions {
  stage: Stage;
  /** Folder with the built UI (`dist/ui`). */
  uiDir?: string;
  /** Vite dev middleware, in development. */
  devMiddleware?: (req: Request, res: Response, next: NextFunction) => void;
  log?: (line: string) => void;
}

export function createStageApp(options: StageAppOptions): Express {
  const { stage } = options;
  const log = options.log ?? (() => undefined);
  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    if (!isLocal(req.headers.host, false) || (req.headers.origin !== undefined && !isLocal(req.headers.origin, true))) {
      res.status(403).json({ error: 'Voicestage only answers requests from this machine.' });
      return;
    }
    next();
  });
  app.use('/api', express.json({ limit: '1mb' }));

  const deviceOf = (req: Request, res: Response) => {
    const device = stage.device(String(req.params.id));
    if (!device) res.status(404).json({ error: `No device "${String(req.params.id)}".` });
    return device;
  };
  const body = (req: Request): JsonObject => (req.body && typeof req.body === 'object' ? (req.body as JsonObject) : {});

  // Cues: a scenario asks the UI to show (and voice) a person's line, and waits until it has.
  const cues = new Map<string, () => void>();
  const cue = (deviceId: string, text: string): Promise<void> =>
    new Promise((resolve) => {
      const id = randomUUID();
      const done = () => {
        if (!cues.delete(id)) return;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, estimateSpeechMs(text) * 1.5 + 2500);
      cues.set(id, done);
      stage.emit({ type: 'cue', id, deviceId, text });
    });

  app.get('/api/state', (_req, res) => {
    res.json(stage.snapshot());
  });

  app.get('/api/stream', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const send = (event: StageEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    res.write('retry: 1500\n\n');
    send({ type: 'snapshot', stage: stage.snapshot() });
    const unsubscribe = stage.subscribe(send, { speaks: req.query.speaks !== '0' });
    const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  app.post('/api/devices/:id/say', (req, res) => {
    const device = deviceOf(req, res);
    if (!device) return;
    const text = typeof body(req).text === 'string' ? (body(req).text as string) : '';
    if (!text.trim()) {
      res.status(400).json({ error: 'Give the words to say as "text".' });
      return;
    }
    const source = (['voice', 'typed', 'card'] as const).find((item) => item === body(req).source) ?? 'typed';
    // The turn runs on; its progress arrives on the stream.
    void device.hear(text, { source: source as UtteranceSource }).catch((error: unknown) => log(`turn failed: ${errorMessage(error)}`));
    res.status(202).json({ ok: true });
  });

  app.post('/api/devices/:id/speech/:speechId/done', (req, res) => {
    const device = deviceOf(req, res);
    if (!device) return;
    device.speechDone(String(req.params.speechId));
    res.json({ ok: true });
  });

  app.post('/api/devices/:id/tool', async (req, res) => {
    const device = deviceOf(req, res);
    if (!device) return;
    const { server, name } = body(req);
    if (typeof server !== 'string' || typeof name !== 'string') {
      res.status(400).json({ error: 'Give "server" and "name".' });
      return;
    }
    const args = body(req).arguments && typeof body(req).arguments === 'object' ? (body(req).arguments as JsonObject) : {};
    const origin: ToolOrigin = body(req).origin === 'inspector' ? 'inspector' : 'card';
    res.json(await device.callServerTool(server, name, args, origin));
  });

  app.post('/api/devices/:id/resource', async (req, res) => {
    const device = deviceOf(req, res);
    if (!device) return;
    const { server, uri } = body(req);
    if (typeof server !== 'string' || typeof uri !== 'string') {
      res.status(400).json({ error: 'Give "server" and "uri".' });
      return;
    }
    try {
      res.json(await device.readResource(server, uri, 'card'));
    } catch (error) {
      res.status(502).json({ error: errorMessage(error) });
    }
  });

  app.post('/api/devices/:id/card-event', (req, res) => {
    const device = deviceOf(req, res);
    if (!device) return;
    device.cardEvent(String(body(req).action ?? 'event'), body(req).detail, typeof body(req).uri === 'string' ? (body(req).uri as string) : undefined);
    res.json({ ok: true });
  });

  app.post('/api/devices/:id/elicitation/:elicitationId', (req, res) => {
    const device = deviceOf(req, res);
    if (!device) return;
    const action = (['accept', 'decline', 'cancel'] as const).find((item) => item === body(req).action) ?? 'cancel';
    const content = body(req).content && typeof body(req).content === 'object' ? (body(req).content as JsonObject) : undefined;
    const accepted = device.answerElicitation(String(req.params.elicitationId), { action, content });
    res.status(accepted ? 200 : 409).json(accepted ? { ok: true } : { error: 'That question is no longer waiting for an answer.' });
  });

  app.post('/api/devices/:id/notification', (req, res) => {
    const device = deviceOf(req, res);
    if (!device) return;
    if (body(req).action === 'dismiss') device.dismissNotification();
    else void device.playNotification();
    res.json({ ok: true });
  });

  app.post('/api/devices/:id/reset', async (req, res) => {
    const device = deviceOf(req, res);
    if (!device) return;
    await device.reset({ reconnect: body(req).reconnect === true });
    res.json({ ok: true });
  });

  app.post('/api/reset', async (req, res) => {
    stage.activeRun?.stop();
    await Promise.all([...stage.devices.values()].map((device) => device.reset({ reconnect: body(req).reconnect === true })));
    stage.clearRun();
    res.json({ ok: true });
  });

  app.post('/api/scenarios/reload', (_req, res) => {
    stage.reloadScenarios();
    stage.emit({ type: 'snapshot', stage: stage.snapshot() });
    res.json({ scenarios: stage.scenarios.length, errors: stage.scenarioErrors });
  });

  app.post('/api/scenarios/:id/play', async (req, res) => {
    const scenario = stage.findScenario(String(req.params.id));
    if (!scenario) {
      res.status(404).json({ error: `No scenario "${String(req.params.id)}".` });
      return;
    }
    const mode = body(req).mode === 'live' ? 'live' : 'scripted';
    try {
      const run = await stage.play(scenario, {
        mode,
        paced: true,
        pacing: body(req).pacing === 'step' ? 'step' : 'auto',
        gapMs: typeof body(req).gapMs === 'number' ? (body(req).gapMs as number) : 900,
        reset: body(req).reset !== false,
        beforeSay: cue,
      });
      res.status(202).json(run.state);
    } catch (error) {
      res.status(409).json({ error: errorMessage(error) });
    }
  });

  app.post('/api/scenarios/next', (_req, res) => {
    stage.activeRun?.next();
    res.json({ ok: true });
  });

  app.post('/api/scenarios/stop', (_req, res) => {
    stage.activeRun?.stop();
    for (const done of [...cues.values()]) done();
    res.json({ ok: true });
  });

  app.post('/api/scenarios/clear', (_req, res) => {
    stage.clearRun();
    res.json({ ok: true });
  });

  app.post('/api/cues/:id/done', (req, res) => {
    cues.get(String(req.params.id))?.();
    res.json({ ok: true });
  });

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Unknown API route.' });
  });

  if (options.devMiddleware) {
    app.use(options.devMiddleware);
  } else if (options.uiDir && existsSync(join(options.uiDir, 'index.html'))) {
    const uiDir = options.uiDir;
    app.use(express.static(uiDir, { index: 'index.html' }));
    app.use((req, res, next) => {
      if (req.method !== 'GET') return next();
      res.sendFile(join(uiDir, 'index.html'));
    });
  } else {
    app.get('/', (_req, res) => {
      res.type('text/plain').send('The Voicestage UI has not been built. Run "npm run build", or use "npm run dev".');
    });
  }

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    log(`http: ${errorMessage(error)}`);
    if (!res.headersSent) res.status(500).json({ error: errorMessage(error) });
  });

  return app;
}

export interface RunningStage {
  url: string;
  port: number;
  close(): Promise<void>;
}

/** Listen on localhost. Falls forward to the next free port when the wanted one is taken (unless `strictPort`). */
export async function listen(app: Express, options: { port?: number; strictPort?: boolean } = {}): Promise<RunningStage> {
  const wanted = options.port ?? 4700;
  let server: HttpServer | undefined;
  for (let port = wanted, attempts = 0; !server; port += 1, attempts += 1) {
    try {
      server = await new Promise<HttpServer>((resolve, reject) => {
        const listening = app.listen(port, '127.0.0.1', () => resolve(listening));
        listening.once('error', reject);
      });
    } catch (error) {
      const inUse = (error as NodeJS.ErrnoException).code === 'EADDRINUSE';
      if (!inUse || options.strictPort || wanted === 0 || attempts >= 20) throw error;
    }
  }
  const http = server;
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://localhost:${port}`,
    port,
    async close() {
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
