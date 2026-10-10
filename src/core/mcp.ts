/**
 * One MCP connection for one device: a real `@modelcontextprotocol/client`
 * `Client` over Streamable HTTP, with that device's HTTP headers.
 *
 * By default the connection uses the 2025 `initialize` handshake, which
 * negotiates protocol version 2025-11-25 and a session (`Mcp-Session-Id`).
 * Set `protocol: auto` on a server to probe for 2026-07-28 first.
 *
 * A developer restarts their server many times a day, and every restart
 * forgets this connection's session. The connection therefore repairs itself.
 * After a quiet moment it pings before the next request; if the server is
 * gone or no longer knows the session (HTTP 404), it connects again and only
 * then sends the request. A tool call that fails on the wire is never sent
 * twice, because it may have arrived: it reports that the server could not be
 * reached, and the next request connects again first.
 */
import { Client, SdkHttpError, StreamableHTTPClientTransport, type ClientCapabilities, type Tool } from '@modelcontextprotocol/client';
import { PRODUCT_VERSION, type CardResource, type ConnectionStatus, type JsonObject, type ServerSnapshot, type ToolResult, type ToolSummary } from '../shared/types.js';

/** MIME type of an MCP Apps card, and the extension id a host advertises to say it can render them. */
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';
export const MCP_APPS_EXTENSION_ID = 'io.modelcontextprotocol/ui';

export interface ElicitationRequest {
  server: string;
  message: string;
  requestedSchema: JsonObject;
  mode: 'form' | 'url';
  url?: string;
}

export interface ElicitationAnswer {
  action: 'accept' | 'decline' | 'cancel';
  content?: JsonObject;
}

export interface McpConnectionOptions {
  id: string;
  url: string;
  headers?: Record<string, string>;
  /** `legacy` (default) negotiates 2025-11-25 with a session; `auto` tries 2026-07-28 first. */
  protocol?: 'legacy' | 'auto';
  clientName?: string;
  /** Default timeout for one request, in milliseconds. */
  timeoutMs?: number;
  /** After this long without a successful request, check that the server is still there before the next one. Default 1000 ms. */
  idleCheckMs?: number;
  onStatus?: (snapshot: ServerSnapshot) => void;
  /** The connection was lost and has been made again, with a new session. */
  onReconnect?: (snapshot: ServerSnapshot) => void;
  /** The server asked the person a question. */
  onElicitation?: (request: ElicitationRequest) => Promise<ElicitationAnswer>;
  /** Any notification that arrived on the connection outside a request (logging, list changes, resource updates). */
  onNotification?: (method: string, params: unknown) => void;
}

export interface CallOptions {
  onProgress?: (update: { progress: number; total?: number; message?: string }) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function uiResourceUri(tool: Tool): string | undefined {
  const meta = tool._meta as { ui?: { resourceUri?: unknown }; 'ui/resourceUri'?: unknown } | undefined;
  const uri = meta?.ui?.resourceUri ?? meta?.['ui/resourceUri'];
  return typeof uri === 'string' && uri.startsWith('ui://') ? uri : undefined;
}

function isAppOnly(tool: Tool): boolean {
  const visibility = (tool._meta as { ui?: { visibility?: unknown } } | undefined)?.ui?.visibility;
  return Array.isArray(visibility) && !visibility.includes('model');
}

export function summarizeTool(server: string, tool: Tool): ToolSummary {
  return {
    name: tool.name,
    exposedName: tool.name,
    server,
    title: tool.title ?? tool.annotations?.title,
    description: tool.description,
    inputSchema: tool.inputSchema as JsonObject,
    uiResourceUri: uiResourceUri(tool),
    readOnly: tool.annotations?.readOnlyHint,
    appOnly: isAppOnly(tool),
  };
}

/** The server answered, but no longer knows this connection's session: it was restarted, or the session expired. */
function sessionWasLost(error: unknown): boolean {
  return error instanceof SdkHttpError && error.status === 404;
}

/**
 * Why a request got no answer from any server, or `undefined` if it got one.
 * Node reports this as a bare `TypeError: fetch failed`; the reason
 * (ECONNREFUSED, ECONNRESET, ENOTFOUND) is a code somewhere down the `cause`
 * chain. An empty string means it failed without saying why.
 */
function unreachableReason(error: unknown): string | undefined {
  let failed = false;
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
    const { message, code, errors, cause } = current as { message?: unknown; code?: unknown; errors?: unknown; cause?: unknown };
    if (typeof message === 'string' && /fetch failed/i.test(message)) failed = true;
    if (typeof code === 'string' && /^(E[A-Z_]+|UND_ERR_[A-Z_]+)$/.test(code)) return code;
    current = Array.isArray(errors) && errors.length > 0 ? errors[0] : cause;
  }
  return failed ? '' : undefined;
}

function unreachableMessage(url: string, reason: string): string {
  return `Could not reach ${url}${reason ? ` (${reason})` : ''}. Is the MCP server running?`;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    const causeText = cause instanceof Error && cause.message && !error.message.includes(cause.message) ? ` (${cause.message})` : '';
    return `${error.message}${causeText}`;
  }
  return String(error);
}

export class McpConnection {
  readonly id: string;
  readonly url: string;
  private client: Client | undefined;
  private transport: StreamableHTTPClientTransport | undefined;
  private status: ConnectionStatus = 'idle';
  private error: string | undefined;
  private tools: Tool[] = [];
  private resources: Array<{ uri: string; name?: string; mimeType?: string }> = [];
  private readonly cards = new Map<string, CardResource>();
  private eventsState: ServerSnapshot['events'];
  /** False until `connect()` is first called, and again after `close()`: a closed connection stays closed. */
  private wanted = false;
  private reconnecting: Promise<void> | undefined;
  /** When a request last succeeded. */
  private lastAnswer = 0;

  constructor(private readonly options: McpConnectionOptions) {
    this.id = options.id;
    this.url = options.url;
  }

  get connected(): boolean {
    return this.status === 'connected';
  }

  snapshot(): ServerSnapshot {
    const client = this.client;
    const info = this.status === 'connected' ? client?.getServerVersion() : undefined;
    return {
      id: this.id,
      url: this.url,
      status: this.status,
      error: this.error,
      protocolVersion: this.status === 'connected' ? client?.getNegotiatedProtocolVersion() : undefined,
      era: this.status === 'connected' ? client?.getProtocolEra() : undefined,
      sessionId: this.status === 'connected' ? this.transport?.sessionId : undefined,
      serverInfo: info ? { name: info.name, title: info.title, version: info.version } : undefined,
      capabilities: this.status === 'connected' ? (client?.getServerCapabilities() as JsonObject | undefined) : undefined,
      instructions: this.status === 'connected' ? client?.getInstructions() : undefined,
      tools: this.tools.map((tool) => summarizeTool(this.id, tool)),
      resources: this.resources,
      events: this.eventsState,
    };
  }

  setEventsState(state: ServerSnapshot['events']): void {
    this.eventsState = state;
    this.publish();
  }

  private publish(): void {
    this.options.onStatus?.(this.snapshot());
  }

  private setStatus(status: ConnectionStatus, error?: string): void {
    this.status = status;
    this.error = error;
    this.publish();
  }

  async connect(): Promise<void> {
    await this.dispose();
    this.wanted = true;
    this.setStatus('connecting');
    // Declaring `elicitation.form` lets a server ask the person a question; the
    // extension entry says this host renders MCP Apps cards.
    const capabilities: ClientCapabilities = {
      elicitation: { form: {} },
      extensions: { [MCP_APPS_EXTENSION_ID]: { mimeTypes: [MCP_APP_MIME_TYPE] } },
    };
    const client = new Client(
      { name: this.options.clientName ?? 'voicestage', title: 'Voicestage', version: PRODUCT_VERSION },
      {
        capabilities,
        versionNegotiation: { mode: this.options.protocol ?? 'legacy' },
        listChanged: {
          tools: {
            onChanged: (error, tools) => {
              if (!error && tools) {
                this.tools = tools;
                this.publish();
              }
            },
          },
        },
      },
    );
    client.setRequestHandler('elicitation/create', async (request) => {
      const params = request.params as { mode?: string; message: string; requestedSchema?: JsonObject; url?: string };
      const handler = this.options.onElicitation;
      if (!handler) return { action: 'decline' as const };
      const answer = await handler({
        server: this.id,
        message: params.message,
        requestedSchema: params.requestedSchema ?? { type: 'object', properties: {} },
        mode: params.mode === 'url' ? 'url' : 'form',
        url: params.url,
      });
      return answer.action === 'accept' ? { action: 'accept' as const, content: (answer.content ?? {}) as Record<string, string> } : { action: answer.action };
    });
    client.setNotificationHandler('notifications/message', (notification) => {
      this.options.onNotification?.('notifications/message', notification.params);
    });
    client.setNotificationHandler('notifications/resources/updated', (notification) => {
      this.options.onNotification?.('notifications/resources/updated', notification.params);
    });
    client.fallbackNotificationHandler = async (notification) => {
      this.options.onNotification?.(notification.method, notification.params);
    };
    client.onerror = (error) => {
      // Transport hiccups (for example the idle event stream being closed) are
      // reported here; the connection itself may still be fine.
      this.options.onNotification?.('client/error', { message: errorMessage(error) });
    };

    const transport = new StreamableHTTPClientTransport(new URL(this.url), {
      requestInit: { headers: { ...this.options.headers } },
    });
    try {
      await client.connect(transport, { timeout: this.options.timeoutMs ?? 15_000 });
      this.client = client;
      this.transport = transport;
      this.tools = (await client.listTools()).tools;
      this.resources = [];
      if (client.getServerCapabilities()?.resources) {
        try {
          this.resources = (await client.listResources()).resources.map((resource) => ({ uri: resource.uri, name: resource.title ?? resource.name, mimeType: resource.mimeType }));
        } catch {
          // Listing resources is optional; cards are read by URI when a tool links one.
        }
      }
      client.onclose = () => {
        if (this.client === client && this.status === 'connected') this.setStatus('closed', 'The server closed the connection.');
      };
      this.lastAnswer = Date.now();
      this.setStatus('connected');
    } catch (error) {
      this.client = undefined;
      this.transport = undefined;
      this.tools = [];
      await client.close().catch(() => undefined);
      this.setStatus('error', describeConnectError(error, this.url));
      throw new Error(this.error);
    }
  }

  private requireClient(): Client {
    if (!this.client || this.status !== 'connected') {
      throw new Error(`Not connected to "${this.id}" (${this.url})${this.error ? `: ${this.error}` : '.'}`);
    }
    return this.client;
  }

  /** Connect again. Requests that find the connection broken at the same moment share one attempt. */
  private reconnect(): Promise<void> {
    const attempt = async (): Promise<void> => {
      for (let tries = 1; ; tries += 1) {
        try {
          await this.connect();
          break;
        } catch (error) {
          // Each socket still pooled for the old server process fails once; the next try opens a new one.
          if (tries >= 4 || !/ECONNRESET|EPIPE|UND_ERR_SOCKET/.test(this.error ?? '')) throw error;
        }
      }
      this.options.onReconnect?.(this.snapshot());
    };
    this.reconnecting ??= attempt().finally(() => {
      this.reconnecting = undefined;
    });
    return this.reconnecting;
  }

  /**
   * Make sure the server is there before a request: connect again if the
   * connection is broken, and after a quiet moment ask with a ping, which is
   * safe to lose. Throws when the server cannot be reached.
   */
  private async check(): Promise<void> {
    if (!this.wanted) return;
    if (this.reconnecting) return this.reconnecting;
    if (this.status === 'error' || this.status === 'closed') return this.reconnect();
    const client = this.client;
    if (!client || this.status !== 'connected' || Date.now() - this.lastAnswer < (this.options.idleCheckMs ?? 1000)) return;
    try {
      await client.ping({ timeout: 3000 });
      this.lastAnswer = Date.now();
    } catch (error) {
      // Any other failure is still an answer, so the server is there.
      if (this.client === client && (sessionWasLost(error) || unreachableReason(error) !== undefined)) return this.reconnect();
    }
    // Another request may have started a reconnection while this one was asking.
    if (this.reconnecting) await this.reconnecting;
  }

  /**
   * Connect again if the connection is broken or the server has forgotten it.
   * No I/O when a request succeeded a moment ago. Never throws: the connection
   * status says how it went.
   */
  async ensure(): Promise<void> {
    await this.check().catch(() => undefined);
  }

  /** Send one request, with the connection repaired first if need be. */
  private async request<T>(send: (client: Client) => Promise<T>): Promise<T> {
    await this.check();
    const client = this.requireClient();
    try {
      const result = await send(client);
      this.lastAnswer = Date.now();
      return result;
    } catch (error) {
      if (!this.wanted) throw error;
      if (sessionWasLost(error)) {
        // Refused before anything ran, so sending it again on a new session is safe.
        if (this.client === client) await this.reconnect();
        else if (this.reconnecting) await this.reconnecting;
        return send(this.requireClient());
      }
      const reason = unreachableReason(error);
      if (reason !== undefined && this.client === client) {
        // Not sent again: the request may have arrived before the connection broke.
        this.setStatus('error', unreachableMessage(this.url, reason));
        throw new Error(this.error, { cause: error });
      }
      throw error;
    }
  }

  listTools(): Tool[] {
    return this.tools;
  }

  findTool(name: string): Tool | undefined {
    return this.tools.find((tool) => tool.name === name);
  }

  async callTool(name: string, args: JsonObject, options: CallOptions = {}): Promise<ToolResult> {
    const result = await this.request((client) =>
      client.callTool(
        { name, arguments: args },
        {
          onprogress: options.onProgress ? (update) => options.onProgress?.({ progress: update.progress, total: update.total, message: update.message }) : undefined,
          signal: options.signal,
          timeout: options.timeoutMs ?? 120_000,
          resetTimeoutOnProgress: true,
        },
      ),
    );
    return result as ToolResult;
  }

  async readResource(uri: string): Promise<{ contents: Array<{ uri: string; mimeType?: string; text?: string; blob?: string; _meta?: JsonObject }> }> {
    return (await this.request((client) => client.readResource({ uri }))) as never;
  }

  /** Read an MCP Apps card (`ui://...`). Cached per connection: cards are static templates. */
  async readCard(uri: string): Promise<CardResource> {
    const cached = this.cards.get(uri);
    if (cached) return cached;
    const result = await this.readResource(uri);
    const content = result.contents.find((item) => typeof item.text === 'string' || typeof item.blob === 'string');
    if (!content) throw new Error(`The server returned no content for ${uri}.`);
    const html = typeof content.text === 'string' ? content.text : Buffer.from(content.blob ?? '', 'base64').toString('utf8');
    if (content.mimeType && !content.mimeType.startsWith('text/html')) {
      throw new Error(`${uri} has MIME type ${content.mimeType}; an MCP Apps card must be ${MCP_APP_MIME_TYPE}.`);
    }
    const ui = (content._meta as { ui?: { csp?: CardResource['csp']; permissions?: JsonObject; prefersBorder?: boolean } } | undefined)?.ui;
    const card: CardResource = { uri, mimeType: content.mimeType, html, csp: ui?.csp, permissions: ui?.permissions, prefersBorder: ui?.prefersBorder };
    this.cards.set(uri, card);
    return card;
  }

  async close(): Promise<void> {
    this.wanted = false;
    await this.dispose();
  }

  private async dispose(): Promise<void> {
    const client = this.client;
    const transport = this.transport;
    this.client = undefined;
    this.transport = undefined;
    this.cards.clear();
    if (!client) return;
    this.status = 'closed';
    // Ending the session is polite; a server without sessions answers 405, which is fine.
    await transport?.terminateSession().catch(() => undefined);
    await client.close().catch(() => undefined);
    this.publish();
  }
}

function describeConnectError(error: unknown, url: string): string {
  const message = errorMessage(error);
  const reason = unreachableReason(error);
  if (reason !== undefined) return unreachableMessage(url, reason);
  if (/ECONNREFUSED|fetch failed|ENOTFOUND|EAI_AGAIN/i.test(message)) return unreachableMessage(url, '');
  if (/401|unauthori[sz]ed/i.test(message)) return `${url} rejected the request as unauthorized. Check the headers configured for this device. (${message})`;
  return message;
}
