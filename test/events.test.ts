import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { openEventStream, SseParser, type ServerSentEvent } from '../src/core/events.js';

describe('server-sent events parser', () => {
  const parse = (chunks: string[]) => {
    const events: ServerSentEvent[] = [];
    const retries: number[] = [];
    const parser = new SseParser((event) => events.push(event), (ms) => retries.push(ms));
    for (const chunk of chunks) parser.feed(chunk);
    return { events, retries };
  };

  it('parses named events, ids, multi-line data, comments and retry', () => {
    const { events, retries } = parse(['retry: 3000\n\n: keep-alive\n\nid: 7\nevent: hold.created\ndata: {"a":1}\n\ndata: first\ndata: second\n\n']);
    expect(retries).toEqual([3000]);
    expect(events).toEqual([
      { event: 'hold.created', data: '{"a":1}', id: '7' },
      { event: 'message', data: 'first\nsecond', id: '7' },
    ]);
  });

  it('copes with events split across chunks and with CRLF line endings', () => {
    const { events } = parse(['event: tim', 'er.done\r', '\ndata: {"label":', '"tea"}\r\n\r', '\nevent: x\ndata: y\n', '\n']);
    expect(events).toEqual([
      { event: 'timer.done', data: '{"label":"tea"}', id: undefined },
      { event: 'x', data: 'y', id: undefined },
    ]);
  });

  it('ignores an event with no data', () => {
    expect(parse(['event: empty\n\n']).events).toEqual([]);
  });
});

describe('event stream client', () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((resolve) => (server ? (server.closeAllConnections(), server.close(() => resolve())) : resolve())));

  const listen = (handler: Parameters<typeof createServer>[1]) =>
    new Promise<string>((resolve) => {
      server = createServer(handler);
      server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}/events`));
    });

  it('sends headers, delivers events, and reconnects with Last-Event-ID', async () => {
    const seen: Array<{ authorization?: string; lastEventId?: string }> = [];
    const url = await listen((req, res) => {
      seen.push({ authorization: req.headers.authorization, lastEventId: req.headers['last-event-id'] as string | undefined });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('retry: 20\n\n');
      if (seen.length === 1) {
        res.write('id: 1\nevent: first\ndata: {"n":1}\n\n');
        // Drop the connection: the client should come back and say where it was.
        setTimeout(() => res.end(), 20);
      } else {
        res.write('id: 2\nevent: second\ndata: {"n":2}\n\n');
      }
    });
    const events: ServerSentEvent[] = [];
    const statuses: string[] = [];
    const stream = openEventStream({ url, headers: { Authorization: 'Bearer demo' }, onEvent: (event) => events.push(event), onStatus: (status) => statuses.push(status) });
    await stream.ready;
    await expect.poll(() => events.length, { timeout: 3000 }).toBe(2);
    stream.close();

    expect(events.map((event) => event.event)).toEqual(['first', 'second']);
    expect(seen[0]).toEqual({ authorization: 'Bearer demo', lastEventId: undefined });
    expect(seen[1]).toEqual({ authorization: 'Bearer demo', lastEventId: '1' });
    expect(statuses.slice(0, 2)).toEqual(['connecting', 'open']);
    await expect.poll(() => statuses.at(-1)).toBe('closed');
  });

  it('reports a refusal instead of hanging', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end('{"error":"unauthorized"}');
    });
    const errors: string[] = [];
    const stream = openEventStream({ url, onEvent: () => undefined, onStatus: (status, error) => status === 'error' && errors.push(error ?? '') });
    await expect(stream.ready).rejects.toThrow(/answered 401/);
    stream.close();
    expect(errors[0]).toMatch(/401.*unauthorized/);
  });

  it('refuses a response that is not an event stream', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html></html>');
    });
    const stream = openEventStream({ url, onEvent: () => undefined });
    await expect(stream.ready).rejects.toThrow(/not text\/event-stream/);
    stream.close();
  });
});
