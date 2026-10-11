/**
 * Runs a scenario against a stage: speaks the lines, makes the direct calls,
 * waits for the events, and checks the expectations after each step.
 *
 * Two modes:
 *   scripted  no model. Each `say` step's `script` is replayed by the scripted
 *             provider. Deterministic; this is what CI and recordings use.
 *   live      the device's configured provider decides what to do. `script`
 *             is ignored and the expectations check what the model did.
 *
 * The same runner serves the CLI (as fast as possible) and the UI (paced, so
 * each line can be heard before the next one starts).
 */
import { randomUUID } from 'node:crypto';
import { matchValue, renderValue, TemplateError } from '../../shared/template.js';
import type { CheckResult, ElicitationEntry, JsonObject, ScenarioRunState, ScreenContent, SpeechEntry, StepResult, TimelineEntry, ToolEntry, ToolResult } from '../../shared/types.js';
import type { Device, TurnRecord } from '../device.js';
import { summarizeScenario, type Expectation, type Scenario, type ScenarioStep } from './schema.js';

export interface ScenarioHost {
  device(id: string): Device | undefined;
  deviceIds(): string[];
  vars: Record<string, unknown>;
}

export interface RunOptions {
  mode: 'scripted' | 'live';
  /** Wait for speech to finish and leave a gap between steps. */
  paced?: boolean;
  /** Gap between steps when paced, in milliseconds. */
  gapMs?: number;
  /** `step`: wait for `next()` before each step. */
  pacing?: 'auto' | 'step';
  signal?: AbortSignal;
  onUpdate?: (state: ScenarioRunState) => void;
  /** Called before a `say` step when paced, so a UI can show (or voice) the person's line first. Resolves when it is time to go on. */
  beforeSay?: (deviceId: string, text: string) => Promise<void>;
  /**
   * Press a button on the card a device is showing, the way a person would.
   * When this is given, a `call` step that names a `press` label is left to
   * the card: the button is pressed and the step waits for the card's own call.
   */
  pressCard?: (deviceId: string, label: string) => Promise<void>;
  /** How long to wait for a pressed card to make its call, in milliseconds. */
  pressTimeoutMs?: number;
}

export interface ScenarioRun {
  state: ScenarioRunState;
  /** Resolves with the final state. */
  done: Promise<ScenarioRunState>;
  /** Let the next step start (pacing `step`). */
  next(): void;
  stop(): void;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted || ms <= 0) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function textMatches(actual: string, expected: string | Record<string, unknown>): string | undefined {
  if (typeof expected === 'string') return actual.toLowerCase().includes(expected.toLowerCase()) ? undefined : `expected to find "${expected}"`;
  return matchValue(actual, expected, 'text');
}

function describeMatch(expected: string | Record<string, unknown>): string {
  return typeof expected === 'string' ? `"${expected}"` : JSON.stringify(expected);
}

function clip(text: string, length = 160): string {
  return text.length > length ? `${text.slice(0, length)}...` : text;
}

/** Check one step's expectations against what happened during it. */
export function checkExpectations(expectations: Expectation[], entries: TimelineEntry[], screen: ScreenContent | null, vars: Record<string, unknown>): CheckResult[] {
  const tools = entries.filter((entry): entry is ToolEntry => entry.kind === 'tool');
  const speech = entries.filter((entry): entry is SpeechEntry => entry.kind === 'speech');
  const said = speech.map((entry) => entry.text).join(' ');
  const announced = speech.filter((entry) => entry.reason === 'announcement').map((entry) => entry.text).join(' ');
  const asked = entries.filter((entry): entry is ElicitationEntry => entry.kind === 'elicitation').map((entry) => entry.message).join(' ');
  const called = [...new Set(tools.map((tool) => tool.name))].join(', ') || 'no tools';
  const results: CheckResult[] = [];

  for (const raw of expectations) {
    const expectation = renderValue(raw, vars) as Expectation;
    if ('tool' in expectation) {
      const label = `calls ${expectation.tool}`;
      const named = tools.filter((tool) => tool.name === expectation.tool);
      if (named.length === 0) {
        results.push({ ok: false, label, detail: `${expectation.tool} was not called (called: ${called}).` });
        continue;
      }
      if (expectation.times !== undefined && named.length !== expectation.times) {
        results.push({ ok: false, label: `${label} ${expectation.times} time(s)`, detail: `It was called ${named.length} time(s).` });
        continue;
      }
      let failure: string | undefined;
      let match: ToolEntry | undefined;
      for (const candidate of named) {
        failure = undefined;
        if (expectation.args) failure = matchValue(candidate.arguments, expectation.args, 'args');
        const failed = candidate.status === 'error';
        const errorText = candidate.error ?? (candidate.result?.content ?? []).map((block) => block.text ?? '').join(' ');
        if (!failure) {
          if (expectation.error === true) failure = failed ? undefined : 'the call succeeded, but an error was expected';
          else if (expectation.error !== undefined && expectation.error !== false) failure = failed ? textMatches(errorText, expectation.error)?.replace(/^/, 'error ') : 'the call succeeded, but an error was expected';
          else if (failed) failure = `the call failed: ${clip(errorText)}`;
        }
        if (!failure && expectation.result) failure = matchValue(candidate.result?.structuredContent, expectation.result, 'result');
        if (!failure) {
          match = candidate;
          break;
        }
      }
      if (match && expectation.save) vars[expectation.save] = match.result?.structuredContent ?? {};
      const what = [expectation.args ? `args ${JSON.stringify(expectation.args)}` : '', expectation.result ? `result ${JSON.stringify(expectation.result)}` : '', expectation.error ? 'an error' : ''].filter(Boolean).join(', ');
      results.push({ ok: Boolean(match), label: what ? `${label} with ${what}` : label, detail: match ? undefined : failure });
    } else if ('not_tool' in expectation) {
      const hit = tools.some((tool) => tool.name === expectation.not_tool);
      results.push({ ok: !hit, label: `does not call ${expectation.not_tool}`, detail: hit ? `${expectation.not_tool} was called.` : undefined });
    } else if ('said' in expectation) {
      const failure = textMatches(said, expectation.said);
      results.push({ ok: !failure, label: `says ${describeMatch(expectation.said)}`, detail: failure ? `${failure}. Said: "${clip(said) || '(nothing)'}"` : undefined });
    } else if ('not_said' in expectation) {
      const failure = textMatches(said, expectation.not_said);
      results.push({ ok: Boolean(failure), label: `does not say ${describeMatch(expectation.not_said)}`, detail: failure ? undefined : `Said: "${clip(said)}"` });
    } else if ('announced' in expectation) {
      const failure = textMatches(announced, expectation.announced);
      results.push({ ok: !failure, label: `announces ${describeMatch(expectation.announced)}`, detail: failure ? `${failure}. Announced: "${clip(announced) || '(nothing)'}"` : undefined });
    } else if ('asked' in expectation) {
      const failure = textMatches(asked, expectation.asked);
      results.push({ ok: !failure, label: `asks ${describeMatch(expectation.asked)}`, detail: failure ? `${failure}. Asked: "${clip(asked) || '(nothing)'}"` : undefined });
    } else if ('screen' in expectation) {
      const want = typeof expectation.screen === 'string' ? { card: expectation.screen } : expectation.screen;
      const shown = screen ? (screen.card?.uri ?? 'default') : 'none';
      let failure: string | undefined;
      if (want.card !== undefined && want.card !== shown) failure = `the screen shows ${shown === 'default' ? 'the default card' : shown === 'none' ? 'nothing' : shown}${screen ? ` (from ${screen.tool.name})` : ''}`;
      if (!failure && want.tool !== undefined && screen?.tool.name !== want.tool) failure = `the screen shows the result of ${screen?.tool.name ?? 'nothing'}`;
      if (!failure && want.result) failure = matchValue(screen?.result.structuredContent, want.result, 'screen result');
      results.push({ ok: !failure, label: `screen shows ${want.card ?? want.tool ?? 'the expected result'}`, detail: failure });
    }
  }
  return results;
}

export function startScenario(host: ScenarioHost, scenario: Scenario, options: RunOptions): ScenarioRun {
  const controller = new AbortController();
  options.signal?.addEventListener('abort', () => controller.abort());
  const signal = controller.signal;
  const state: ScenarioRunState = {
    runId: randomUUID(),
    scenario: summarizeScenario(scenario),
    mode: options.mode,
    status: 'running',
    pacing: options.pacing ?? 'auto',
    waitingForNext: false,
    steps: scenario.steps.map((step): StepResult => ({ index: step.index, label: step.label, device: step.device, kind: step.kind, status: 'pending', checks: [] })),
    startedAt: new Date().toISOString(),
  };
  const publish = () => options.onUpdate?.(structuredClone(state));
  let release: (() => void) | undefined;
  const gate = () =>
    new Promise<void>((resolve) => {
      release = resolve;
      signal.addEventListener('abort', () => resolve());
    });

  const cursors = new Map<string, number>();
  for (const id of host.deviceIds()) cursors.set(id, host.device(id)!.eventCursor());

  const runStep = async (step: ScenarioStep, result: StepResult): Promise<void> => {
    if (step.kind === 'pause') {
      if (options.paced) await sleep((step.pause ?? 0) * 1000, signal);
      return;
    }
    const device = host.device(step.device!);
    if (!device) throw new Error(`There is no device "${step.device}" on this stage. Devices: ${host.deviceIds().join(', ')}.`);
    let record: TurnRecord | undefined;

    if (step.kind === 'say') {
      if (options.mode === 'scripted' && !step.script) {
        throw new Error('This step has no "script", so it can only run in live mode. Add a script, or mark the step "only: live".');
      }
      if (options.mode === 'live' && !device.providerInfo.ready) {
        throw new Error(device.providerInfo.error ?? `The "${device.providerInfo.id}" provider is not ready.`);
      }
      if (options.mode === 'live' && device.providerInfo.id === 'scripted') {
        throw new Error('Live mode needs a model provider, but this device uses "scripted". Pass --provider, set VOICESTAGE_PROVIDER, or set assistant.provider in the configuration.');
      }
      device.clearQueuedAnswers();
      const answers = step.when_asked === undefined ? [] : Array.isArray(step.when_asked) ? step.when_asked : [step.when_asked];
      // When paced, a spoken answer is cued like any other line of the person, so it can be seen and heard.
      const cue = options.paced && options.beforeSay ? (text: string) => options.beforeSay!(device.id, text) : undefined;
      for (const answer of answers) device.queueAnswer(typeof answer === 'string' ? answer : (renderValue(answer, host.vars) as { content?: JsonObject; action?: 'decline' | 'cancel' }), cue);
      if (options.paced) await options.beforeSay?.(device.id, step.say!);
      record = await device.hear(step.say!, { source: 'scenario', script: options.mode === 'scripted' ? step.script : undefined, scripted: options.mode === 'scripted' });
      device.clearQueuedAnswers();
    } else if (step.kind === 'call') {
      const args = renderValue(step.args ?? {}, host.vars, true) as JsonObject;
      let pressed: TurnRecord & { result: ToolResult };
      if (step.press && options.pressCard) {
        // Something can press the real button: the card makes the call, as it would for a person.
        const made = device.waitForToolCall({ name: step.call!, origin: 'card', timeoutMs: options.pressTimeoutMs ?? 15_000 });
        made.catch(() => undefined);
        await options.pressCard(device.id, step.press);
        pressed = await made;
      } else {
        pressed = await device.press(step.call!, args, 'scenario', { show: step.show });
      }
      record = pressed;
      host.vars.last = pressed.result.structuredContent ?? {};
      if (step.save) host.vars[step.save] = pressed.result.structuredContent ?? {};
    } else {
      const wait = step.wait_for!;
      const event = await device.waitForEvent({
        name: wait.event,
        where: wait.where ? (renderValue(wait.where, host.vars) as JsonObject) : undefined,
        after: cursors.get(device.id) ?? 0,
        timeoutMs: (wait.timeout ?? 15) * 1000,
      });
      cursors.set(device.id, event.seq);
      host.vars.event = event.data;
      // If the device announces this event, the step lasts until it has finished doing so.
      if (event.announced && !device.hasHeldNotification) record = await event.announced;
    }

    if (record?.error) throw new Error(record.error);
    if (options.paced) await device.whenQuiet();
    if (step.expect && step.expect.length > 0) {
      result.checks = checkExpectations(step.expect, record?.entries ?? [], device.currentScreen(), host.vars);
    }
  };

  const done = (async (): Promise<ScenarioRunState> => {
    publish();
    let broken = false;
    for (const step of scenario.steps) {
      const result = state.steps[step.index]!;
      if (signal.aborted) break;
      if (broken || (step.only && step.only !== options.mode)) {
        result.status = 'skipped';
        publish();
        continue;
      }
      if (state.pacing === 'step' && step.kind !== 'pause') {
        state.waitingForNext = true;
        publish();
        await gate();
        state.waitingForNext = false;
        if (signal.aborted) break;
      }
      result.status = 'running';
      publish();
      const started = Date.now();
      try {
        await runStep(step, result);
        result.status = result.checks.every((check) => check.ok) ? 'passed' : 'failed';
      } catch (error) {
        result.status = 'failed';
        result.error = error instanceof TemplateError ? `${error.message} An earlier step was expected to save it.` : error instanceof Error ? error.message : String(error);
        // Later steps build on this one; running them would only add noise.
        broken = true;
      }
      result.durationMs = Date.now() - started;
      publish();
      if (options.paced && !signal.aborted && state.pacing !== 'step') await sleep(options.gapMs ?? 900, signal);
    }
    state.status = signal.aborted ? 'stopped' : state.steps.some((step) => step.status === 'failed') ? 'failed' : 'passed';
    state.waitingForNext = false;
    state.finishedAt = new Date().toISOString();
    publish();
    return structuredClone(state);
  })();

  return {
    state,
    done,
    next: () => {
      const go = release;
      release = undefined;
      go?.();
    },
    stop: () => controller.abort(),
  };
}

/** A plain-text report of a finished run, for the terminal. */
export function formatReport(state: ScenarioRunState, options: { color?: boolean } = {}): string {
  const paint = (code: number, text: string) => (options.color ? `\u001b[${code}m${text}\u001b[0m` : text);
  const lines: string[] = [`${paint(1, state.scenario.name)}  (${state.mode} mode)`];
  for (const step of state.steps) {
    const mark = step.status === 'passed' ? paint(32, '✓') : step.status === 'failed' ? paint(31, '✗') : step.status === 'skipped' ? paint(90, '-') : paint(90, '·');
    const time = step.durationMs !== undefined && step.status !== 'skipped' ? paint(90, ` ${step.durationMs} ms`) : '';
    lines.push(`  ${mark} ${step.index + 1}. ${step.label}${time}`);
    if (step.error) lines.push(`      ${paint(31, step.error)}`);
    for (const check of step.checks) {
      lines.push(`      ${check.ok ? paint(32, '✓') : paint(31, '✗')} ${check.label}`);
      if (!check.ok && check.detail) lines.push(`          ${paint(31, check.detail)}`);
    }
  }
  const passed = state.steps.filter((step) => step.status === 'passed').length;
  const failed = state.steps.filter((step) => step.status === 'failed').length;
  const skipped = state.steps.filter((step) => step.status === 'skipped').length;
  const verdict = state.status === 'passed' ? paint(32, 'PASSED') : state.status === 'stopped' ? paint(33, 'STOPPED') : paint(31, 'FAILED');
  lines.push(`  ${verdict}: ${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}`);
  return lines.join('\n');
}

/** A plain-text rendering of a device's timeline, for `voicestage scenario --trace`. */
export function formatTimeline(entries: TimelineEntry[]): string {
  const short = (value: unknown, length = 220) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text === undefined ? '' : text.length > length ? `${text.slice(0, length)}...` : text;
  };
  const lines: string[] = [];
  for (const entry of entries) {
    const time = entry.at.slice(11, 23);
    switch (entry.kind) {
      case 'utterance':
        lines.push(`${time}  heard      "${entry.text}"`);
        break;
      case 'speech':
        lines.push(`${time}  ${entry.reason === 'announcement' ? 'announced ' : entry.reason === 'question' ? 'asked     ' : 'said      '} "${entry.text}"`);
        break;
      case 'model':
        lines.push(`${time}  model      ${entry.model ?? entry.provider} round ${entry.round}: ${entry.toolCalls.length > 0 ? `calls ${entry.toolCalls.map((call) => call.name).join(', ')}` : entry.text ? `"${short(entry.text, 120)}"` : (entry.note ?? '')}`);
        break;
      case 'tool':
        lines.push(`${time}  tool       ${entry.name}(${short(entry.arguments)}) [${entry.origin}] -> ${entry.status}${entry.durationMs !== undefined ? ` in ${entry.durationMs} ms` : ''}${entry.progress.length > 0 ? `, ${entry.progress.length} progress` : ''}`);
        if (entry.result?.structuredContent !== undefined) lines.push(`${' '.repeat(25)}${short(entry.result.structuredContent, 300)}`);
        else if (entry.status === 'error') lines.push(`${' '.repeat(25)}${short(entry.error ?? (entry.result?.content ?? []).map((block) => block.text).join(' '), 300)}`);
        break;
      case 'elicitation':
        lines.push(`${time}  question   "${entry.message}" -> ${entry.status}${entry.content ? ` ${JSON.stringify(entry.content)}` : ''}${entry.answeredBy ? ` (by ${entry.answeredBy})` : ''}`);
        break;
      case 'event':
        lines.push(`${time}  event      ${entry.name} (${entry.channel})${entry.matched ? ', announced' : ''}`);
        break;
      case 'resource':
        lines.push(`${time}  resource   ${entry.uri}${entry.error ? ` FAILED: ${entry.error}` : ` ${entry.bytes ?? '?'} bytes`}`);
        break;
      case 'connection':
        lines.push(`${time}  connection ${entry.server}: ${entry.status === 'connected' ? `MCP ${entry.protocolVersion}, ${entry.toolCount} tools` : (entry.error ?? entry.status)}`);
        break;
      case 'skill':
        lines.push(`${time}  skill      ${entry.action} ${entry.name}${entry.file ? `/${entry.file}` : ''}`);
        break;
      case 'card':
        lines.push(`${time}  card       ${entry.action}`);
        break;
      case 'error':
        lines.push(`${time}  ERROR      ${entry.message}${entry.detail ? `: ${short(entry.detail, 300)}` : ''}`);
        break;
    }
  }
  return lines.join('\n');
}
