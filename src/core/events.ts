/**
 * A small server-sent events client for Node: `fetch` with a streaming body,
 * custom headers (a browser `EventSource` cannot send any), automatic
 * reconnection and `Last-Event-ID`.
 */

export interface ServerSentEvent {
  /** `message` when the server sent no `event:` line. */
  event: string;
  data: string;
  id?: string;
}

/**
 * Incremental parser for the `text/event-stream` format. Feed it chunks of
 * text; it calls back once per complete event.
 */
export class SseParser {
  private buffer = '';
  private event = '';
  private data: string[] = [];
  private id: string | undefined;

  constructor(
    private readonly onEvent: (event: ServerSentEvent) => void,
    private readonly onRetry?: (ms: number) => void,
  ) {}

  feed(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.search(/\r\n|\n|\r/)) >= 0) {
      // A lone "\r" at the very end may be the first half of "\r\n": wait for more.
      if (this.buffer[index] === '\r' && index === this.buffer.length - 1) break;
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + (this.buffer.startsWith('\r\n', index) ? 2 : 1));
      this.line(line);
    }
  }

  private line(line: string): void {
    if (line === '') {
      if (this.data.length > 0) this.onEvent({ event: this.event || 'message', data: this.data.join('\n'), id: this.id });
      this.event = '';
      this.data = [];
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') this.event = value;
    else if (field === 'data') this.data.push(value);
    else if (field === 'id') {
      if (!value.includes('\0')) this.id = value;
    } else if (field === 'retry' && /^\d+$/.test(value)) this.onRetry?.(Number(value));
  }
}

export interface EventStreamOptions {
  url: string;
  headers?: Record<string, string>;
  onEvent: (event: ServerSentEvent) => void;
  onStatus?: (status: 'connecting' | 'open' | 'error' | 'closed', error?: string) => void;
  /** Longest wait between reconnection attempts, in milliseconds. */
  maxRetryMs?: number;
  fetch?: typeof fetch;
}

export interface EventStream {
  close(): void;
  /** Resolves when the stream is open for the first time, or rejects if the first attempt fails. */
  ready: Promise<void>;
}

/** Subscribe to a server-sent events URL and keep the subscription alive until `close()`. */
export function openEventStream(options: EventStreamOptions): EventStream {
  const controller = new AbortController();
  const doFetch = options.fetch ?? fetch;
  let retryMs = 1000;
  let lastEventId: string | undefined;
  let attempt = 0;
  let resolveReady: () => void = () => undefined;
  let rejectReady: (error: Error) => void = () => undefined;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // Nobody is obliged to await `ready`.
  ready.catch(() => undefined);

  const run = async (): Promise<void> => {
    while (!controller.signal.aborted) {
      attempt += 1;
      options.onStatus?.('connecting');
      try {
        const response = await doFetch(options.url, {
          headers: { Accept: 'text/event-stream', 'Cache-Control': 'no-cache', ...options.headers, ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}) },
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          const body = await response.text().catch(() => '');
          throw new Error(`${options.url} answered ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
        }
        const type = response.headers.get('content-type') ?? '';
        if (!type.includes('text/event-stream')) throw new Error(`${options.url} answered with content type "${type}", not text/event-stream.`);
        options.onStatus?.('open');
        resolveReady();
        const parser = new SseParser(
          (event) => {
            if (event.id !== undefined) lastEventId = event.id;
            options.onEvent(event);
          },
          (ms) => {
            retryMs = ms;
          },
        );
        const decoder = new TextDecoder();
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          parser.feed(decoder.decode(chunk, { stream: true }));
        }
        if (controller.signal.aborted) break;
        options.onStatus?.('error', 'The server closed the event stream. Reconnecting.');
      } catch (error) {
        if (controller.signal.aborted) break;
        const message = error instanceof Error ? error.message : String(error);
        options.onStatus?.('error', message);
        if (attempt === 1) rejectReady(new Error(message));
      }
      const wait = Math.min(retryMs * Math.min(attempt, 5), options.maxRetryMs ?? 15_000);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, wait);
        timer.unref?.();
        controller.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    options.onStatus?.('closed');
  };
  void run();

  return {
    ready,
    close: () => controller.abort(),
  };
}
