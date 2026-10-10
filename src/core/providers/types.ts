/**
 * The contract between a device and whatever decides what the assistant does
 * next: a hosted model, a local model, or a scenario script.
 *
 * A provider receives one user utterance and runs the whole turn. It calls
 * tools through `ctx.callTool` (which goes to the device's MCP connections and
 * shows up in the inspector), speaks through `ctx.say`, and returns the
 * messages the turn added to the conversation.
 */
import type { JsonObject, ModelEntry } from '../../shared/types.js';
import type { AssistantConfig, ProviderId } from '../config.js';

export interface ProviderTool {
  name: string;
  description: string;
  inputSchema: JsonObject;
}

export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: JsonObject;
}

/** What a tool call returns to the provider. `text` is what the model reads. */
export interface ToolOutcome {
  text: string;
  isError: boolean;
  structuredContent?: unknown;
}

/** A provider-neutral conversation message. */
export type ChatMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls: ToolCallRequest[] }
  | { role: 'tool'; toolCallId: string; name: string; text: string; isError: boolean };

export type ModelTurnReport = Pick<ModelEntry, 'round' | 'text' | 'toolCalls' | 'stopReason' | 'usage' | 'durationMs' | 'note' | 'model'>;

export interface ScriptAction {
  /** Call a tool. */
  call?: string;
  args?: JsonObject;
  /** Keep the tool's structured result under this name for later `{{ ... }}` placeholders. */
  save?: string;
  /** Say something. `{{ ... }}` placeholders read saved results. */
  say?: string;
  /** Load a skill, as a model would with `load_skill`. */
  skill?: string;
  /** Only run this action when the saved value at this path is truthy (or equals `equals`). */
  if?: string | { path: string; equals?: unknown; not?: unknown };
}

export interface RunContext {
  deviceId: string;
  system: string;
  /** The conversation before this utterance. */
  history: readonly ChatMessage[];
  userText: string;
  tools: ProviderTool[];
  maxRounds: number;
  signal: AbortSignal;
  /** Per-device scratch space that lives until the device is reset. Providers keep native transcripts or session ids here. */
  state: Map<string, unknown>;
  /** Values saved by scripts and scenario steps, shared across the stage. */
  vars: Record<string, unknown>;
  /** The script to replay for this utterance, when a scenario supplies one. */
  script?: ScriptAction[];
  callTool(name: string, args: JsonObject): Promise<ToolOutcome>;
  /** Speak now. Use it for text that comes before or between tool calls, and for the final answer. */
  say(text: string): void;
  /** Record one model turn in the inspector. */
  report(turn: ModelTurnReport): void;
}

export interface RunResult {
  /** Messages this turn added, in order, not including the user message. */
  messages: ChatMessage[];
}

export interface Provider {
  readonly id: ProviderId;
  readonly label: string;
  readonly model?: string;
  run(ctx: RunContext): Promise<RunResult>;
  /** Forget anything kept for a device, such as a live session. */
  reset?(deviceId: string): Promise<void> | void;
  dispose?(): Promise<void> | void;
}

export interface ProviderFactoryInput {
  assistant: AssistantConfig;
  env: NodeJS.ProcessEnv;
}

/** Thrown when a provider is selected but cannot work as configured. The message says how to fix it. */
export class ProviderNotConfiguredError extends Error {
  constructor(
    readonly provider: ProviderId,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderNotConfiguredError';
  }
}

export function optionString(options: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = options?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function optionNumber(options: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = options?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
