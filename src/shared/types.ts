/**
 * Types shared by the stage server (Node) and the browser UI.
 *
 * Everything here is plain JSON: it is what travels over `/api/stream` and what
 * "Copy as JSON" in the inspector puts on the clipboard.
 */

export const PRODUCT_NAME = 'Voicestage';
export const PRODUCT_VERSION = '0.1.0';

export type JsonObject = Record<string, unknown>;

export type DeviceKind = 'display' | 'speaker' | 'phone';
export type DeviceStatus = 'idle' | 'thinking' | 'speaking' | 'asking';

/** An MCP tool result as the client received it. */
export interface ToolResult {
  content?: Array<{ type: string; text?: string; [key: string]: unknown }>;
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: JsonObject;
}

export interface ToolSummary {
  /** Name on the MCP server. */
  name: string;
  /** Name the assistant sees. Equal to `name` unless two servers on one device share a tool name. */
  exposedName: string;
  server: string;
  title?: string;
  description?: string;
  inputSchema?: JsonObject;
  /** `ui://` resource linked from the tool through `_meta.ui.resourceUri` (MCP Apps). */
  uiResourceUri?: string;
  readOnly?: boolean;
  /** True when the tool is only meant to be called from its card (`_meta.ui.visibility: ["app"]`). */
  appOnly?: boolean;
}

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'error' | 'closed';

export interface ServerSnapshot {
  id: string;
  url: string;
  status: ConnectionStatus;
  error?: string;
  /** Protocol version agreed with the server, e.g. "2025-11-25". */
  protocolVersion?: string;
  /** "legacy" is the 2025 initialize handshake with a session; "modern" is 2026-07-28 and later. */
  era?: string;
  sessionId?: string;
  serverInfo?: { name: string; title?: string; version: string };
  capabilities?: JsonObject;
  instructions?: string;
  tools: ToolSummary[];
  resources: Array<{ uri: string; name?: string; mimeType?: string }>;
  /** State of the server-sent events subscription, when one is configured. */
  events?: { url: string; status: 'connecting' | 'open' | 'error' | 'closed'; error?: string; received: number };
}

export interface SkillSummary {
  name: string;
  description: string;
  path: string;
  /** True once the body has been loaded into the conversation. */
  active: boolean;
  bodyChars: number;
  files: string[];
}

export interface ProviderSummary {
  id: string;
  label: string;
  model?: string;
  ready: boolean;
  /** Why the provider cannot run, in words a person can act on. */
  error?: string;
}

export interface TranscriptLine {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  at: string;
  /** How a user line arrived, or why an assistant line was spoken. */
  source?: UtteranceSource | 'reply' | 'announcement' | 'question';
}

export type UtteranceSource = 'voice' | 'typed' | 'scenario' | 'card';

/** Where a tool call came from. */
export type ToolOrigin = 'assistant' | 'card' | 'scenario' | 'announcement' | 'inspector';

export interface CardResource {
  uri: string;
  mimeType?: string;
  html: string;
  /** `_meta.ui.csp` of the resource, when the server declares one. */
  csp?: { connectDomains?: string[]; resourceDomains?: string[]; frameDomains?: string[]; baseUriDomains?: string[] };
  permissions?: JsonObject;
  prefersBorder?: boolean;
}

/** What a device with a screen is showing. */
export interface ScreenContent {
  id: string;
  at: string;
  server: string;
  tool: ToolSummary;
  arguments: JsonObject;
  result: ToolResult;
  /** Present when the tool links an MCP Apps card; absent means the default card is drawn from the result. */
  card?: CardResource;
  origin: ToolOrigin;
}

export interface PendingElicitation {
  id: string;
  server: string;
  message: string;
  requestedSchema: JsonObject;
  at: string;
}

export interface NotificationState {
  id: string;
  text: string;
  at: string;
  /** `pending`: the indicator is lit. `speaking`: being read out. `done`: finished, kept until the next turn. */
  state: 'pending' | 'speaking' | 'done';
  event?: string;
}

export interface DeviceSnapshot {
  id: string;
  name: string;
  kind: DeviceKind;
  person: { name: string; role?: string };
  /** Word that starts a hands-free request when wake mode is on. */
  wakeWord: string;
  /** Speech synthesis preferences for this device's assistant voice. */
  voice: { name?: string; lang?: string; rate?: number; pitch?: number };
  /** Things to try, shown on the idle screen. */
  hints: string[];
  status: DeviceStatus;
  provider: ProviderSummary;
  servers: ServerSnapshot[];
  skills: SkillSummary[];
  transcript: TranscriptLine[];
  screen: ScreenContent | null;
  notification: NotificationState | null;
  elicitation: PendingElicitation | null;
  /** Latest progress notification of a running tool call, for the screen. */
  progress: { tool: string; progress: number; total?: number; message?: string } | null;
  timeline: TimelineEntry[];
}

// --- inspector timeline -------------------------------------------------------

interface EntryBase {
  id: string;
  seq: number;
  at: string;
  /** Groups everything that happened because of one utterance or one announcement. */
  turn?: string;
}

export interface UtteranceEntry extends EntryBase {
  kind: 'utterance';
  text: string;
  source: UtteranceSource;
}

export interface ModelEntry extends EntryBase {
  kind: 'model';
  provider: string;
  model?: string;
  round: number;
  text?: string;
  toolCalls: Array<{ id: string; name: string; arguments: unknown }>;
  stopReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
  durationMs?: number;
  note?: string;
}

export interface SpeechEntry extends EntryBase {
  kind: 'speech';
  text: string;
  reason: 'reply' | 'announcement' | 'question';
}

export interface ToolEntry extends EntryBase {
  kind: 'tool';
  server: string;
  name: string;
  title?: string;
  arguments: unknown;
  origin: ToolOrigin;
  status: 'running' | 'ok' | 'error';
  result?: ToolResult;
  /** Set when the call itself failed (transport or protocol error) rather than returning `isError`. */
  error?: string;
  durationMs?: number;
  progress: Array<{ at: string; progress: number; total?: number; message?: string }>;
  uiResourceUri?: string;
}

export interface ElicitationEntry extends EntryBase {
  kind: 'elicitation';
  server: string;
  message: string;
  requestedSchema: JsonObject;
  status: 'pending' | 'accept' | 'decline' | 'cancel';
  content?: JsonObject;
  answeredBy?: 'voice' | 'screen' | 'scenario' | 'timeout';
  heard?: string;
  durationMs?: number;
}

export interface ServerEventEntry extends EntryBase {
  kind: 'event';
  server: string;
  /** `sse` for the configured events URL, `mcp` for a notification on the MCP connection. */
  channel: 'sse' | 'mcp';
  name: string;
  data: unknown;
  /** Announcement rule that matched, if any. */
  matched?: string;
}

export interface ResourceEntry extends EntryBase {
  kind: 'resource';
  server: string;
  uri: string;
  mimeType?: string;
  bytes?: number;
  durationMs?: number;
  origin: ToolOrigin;
  error?: string;
}

export interface ConnectionEntry extends EntryBase {
  kind: 'connection';
  server: string;
  url: string;
  status: ConnectionStatus;
  protocolVersion?: string;
  era?: string;
  sessionId?: string;
  serverInfo?: { name: string; title?: string; version: string };
  capabilities?: JsonObject;
  toolCount?: number;
  error?: string;
}

export interface SkillEntry extends EntryBase {
  kind: 'skill';
  name: string;
  action: 'loaded' | 'read-file';
  file?: string;
  chars?: number;
}

export interface CardEntry extends EntryBase {
  kind: 'card';
  /** Message from an MCP Apps card that is not a tool call: a link, a log line, a chat message, a size change. */
  action: string;
  uri?: string;
  detail?: unknown;
}

export interface ErrorEntry extends EntryBase {
  kind: 'error';
  message: string;
  detail?: string;
}

export type TimelineEntry =
  | UtteranceEntry
  | ModelEntry
  | SpeechEntry
  | ToolEntry
  | ElicitationEntry
  | ServerEventEntry
  | ResourceEntry
  | ConnectionEntry
  | SkillEntry
  | CardEntry
  | ErrorEntry;

export type TimelineKind = TimelineEntry['kind'];

/** A timeline entry before the device stamps it with an id, a sequence number and a time. */
export type NewTimelineEntry = TimelineEntry extends infer E ? (E extends TimelineEntry ? Omit<E, 'id' | 'seq' | 'at'> : never) : never;

// --- scenarios ----------------------------------------------------------------

export interface ScenarioSummary {
  id: string;
  file: string;
  name: string;
  description?: string;
  devices: string[];
  steps: Array<{ index: number; device?: string; label: string; kind: string }>;
}

export interface CheckResult {
  ok: boolean;
  label: string;
  detail?: string;
}

export interface StepResult {
  index: number;
  label: string;
  device?: string;
  kind: string;
  status: 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
  checks: CheckResult[];
  error?: string;
  durationMs?: number;
}

export interface ScenarioRunState {
  runId: string;
  scenario: ScenarioSummary;
  mode: 'scripted' | 'live';
  status: 'running' | 'passed' | 'failed' | 'stopped';
  /** `step` waits for the Next control before each step; handy when recording. */
  pacing: 'auto' | 'step';
  waitingForNext: boolean;
  steps: StepResult[];
  startedAt: string;
  finishedAt?: string;
}

// --- stream -------------------------------------------------------------------

export interface StageSnapshot {
  name: string;
  version: string;
  configPath?: string;
  devices: DeviceSnapshot[];
  scenarios: ScenarioSummary[];
  run: ScenarioRunState | null;
}

export type DevicePatch = Partial<Omit<DeviceSnapshot, 'id' | 'timeline' | 'transcript'>>;

export type StageEvent =
  | { type: 'snapshot'; stage: StageSnapshot }
  | { type: 'device'; deviceId: string; patch: DevicePatch }
  | { type: 'transcript'; deviceId: string; line: TranscriptLine }
  | { type: 'timeline'; deviceId: string; entry: TimelineEntry }
  | { type: 'speech'; deviceId: string; id: string; text: string; reason: SpeechEntry['reason'] }
  /** A scenario is about to speak a person's line: show it (and voice it) first, then report back. */
  | { type: 'cue'; id: string; deviceId: string; text: string }
  | { type: 'reset'; deviceId: string }
  | { type: 'scenario'; run: ScenarioRunState | null };
