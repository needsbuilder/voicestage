/**
 * Amazon Bedrock through the Converse API (`@aws-sdk/client-bedrock-runtime`),
 * with tool use. Works with any Bedrock model that supports tools in Converse.
 *
 * Credentials come from the standard AWS chain (environment, shared config,
 * SSO, instance role). The model has no default: set `assistant.model` to a
 * model id or inference profile id that your account can invoke.
 */
import { BedrockRuntimeClient, ConverseCommand, type ContentBlock, type Message, type Tool, type ToolResultBlock } from '@aws-sdk/client-bedrock-runtime';
import { runToolLoop, syncTranscript, type ModelStep } from './tool-loop.js';
import { optionNumber, optionString, ProviderNotConfiguredError, type ChatMessage, type Provider, type ProviderFactoryInput, type RunContext, type RunResult, type ToolCallRequest } from './types.js';

function toNative(messages: readonly ChatMessage[]): Message[] {
  const native: Message[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      native.push({ role: 'user', content: [{ text: message.text }] });
    } else if (message.role === 'assistant') {
      const content: ContentBlock[] = [];
      if (message.text.trim()) content.push({ text: message.text });
      for (const call of message.toolCalls) content.push({ toolUse: { toolUseId: call.id, name: call.name, input: call.arguments as never } });
      if (content.length > 0) native.push({ role: 'assistant', content });
    } else {
      const block: ContentBlock = { toolResult: { toolUseId: message.toolCallId, content: [{ text: message.text }], status: message.isError ? 'error' : 'success' } };
      const previous = native.at(-1);
      if (previous?.role === 'user' && previous.content?.every((item) => 'toolResult' in item)) previous.content.push(block);
      else native.push({ role: 'user', content: [block] });
    }
  }
  return native;
}

export class BedrockProvider implements Provider {
  readonly id = 'bedrock' as const;
  readonly label = 'Amazon Bedrock (Converse)';
  readonly model: string;
  private readonly client: BedrockRuntimeClient;
  private readonly maxTokens: number;

  constructor(input: ProviderFactoryInput) {
    const { assistant, env } = input;
    const model = env.VOICESTAGE_MODEL ?? assistant.model;
    if (!model) {
      throw new ProviderNotConfiguredError(
        'bedrock',
        'The "bedrock" provider needs a model. Set assistant.model (or VOICESTAGE_MODEL) to a Bedrock model id or inference profile id that supports tool use with the Converse API.',
      );
    }
    const region = optionString(assistant.options, 'region') ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION;
    if (!region) {
      throw new ProviderNotConfiguredError('bedrock', 'The "bedrock" provider needs a region. Set AWS_REGION, or assistant.options.region in the configuration.');
    }
    this.model = model;
    this.maxTokens = optionNumber(assistant.options, 'maxTokens') ?? 2048;
    this.client = new BedrockRuntimeClient({ region });
  }

  async run(ctx: RunContext): Promise<RunResult> {
    const transcript = syncTranscript<Message>(ctx.state, 'bedrock.messages', ctx.history, toNative);
    const messages = transcript.messages;
    const tools: Tool[] = ctx.tools.map((tool) => ({
      toolSpec: { name: tool.name, description: tool.description.slice(0, 4000) || tool.name, inputSchema: { json: tool.inputSchema as never } },
    }));
    messages.push({ role: 'user', content: [{ text: ctx.userText }] });

    try {
      const result = await runToolLoop(ctx, {
        generate: async (): Promise<ModelStep> => {
          let output;
          try {
            output = await this.client.send(
              new ConverseCommand({
                modelId: this.model,
                system: [{ text: ctx.system }],
                messages,
                ...(tools.length > 0 ? { toolConfig: { tools } } : {}),
                inferenceConfig: { maxTokens: this.maxTokens },
              }),
              { abortSignal: ctx.signal },
            );
          } catch (error) {
            throw describeError(error);
          }
          const message = output.output?.message;
          if (!message) throw new Error('Bedrock returned no message.');
          // Keep the message as received (reasoning blocks included) for the next request.
          messages.push(message);

          const blocks = message.content ?? [];
          const text = blocks
            .map((block) => ('text' in block && typeof block.text === 'string' ? block.text : ''))
            .filter(Boolean)
            .join('\n')
            .trim();
          const toolCalls: ToolCallRequest[] = blocks.flatMap((block) =>
            'toolUse' in block && block.toolUse?.toolUseId && block.toolUse.name
              ? [{ id: block.toolUse.toolUseId, name: block.toolUse.name, arguments: (block.toolUse.input ?? {}) as Record<string, unknown> }]
              : [],
          );
          const step = {
            stopReason: output.stopReason,
            usage: { inputTokens: output.usage?.inputTokens, outputTokens: output.usage?.outputTokens },
            model: this.model,
          };
          if (output.stopReason === 'max_tokens' || output.stopReason === 'guardrail_intervened' || output.stopReason === 'content_filtered') {
            // The turn ends here; a tool call cut off by the limit must not stay in the transcript without a result.
            const spoken = text || "I'm not able to answer that.";
            messages[messages.length - 1] = { role: 'assistant', content: [{ text: spoken }] };
            return { ...step, text: spoken, toolCalls: [], final: true, note: `The model stopped early (${output.stopReason}).` };
          }
          return { ...step, text, toolCalls };
        },
        addToolResults: (results) => {
          messages.push({
            role: 'user',
            content: results.map(({ call, outcome }) => ({
              toolResult: { toolUseId: call.id, content: [{ text: outcome.text || '(no content)' }], status: outcome.isError ? 'error' : 'success' } satisfies ToolResultBlock,
            })),
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

  dispose(): void {
    this.client.destroy();
  }
}

function describeError(error: unknown): Error {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  if (/CredentialsProviderError|ExpiredToken|UnrecognizedClient|InvalidSignature|TokenProviderError/i.test(`${name} ${message}`)) {
    return new Error(`AWS credentials are missing or expired (${name || 'credentials error'}). Refresh them (for example "aws sso login") and try again.`);
  }
  if (/AccessDenied/i.test(name)) return new Error(`AWS denied access to this Bedrock model: ${message}`);
  if (/ValidationException|ResourceNotFound/i.test(name)) return new Error(`Bedrock rejected the request: ${message}`);
  if (/Throttling/i.test(name)) return new Error('Bedrock is throttling requests. Wait a moment and try again.');
  return error instanceof Error ? error : new Error(message);
}
