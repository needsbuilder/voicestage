import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import type { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../src/core/config.js';
import { AnthropicProvider } from '../src/core/providers/anthropic.js';
import { BedrockProvider } from '../src/core/providers/bedrock.js';
import { createProvider, ProviderNotConfiguredError, ScriptedProvider } from '../src/core/providers/index.js';
import { OpenAiCompatibleProvider, parseToolArguments } from '../src/core/providers/openai-compatible.js';
import { runToolLoop, syncTranscript } from '../src/core/providers/tool-loop.js';
import type { ChatMessage, ModelTurnReport, ProviderTool, RunContext, ToolOutcome } from '../src/core/providers/types.js';

/** An environment with no credentials of any kind, and a home folder with no saved profiles. */
const bare = (): NodeJS.ProcessEnv => ({ HOME: mkdtempSync(join(tmpdir(), 'voicestage-home-')) });

const TOOLS: ProviderTool[] = [
  { name: 'check', description: 'Check a request.', inputSchema: { type: 'object', properties: { amount: { type: 'number' } }, required: ['amount'] } },
  { name: 'hold', description: 'Place a hold.', inputSchema: { type: 'object', properties: { check_id: { type: 'string' } } } },
];

interface Harness {
  ctx: RunContext;
  calls: Array<{ name: string; args: Record<string, unknown> }>;
  said: string[];
  reports: ModelTurnReport[];
}

function harness(overrides: Partial<RunContext> = {}, results: Record<string, ToolOutcome> = {}): Harness {
  const calls: Harness['calls'] = [];
  const said: string[] = [];
  const reports: ModelTurnReport[] = [];
  const ctx: RunContext = {
    deviceId: 'kitchen',
    system: 'You are a test assistant.',
    history: [],
    userText: 'Pay my bill',
    tools: TOOLS,
    maxRounds: 4,
    signal: new AbortController().signal,
    state: new Map(),
    vars: {},
    callTool: async (name, args) => {
      calls.push({ name, args });
      return results[name] ?? { text: `${name} ok`, isError: false, structuredContent: { ok: true } };
    },
    say: (text) => void said.push(text),
    report: (report) => void reports.push(report),
    ...overrides,
  };
  return { ctx, calls, said, reports };
}

describe('choosing a provider', () => {
  it('defaults to scripted, which needs nothing', () => {
    const provider = createProvider({ assistant: {}, env: bare() });
    expect(provider.id).toBe('scripted');
  });

  it('says what is missing when a provider is not configured', () => {
    const attempt = (assistant: Parameters<typeof createProvider>[0]['assistant'], env: NodeJS.ProcessEnv = bare()) => () => createProvider({ assistant, env });
    expect(attempt({ provider: 'anthropic' })).toThrow(ProviderNotConfiguredError);
    expect(attempt({ provider: 'anthropic' })).toThrow(/Set ANTHROPIC_API_KEY.*"scripted" provider/s);
    expect(attempt({ provider: 'anthropic', options: { apiKeyEnv: 'MY_KEY' } })).toThrow(/or MY_KEY/);
    expect(attempt({ provider: 'bedrock' })).toThrow(/needs a model.*assistant\.model/s);
    expect(attempt({ provider: 'bedrock', model: 'some.model-v1:0' })).toThrow(/needs a region.*AWS_REGION/s);
    expect(attempt({ provider: 'openai-compatible' })).toThrow(/needs a base URL.*OPENAI_BASE_URL/s);
    expect(attempt({ provider: 'openai-compatible', options: { baseUrl: 'http://localhost:11434/v1' } })).toThrow(/needs a model/);
    expect(attempt({ provider: 'claude-code', options: { effort: 'extreme' } })).toThrow(/effort is "extreme"/);
    expect(attempt({ provider: 'anthropic', options: { effort: 'extreme' } }, { ...bare(), ANTHROPIC_API_KEY: 'test-key' })).toThrow(/effort is "extreme"/);
    expect(attempt({}, { ...bare(), VOICESTAGE_PROVIDER: 'nonsense' })).toThrow(ConfigError);
  });

  it('creates each provider when its settings are present', () => {
    const env = bare();
    expect(createProvider({ assistant: { provider: 'anthropic' }, env: { ...env, ANTHROPIC_API_KEY: 'test-key' } })).toMatchObject({ id: 'anthropic', model: 'claude-opus-5-5' });
    expect(createProvider({ assistant: { provider: 'anthropic', model: 'claude-haiku-5-5' }, env: { ...env, ANTHROPIC_API_KEY: 'test-key' } }).model).toBe('claude-haiku-5-5');
    expect(createProvider({ assistant: { provider: 'bedrock', model: 'some.model-v1:0' }, env: { ...env, AWS_REGION: 'us-east-1' } })).toMatchObject({ id: 'bedrock', model: 'some.model-v1:0' });
    expect(createProvider({ assistant: { provider: 'openai-compatible', model: 'llama', options: { baseUrl: 'http://localhost:11434/v1/' } }, env })).toMatchObject({ id: 'openai-compatible', model: 'llama' });
    expect(createProvider({ assistant: { provider: 'claude-code' }, env })).toMatchObject({ id: 'claude-code', model: undefined });
    // The override beats the environment, which beats the configuration; VOICESTAGE_MODEL beats assistant.model.
    expect(createProvider({ assistant: { provider: 'anthropic' }, env: { ...env, VOICESTAGE_PROVIDER: 'claude-code', VOICESTAGE_MODEL: 'claude-sonnet-5-5' } })).toMatchObject({ id: 'claude-code', model: 'claude-sonnet-5-5' });
    expect(createProvider({ assistant: { provider: 'anthropic' }, env: { ...env, VOICESTAGE_PROVIDER: 'claude-code' }, override: 'scripted' }).id).toBe('scripted');
  });
});

describe('scripted provider', () => {
  it('replays a script: calls tools with saved values, speaks, and honours conditions', async () => {
    const { ctx, calls, said } = harness(
      {
        script: [
          { call: 'check', args: { amount: 20 }, save: 'check' },
          { say: '{{check.say_to_user}}' },
          { call: 'hold', args: { check_id: '{{check.check_id}}' }, save: 'hold', if: { path: 'check.next_step', equals: 'place_hold' } },
          { say: 'Skipped.', if: 'check.missing' },
          { say: 'Hold {{hold.hold_id}} placed.' },
        ],
      },
      {
        check: { text: 'ok', isError: false, structuredContent: { check_id: 'chk_1', next_step: 'place_hold', say_to_user: 'Let me check with Sarah.' } },
        hold: { text: 'ok', isError: false, structuredContent: { hold_id: 'hold_1' } },
      },
    );
    const result = await new ScriptedProvider().run(ctx);
    expect(calls).toEqual([
      { name: 'check', args: { amount: 20 } },
      { name: 'hold', args: { check_id: 'chk_1' } },
    ]);
    expect(said).toEqual(['Let me check with Sarah.', 'Hold hold_1 placed.']);
    expect(ctx.vars).toMatchObject({ check: { check_id: 'chk_1' }, hold: { hold_id: 'hold_1' }, last: { hold_id: 'hold_1' } });
    expect(result.messages.map((message) => message.role)).toEqual(['assistant', 'tool', 'assistant', 'assistant', 'tool', 'assistant']);
  });

  it('stops with a clear error when a script refers to something that was never saved', async () => {
    const { ctx } = harness({ script: [{ call: 'hold', args: { check_id: '{{check.check_id}}' } }] });
    await expect(new ScriptedProvider().run(ctx)).rejects.toThrow(/Scripted call to hold could not be built: Nothing is saved under "check.check_id"/);
  });

  it('matches free speech against the lines of loaded scenarios for the device', async () => {
    const lines = [
      { deviceId: 'kitchen', text: 'How do I make pancakes?', script: [{ say: 'Like this.' }], scenario: 'Pancakes' },
      { deviceId: 'phone', text: 'Approve it.', script: [{ call: 'approve' }], scenario: 'Phone only' },
      { deviceId: 'phone', text: 'Check twenty dollars.', script: [{ call: 'check', args: { amount: 20 } }, { say: 'Checked.' }], scenario: 'Shared tools' },
    ];
    const provider = new ScriptedProvider(() => lines);

    const heard = harness({ userText: 'how do i make the pancakes' });
    await provider.run(heard.ctx);
    expect(heard.said).toEqual(['Like this.']);
    expect(heard.reports[0]!.note).toMatch(/from "Pancakes" \(matched \d+%\)/);

    // A line written for another device works here when this device has its tools ...
    const shared = harness({ userText: 'Check twenty dollars' });
    await provider.run(shared.ctx);
    expect(shared.calls).toEqual([{ name: 'check', args: { amount: 20 } }]);

    // ... and does not when it lacks them.
    const foreign = harness({ userText: 'Approve it.' });
    await provider.run(foreign.ctx);
    expect(foreign.calls).toEqual([]);
    expect(foreign.said[0]).toMatch(/I'm running without a model.*Try saying: How do I make pancakes\?/);

    const nothing = harness({ userText: 'hello' });
    await new ScriptedProvider().run(nothing.ctx);
    expect(nothing.said[0]).toMatch(/no scenario has lines for this device/);
  });
});

describe('tool loop', () => {
  it('runs tools until the model answers without any', async () => {
    const { ctx, calls, said, reports } = harness();
    const fed: string[][] = [];
    const steps = [
      { text: 'Let me check.', toolCalls: [{ id: 'a', name: 'check', arguments: { amount: 20 } }] },
      { text: '', toolCalls: [{ id: 'b', name: 'hold', arguments: {} }, { id: 'c', name: 'check', arguments: { amount: 5 } }] },
      { text: 'All done.', toolCalls: [] },
    ];
    const result = await runToolLoop(ctx, {
      generate: async (round) => steps[round - 1]!,
      addToolResults: (results) => void fed.push(results.map(({ call, outcome }) => `${call.id}:${outcome.text}`)),
    });
    expect(calls.map((call) => call.name)).toEqual(['check', 'hold', 'check']);
    expect(fed).toEqual([['a:check ok'], ['b:hold ok', 'c:check ok']]);
    expect(said).toEqual(['Let me check.', 'All done.']);
    expect(reports.map((report) => report.round)).toEqual([1, 2, 3]);
    expect(result.messages.map((message) => message.role)).toEqual(['assistant', 'tool', 'assistant', 'tool', 'tool', 'assistant']);
  });

  it('stops at the round limit, answering the pending calls so the transcript stays valid', async () => {
    const { ctx, calls, said } = harness({ maxRounds: 2 });
    const fed: ToolOutcome[][] = [];
    const result = await runToolLoop(ctx, {
      generate: async (round) => ({ text: '', toolCalls: [{ id: `call_${round}`, name: 'check', arguments: {} }] }),
      addToolResults: (results) => void fed.push(results.map(({ outcome }) => outcome)),
    });
    expect(calls).toHaveLength(1);
    expect(fed[1]![0]).toMatchObject({ isError: true, text: expect.stringMatching(/limit of 2 tool rounds/) });
    expect(said).toEqual(["I wasn't able to finish that. Please try again."]);
    expect(result.messages.at(-1)).toMatchObject({ role: 'assistant', toolCalls: [] });
  });

  it('keeps a native transcript in step with the device history, append-only', () => {
    const state = new Map<string, unknown>();
    const history: ChatMessage[] = [
      { role: 'user', text: 'hello' },
      { role: 'assistant', text: 'hi', toolCalls: [] },
    ];
    const convert = (messages: readonly ChatMessage[]) => messages.map((message) => `${message.role}:${message.text}`);
    const first = syncTranscript(state, 'k', history, convert);
    expect(first.messages).toEqual(['user:hello', 'assistant:hi']);
    first.messages.push('user:next', 'native-assistant');
    first.commit(1);

    // The device recorded the user message and one assistant message; nothing is converted twice.
    const grown: ChatMessage[] = [...history, { role: 'user', text: 'next' }, { role: 'assistant', text: 'answer', toolCalls: [] }];
    const second = syncTranscript(state, 'k', grown, convert);
    expect(second.messages).toEqual(['user:hello', 'assistant:hi', 'user:next', 'native-assistant']);

    // A scripted turn happened in between: it is converted and appended once.
    const withScripted: ChatMessage[] = [...grown, { role: 'user', text: 'scripted' }, { role: 'assistant', text: 'replayed', toolCalls: [] }];
    const third = syncTranscript(state, 'k', withScripted, convert);
    expect(third.messages.slice(-2)).toEqual(['user:scripted', 'assistant:replayed']);

    // A failed turn leaves nothing half-finished behind.
    third.messages.push('user:boom', 'assistant-with-unanswered-tool-call');
    third.rollback();
    expect(third.messages).toHaveLength(6);
  });
});

describe('openai-compatible provider', () => {
  it('sends tools in Chat Completions format and loops on tool calls', async () => {
    const bodies: Array<Record<string, any>> = [];
    const replies = [
      { choices: [{ message: { content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'check', arguments: '{"amount":20}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
      { choices: [{ message: { content: 'It is on hold.' }, finish_reason: 'stop' }], model: 'llama-test' },
    ];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      expect(url).toBe('http://localhost:11434/v1/chat/completions');
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer local-key');
      bodies.push(JSON.parse(init.body as string));
      return new Response(JSON.stringify(replies[bodies.length - 1]), { status: 200 });
    }) as typeof fetch;
    const provider = new OpenAiCompatibleProvider({ assistant: { model: 'llama', options: { baseUrl: 'http://localhost:11434/v1/' } }, env: { OPENAI_API_KEY: 'local-key' } }, fakeFetch);
    const { ctx, calls, said, reports } = harness({ history: [{ role: 'user', text: 'earlier' }, { role: 'assistant', text: 'earlier answer', toolCalls: [] }] });
    const result = await provider.run(ctx);

    expect(bodies[0]!.model).toBe('llama');
    expect(bodies[0]!.messages.map((message: any) => message.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(bodies[0]!.tools[0]).toEqual({ type: 'function', function: { name: 'check', description: 'Check a request.', parameters: TOOLS[0]!.inputSchema } });
    expect(bodies[1]!.messages.slice(-2)).toEqual([
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'check', arguments: '{"amount":20}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'check ok' },
    ]);
    expect(calls).toEqual([{ name: 'check', args: { amount: 20 } }]);
    expect(said).toEqual(['It is on hold.']);
    expect(reports[0]).toMatchObject({ round: 1, usage: { inputTokens: 10, outputTokens: 5 }, stopReason: 'tool_calls' });
    expect(result.messages.map((message) => message.role)).toEqual(['assistant', 'tool', 'assistant']);
  });

  it('explains HTTP failures and drops the half-finished turn', async () => {
    const provider = new OpenAiCompatibleProvider({ assistant: { model: 'llama', options: { baseUrl: 'http://localhost:1/v1' } }, env: {} }, (async () => new Response('{"error":"no such model"}', { status: 404 })) as typeof fetch);
    const { ctx } = harness();
    await expect(provider.run(ctx)).rejects.toThrow(/answered 404\. Check the base URL and the model name\./);
    expect((ctx.state.get('openai.messages') as { messages: unknown[] }).messages).toEqual([]);
  });

  it('parses tool arguments defensively', () => {
    expect(parseToolArguments('{"a":1}')).toEqual({ a: 1 });
    expect(parseToolArguments('')).toEqual({});
    expect(parseToolArguments('not json')).toEqual({});
    expect(parseToolArguments('[1,2]')).toEqual({});
  });
});

describe('anthropic provider', () => {
  const message = (content: unknown[], stop_reason: string, extra: Record<string, unknown> = {}) => ({ id: 'msg', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason, stop_details: null, usage: { input_tokens: 12, output_tokens: 7 }, ...extra });

  it('sends tools, replays the full content of each response, and groups tool results', async () => {
    const requests: Array<Record<string, any>> = [];
    const replies = [
      message([{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: 'Let me check.' }, { type: 'tool_use', id: 'tu_1', name: 'check', input: { amount: 20 } }, { type: 'tool_use', id: 'tu_2', name: 'hold', input: {} }], 'tool_use'),
      message([{ type: 'text', text: 'It is on hold.' }], 'end_turn'),
    ];
    const client = {
      beta: { messages: { create: async (params: Record<string, any>) => (requests.push(structuredClone(params)), replies[requests.length - 1]) } },
      messages: { create: async () => { throw new Error('the beta endpoint should be used while fallbacks are on'); } },
    } as unknown as Anthropic;
    const provider = new AnthropicProvider({ assistant: {}, env: {} }, client);
    const { ctx, calls, said } = harness();
    const result = await provider.run(ctx);

    expect(provider.model).toBe('claude-opus-5-5');
    expect(requests[0]).toMatchObject({ model: 'claude-opus-5-5', system: 'You are a test assistant.', output_config: { effort: 'low' }, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
    // No thinking or sampling parameters: the model's defaults apply.
    expect(requests[0]).not.toHaveProperty('thinking');
    expect(requests[0]).not.toHaveProperty('temperature');
    expect(requests[0]).not.toHaveProperty('tool_choice');
    expect(requests[0]!.tools[0]).toEqual({ name: 'check', description: 'Check a request.', input_schema: TOOLS[0]!.inputSchema });
    expect(requests[1]!.messages).toEqual([
      { role: 'user', content: 'Pay my bill' },
      { role: 'assistant', content: replies[0]!.content },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'check ok', is_error: false }, { type: 'tool_result', tool_use_id: 'tu_2', content: 'hold ok', is_error: false }] },
    ]);
    expect(calls.map((call) => call.name)).toEqual(['check', 'hold']);
    expect(said).toEqual(['Let me check.', 'It is on hold.']);
    expect(result.messages.map((entry) => entry.role)).toEqual(['assistant', 'tool', 'tool', 'assistant']);
  });

  it('ends the turn on a refusal without running tools', async () => {
    const client = { beta: { messages: { create: async () => message([], 'refusal', { stop_details: { type: 'refusal', category: 'cyber', explanation: null } }) } }, messages: { create: async () => message([], 'refusal') } } as unknown as Anthropic;
    const { ctx, calls, said, reports } = harness();
    await new AnthropicProvider({ assistant: {}, env: {} }, client).run(ctx);
    expect(calls).toEqual([]);
    expect(said).toEqual(["I'm not able to help with that request."]);
    expect(reports[0]).toMatchObject({ stopReason: 'refusal', note: 'The model declined this request (category: cyber).' });
    expect((ctx.state.get('anthropic.messages') as { messages: unknown[] }).messages.at(-1)).toEqual({ role: 'assistant', content: "I'm not able to help with that request." });
  });

  it('skips the fallback option for models and endpoints that do not take it', async () => {
    const requests: Array<Record<string, any>> = [];
    const client = { beta: { messages: { create: async () => { throw new Error('should not be called'); } } }, messages: { create: async (params: Record<string, any>) => (requests.push(params), message([{ type: 'text', text: 'Hi.' }], 'end_turn')) } } as unknown as Anthropic;
    await new AnthropicProvider({ assistant: { model: 'claude-haiku-5-5', options: { effort: 'medium' } }, env: {} }, client).run(harness().ctx);
    await new AnthropicProvider({ assistant: { options: { fallbacks: false } }, env: {} }, client).run(harness().ctx);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ model: 'claude-haiku-5-5', output_config: { effort: 'medium' } });
    for (const request of requests) expect(request).not.toHaveProperty('fallbacks');
  });
});

describe('bedrock provider', () => {
  it('uses the Converse API with a tool configuration and loops on tool use', async () => {
    const inputs: Array<Record<string, any>> = [];
    const outputs = [
      { output: { message: { role: 'assistant', content: [{ text: 'Checking.' }, { toolUse: { toolUseId: 'tu_1', name: 'check', input: { amount: 20 } } }] } }, stopReason: 'tool_use', usage: { inputTokens: 9, outputTokens: 4 } },
      { output: { message: { role: 'assistant', content: [{ text: 'Done.' }] } }, stopReason: 'end_turn', usage: { inputTokens: 20, outputTokens: 2 } },
    ];
    const client = { send: async (command: { input: Record<string, any>; constructor: { name: string } }) => (expect(command.constructor.name).toBe('ConverseCommand'), inputs.push(structuredClone(command.input)), outputs[inputs.length - 1]), destroy: () => undefined } as unknown as BedrockRuntimeClient;
    const provider = new BedrockProvider({ assistant: { model: 'test.model-v1:0' }, env: { AWS_REGION: 'us-east-1' } }, client);
    const { ctx, calls, said } = harness({}, { check: { text: '', isError: true } });
    await provider.run(ctx);

    expect(inputs[0]).toMatchObject({ modelId: 'test.model-v1:0', system: [{ text: 'You are a test assistant.' }], messages: [{ role: 'user', content: [{ text: 'Pay my bill' }] }] });
    expect(inputs[0]!.toolConfig.tools[0]).toEqual({ toolSpec: { name: 'check', description: 'Check a request.', inputSchema: { json: TOOLS[0]!.inputSchema } } });
    expect(inputs[1]!.messages.at(-1)).toEqual({ role: 'user', content: [{ toolResult: { toolUseId: 'tu_1', content: [{ text: '(no content)' }], status: 'error' } }] });
    expect(calls).toEqual([{ name: 'check', args: { amount: 20 } }]);
    expect(said).toEqual(['Checking.', 'Done.']);
  });
});
