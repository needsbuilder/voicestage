/**
 * One simulated device: its MCP connections, its assistant, and everything it
 * has heard, said, shown and been told.
 *
 * A device owns:
 *   - one MCP connection per configured server, with this device's headers
 *   - the Agent Skills it loads
 *   - a conversation with a model provider (or a script)
 *   - a screen (what the last tool result looks like), unless it is a speaker
 *   - an inspector timeline of every event
 *
 * Turns and proactive announcements run one at a time. A question from a
 * server (MCP elicitation) arrives in the middle of a tool call and is answered
 * by the next thing the person says or taps.
 */
import { randomUUID } from 'node:crypto';
import { answerFromSpeech, formFields, questionForSpeech, type FormField } from '../shared/speech.js';
import { matchValue, renderText, renderValue } from '../shared/template.js';
import type {
  DevicePatch,
  DeviceSnapshot,
  DeviceStatus,
  ElicitationEntry,
  JsonObject,
  NewTimelineEntry,
  NotificationState,
  PendingElicitation,
  ProviderSummary,
  ScreenContent,
  ServerEventEntry,
  ServerSnapshot,
  SkillSummary,
  SpeechEntry,
  StageEvent,
  TimelineEntry,
  ToolEntry,
  ToolOrigin,
  ToolResult,
  ToolSummary,
  TranscriptLine,
  UtteranceSource,
} from '../shared/types.js';
import { selectProviderId, type AnnounceRule, type ResolvedDevice, type ResolvedDeviceServer } from './config.js';
import { openEventStream, type EventStream } from './events.js';
import { errorMessage, McpConnection, type ElicitationAnswer, type ElicitationRequest } from './mcp.js';
import { buildSystemPrompt } from './prompt.js';
import { createProvider, PROVIDER_LABELS, ProviderNotConfiguredError, ScriptedProvider, type Provider, type ScriptedLine } from './providers/index.js';
import type { ChatMessage, ProviderTool, RunContext, ScriptAction, ToolOutcome } from './providers/types.js';
import { LOAD_SKILL_TOOL, loadSkills, READ_SKILL_FILE_TOOL, readSkillFile, skillTools, type LoadedSkill } from './skills.js';

/** Progress text written by the MCP client SDK itself, not by the server. */
const SDK_PROGRESS = /^Fulfilling input required by /;

export interface DeviceHost {
  emit(event: StageEvent): void;
  /** True when at least one browser is watching: speech is then paced by the browser. */
  hasListeners(): boolean;
  /** Values saved by scripts and scenario steps. */
  vars: Record<string, unknown>;
  scriptedLines(): ScriptedLine[];
  env: NodeJS.ProcessEnv;
  providerOverride?: string;
  /** Start a built-in server on demand and say where it is. */
  resolveBuiltin(kind: 'example'): Promise<{ url: string; eventsUrl: string }>;
}

export interface HearOptions {
  source?: UtteranceSource;
  /** Replay this script instead of asking the device's provider. */
  script?: ScriptAction[];
  /** Force the scripted provider even when a live one is configured. */
  scripted?: boolean;
}

export interface TurnRecord {
  turn: string;
  /** Timeline entries the turn produced, in their final state. */
  entries: TimelineEntry[];
  error?: string;
}

export interface ReceivedEvent {
  seq: number;
  server: string;
  channel: 'sse' | 'mcp';
  name: string;
  data: unknown;
  /** Set when an announcement rule matched; resolves when the announcement has finished. */
  announced?: Promise<TurnRecord>;
}

interface ToolRoute {
  server: string;
  tool: ToolSummary;
}

interface PendingAsk {
  pending: PendingElicitation;
  entryId: string;
  fields: FormField[];
  startedAt: number;
  attempts: number;
  resolve(answer: ElicitationAnswer): void;
  timer?: NodeJS.Timeout;
}

interface ServerLink {
  config: ResolvedDeviceServer;
  connection: McpConnection;
  stream?: EventStream;
  eventsUrl?: string;
  received: number;
}

const MAX_TIMELINE = 600;
const MODEL_RESULT_LIMIT = 16_000;
const NOTIFICATION_REQUEST = /\b(notification|notifications|what did i miss|what'?s new|any (news|messages|updates)|play (it|them)|read (it|them)|go ahead)\b/i;

/** What the model reads for a tool result: the text, then the structured content when there is one. */
export function toolResultText(result: ToolResult): string {
  const text = (result.content ?? [])
    .map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : block.type === 'text' ? '' : `[${block.type} content]`))
    .filter(Boolean)
    .join('\n')
    .trim();
  const structured = result.structuredContent === undefined ? '' : JSON.stringify(result.structuredContent);
  const combined = structured && !text.includes(structured) ? `${text}${text ? '\n\n' : ''}structuredContent: ${structured}` : text;
  return combined.length > MODEL_RESULT_LIMIT ? `${combined.slice(0, MODEL_RESULT_LIMIT)}\n[truncated]` : combined;
}

/** Roughly how long a sentence takes to say, for pacing when no browser reports back. */
export function estimateSpeechMs(text: string): number {
  return Math.min(20_000, 500 + text.length * 62);
}

export class Device {
  readonly id: string;
  private readonly links = new Map<string, ServerLink>();
  private skills: LoadedSkill[] = [];
  private readonly activeSkills = new Set<string>();
  private provider: Provider | undefined;
  private providerSummary: ProviderSummary;
  private readonly scripted: ScriptedProvider;
  private history: ChatMessage[] = [];
  private providerState = new Map<string, unknown>();
  private transcript: TranscriptLine[] = [];
  private timeline: TimelineEntry[] = [];
  private screen: ScreenContent | null = null;
  private status: DeviceStatus = 'idle';
  private notification: NotificationState | null = null;
  /** Announcements waiting behind the indicator (`announcements.mode: indicator`). */
  private readonly held: Array<() => Promise<TurnRecord>> = [];
  private ask: PendingAsk | undefined;
  private progress: DeviceSnapshot['progress'] = null;
  private queue: Promise<unknown> = Promise.resolve();
  private busy = 0;
  private readonly speech = new Map<string, { resolve(): void; timer: NodeJS.Timeout }>();
  private readonly quietWaiters: Array<() => void> = [];
  private seq = 0;
  private currentTurn: string | undefined;
  private abort = new AbortController();
  private readonly events: ReceivedEvent[] = [];
  private eventSeq = 0;
  private readonly eventWaiters = new Set<(event: ReceivedEvent) => void>();
  /** Answers queued by a scenario for the next question a server asks. */
  private readonly scriptedAnswers: Array<{ answer: string | { content?: JsonObject; action?: 'decline' | 'cancel' }; cue?: (text: string) => Promise<void> }> = [];
  private closed = false;

  constructor(
    readonly config: ResolvedDevice,
    private readonly host: DeviceHost,
  ) {
    this.id = config.id;
    this.scripted = new ScriptedProvider(() => host.scriptedLines());
    this.providerSummary = { id: 'scripted', label: PROVIDER_LABELS.scripted, ready: true };
  }

  // --- lifecycle --------------------------------------------------------------

  async start(): Promise<void> {
    this.loadSkillFolders();
    this.createProvider();
    await Promise.all(this.config.servers.map((server) => this.connectServer(server)));
  }

  private loadSkillFolders(): void {
    this.skills = [];
    for (const path of this.config.skillPaths) {
      try {
        for (const skill of loadSkills(path)) {
          if (this.skills.some((existing) => existing.name === skill.name)) continue;
          this.skills.push(skill);
          for (const warning of skill.warnings) this.add({ kind: 'error', message: `Skill "${skill.name}": ${warning}`, detail: skill.dir });
        }
      } catch (error) {
        this.add({ kind: 'error', message: `Could not load skills from ${path}`, detail: errorMessage(error) });
      }
    }
  }

  private createProvider(): void {
    let id = 'scripted';
    try {
      id = selectProviderId(this.config.assistant, this.host.env, this.host.providerOverride);
      this.provider = createProvider({
        assistant: this.config.assistant,
        env: this.host.env,
        override: this.host.providerOverride,
        scriptedLines: () => this.host.scriptedLines(),
      });
      this.providerSummary = { id: this.provider.id, label: this.provider.label, model: this.provider.model, ready: true };
    } catch (error) {
      this.provider = undefined;
      const label = (PROVIDER_LABELS as Record<string, string>)[id] ?? id;
      this.providerSummary = { id, label, ready: false, error: errorMessage(error) };
      if (!(error instanceof ProviderNotConfiguredError)) this.add({ kind: 'error', message: `Provider "${id}" could not be created`, detail: errorMessage(error) });
    }
  }

  private async connectServer(server: ResolvedDeviceServer): Promise<void> {
    let url = server.url;
    let eventsUrl = server.events?.url;
    if (server.builtin) {
      const builtin = await this.host.resolveBuiltin(server.builtin);
      url = builtin.url;
      eventsUrl = eventsUrl ?? (server.events ? builtin.eventsUrl : undefined);
    }
    if (!url) return;
    const connection = new McpConnection({
      id: server.id,
      url,
      headers: server.headers,
      protocol: server.protocol,
      timeoutMs: server.timeoutMs,
      onStatus: () => this.patch({ servers: this.serverSnapshots(), hints: this.hints() }),
      onReconnect: () => this.noteConnected(connection),
      onElicitation: (request) => this.onElicitation(request),
      onNotification: (method, params) => this.onServerEvent(server.id, 'mcp', method, params),
    });
    const link: ServerLink = { config: server, connection, eventsUrl, received: 0 };
    this.links.set(server.id, link);
    await this.connectLink(link);
  }

  private async connectLink(link: ServerLink): Promise<void> {
    const { connection } = link;
    try {
      await connection.connect();
      this.noteConnected(connection);
    } catch (error) {
      this.add({ kind: 'connection', server: connection.id, url: connection.url, status: 'error', error: errorMessage(error) });
    }
    this.openEvents(link);
  }

  /** Put a connection (or a reconnection, with its new session) on the timeline. */
  private noteConnected(connection: McpConnection): void {
    const snapshot = connection.snapshot();
    this.add({
      kind: 'connection',
      server: connection.id,
      url: connection.url,
      status: 'connected',
      protocolVersion: snapshot.protocolVersion,
      era: snapshot.era,
      sessionId: snapshot.sessionId,
      serverInfo: snapshot.serverInfo,
      capabilities: snapshot.capabilities,
      toolCount: snapshot.tools.length,
    });
  }

  private openEvents(link: ServerLink): void {
    link.stream?.close();
    link.stream = undefined;
    const url = link.eventsUrl;
    if (!url) return;
    const publish = (status: 'connecting' | 'open' | 'error' | 'closed', error?: string) => link.connection.setEventsState({ url, status, error, received: link.received });
    link.stream = openEventStream({
      url,
      headers: link.config.events?.headers ?? link.config.headers,
      onStatus: (status, error) => {
        if (!this.closed) publish(status, error);
      },
      onEvent: (event) => {
        link.received += 1;
        publish('open');
        let data: unknown = event.data;
        try {
          data = JSON.parse(event.data);
        } catch {
          // Not JSON: keep the text.
        }
        this.onServerEvent(link.config.id, 'sse', event.event, data);
      },
    });
  }

  /** Resolves when every configured event stream is open (or has failed once). */
  async eventsReady(): Promise<void> {
    await Promise.all([...this.links.values()].map((link) => link.stream?.ready.catch(() => undefined)));
  }

  async close(): Promise<void> {
    this.closed = true;
    this.abort.abort();
    this.ask?.resolve({ action: 'cancel' });
    for (const waiting of [...this.speech.values()]) waiting.resolve();
    await this.provider?.dispose?.();
    await Promise.all(
      [...this.links.values()].map(async (link) => {
        link.stream?.close();
        await link.connection.close();
      }),
    );
  }

  /** Forget the conversation. With `reconnect`, also start new MCP sessions. */
  async reset(options: { reconnect?: boolean } = {}): Promise<void> {
    this.abort.abort();
    this.abort = new AbortController();
    this.ask?.resolve({ action: 'cancel' });
    this.ask = undefined;
    for (const waiting of [...this.speech.values()]) waiting.resolve();
    await this.queue.catch(() => undefined);
    await this.provider?.reset?.(this.id);
    this.history = [];
    this.providerState = new Map();
    this.transcript = [];
    this.timeline = [];
    this.screen = null;
    this.notification = null;
    this.held.length = 0;
    this.progress = null;
    this.status = 'idle';
    this.activeSkills.clear();
    this.scriptedAnswers.length = 0;
    this.host.emit({ type: 'reset', deviceId: this.id });
    if (options.reconnect) {
      await Promise.all([...this.links.values()].map((link) => this.connectLink(link)));
    } else {
      for (const link of this.links.values()) {
        const snapshot = link.connection.snapshot();
        if (snapshot.status === 'connected') {
          this.add({ kind: 'connection', server: snapshot.id, url: snapshot.url, status: 'connected', protocolVersion: snapshot.protocolVersion, era: snapshot.era, sessionId: snapshot.sessionId, serverInfo: snapshot.serverInfo, capabilities: snapshot.capabilities, toolCount: snapshot.tools.length });
        }
      }
    }
    this.patch({ ...this.statePatch(), servers: this.serverSnapshots(), skills: this.skillSummaries() });
  }

  // --- state for the UI -------------------------------------------------------

  private serverSnapshots(): ServerSnapshot[] {
    return [...this.links.values()].map((link) => link.connection.snapshot());
  }

  private skillSummaries(): SkillSummary[] {
    return this.skills.map((skill) => ({ name: skill.name, description: skill.description, path: skill.dir, active: this.activeSkills.has(skill.name), bodyChars: skill.body.length, files: skill.files }));
  }

  private statePatch(): DevicePatch {
    return { status: this.status, screen: this.screen, notification: this.notification, elicitation: this.ask?.pending ?? null, progress: this.progress };
  }

  snapshot(): DeviceSnapshot {
    return {
      id: this.id,
      name: this.config.name,
      kind: this.config.kind,
      person: this.config.person,
      wakeWord: this.config.wakeWord,
      voice: this.config.voice,
      hints: this.hints(),
      status: this.status,
      provider: this.providerSummary,
      servers: this.serverSnapshots(),
      skills: this.skillSummaries(),
      transcript: this.transcript,
      screen: this.screen,
      notification: this.notification,
      elicitation: this.ask?.pending ?? null,
      progress: this.progress,
      timeline: this.timeline,
    };
  }

  /** Things to try: from the configuration, else lines from the loaded scenarios that this device can replay. */
  private hints(): string[] {
    if (this.config.hints.length > 0) return this.config.hints;
    const lines = this.host.scriptedLines();
    const own = lines.filter((line) => line.deviceId === this.id);
    const routes = this.routes();
    const usable = own.length > 0 ? own : lines.filter((line) => line.script.every((action) => action.call === undefined || routes.has(action.call)));
    return [...new Set(usable.map((line) => line.text))].slice(0, 3);
  }

  get providerInfo(): ProviderSummary {
    return this.providerSummary;
  }

  currentScreen(): ScreenContent | null {
    return this.screen;
  }

  private patch(patch: DevicePatch): void {
    if (!this.closed) this.host.emit({ type: 'device', deviceId: this.id, patch });
  }

  private setStatus(status: DeviceStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.patch({ status });
  }

  private refreshStatus(): void {
    this.setStatus(this.ask ? 'asking' : this.busy > 0 ? 'thinking' : this.speech.size > 0 ? 'speaking' : 'idle');
  }

  // --- timeline ---------------------------------------------------------------

  /** Add an entry. `turn` defaults to the turn in progress; pass `null` for something that belongs to no turn. */
  private add(entry: NewTimelineEntry, turn: string | null | undefined = this.currentTurn): TimelineEntry {
    const full = { ...entry, id: `${this.id}-${(this.seq += 1)}`, seq: this.seq, at: new Date().toISOString(), ...(turn ? { turn } : {}) } as TimelineEntry;
    this.timeline.push(full);
    if (this.timeline.length > MAX_TIMELINE) this.timeline.splice(0, this.timeline.length - MAX_TIMELINE);
    if (!this.closed) this.host.emit({ type: 'timeline', deviceId: this.id, entry: full });
    return full;
  }

  private update<E extends TimelineEntry>(entry: E, changes: Partial<E>): E {
    Object.assign(entry, changes);
    if (!this.closed) this.host.emit({ type: 'timeline', deviceId: this.id, entry });
    return entry;
  }

  entriesOf(turn: string): TimelineEntry[] {
    return this.timeline.filter((entry) => entry.turn === turn);
  }

  private say(role: 'user' | 'assistant', text: string, source: TranscriptLine['source']): TranscriptLine {
    const line: TranscriptLine = { id: randomUUID(), role, text, at: new Date().toISOString(), source };
    this.transcript.push(line);
    if (this.transcript.length > 200) this.transcript.splice(0, this.transcript.length - 200);
    if (!this.closed) this.host.emit({ type: 'transcript', deviceId: this.id, line });
    return line;
  }

  // --- speech -----------------------------------------------------------------

  /** Speak. Resolves when a browser reports that it finished, or after an estimate when it does not. */
  speak(text: string, reason: SpeechEntry['reason'] = 'reply'): Promise<void> {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean) return Promise.resolve();
    const line = this.say('assistant', clean, reason);
    this.add({ kind: 'speech', text: clean, reason });
    if (this.closed) return Promise.resolve();
    this.host.emit({ type: 'speech', deviceId: this.id, id: line.id, text: clean, reason });
    if (!this.host.hasListeners()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const finish = () => {
        const waiting = this.speech.get(line.id);
        if (!waiting) return;
        clearTimeout(waiting.timer);
        this.speech.delete(line.id);
        this.refreshStatus();
        this.flushQuiet();
        resolve();
      };
      // The browser normally acknowledges; the timer covers a closed tab. Earlier
      // sentences are still being spoken, so allow for those too.
      const backlog = [...this.speech.keys()].length;
      const timer = setTimeout(finish, estimateSpeechMs(clean) * 1.6 + backlog * 4000 + 3000);
      timer.unref?.();
      this.speech.set(line.id, { resolve: finish, timer });
      this.refreshStatus();
    });
  }

  /** A browser finished (or skipped) speaking a line. */
  speechDone(id: string): void {
    this.speech.get(id)?.resolve();
  }

  /** Resolves when nothing is being spoken. */
  whenQuiet(): Promise<void> {
    if (this.speech.size === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.quietWaiters.push(resolve));
  }

  private flushQuiet(): void {
    if (this.speech.size > 0) return;
    for (const resolve of this.quietWaiters.splice(0)) resolve();
  }

  // --- tools ------------------------------------------------------------------

  /** Every tool the assistant may call, keyed by the name it sees. */
  private routes(): Map<string, ToolRoute> {
    const counts = new Map<string, number>();
    const all: ToolRoute[] = [];
    for (const link of this.links.values()) {
      for (const tool of link.connection.snapshot().tools) {
        all.push({ server: link.config.id, tool });
        counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
      }
    }
    const routes = new Map<string, ToolRoute>();
    for (const route of all) {
      const exposed = (counts.get(route.tool.name) ?? 0) > 1 ? `${route.server}__${route.tool.name}` : route.tool.name;
      routes.set(exposed, { server: route.server, tool: { ...route.tool, exposedName: exposed } });
    }
    return routes;
  }

  private skillActivation(): 'tool' | 'always' {
    return this.config.assistant.skillActivation ?? 'tool';
  }

  private providerTools(): ProviderTool[] {
    const tools: ProviderTool[] = [];
    for (const [name, route] of this.routes()) {
      if (route.tool.appOnly) continue;
      tools.push({ name, description: route.tool.description ?? route.tool.title ?? name, inputSchema: route.tool.inputSchema ?? { type: 'object', properties: {} } });
    }
    if (this.skillActivation() === 'tool') tools.push(...skillTools(this.skills));
    return tools;
  }

  /** Call a tool by the name the assistant sees. Never throws: failures come back as an error outcome. */
  async callTool(
    name: string,
    args: JsonObject,
    origin: ToolOrigin,
    turn: string | null | undefined = this.currentTurn,
    options: { show?: boolean } = {},
  ): Promise<{ outcome: ToolOutcome; result: ToolResult; entry?: ToolEntry }> {
    if (name === LOAD_SKILL_TOOL || name === READ_SKILL_FILE_TOOL) {
      const result = this.callSkillTool(name, args, turn);
      return { outcome: { text: toolResultText(result), isError: Boolean(result.isError) }, result };
    }
    const route = this.routes().get(name) ?? [...this.routes().values()].find((candidate) => candidate.tool.name === name);
    if (!route) {
      const known = [...this.routes().keys()].join(', ') || 'none';
      const result: ToolResult = { content: [{ type: 'text', text: `Error (unknown_tool): This device has no tool called "${name}". Available tools: ${known}.` }], isError: true };
      const entry = this.add({ kind: 'tool', server: '?', name, arguments: args, origin, status: 'error', result, error: 'Unknown tool', progress: [], durationMs: 0 }, turn) as ToolEntry;
      return { outcome: { text: toolResultText(result), isError: true }, result, entry };
    }
    return this.invoke(route, args, origin, turn, options);
  }

  /** Call a tool on a named server by its real name, as a card on the screen does. */
  async callServerTool(server: string, toolName: string, args: JsonObject, origin: ToolOrigin): Promise<ToolResult> {
    const link = this.links.get(server);
    const tool = link?.connection.snapshot().tools.find((candidate) => candidate.name === toolName);
    if (!link || !tool) {
      return { content: [{ type: 'text', text: `Error (unknown_tool): Server "${server}" has no tool called "${toolName}".` }], isError: true };
    }
    const { result } = await this.invoke({ server, tool }, args, origin, `${origin}-${randomUUID().slice(0, 8)}`);
    if (origin === 'card' && this.screen?.card && this.screen.server === server && tool.uiResourceUri === this.screen.card.uri) {
      // The card on screen has moved on (it asked for this result and redrew itself).
      // Remember where it is now, under the same id, so a reloaded page shows the same thing.
      this.screen = { ...this.screen, tool, arguments: args, result };
      this.patch({ screen: this.screen });
    }
    if (origin === 'card') {
      // The person acted on the screen. Put it in the conversation so the assistant knows.
      const id = `card_${randomUUID().slice(0, 8)}`;
      this.history.push(
        { role: 'assistant', text: '', toolCalls: [{ id, name: tool.exposedName, arguments: args }] },
        { role: 'tool', toolCallId: id, name: tool.exposedName, text: `(Called by the person from the card on the screen.)\n${toolResultText(result)}`, isError: Boolean(result.isError) },
      );
    }
    return result;
  }

  /** Call a tool straight from the device, the way a tap on a card button does, and report what happened. */
  async press(name: string, args: JsonObject, origin: ToolOrigin = 'scenario', options: { show?: boolean } = {}): Promise<TurnRecord & { result: ToolResult }> {
    const turn = `${origin}-${randomUUID().slice(0, 8)}`;
    const { result, outcome } = await this.callTool(name, args, origin, turn, options);
    const id = `${origin}_${randomUUID().slice(0, 8)}`;
    this.history.push(
      { role: 'assistant', text: '', toolCalls: [{ id, name, arguments: args }] },
      { role: 'tool', toolCallId: id, name, text: `(Called by the person from the screen.)\n${outcome.text}`, isError: outcome.isError },
    );
    return { turn, entries: this.entriesOf(turn), result };
  }

  private async invoke(
    route: ToolRoute,
    args: JsonObject,
    origin: ToolOrigin,
    turn: string | null | undefined,
    options: { show?: boolean } = {},
  ): Promise<{ outcome: ToolOutcome; result: ToolResult; entry: ToolEntry }> {
    const link = this.links.get(route.server)!;
    const entry = this.add(
      { kind: 'tool', server: route.server, name: route.tool.name, title: route.tool.title, arguments: args, origin, status: 'running', progress: [], uiResourceUri: route.tool.uiResourceUri },
      turn,
    ) as ToolEntry;
    const started = Date.now();
    this.busy += 1;
    this.refreshStatus();
    let result: ToolResult;
    try {
      result = await link.connection.callTool(route.tool.name, args, {
        signal: this.abort.signal,
        onProgress: (update) => {
          entry.progress.push({ at: new Date().toISOString(), ...update });
          this.update(entry, {});
          // On 2026-07-28 the client SDK adds a progress item of its own while it answers a
          // server's question ("Fulfilling input required by 'tools/call' (round 1)"). That is
          // for the inspector, which has it above; it is not something to show the person.
          if (SDK_PROGRESS.test(update.message ?? '')) return;
          this.progress = { tool: route.tool.title ?? route.tool.name, ...update };
          this.patch({ progress: this.progress });
        },
      });
      this.update(entry, { status: result.isError ? 'error' : 'ok', result, durationMs: Date.now() - started });
    } catch (error) {
      const message = errorMessage(error);
      result = { content: [{ type: 'text', text: `Error (call_failed): ${message}` }], isError: true };
      this.update(entry, { status: 'error', error: message, result, durationMs: Date.now() - started });
    } finally {
      this.busy -= 1;
      if (this.progress) {
        this.progress = null;
        this.patch({ progress: null });
      }
      this.refreshStatus();
    }
    // A call made by a card is answered to the card; the card redraws itself.
    if (origin !== 'card' && options.show !== false) await this.show(route, args, result, origin, turn);
    return { outcome: { text: toolResultText(result), isError: Boolean(result.isError), structuredContent: result.structuredContent }, result, entry };
  }

  private async show(route: ToolRoute, args: JsonObject, result: ToolResult, origin: ToolOrigin, turn: string | null | undefined): Promise<void> {
    if (this.config.kind === 'speaker') return;
    const screen: ScreenContent = { id: randomUUID(), at: new Date().toISOString(), server: route.server, tool: route.tool, arguments: args, result, origin };
    const uri = route.tool.uiResourceUri;
    if (uri) {
      const started = Date.now();
      try {
        const card = await this.links.get(route.server)!.connection.readCard(uri);
        screen.card = card;
        if (!this.timeline.some((entry) => entry.kind === 'resource' && entry.uri === uri && entry.server === route.server && !entry.error)) {
          this.add({ kind: 'resource', server: route.server, uri, mimeType: card.mimeType, bytes: Buffer.byteLength(card.html), durationMs: Date.now() - started, origin }, turn);
        }
      } catch (error) {
        this.add({ kind: 'resource', server: route.server, uri, origin, durationMs: Date.now() - started, error: errorMessage(error) }, turn);
      }
    }
    this.screen = screen;
    this.patch({ screen });
  }

  /** Read a resource for a card (`resources/read` through the host). */
  async readResource(server: string, uri: string, origin: ToolOrigin = 'card'): Promise<unknown> {
    const link = this.links.get(server);
    if (!link) throw new Error(`This device is not connected to a server called "${server}".`);
    const started = Date.now();
    try {
      const result = await link.connection.readResource(uri);
      const first = result.contents[0];
      this.add({ kind: 'resource', server, uri, mimeType: first?.mimeType, bytes: Buffer.byteLength(first?.text ?? first?.blob ?? ''), durationMs: Date.now() - started, origin }, null);
      return result;
    } catch (error) {
      this.add({ kind: 'resource', server, uri, origin, durationMs: Date.now() - started, error: errorMessage(error) }, null);
      throw error;
    }
  }

  private callSkillTool(name: string, args: JsonObject, turn: string | null | undefined): ToolResult {
    const skill = this.skills.find((candidate) => candidate.name === args.name);
    if (!skill) {
      return { content: [{ type: 'text', text: `Error (unknown_skill): No skill called "${String(args.name)}". Skills: ${this.skills.map((candidate) => candidate.name).join(', ') || 'none'}.` }], isError: true };
    }
    if (name === LOAD_SKILL_TOOL) {
      this.activeSkills.add(skill.name);
      this.add({ kind: 'skill', name: skill.name, action: 'loaded', chars: skill.body.length }, turn);
      this.patch({ skills: this.skillSummaries() });
      const files = skill.files.length > 0 ? `\n\nFiles in this skill (read with ${READ_SKILL_FILE_TOOL}): ${skill.files.join(', ')}` : '';
      return { content: [{ type: 'text', text: `# Skill: ${skill.name}\n\n${skill.body}${files}` }] };
    }
    try {
      const file = String(args.file ?? '');
      const text = readSkillFile(skill, file);
      this.add({ kind: 'skill', name: skill.name, action: 'read-file', file, chars: text.length }, turn);
      return { content: [{ type: 'text', text }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error (skill_file): ${errorMessage(error)}` }], isError: true };
    }
  }

  /** Note something a card did that is not a tool call (a link, a message, a log line). */
  cardEvent(action: string, detail: unknown, uri?: string): void {
    this.add({ kind: 'card', action, uri, detail }, null);
  }

  // --- turns ------------------------------------------------------------------

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** The person said (or typed) something. */
  hear(text: string, options: HearOptions = {}): Promise<TurnRecord> {
    const said = text.replace(/\s+/g, ' ').trim();
    const source = options.source ?? 'typed';
    if (!said) return Promise.resolve({ turn: '', entries: [] });

    // A server is waiting for an answer: this is the answer, not a new request.
    if (this.ask) return this.answerBySpeech(said, source);

    if (this.held.length > 0 && NOTIFICATION_REQUEST.test(said)) {
      this.say('user', said, source);
      this.add({ kind: 'utterance', text: said, source }, null);
      return this.playNotification() ?? Promise.resolve({ turn: '', entries: [] });
    }
    return this.enqueue(() => this.runTurn(said, source, options));
  }

  private async runTurn(said: string, source: UtteranceSource, options: HearOptions): Promise<TurnRecord> {
    const turn = `turn-${randomUUID().slice(0, 8)}`;
    this.currentTurn = turn;
    this.say('user', said, source);
    this.add({ kind: 'utterance', text: said, source });
    if (this.notification?.state === 'done') {
      this.notification = null;
      this.patch({ notification: null });
    }
    this.busy += 1;
    this.refreshStatus();

    const useScript = Boolean(options.script) || options.scripted === true;
    const provider: Provider | undefined = useScript ? this.scripted : this.provider;
    let error: string | undefined;
    try {
      // A server that was down when the stage started, or went away since, gets another chance before each turn.
      await Promise.all([...this.links.values()].map((link) => link.connection.ensure()));
      if (!provider) {
        error = this.providerSummary.error ?? 'No model provider is configured.';
        this.add({ kind: 'error', message: `The "${this.providerSummary.id}" provider is not configured`, detail: error });
        void this.speak(error, 'reply');
        this.history.push({ role: 'user', text: said }, { role: 'assistant', text: error, toolCalls: [] });
      } else {
        const servers = [...this.links.values()].map((link) => {
          const snapshot = link.connection.snapshot();
          return { id: snapshot.id, title: snapshot.serverInfo?.title ?? snapshot.serverInfo?.name, instructions: snapshot.instructions };
        });
        const ctx: RunContext = {
          deviceId: this.id,
          system: buildSystemPrompt({ device: this.config, servers, skills: this.skills, skillActivation: this.skillActivation(), extra: this.config.assistant.instructions }),
          history: this.history,
          userText: said,
          tools: this.providerTools(),
          maxRounds: this.config.assistant.maxRounds ?? 8,
          signal: this.abort.signal,
          state: this.providerState,
          vars: this.host.vars,
          script: options.script,
          callTool: async (name, args) => (await this.callTool(name, args, 'assistant', turn)).outcome,
          say: (text) => void this.speak(text, 'reply'),
          report: (report) => {
            this.add({ kind: 'model', provider: provider.id, model: report.model ?? provider.model, round: report.round, text: report.text, toolCalls: report.toolCalls, stopReason: report.stopReason, usage: report.usage, durationMs: report.durationMs, note: report.note }, turn);
          },
        };
        const result = await provider.run(ctx);
        this.history.push({ role: 'user', text: said }, ...result.messages);
      }
    } catch (caught) {
      error = errorMessage(caught);
      this.add({ kind: 'error', message: 'The turn failed', detail: error }, turn);
      const spoken = "Sorry, I couldn't do that just now.";
      void this.speak(spoken, 'reply');
      this.history.push({ role: 'user', text: said }, { role: 'assistant', text: spoken, toolCalls: [] });
    } finally {
      this.busy -= 1;
      this.currentTurn = undefined;
      this.refreshStatus();
    }
    return { turn, entries: this.entriesOf(turn), error };
  }

  // --- questions from a server (MCP elicitation) --------------------------------

  /**
   * Queue the answer to the next question a server asks. Used by scenarios.
   * `cue` is called with a spoken answer just before it is given, so a UI can
   * show (and voice) the person saying it; the answer waits until it resolves.
   */
  queueAnswer(answer: string | { content?: JsonObject; action?: 'decline' | 'cancel' }, cue?: (text: string) => Promise<void>): void {
    this.scriptedAnswers.push({ answer, cue });
  }

  clearQueuedAnswers(): void {
    this.scriptedAnswers.length = 0;
  }

  private async onElicitation(request: ElicitationRequest): Promise<ElicitationAnswer> {
    const turn = this.currentTurn;
    if (request.mode === 'url') {
      this.add({ kind: 'elicitation', server: request.server, message: request.message, requestedSchema: { url: request.url }, status: 'decline', answeredBy: 'timeout' }, turn);
      return { action: 'decline' };
    }
    const fields = formFields(request.requestedSchema);
    const pending: PendingElicitation = { id: randomUUID(), server: request.server, message: request.message, requestedSchema: request.requestedSchema, at: new Date().toISOString() };
    const entry = this.add({ kind: 'elicitation', server: request.server, message: request.message, requestedSchema: request.requestedSchema, status: 'pending' }, turn) as ElicitationEntry;

    const answer = new Promise<ElicitationAnswer>((resolve) => {
      this.ask = { pending, entryId: entry.id, fields, startedAt: Date.now(), attempts: 0, resolve };
    });
    this.patch({ elicitation: pending });
    this.refreshStatus();
    const spoken = this.speak(questionForSpeech(request.message, fields), 'question');

    const scripted = this.scriptedAnswers.shift();
    if (scripted !== undefined) {
      // Let the question be heard before the scripted answer comes.
      void spoken.then(async () => {
        if (this.ask?.pending.id !== pending.id) return;
        const { answer, cue } = scripted;
        if (typeof answer === 'string') {
          await cue?.(answer).catch(() => undefined);
          if (this.ask?.pending.id === pending.id) void this.answerBySpeech(answer, 'scenario');
        } else if (answer.action) this.settle({ action: answer.action }, 'scenario');
        else this.settle({ action: 'accept', content: answer.content ?? {} }, 'scenario');
      });
    } else if (!this.host.hasListeners()) {
      // Nobody is there to answer.
      this.settle({ action: 'decline' }, 'timeout');
    } else if (this.ask) {
      const timer = setTimeout(() => {
        if (this.ask?.pending.id === pending.id) this.settle({ action: 'cancel' }, 'timeout');
      }, 120_000);
      timer.unref?.();
      this.ask.timer = timer;
    }
    return answer;
  }

  private settle(answer: ElicitationAnswer, by: ElicitationEntry['answeredBy'], heard?: string): void {
    const ask = this.ask;
    if (!ask) return;
    this.ask = undefined;
    if (ask.timer) clearTimeout(ask.timer);
    const entry = this.timeline.find((candidate) => candidate.id === ask.entryId) as ElicitationEntry | undefined;
    if (entry) this.update(entry, { status: answer.action, content: answer.content, answeredBy: by, heard, durationMs: Date.now() - ask.startedAt });
    this.patch({ elicitation: null });
    this.refreshStatus();
    ask.resolve(answer);
  }

  /** The person answered on the screen. */
  answerElicitation(id: string, answer: ElicitationAnswer): boolean {
    if (this.ask?.pending.id !== id) return false;
    if (answer.action === 'accept') {
      const labels = this.ask.fields
        .map((field) => {
          const value = answer.content?.[field.key];
          const label = field.options?.find((option) => option.value === value)?.label;
          return label ?? (value === undefined ? undefined : String(value));
        })
        .filter(Boolean)
        .join(', ');
      if (labels) this.say('user', labels, 'card');
    }
    this.settle(answer, 'screen');
    return true;
  }

  private async answerBySpeech(said: string, source: UtteranceSource): Promise<TurnRecord> {
    const ask = this.ask;
    if (!ask) return { turn: '', entries: [] };
    this.say('user', said, source);
    const parsed = answerFromSpeech(ask.fields, said);
    const by = source === 'scenario' ? 'scenario' : 'voice';
    if (parsed.action === 'accept') this.settle({ action: 'accept', content: parsed.content }, by, said);
    else if (parsed.action === 'decline') this.settle({ action: 'decline' }, by, said);
    else {
      ask.attempts += 1;
      if (ask.attempts >= 2 || source === 'scenario') this.settle({ action: 'cancel' }, by, said);
      else {
        const hint = this.config.kind === 'speaker' ? '' : ' You can also choose on the screen.';
        void this.speak(`Sorry, I didn't catch that. ${questionForSpeech(ask.pending.message, ask.fields)}${hint}`, 'question');
      }
    }
    return { turn: '', entries: [] };
  }

  // --- events and proactive announcements ---------------------------------------

  private onServerEvent(server: string, channel: 'sse' | 'mcp', name: string, data: unknown): void {
    if (this.closed) return;
    const rules = this.links.get(server)?.config.events?.announce ?? [];
    const key = channel === 'mcp' ? `mcp:${name}` : name;
    const rule = rules.find((candidate) => candidate.on === key && (!candidate.when || matchValue(data, candidate.when) === undefined));
    const entry = this.add({ kind: 'event', server, channel, name, data, matched: rule ? rule.on : undefined }, null) as ServerEventEntry;
    const event: ReceivedEvent = { seq: (this.eventSeq += 1), server, channel, name, data };
    if (rule) event.announced = this.announce(server, rule, data, entry);
    this.events.push(event);
    if (this.events.length > 200) this.events.shift();
    for (const waiter of [...this.eventWaiters]) waiter(event);
  }

  /** Sequence number of the newest event received so far. */
  eventCursor(): number {
    return this.eventSeq;
  }

  /** Wait for an event that arrived after `after`. Events already received count. */
  waitForEvent(match: { name: string; where?: JsonObject; after?: number; timeoutMs?: number }): Promise<ReceivedEvent> {
    const fits = (event: ReceivedEvent) =>
      event.seq > (match.after ?? 0) && (event.name === match.name || `${event.channel}:${event.name}` === match.name) && (!match.where || matchValue(event.data, match.where) === undefined);
    const existing = this.events.find(fits);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timeoutMs = match.timeoutMs ?? 15_000;
      const waiter = (event: ReceivedEvent) => {
        if (!fits(event)) return;
        clearTimeout(timer);
        this.eventWaiters.delete(waiter);
        resolve(event);
      };
      const timer = setTimeout(() => {
        this.eventWaiters.delete(waiter);
        const seen = this.events.filter((event) => event.seq > (match.after ?? 0)).map((event) => event.name);
        reject(new Error(`No "${match.name}" event reached ${this.id} within ${timeoutMs / 1000}s.${seen.length > 0 ? ` Events seen: ${[...new Set(seen)].join(', ')}.` : ' No events arrived at all; is the events URL configured for this device?'}`));
      }, timeoutMs);
      this.eventWaiters.add(waiter);
    });
  }

  private announce(server: string, rule: AnnounceRule, data: unknown, source: ServerEventEntry): Promise<TurnRecord> {
    const turn = `announce-${randomUUID().slice(0, 8)}`;
    this.update(source, { turn });
    const vars: Record<string, unknown> = { ...(data && typeof data === 'object' && !Array.isArray(data) ? (data as JsonObject) : {}), event: data, person: this.config.person, device: { id: this.id, name: this.config.name } };
    const text = rule.say ? renderText(rule.say, vars) : '';
    const settings = this.config.announcements;
    const watched = this.host.hasListeners();
    const light = () => {
      this.notification = { id: randomUUID(), text: text || rule.on, at: new Date().toISOString(), state: 'pending', event: rule.on };
      this.patch({ notification: this.notification });
    };

    if (watched && settings.mode === 'indicator') {
      // Light the indicator and wait to be asked. The device stays free for other requests meanwhile.
      light();
      return new Promise<TurnRecord>((resolve) => {
        this.held.push(() => {
          const delivered = this.enqueue(() => this.deliver(turn, server, rule, vars, text));
          resolve(delivered);
          return delivered;
        });
      });
    }
    // First the indicator, then the voice.
    return this.enqueue(async () => {
      await this.whenQuiet();
      light();
      if (watched && settings.delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, settings.delayMs));
      return this.deliver(turn, server, rule, vars, text);
    });
  }

  private async deliver(turn: string, server: string, rule: AnnounceRule, vars: Record<string, unknown>, text: string): Promise<TurnRecord> {
    if (this.closed) return { turn, entries: [] };
    this.currentTurn = turn;
    this.notification = { id: this.notification?.id ?? randomUUID(), text: text || rule.on, at: this.notification?.at ?? new Date().toISOString(), state: 'speaking', event: rule.on };
    this.patch({ notification: this.notification });
    const spoken: string[] = [];
    let error: string | undefined;
    try {
      const speaking: Array<Promise<void>> = [];
      if (text) {
        spoken.push(text);
        speaking.push(this.speak(text, 'announcement'));
      }
      const record: ChatMessage[] = [];
      if (rule.show) {
        const args = renderValue(rule.show.args ?? {}, vars) as JsonObject;
        const { outcome, result } = await this.callTool(rule.show.tool, args, 'announcement', turn);
        const id = `announce_${randomUUID().slice(0, 8)}`;
        record.push({ role: 'assistant', text: '', toolCalls: [{ id, name: rule.show.tool, arguments: args }] }, { role: 'tool', toolCallId: id, name: rule.show.tool, text: outcome.text, isError: outcome.isError });
        if (rule.then_say && !result.isError) {
          const after = renderText(rule.then_say, { ...vars, result: result.structuredContent ?? {} });
          if (after) {
            spoken.push(after);
            speaking.push(this.speak(after, 'announcement'));
          }
        }
      }
      // Keep the conversation in step: the assistant should know what it just announced.
      this.history.push(
        { role: 'user', text: `[The service "${server}" sent the event "${rule.on}". The device announced it to the person without being asked.]` },
        ...record,
        { role: 'assistant', text: spoken.join(' ') || '(announcement shown on screen)', toolCalls: [] },
      );
      await Promise.all(speaking);
    } catch (caught) {
      error = errorMessage(caught);
      this.add({ kind: 'error', message: `Announcement for "${rule.on}" failed`, detail: error }, turn);
    } finally {
      this.currentTurn = undefined;
      this.notification = this.notification ? { ...this.notification, state: 'done' } : null;
      this.patch({ notification: this.notification });
      this.refreshStatus();
    }
    return { turn, entries: this.entriesOf(turn), error };
  }

  /** Play the announcements that are waiting behind the indicator. */
  playNotification(): Promise<TurnRecord> | undefined {
    const waiting = this.held.splice(0);
    if (waiting.length === 0) return undefined;
    const played = waiting.map((play) => play());
    return played.at(-1);
  }

  get hasHeldNotification(): boolean {
    return this.held.length > 0;
  }

  dismissNotification(): void {
    if (this.held.length > 0) return;
    if (this.notification?.state === 'done') {
      this.notification = null;
      this.patch({ notification: null });
    }
  }
}
