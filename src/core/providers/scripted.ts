/**
 * The scripted provider: no model at all. The "assistant" replays a list of
 * actions (call this tool, say that) taken from a scenario file.
 *
 * It is what CI uses, what people without an API key use, and what makes a
 * recorded demo come out the same on every take. The tool calls are real: they
 * go to the MCP server through the device's connection, and whatever the server
 * answers is what gets saved, shown and spoken.
 *
 * When a scenario is playing, each step hands over its own script. When a
 * person just talks to a scripted device, their words are matched against the
 * lines of the loaded scenarios for that device.
 */
import { bestLineMatch } from '../../shared/speech.js';
import { getPath, renderText, renderValue, TemplateError } from '../../shared/template.js';
import type { ChatMessage, Provider, RunContext, RunResult, ScriptAction, ToolCallRequest } from './types.js';

export interface ScriptedLine {
  deviceId: string;
  text: string;
  script: ScriptAction[];
  scenario: string;
}

function conditionHolds(condition: ScriptAction['if'], vars: Record<string, unknown>): boolean {
  if (condition === undefined) return true;
  if (typeof condition === 'string') return Boolean(getPath(vars, condition));
  const value = getPath(vars, condition.path);
  if ('equals' in condition) return value === condition.equals;
  if ('not' in condition) return value !== condition.not;
  return Boolean(value);
}

export class ScriptedProvider implements Provider {
  readonly id = 'scripted' as const;
  readonly label = 'Scripted (no model)';

  constructor(private readonly lines: () => ScriptedLine[] = () => []) {}

  async run(ctx: RunContext): Promise<RunResult> {
    let script = ctx.script;
    let source = 'the scenario step';
    if (!script) {
      const candidates = this.lines().filter((line) => line.deviceId === ctx.deviceId);
      const match = bestLineMatch(ctx.userText, candidates.map((line) => ({ text: line.text, item: line })));
      if (!match) {
        const example = candidates[0]?.text;
        const text = example
          ? `I'm running without a model, so I can only replay lines from the loaded scenarios. Try saying: ${example}`
          : "I'm running without a model, and no scenario has lines for this device. Choose a model provider in the configuration to talk freely.";
        ctx.report({ round: 1, text, toolCalls: [], note: 'No scripted line matched what was said.' });
        ctx.say(text);
        return { messages: [{ role: 'assistant', text, toolCalls: [] }] };
      }
      script = match.item.script;
      source = `"${match.item.scenario}" (matched ${Math.round(match.score * 100)}%)`;
    }

    ctx.report({ round: 1, toolCalls: [], note: `Replaying ${script.length} scripted action${script.length === 1 ? '' : 's'} from ${source}.` });
    const messages: ChatMessage[] = [];
    let counter = 0;
    for (const action of script) {
      if (ctx.signal.aborted) throw new Error('The turn was cancelled.');
      if (!conditionHolds(action.if, ctx.vars)) continue;

      const name = action.skill !== undefined ? 'load_skill' : action.call;
      if (name !== undefined) {
        let args: Record<string, unknown>;
        try {
          args = action.skill !== undefined ? { name: action.skill } : renderValue(action.args ?? {}, ctx.vars, true);
        } catch (error) {
          if (error instanceof TemplateError) throw new Error(`Scripted call to ${name} could not be built: ${error.message}`);
          throw error;
        }
        const call: ToolCallRequest = { id: `scripted_${Date.now().toString(36)}_${(counter += 1)}`, name, arguments: args };
        messages.push({ role: 'assistant', text: '', toolCalls: [call] });
        const outcome = await ctx.callTool(name, args);
        messages.push({ role: 'tool', toolCallId: call.id, name, text: outcome.text, isError: outcome.isError });
        const saved = outcome.structuredContent ?? { text: outcome.text, isError: outcome.isError };
        ctx.vars.last = saved;
        if (action.save) ctx.vars[action.save] = saved;
      }
      if (action.say !== undefined) {
        const text = renderText(action.say, ctx.vars);
        if (text) {
          ctx.say(text);
          messages.push({ role: 'assistant', text, toolCalls: [] });
        }
      }
    }
    return { messages };
  }
}
