/**
 * Claude through a local Claude Code login, using `@anthropic-ai/claude-agent-sdk`.
 * No API key: it uses whatever account `claude` is signed in to on this machine.
 *
 * The Agent SDK runs its own agent loop, so this provider does not use the
 * shared tool loop. Instead it hands the SDK an in-process MCP server whose
 * tools are the device's tools; every call the model makes comes back here
 * and goes out through the device's own MCP connection. That keeps one MCP
 * session per device, and puts every call in the inspector.
 *
 * Claude Code's built-in tools (files, shell, web) are switched off, user and
 * project settings are not loaded, and nothing is written to the session
 * history on disk.
 *
 * One SDK session is kept open per device, so a follow-up ("yes, go ahead")
 * has the earlier turns in context without starting a new process.
 */
import { tmpdir } from 'node:os';
import type { McpSdkServerConfigWithInstance, Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { PRODUCT_VERSION } from '../../shared/types.js';
import { optionString, ProviderNotConfiguredError, type ChatMessage, type Provider, type ProviderFactoryInput, type RunContext, type RunResult, type ToolCallRequest } from './types.js';

const SERVER_NAME = 'stage';
const TOOL_PREFIX = `mcp__${SERVER_NAME}__`;

/** A minimal async queue: the SDK reads user messages from it for as long as the session lives. */
class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private readonly items: SDKUserMessage[] = [];
  private waiting: ((result: IteratorResult<SDKUserMessage>) => void) | undefined;
  private ended = false;

  push(message: SDKUserMessage): void {
    if (this.ended) return;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ value: message, done: false });
    } else this.items.push(message);
  }

  end(): void {
    this.ended = true;
    this.waiting?.({ value: undefined, done: true });
    this.waiting = undefined;
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}

interface ActiveTurn {
  ctx: RunContext;
  messages: ChatMessage[];
  round: number;
  toolCalls: number;
  spoke: boolean;
  resolve(result: RunResult): void;
  reject(error: Error): void;
}

class DeviceSession {
  private readonly queue = new MessageQueue();
  private query: Query | undefined;
  private turn: ActiveTurn | undefined;
  private closed = false;
  private stderr = '';
  private toolSignature = '';
  model: string | undefined;

  constructor(
    private readonly sdk: typeof import('@anthropic-ai/claude-agent-sdk'),
    private readonly settings: { model?: string; effort?: Options['effort']; executable?: string },
  ) {}

  /** The in-process MCP server the SDK talks to. Its tool list and calls are answered from the current turn. */
  private buildServer(): McpSdkServerConfigWithInstance {
    const instance = new McpServer({ name: SERVER_NAME, version: PRODUCT_VERSION });
    instance.server.registerCapabilities({ tools: {} });
    // The device's tools already have JSON Schemas, so the low-level handlers are
    // used directly instead of redefining every tool with a Zod shape.
    instance.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: (this.turn?.ctx.tools ?? []).map((tool) => ({ name: tool.name, description: tool.description, inputSchema: { ...tool.inputSchema, type: 'object' as const } })),
    }));
    instance.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const turn = this.turn;
      if (!turn) return { content: [{ type: 'text' as const, text: 'No turn is in progress.' }], isError: true };
      turn.toolCalls += 1;
      if (turn.toolCalls > turn.ctx.maxRounds * 2) {
        return { content: [{ type: 'text' as const, text: `Not run: this turn reached its limit of tool calls. Answer the person with what you have.` }], isError: true };
      }
      const name = request.params.name;
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      const outcome = await turn.ctx.callTool(name, args);
      turn.messages.push({ role: 'tool', toolCallId: `${name}_${turn.toolCalls}`, name, text: outcome.text, isError: outcome.isError });
      return { content: [{ type: 'text' as const, text: outcome.text || '(no content)' }], isError: outcome.isError };
    });
    return { type: 'sdk', name: SERVER_NAME, instance, timeout: 300_000 } as McpSdkServerConfigWithInstance;
  }

  private start(ctx: RunContext): void {
    this.toolSignature = ctx.tools.map((tool) => tool.name).join(',');
    const options: Options = {
      systemPrompt: ctx.system,
      // No built-in tools: the assistant can only use the device's tools.
      tools: [],
      mcpServers: { [SERVER_NAME]: this.buildServer() },
      strictMcpConfig: true,
      // Every tool call is decided here: the device's own tools are allowed, nothing else is.
      canUseTool: async (toolName, input) =>
        toolName.startsWith(TOOL_PREFIX) ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Only the tools of the connected services are available on this device.' },
      settingSources: [],
      persistSession: false,
      cwd: tmpdir(),
      stderr: (data) => {
        this.stderr = `${this.stderr}${data}`.slice(-2000);
      },
      ...(this.settings.model ? { model: this.settings.model } : {}),
      ...(this.settings.effort ? { effort: this.settings.effort } : {}),
      ...(this.settings.executable ? { pathToClaudeCodeExecutable: this.settings.executable } : {}),
    };
    this.query = this.sdk.query({ prompt: this.queue, options });
    void this.pump(this.query);
  }

  private async pump(query: Query): Promise<void> {
    try {
      for await (const message of query) this.handle(message);
      this.fail(new Error(`The Claude Code session ended unexpectedly.${this.stderr ? ` ${this.stderr.trim().split('\n').at(-1)}` : ''}`));
    } catch (error) {
      this.fail(describeError(error, this.stderr));
    } finally {
      this.closed = true;
    }
  }

  private fail(error: Error): void {
    const turn = this.turn;
    this.turn = undefined;
    this.closed = true;
    turn?.reject(error);
  }

  private handle(message: SDKMessage): void {
    if (message.type === 'system' && message.subtype === 'init') {
      this.model = message.model;
      return;
    }
    const turn = this.turn;
    if (!turn) return;

    if (message.type === 'assistant') {
      if (message.parent_tool_use_id) return;
      const blocks = message.message.content;
      const text = blocks
        .map((block) => (block.type === 'text' ? block.text : ''))
        .filter(Boolean)
        .join('\n')
        .trim();
      const toolCalls: ToolCallRequest[] = blocks.flatMap((block) =>
        block.type === 'tool_use' ? [{ id: block.id, name: block.name.startsWith(TOOL_PREFIX) ? block.name.slice(TOOL_PREFIX.length) : block.name, arguments: (block.input ?? {}) as Record<string, unknown> }] : [],
      );
      if (!text && toolCalls.length === 0) return;
      turn.round += 1;
      turn.ctx.report({
        round: turn.round,
        text: text || undefined,
        toolCalls,
        stopReason: message.message.stop_reason ?? undefined,
        // Token counts per message leave out cached input and would mislead; the turn total is reported at the end.
        model: message.message.model,
        note: message.error ? `The model reported an error: ${message.error}.` : undefined,
      });
      turn.messages.push({ role: 'assistant', text, toolCalls });
      if (text) {
        turn.spoke = true;
        turn.ctx.say(text);
      }
      return;
    }

    if (message.type === 'result') {
      this.turn = undefined;
      if (message.subtype === 'success' && !message.is_error) {
        if (!turn.spoke && message.result.trim()) {
          turn.ctx.say(message.result.trim());
          turn.messages.push({ role: 'assistant', text: message.result.trim(), toolCalls: [] });
        }
        turn.ctx.report({
          round: turn.round + 1,
          toolCalls: [],
          note: `Turn finished: ${message.num_turns} model turn${message.num_turns === 1 ? '' : 's'}, ${Math.round(message.duration_ms / 100) / 10}s.`,
          usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens, costUsd: message.total_cost_usd },
          durationMs: message.duration_ms,
          model: this.model,
        });
        turn.resolve({ messages: turn.messages });
      } else {
        const detail = message.subtype === 'success' ? message.result : (message.errors ?? []).join('; ') || message.subtype;
        turn.reject(describeError(new Error(detail), this.stderr));
      }
    }
  }

  run(ctx: RunContext): Promise<RunResult> {
    if (this.turn) return Promise.reject(new Error('This device is still working on the previous request.'));
    return new Promise<RunResult>((resolve, reject) => {
      this.turn = { ctx, messages: [], round: 0, toolCalls: 0, spoke: false, resolve, reject };
      if (!this.query) {
        try {
          this.start(ctx);
        } catch (error) {
          this.turn = undefined;
          reject(describeError(error, this.stderr));
          return;
        }
      }
      const onAbort = () => {
        void this.query?.interrupt().catch(() => undefined);
      };
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      this.queue.push({ type: 'user', message: { role: 'user', content: ctx.userText }, parent_tool_use_id: null } as SDKUserMessage);
    });
  }

  /** True when this session can take another turn with the given tool list. */
  usable(ctx: RunContext): boolean {
    return !this.closed && this.toolSignature === ctx.tools.map((tool) => tool.name).join(',');
  }

  get started(): boolean {
    return this.query !== undefined;
  }

  close(): void {
    this.closed = true;
    this.queue.end();
    try {
      this.query?.close();
    } catch {
      // Already gone.
    }
    const turn = this.turn;
    this.turn = undefined;
    turn?.reject(new Error('The session was closed.'));
  }
}

export class ClaudeCodeProvider implements Provider {
  readonly id = 'claude-code' as const;
  readonly label = 'Claude Code (local login)';
  readonly model: string | undefined;
  private readonly sessions = new Map<string, DeviceSession>();
  private readonly effort: Options['effort'] | undefined;
  private readonly executable: string | undefined;
  private sdk: typeof import('@anthropic-ai/claude-agent-sdk') | undefined;

  constructor(input: ProviderFactoryInput) {
    const { assistant, env } = input;
    this.model = env.VOICESTAGE_MODEL ?? assistant.model;
    const effort = optionString(assistant.options, 'effort');
    if (effort && !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) {
      throw new ProviderNotConfiguredError('claude-code', `assistant.options.effort is "${effort}"; choose one of low, medium, high, xhigh, max.`);
    }
    this.effort = effort as Options['effort'] | undefined;
    this.executable = optionString(assistant.options, 'executable');
  }

  async run(ctx: RunContext): Promise<RunResult> {
    if (!this.sdk) {
      try {
        this.sdk = await import('@anthropic-ai/claude-agent-sdk');
      } catch (error) {
        throw new Error(`The "claude-code" provider needs the @anthropic-ai/claude-agent-sdk package: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    let session = this.sessions.get(ctx.deviceId);
    if (session && !session.usable(ctx)) {
      // The process ended, or the device's tools changed: start a fresh session.
      session.close();
      session = undefined;
    }
    let preface = '';
    if (!session) {
      session = new DeviceSession(this.sdk, { model: this.model, effort: this.effort, executable: this.executable });
      this.sessions.set(ctx.deviceId, session);
      // A new session has no memory of turns that happened before it started.
      preface = recap(ctx.history);
    }
    return session.run(preface ? { ...ctx, userText: `${preface}\n\nThe person now says: ${ctx.userText}` } : ctx);
  }

  reset(deviceId: string): void {
    this.sessions.get(deviceId)?.close();
    this.sessions.delete(deviceId);
  }

  dispose(): void {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }
}

/** Earlier turns, written out for a session that was not there for them. */
function recap(history: readonly ChatMessage[]): string {
  if (history.length === 0) return '';
  const lines = history.slice(-24).map((message) => {
    if (message.role === 'user') return `Person: ${message.text}`;
    if (message.role === 'tool') return `Tool result (${message.name}${message.isError ? ', error' : ''}): ${message.text.slice(0, 1500)}`;
    const calls = message.toolCalls.map((call) => `[called ${call.name} with ${JSON.stringify(call.arguments)}]`).join(' ');
    return `Assistant: ${[message.text, calls].filter(Boolean).join(' ')}`;
  });
  return `Earlier in this conversation:\n${lines.join('\n')}`;
}

function describeError(error: unknown, stderr: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  const all = `${message}\n${stderr}`;
  if (/ENOENT|not found|Claude Code executable|native binary/i.test(all) && /claude/i.test(all)) {
    return new Error(`Claude Code could not be started. Install it and sign in ("claude" in a terminal), or set assistant.options.executable to its path. (${message})`);
  }
  if (/not logged in|\/login|authentication|unauthorized|invalid api key|OAuth/i.test(all)) {
    return new Error(`Claude Code is not signed in. Run "claude" in a terminal and sign in, then try again. (${message})`);
  }
  if (/rate limit|usage limit|overloaded/i.test(all)) return new Error(`Claude Code reported a usage limit: ${message}`);
  return new Error(`Claude Code: ${message}`);
}
