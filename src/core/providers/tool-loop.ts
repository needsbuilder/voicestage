/**
 * The agent loop shared by the providers that work one model call at a time
 * (Anthropic, Bedrock, OpenAI-compatible): ask the model, run the tools it
 * asks for, feed the results back, and stop when it answers without tools.
 *
 * Each provider keeps its own transcript in the model's native message format,
 * because that is what must be replayed unchanged (reasoning blocks, tool-use
 * ids). The loop only deals in the neutral shapes from `types.ts`.
 */
import type { ChatMessage, ModelTurnReport, RunContext, RunResult, ToolCallRequest, ToolOutcome } from './types.js';

export interface ModelStep {
  text: string;
  toolCalls: ToolCallRequest[];
  stopReason?: string;
  usage?: ModelTurnReport['usage'];
  model?: string;
  note?: string;
  /** True when the model stopped for a reason that must end the turn (a refusal, a length limit). */
  final?: boolean;
}

export interface LoopAdapter {
  /** Ask the model for its next step, given everything sent so far. */
  generate(round: number): Promise<ModelStep>;
  /** Give the model the results of the tool calls from its last step. */
  addToolResults(results: Array<{ call: ToolCallRequest; outcome: ToolOutcome }>): void;
}

export async function runToolLoop(ctx: RunContext, adapter: LoopAdapter): Promise<RunResult> {
  const messages: ChatMessage[] = [];
  for (let round = 1; ; round += 1) {
    if (ctx.signal.aborted) throw new Error('The turn was cancelled.');
    const started = Date.now();
    const step = await adapter.generate(round);
    ctx.report({
      round,
      text: step.text || undefined,
      toolCalls: step.toolCalls,
      stopReason: step.stopReason,
      usage: step.usage,
      model: step.model,
      note: step.note,
      durationMs: Date.now() - started,
    });
    messages.push({ role: 'assistant', text: step.text, toolCalls: step.toolCalls });
    if (step.text.trim()) ctx.say(step.text);
    if (step.final || step.toolCalls.length === 0) break;

    if (round >= ctx.maxRounds) {
      // Answer every pending call so the transcript stays valid, then stop.
      const results = step.toolCalls.map((call) => ({
        call,
        outcome: { text: `Not run: this turn reached its limit of ${ctx.maxRounds} tool rounds.`, isError: true },
      }));
      adapter.addToolResults(results);
      for (const { call, outcome } of results) messages.push({ role: 'tool', toolCallId: call.id, name: call.name, text: outcome.text, isError: true });
      ctx.say("I wasn't able to finish that. Please try again.");
      messages.push({ role: 'assistant', text: "I wasn't able to finish that. Please try again.", toolCalls: [] });
      break;
    }

    // One call at a time: a voice assistant's tools are usually steps of one
    // flow, and the screen shows each result as it arrives.
    const results: Array<{ call: ToolCallRequest; outcome: ToolOutcome }> = [];
    for (const call of step.toolCalls) {
      results.push({ call, outcome: await ctx.callTool(call.name, call.arguments) });
    }
    adapter.addToolResults(results);
    for (const { call, outcome } of results) messages.push({ role: 'tool', toolCallId: call.id, name: call.name, text: outcome.text, isError: outcome.isError });
  }
  return { messages };
}

/**
 * Bring a provider's native transcript up to date with the neutral history.
 *
 * A device's history can contain turns the provider did not produce (scripted
 * turns, or turns from before the provider was switched). Those are converted
 * and appended once; turns the provider produced itself are already there in
 * native form. The transcript is only ever appended to.
 */
export function syncTranscript<M>(
  state: Map<string, unknown>,
  key: string,
  history: readonly ChatMessage[],
  convert: (messages: readonly ChatMessage[]) => M[],
): { messages: M[]; commit(added: number): void; rollback(): void } {
  let entry = state.get(key) as { messages: M[]; synced: number } | undefined;
  if (!entry) {
    entry = { messages: [], synced: 0 };
    state.set(key, entry);
  }
  if (history.length > entry.synced) entry.messages.push(...convert(history.slice(entry.synced)));
  entry.synced = history.length;
  const transcript = entry;
  const mark = transcript.messages.length;
  return {
    messages: transcript.messages,
    // The user message plus whatever the turn added are now part of the device history too.
    commit: (added: number) => {
      transcript.synced = history.length + 1 + added;
    },
    // A turn that failed half-way must not leave a tool call without its result
    // in the transcript. Drop what the turn added; the device records the
    // failure in its own history, which is converted on the next turn.
    rollback: () => {
      transcript.messages.length = mark;
      transcript.synced = history.length;
    },
  };
}
