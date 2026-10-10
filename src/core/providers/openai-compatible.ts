/**
 * Any server that speaks the OpenAI Chat Completions format with function
 * tools: hosted gateways and local runtimes alike (Ollama, LM Studio, vLLM,
 * llama.cpp server, and so on).
 *
 * Plain `fetch`, no SDK. Settings:
 *   assistant.options.baseUrl    e.g. http://localhost:11434/v1   (or OPENAI_BASE_URL)
 *   assistant.options.apiKeyEnv  name of the variable holding the key (default OPENAI_API_KEY; optional for local servers)
 *   assistant.model              required (or VOICESTAGE_MODEL)
 */
import { runToolLoop, syncTranscript, type ModelStep } from './tool-loop.js';
import { optionNumber, optionString, ProviderNotConfiguredError, type ChatMessage, type Provider, type ProviderFactoryInput, type RunContext, type RunResult, type ToolCallRequest } from './types.js';

interface WireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

type WireMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: WireToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

function toNative(messages: readonly ChatMessage[]): WireMessage[] {
  return messages.map((message): WireMessage => {
    if (message.role === 'user') return { role: 'user', content: message.text };
    if (message.role === 'tool') return { role: 'tool', tool_call_id: message.toolCallId, content: message.text };
    return {
      role: 'assistant',
      content: message.text || null,
      ...(message.toolCalls.length > 0
        ? { tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: 'function' as const, function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) }
        : {}),
    };
  });
}

export function parseToolArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export class OpenAiCompatibleProvider implements Provider {
  readonly id = 'openai-compatible' as const;
  readonly label = 'OpenAI-compatible';
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly maxTokens: number | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(input: ProviderFactoryInput, fetchImpl: typeof fetch = fetch) {
    const { assistant, env } = input;
    const baseUrl = optionString(assistant.options, 'baseUrl') ?? env.OPENAI_BASE_URL;
    if (!baseUrl) {
      throw new ProviderNotConfiguredError(
        'openai-compatible',
        'The "openai-compatible" provider needs a base URL. Set assistant.options.baseUrl (for example http://localhost:11434/v1) or OPENAI_BASE_URL.',
      );
    }
    const model = env.VOICESTAGE_MODEL ?? assistant.model;
    if (!model) {
      throw new ProviderNotConfiguredError('openai-compatible', 'The "openai-compatible" provider needs a model. Set assistant.model (or VOICESTAGE_MODEL) to a model that supports tool calling.');
    }
    const keyEnv = optionString(assistant.options, 'apiKeyEnv') ?? 'OPENAI_API_KEY';
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = env[keyEnv] || undefined;
    this.model = model;
    this.maxTokens = optionNumber(assistant.options, 'maxTokens');
    this.fetchImpl = fetchImpl;
  }

  async run(ctx: RunContext): Promise<RunResult> {
    const transcript = syncTranscript<WireMessage>(ctx.state, 'openai.messages', ctx.history, toNative);
    const messages = transcript.messages;
    const tools = ctx.tools.map((tool) => ({ type: 'function' as const, function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }));
    messages.push({ role: 'user', content: ctx.userText });

    try {
      const result = await runToolLoop(ctx, {
        generate: async (): Promise<ModelStep> => {
          let response: Response;
          try {
            response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) },
              body: JSON.stringify({
                model: this.model,
                messages: [{ role: 'system', content: ctx.system }, ...messages],
                ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
                ...(this.maxTokens ? { max_tokens: this.maxTokens } : {}),
              }),
              signal: ctx.signal,
            });
          } catch (error) {
            throw new Error(`Could not reach ${this.baseUrl}: ${error instanceof Error ? error.message : String(error)}`);
          }
          const bodyText = await response.text();
          if (!response.ok) {
            const hint = response.status === 401 || response.status === 403 ? ' Check the API key.' : response.status === 404 ? ' Check the base URL and the model name.' : '';
            throw new Error(`${this.baseUrl} answered ${response.status}.${hint} ${bodyText.slice(0, 300)}`.trim());
          }
          let body: { choices?: Array<{ message?: { content?: string | null; tool_calls?: WireToolCall[] }; finish_reason?: string }>; usage?: { prompt_tokens?: number; completion_tokens?: number }; model?: string };
          try {
            body = JSON.parse(bodyText) as typeof body;
          } catch {
            throw new Error(`${this.baseUrl} did not answer with JSON: ${bodyText.slice(0, 200)}`);
          }
          const choice = body.choices?.[0];
          if (!choice?.message) throw new Error(`${this.baseUrl} answered without a message.`);
          const wireCalls = (choice.message.tool_calls ?? []).filter((call) => call?.function?.name);
          // Some servers omit ids; the transcript needs one to pair results with calls.
          wireCalls.forEach((call, index) => {
            if (!call.id) call.id = `call_${Date.now().toString(36)}_${index}`;
            call.type = 'function';
          });
          messages.push({ role: 'assistant', content: choice.message.content ?? null, ...(wireCalls.length > 0 ? { tool_calls: wireCalls } : {}) });
          const toolCalls: ToolCallRequest[] = wireCalls.map((call) => ({ id: call.id, name: call.function.name, arguments: parseToolArguments(call.function.arguments) }));
          return {
            text: (choice.message.content ?? '').trim(),
            toolCalls,
            stopReason: choice.finish_reason,
            usage: { inputTokens: body.usage?.prompt_tokens, outputTokens: body.usage?.completion_tokens },
            model: body.model ?? this.model,
            final: choice.finish_reason === 'length' || choice.finish_reason === 'content_filter',
          };
        },
        addToolResults: (results) => {
          for (const { call, outcome } of results) messages.push({ role: 'tool', tool_call_id: call.id, content: outcome.text });
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
