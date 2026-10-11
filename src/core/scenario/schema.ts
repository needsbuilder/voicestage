/**
 * Scenario files: an ordered list of steps across devices, in YAML.
 *
 *   name: A short title
 *   description: What this shows
 *   config: ../my.config.yaml        # optional; used by the CLI when --config is not given
 *   steps:
 *     - device: kitchen
 *       say: "Pay my electric bill."            # the person speaks
 *       script:                                 # what the assistant does when no model is driving
 *         - call: some_tool
 *           args: { amount: 20 }
 *           save: check                         # keep the structured result as {{check. ...}}
 *         - say: "{{check.say_to_user}}"
 *       when_asked: "It came in the mail"       # the answer if a server asks a question (elicitation)
 *       expect:
 *         - tool: some_tool                     # this tool was called during the step ...
 *           args: { amount: 20 }                # ... with at least these arguments
 *           result: { status: ok }              # ... and its structured result has these fields
 *           save: check
 *         - not_tool: pay
 *         - said: { contains: "on hold" }       # the assistant said something like this
 *         - screen: ui://app/card.html          # the screen shows this card (or `default` for the default card)
 *
 *     - device: phone
 *       wait_for: { event: order.created, timeout: 10 }   # an event reaches the device (and is announced)
 *       expect:
 *         - announced: { contains: "new order" }
 *
 *     - device: phone
 *       call: approve_order                     # a tool call straight from the device, as a tap on a card makes
 *       args: { id: "{{check.id}}" }
 *       press: Approve                          # optional: the button on the card that makes this call. When a
 *                                               # scenario is recorded, that button is really pressed and the card
 *                                               # makes the call; everywhere else the call is made directly.
 *       show: false                             # optional: leave the screen as it is (setup and checks)
 *       expect:
 *         - tool: approve_order
 *           result: { status: approved }
 *
 *     - pause: 1.5                              # seconds; only when playing with pacing
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { ScenarioSummary } from '../../shared/types.js';
import type { ScriptAction } from '../providers/types.js';

const ScriptActionSchema = z
  .object({
    call: z.string().min(1).optional(),
    args: z.record(z.string(), z.unknown()).optional(),
    save: z.string().regex(/^[a-z_][a-z0-9_]*$/i, 'Use letters, digits and "_" for a saved name.').optional(),
    say: z.string().optional(),
    skill: z.string().min(1).optional(),
    if: z.union([z.string().min(1), z.object({ path: z.string().min(1), equals: z.unknown().optional(), not: z.unknown().optional() }).strict()]).optional(),
  })
  .strict()
  .refine((action) => action.call !== undefined || action.say !== undefined || action.skill !== undefined, { message: 'A script action needs "call", "say" or "skill".' })
  .refine((action) => !(action.args || action.save) || action.call !== undefined, { message: '"args" and "save" belong to a "call".' });

/** A comparison for text: a string means "contains", or use `{ contains | matches | ... }`. */
const TextMatchSchema = z.union([z.string(), z.record(z.string(), z.unknown())]);

const ExpectSchema = z.union([
  z
    .object({
      tool: z.string().min(1),
      args: z.record(z.string(), z.unknown()).optional(),
      result: z.record(z.string(), z.unknown()).optional(),
      /** `true`: the call must have failed. `false` (default when `result` is given): it must have succeeded. */
      error: z.union([z.boolean(), TextMatchSchema]).optional(),
      times: z.number().int().min(1).optional(),
      save: z.string().regex(/^[a-z_][a-z0-9_]*$/i).optional(),
    })
    .strict(),
  z.object({ not_tool: z.string().min(1) }).strict(),
  z.object({ said: TextMatchSchema }).strict(),
  z.object({ not_said: TextMatchSchema }).strict(),
  z.object({ announced: TextMatchSchema }).strict(),
  z.object({ screen: z.union([z.string().min(1), z.object({ card: z.string().optional(), tool: z.string().optional(), result: z.record(z.string(), z.unknown()).optional() }).strict()]) }).strict(),
  z.object({ asked: TextMatchSchema }).strict(),
]);
export type Expectation = z.infer<typeof ExpectSchema>;

const WhenAskedSchema = z.union([
  z.string().min(1),
  z.object({ content: z.record(z.string(), z.unknown()).optional(), action: z.enum(['decline', 'cancel']).optional() }).strict(),
]);

const WaitForSchema = z
  .object({
    event: z.string().min(1),
    where: z.record(z.string(), z.unknown()).optional(),
    /** Seconds. */
    timeout: z.number().positive().max(300).optional(),
  })
  .strict();

const StepSchema = z
  .object({
    /** Shown while playing; defaults to a description of the step. */
    label: z.string().optional(),
    device: z.string().min(1).optional(),
    say: z.string().min(1).optional(),
    script: z.array(ScriptActionSchema).optional(),
    when_asked: z.union([WhenAskedSchema, z.array(WhenAskedSchema)]).optional(),
    call: z.string().min(1).optional(),
    args: z.record(z.string(), z.unknown()).optional(),
    save: z.string().regex(/^[a-z_][a-z0-9_]*$/i).optional(),
    /** For a `call` step: `false` makes the call without changing what the screen shows (setup and checks). */
    show: z.boolean().optional(),
    /** For a `call` step: the visible label of the button on the card that makes this call. */
    press: z.string().min(1).optional(),
    wait_for: WaitForSchema.optional(),
    pause: z.number().min(0).max(120).optional(),
    expect: z.array(ExpectSchema).optional(),
    /** Run this step only in this mode. */
    only: z.enum(['scripted', 'live']).optional(),
  })
  .strict()
  .superRefine((step, ctx) => {
    const kinds = [step.say !== undefined, step.call !== undefined, step.wait_for !== undefined, step.pause !== undefined].filter(Boolean).length;
    if (kinds !== 1) ctx.addIssue({ code: 'custom', message: 'A step needs exactly one of "say", "call", "wait_for" or "pause".' });
    if (step.pause === undefined && !step.device) ctx.addIssue({ code: 'custom', message: 'This step needs a "device".' });
    if (step.script && step.say === undefined) ctx.addIssue({ code: 'custom', message: '"script" belongs to a "say" step.' });
    if ((step.args || step.save || step.show !== undefined || step.press !== undefined) && step.call === undefined) ctx.addIssue({ code: 'custom', message: '"args", "save", "show" and "press" belong to a "call" step.' });
  });
export type RawStep = z.infer<typeof StepSchema>;

const ScenarioSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    config: z.string().optional(),
    steps: z.array(StepSchema).min(1),
  })
  .strict();

export type StepKind = 'say' | 'call' | 'wait_for' | 'pause';

export interface ScenarioStep extends Omit<RawStep, 'script'> {
  index: number;
  kind: StepKind;
  label: string;
  script?: ScriptAction[];
}

export interface Scenario {
  id: string;
  file: string;
  name: string;
  description?: string;
  /** Absolute path of the config this scenario asks for, when it names one. */
  configPath?: string;
  devices: string[];
  steps: ScenarioStep[];
}

export class ScenarioError extends Error {}

function kindOf(step: RawStep): StepKind {
  return step.say !== undefined ? 'say' : step.call !== undefined ? 'call' : step.wait_for !== undefined ? 'wait_for' : 'pause';
}

function labelOf(step: RawStep, kind: StepKind): string {
  if (step.label) return step.label;
  if (kind === 'say') return `${step.device} hears: "${step.say}"`;
  if (kind === 'call') return step.press ? `${step.device} presses "${step.press}"` : `${step.device} calls ${step.call}`;
  if (kind === 'wait_for') return `${step.device} waits for ${step.wait_for!.event}`;
  return `Pause ${step.pause}s`;
}

/** Parse the text of a scenario file. `file` is used for the id, for messages and to resolve `config`. */
export function parseScenario(text: string, file: string): Scenario {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new ScenarioError(`${file} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = ScenarioSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => {
      const path = issue.path.map((part, index) => (typeof part === 'number' && issue.path[index - 1] === 'steps' ? `step ${part + 1}` : String(part))).filter((part) => part !== 'steps');
      return `  - ${path.length > 0 ? `${path.join(' > ')}: ` : ''}${issue.message}`;
    });
    throw new ScenarioError(`${file} is not a valid scenario:\n${issues.join('\n')}`);
  }
  const steps = parsed.data.steps.map((step, index): ScenarioStep => {
    const kind = kindOf(step);
    return { ...step, index, kind, label: labelOf(step, kind), script: step.script as ScriptAction[] | undefined };
  });
  const absolute = resolve(file);
  return {
    id: basename(file, extname(file)),
    file: absolute,
    name: parsed.data.name,
    description: parsed.data.description?.trim(),
    configPath: parsed.data.config ? resolve(dirname(absolute), parsed.data.config) : undefined,
    devices: [...new Set(steps.map((step) => step.device).filter((device): device is string => Boolean(device)))],
    steps,
  };
}

export function loadScenarioFile(path: string): Scenario {
  const absolute = resolve(path);
  if (!existsSync(absolute)) throw new ScenarioError(`No scenario file at ${absolute}.`);
  return parseScenario(readFileSync(absolute, 'utf8'), absolute);
}

/** Load every scenario from a list of files and folders. Folders are searched one level deep for .yaml and .yml. */
export function loadScenarios(paths: string[], onError?: (path: string, error: Error) => void): Scenario[] {
  const files: string[] = [];
  for (const path of paths) {
    if (!existsSync(path)) {
      onError?.(path, new ScenarioError(`Scenario path ${path} does not exist.`));
      continue;
    }
    if (statSync(path).isDirectory()) {
      for (const entry of readdirSync(path).sort()) {
        if (/\.ya?ml$/i.test(entry)) files.push(join(path, entry));
      }
    } else files.push(path);
  }
  const scenarios: Scenario[] = [];
  const ids = new Set<string>();
  for (const file of files) {
    try {
      const scenario = loadScenarioFile(file);
      // Two files with the same base name in different folders still need distinct ids.
      let id = scenario.id;
      for (let suffix = 2; ids.has(id); suffix += 1) id = `${scenario.id}-${suffix}`;
      ids.add(id);
      scenarios.push({ ...scenario, id });
    } catch (error) {
      onError?.(file, error instanceof Error ? error : new Error(String(error)));
    }
  }
  return scenarios;
}

export function summarizeScenario(scenario: Scenario): ScenarioSummary {
  return {
    id: scenario.id,
    file: scenario.file,
    name: scenario.name,
    description: scenario.description,
    devices: scenario.devices,
    steps: scenario.steps.map((step) => ({ index: step.index, device: step.device, label: step.label, kind: step.kind })),
  };
}
