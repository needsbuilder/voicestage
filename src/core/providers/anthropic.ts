/**
 * Claude through the Anthropic API, using the official `@anthropic-ai/sdk`.
 *
 * Credentials come from the environment the way the SDK resolves them:
 * `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or a profile created with
 * `ant auth login`.
 *
 * The transcript is kept in the API's own message format and only ever
 * appended to, with each response's full `content` (thinking blocks included)
 * sent back unchanged on the next request.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { runToolLoop, syncTranscript, type ModelStep } from './tool-loop.js';
import { optionNumber, optionString, ProviderNotConfiguredError, type ChatMessage, type Provider, type ProviderFactoryInput, type RunContext, type RunResult, type ToolCallRequest, type ToolOutcome } from './types.js';

type BetaMessageParam = Anthropic.Beta.BetaMessageParam;
type BetaContentBlockParam = Anthropic.Beta.BetaContentBlockParam;

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';

/**
 * Models whose safety classifiers can decline a request and that support
 * handing a declined request to a fallback model inside the same API call.
 */
const SERVER_FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);
const SERVER_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type Effort = (typeof EFFORTS)[number];

function toNative(messages: readonly ChatMessage[]): BetaMessageParam[] {
  const native: BetaMessageParam[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      native.push({ role: 'user', content: message.text });
    } else if (message.role === 'assistant') {
      const content: BetaContentBlockParam[] = [];
      if (message.text.trim()) content.push({ type: 'text', text: message.text });
      for (const call of message.toolCalls) content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments });
      if (content.length > 0) native.push({ role: 'assistant', content });
    } else {
      const block: BetaContentBlockParam = { type: 'tool_result', tool_use_id: message.toolCallId, content: message.text, is_error: message.isError };
      const previous = native.at(-1);
      // Results of calls made in one assistant message go back together in one user message.
      if (previous?.role === 'user' && Array.isArray(previous.content) && previous.content.every((item) => item.type === 'tool_result')) previous.content.push(block);
      else native.push({ role: 'user', content: [block] });
    }
  }
  return native;
}

export class AnthropicProvider implements Provider {
  readonly id = 'anthropic' as const;
  readonly label = 'Anthropic API';
  readonly model: string;
  private readonly client: Anthropic;
  private readonly effort: Effort;
  private readonly maxTokens: number;
  private useFallbacks: boolean;

  /** `client` is for tests; normally the SDK client is created from the environment. */
  constructor(input: ProviderFactoryInput, client?: Anthropic) {
    const { assistant, env } = input;
    const keyEnv = optionString(assistant.options, 'apiKeyEnv');
    const baseURL = optionString(assistant.options, 'baseUrl');
    const hasCredentials = Boolean(
      (keyEnv && env[keyEnv]) || env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_IDENTITY_TOKEN_FILE || env.ANTHROPIC_IDENTITY_TOKEN || existsSync(join(env.HOME ?? homedir(), '.config', 'anthropic')),
    );
    if (!hasCredentials && !client) {
      throw new ProviderNotConfiguredError(
        'anthropic',
        `The "anthropic" provider needs credentials. Set ANTHROPIC_API_KEY${keyEnv ? ` (or ${keyEnv})` : ''} in your environment or .env file, or sign in with "ant auth login". To try Voicestage without a key, use the "scripted" provider.`,
      );
    }
    this.model = env.VOICESTAGE_MODEL ?? assistant.model ?? DEFAULT_ANTHROPIC_MODEL;
    const effort = optionString(assistant.options, 'effort') ?? 'low';
    if (!(EFFORTS as readonly string[]).includes(effort)) {
      throw new ProviderNotConfiguredError('anthropic', `assistant.options.effort is "${effort}"; choose one of ${EFFORTS.join(', ')}.`);
    }
    // Spoken replies are short. Low effort keeps them quick; raise it in the config for harder tasks.
    this.effort = effort as Effort;
    this.maxTokens = optionNumber(assistant.options, 'maxTokens') ?? 16000;
    this.useFallbacks = assistant.options?.fallbacks !== false && !baseURL && SERVER_FALLBACK_MODELS.has(this.model);
    this.client =
      client ??
      new Anthropic({
        ...(keyEnv && env[keyEnv] ? { apiKey: env[keyEnv] } : {}),
        ...(baseURL ? { baseURL } : {}),
      });
  }

  private async create(ctx: RunContext, messages: BetaMessageParam[], tools: Anthropic.Beta.BetaTool[]): Promise<{ message: Anthropic.Beta.BetaMessage; note?: string }> {
    const base = {
      model: this.model,
      max_tokens: this.maxTokens,
      system: ctx.system,
      messages,
      ...(tools.length > 0 ? { tools } : {}),
      output_config: { effort: this.effort },
    };
    if (this.useFallbacks) {
      try {
        // If a safety classifier declines the request, the API re-runs it on its
        // recommended fallback model within the same call.
        return { message: await this.client.beta.messages.create({ ...base, betas: [SERVER_FALLBACK_BETA], fallbacks: 'default' }, { signal: ctx.signal }) };
      } catch (error) {
        if (!(error instanceof Anthropic.BadRequestError)) throw error;
        // This account or endpoint does not accept the fallback option: carry on without it.
        this.useFallbacks = false;
        const message = (await this.client.messages.create({ ...base, messages: messages as Anthropic.MessageParam[], tools: tools as Anthropic.Tool[] }, { signal: ctx.signal })) as unknown as Anthropic.Beta.BetaMessage;
        return { message, note: `Server-side refusal fallbacks were rejected (${error.message}) and have been switched off for this session.` };
      }
    }
    const message = (await this.client.messages.create({ ...base, messages: messages as Anthropic.MessageParam[], tools: tools as Anthropic.Tool[] }, { signal: ctx.signal })) as unknown as Anthropic.Beta.BetaMessage;
    return { message };
  }

  async run(ctx: RunContext): Promise<RunResult> {
    const transcript = syncTranscript<BetaMessageParam>(ctx.state, 'anthropic.messages', ctx.history, toNative);
    const messages = transcript.messages;
    const tools: Anthropic.Beta.BetaTool[] = ctx.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: { ...tool.inputSchema, type: 'object' } as Anthropic.Beta.BetaTool['input_schema'],
    }));
    messages.push({ role: 'user', content: ctx.userText });

    try {
      const result = await runToolLoop(ctx, {
        generate: async (): Promise<ModelStep> => {
          let response: { message: Anthropic.Beta.BetaMessage; note?: string };
          try {
            response = await this.create(ctx, messages, tools);
          } catch (error) {
            throw describeError(error);
          }
          const { message } = response;
          // Send the whole content back next time, exactly as received.
          messages.push({ role: 'assistant', content: message.content as BetaContentBlockParam[] });

          const text = message.content
            .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
            .map((block) => block.text)
            .join('\n')
            .trim();
          const toolCalls: ToolCallRequest[] = message.content
            .filter((block): block is Anthropic.Beta.BetaToolUseBlock => block.type === 'tool_use')
            .map((block) => ({ id: block.id, name: block.name, arguments: (block.input ?? {}) as Record<string, unknown> }));
          const usage = { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens };
          const step = { stopReason: message.stop_reason ?? undefined, usage, model: message.model, note: response.note };

          if (message.stop_reason === 'refusal' || message.stop_reason === 'max_tokens' || message.stop_reason === 'model_context_window_exceeded') {
            // The turn ends here. A refusal may carry no content, and a tool call cut
            // off by a length limit must not run with partial input, so what goes
            // into the transcript is the sentence that is actually spoken.
            const refused = message.stop_reason === 'refusal';
            const category = message.stop_details?.category;
            const spoken = refused ? "I'm not able to help with that request." : text || 'That answer got too long. Could you ask again in a shorter way?';
            messages[messages.length - 1] = { role: 'assistant', content: spoken };
            return {
              ...step,
              text: spoken,
              toolCalls: [],
              final: true,
              note: refused ? `The model declined this request${category ? ` (category: ${category})` : ''}.` : `The model stopped early (${message.stop_reason}).`,
            };
          }
          return { ...step, text, toolCalls };
        },
        addToolResults: (results: Array<{ call: ToolCallRequest; outcome: ToolOutcome }>) => {
          messages.push({
            role: 'user',
            content: results.map(({ call, outcome }) => ({ type: 'tool_result' as const, tool_use_id: call.id, content: outcome.text, is_error: outcome.isError })),
          });
        },
      });
      transcript.commit(result.messages.length);
      return result;
    } catch (error) {
      transcript.rollback();
      throw error;
    }
  }
}

function describeError(error: unknown): Error {
  if (error instanceof Anthropic.AuthenticationError) return new Error('The Anthropic API rejected the credentials. Check ANTHROPIC_API_KEY.');
  if (error instanceof Anthropic.PermissionDeniedError) return new Error(`The Anthropic API key is not allowed to do this: ${error.message}`);
  if (error instanceof Anthropic.NotFoundError) return new Error(`The Anthropic API does not know this model or endpoint: ${error.message}`);
  if (error instanceof Anthropic.RateLimitError) return new Error('The Anthropic API is rate limiting this key. Wait a moment and try again.');
  if (error instanceof Anthropic.BadRequestError) return new Error(`The Anthropic API rejected the request: ${error.message}`);
  if (error instanceof Anthropic.APIConnectionError) return new Error(`Could not reach the Anthropic API: ${error.message}`);
  if (error instanceof Anthropic.APIError) return new Error(`Anthropic API error ${error.status ?? ''}: ${error.message}`);
  return error instanceof Error ? error : new Error(String(error));
}
