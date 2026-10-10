import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkExpectations, formatReport } from '../src/core/scenario/runner.js';
import { loadScenarios, parseScenario, ScenarioError, summarizeScenario } from '../src/core/scenario/schema.js';
import type { ScenarioRunState, ScreenContent, TimelineEntry } from '../src/shared/types.js';

const VALID = `
name: Order a pizza
description: A test.
config: ../stage.yaml
steps:
  - device: kitchen
    say: "Order my usual pizza."
    when_asked: "Large"
    script:
      - call: start_order
        args: { item: pizza }
        save: order
      - say: "{{order.message}}"
        if: order.ok
    expect:
      - tool: start_order
        args: { item: pizza }
        result: { status: pending }
        save: order
      - not_tool: pay
      - said: "ordered"
      - screen: ui://shop/order.html
  - device: phone
    wait_for: { event: order.created, where: { order.id: "{{order.id}}" }, timeout: 5 }
    expect:
      - announced: { contains: pizza }
  - device: phone
    label: Approve on the phone
    call: approve_order
    args: { id: "{{order.id}}" }
    save: approval
    show: false
  - pause: 1.5
  - device: kitchen
    say: "Live only."
    only: live
`;

describe('scenario files', () => {
  it('parses steps and gives each a kind and a label', () => {
    const scenario = parseScenario(VALID, '/work/scenarios/pizza.yaml');
    expect(scenario).toMatchObject({ id: 'pizza', file: '/work/scenarios/pizza.yaml', name: 'Order a pizza', description: 'A test.', configPath: '/work/stage.yaml', devices: ['kitchen', 'phone'] });
    expect(scenario.steps.map((step) => [step.kind, step.label])).toEqual([
      ['say', 'kitchen hears: "Order my usual pizza."'],
      ['wait_for', 'phone waits for order.created'],
      ['call', 'Approve on the phone'],
      ['pause', 'Pause 1.5s'],
      ['say', 'kitchen hears: "Live only."'],
    ]);
    expect(scenario.steps[0]!.script).toEqual([{ call: 'start_order', args: { item: 'pizza' }, save: 'order' }, { say: '{{order.message}}', if: 'order.ok' }]);
    expect(scenario.steps[2]).toMatchObject({ call: 'approve_order', save: 'approval', show: false });
    expect(summarizeScenario(scenario).steps).toHaveLength(5);
  });

  it('explains what is wrong, naming the step', () => {
    const broken = (steps: string) => () => parseScenario(`name: x\nsteps:\n${steps}`, 'broken.yaml');
    expect(broken('  - device: a\n    say: hi\n    call: tool')).toThrow(/step 1: A step needs exactly one of "say", "call", "wait_for" or "pause"/);
    expect(broken('  - device: a\n    say: hi\n  - say: hello')).toThrow(/step 2: This step needs a "device"/);
    expect(broken('  - device: a\n    call: t\n    script: [{ say: x }]')).toThrow(/"script" belongs to a "say" step/);
    expect(broken('  - device: a\n    say: hi\n    script: [{ args: {} }]')).toThrow(/needs "call", "say" or "skill"/);
    expect(broken('  - device: a\n    say: hi\n    expects: []')).toThrow(ScenarioError);
    expect(() => parseScenario('steps: []', 'x.yaml')).toThrow(/not a valid scenario/);
    expect(() => parseScenario('name: [unclosed', 'x.yaml')).toThrow(/not valid YAML/);
  });

  it('loads folders of scenarios and reports the ones that do not parse', () => {
    const dir = mkdtempSync(join(tmpdir(), 'voicestage-scenarios-'));
    writeFileSync(join(dir, 'b.yaml'), 'name: B\nsteps:\n  - pause: 1\n');
    writeFileSync(join(dir, 'a.yml'), 'name: A\nsteps:\n  - pause: 1\n');
    writeFileSync(join(dir, 'bad.yaml'), 'name: Bad\n');
    writeFileSync(join(dir, 'notes.txt'), 'not a scenario');
    const errors: string[] = [];
    const scenarios = loadScenarios([dir, join(dir, 'missing')], (path, error) => errors.push(`${path}: ${error.message}`));
    expect(scenarios.map((scenario) => scenario.id)).toEqual(['a', 'b']);
    expect(errors).toHaveLength(2);
    expect(errors.join('\n')).toMatch(/bad\.yaml.*not a valid scenario/s);
    expect(errors.join('\n')).toMatch(/missing does not exist/);
  });

  it('parses every scenario that ships with the project', () => {
    const root = resolve(import.meta.dirname, '..');
    const errors: string[] = [];
    const scenarios = loadScenarios([join(root, 'scenarios/example'), join(root, 'examples/holdon/scenarios')], (path, error) => errors.push(`${path}: ${error.message}`));
    expect(errors).toEqual([]);
    expect(scenarios.map((scenario) => scenario.id)).toEqual(['pancakes', 'soup-and-tea', 'a-irs-gift-cards', 'b-utility-bill', 'c-contractor-deposit']);
    for (const scenario of scenarios) {
      // Every spoken step has a script, so every shipped scenario can run with no model.
      for (const step of scenario.steps.filter((candidate) => candidate.kind === 'say')) expect(step.script, `${scenario.id} step ${step.index + 1}`).toBeDefined();
    }
  });
});

const at = '2026-10-11T12:00:00.000Z';
const entries: TimelineEntry[] = [
  { id: '1', seq: 1, at, kind: 'utterance', text: 'Pay my bill', source: 'scenario' },
  { id: '2', seq: 2, at, kind: 'tool', server: 'app', name: 'check', arguments: { amount: 20, method: 'card' }, origin: 'assistant', status: 'ok', result: { structuredContent: { verdict: 'verified', payee: { status: 'verified' }, id: 'chk_1' } }, progress: [] },
  { id: '3', seq: 3, at, kind: 'tool', server: 'app', name: 'pay', arguments: { id: 'chk_1' }, origin: 'assistant', status: 'error', result: { isError: true, content: [{ type: 'text', text: 'Error (not_approved): Not approved yet.' }] }, progress: [] },
  { id: '4', seq: 4, at, kind: 'speech', text: 'I have put it on hold and told Sarah.', reason: 'reply' },
  { id: '5', seq: 5, at, kind: 'speech', text: 'Sarah has answered.', reason: 'announcement' },
  { id: '6', seq: 6, at, kind: 'elicitation', server: 'app', message: 'How did this reach you?', requestedSchema: {}, status: 'accept' },
];
const screen = { id: 's', at, server: 'app', tool: { name: 'check', exposedName: 'check', server: 'app' }, arguments: {}, result: { structuredContent: { verdict: 'verified' } }, origin: 'assistant', card: { uri: 'ui://app/card.html', html: '' } } as ScreenContent;

describe('expectations', () => {
  it('passes when the step did what was expected, and saves results for later steps', () => {
    const vars: Record<string, unknown> = { want: 'verified' };
    const checks = checkExpectations(
      [
        { tool: 'check', args: { method: 'card' }, result: { verdict: '{{want}}', 'payee.status': 'verified' }, save: 'check' },
        { tool: 'pay', error: true },
        { tool: 'pay', error: 'not approved' },
        { not_tool: 'refund' },
        { said: 'on hold' },
        { said: { matches: 'told \\w+' } },
        { not_said: 'paid' },
        { announced: 'Sarah' },
        { asked: 'reach you' },
        { screen: 'ui://app/card.html' },
        { screen: { tool: 'check', result: { verdict: 'verified' } } },
      ],
      entries,
      screen,
      vars,
    );
    expect(checks.filter((check) => !check.ok)).toEqual([]);
    expect(checks).toHaveLength(11);
    expect(vars.check).toEqual({ verdict: 'verified', payee: { status: 'verified' }, id: 'chk_1' });
  });

  it('says exactly what did not match', () => {
    const checks = checkExpectations(
      [
        { tool: 'refund' },
        { tool: 'check', result: { verdict: 'stop' } },
        { tool: 'check', args: { method: 'gift_card' } },
        { tool: 'pay' },
        { tool: 'check', times: 2 },
        { not_tool: 'pay' },
        { said: 'receipt' },
        { not_said: 'hold' },
        { announced: 'Margaret' },
        { screen: 'default' },
        { screen: { tool: 'pay' } },
      ],
      entries,
      screen,
      {},
    );
    expect(checks.every((check) => !check.ok)).toBe(true);
    expect(checks.map((check) => check.detail)).toEqual([
      'refund was not called (called: check, pay).',
      'result.verdict is "verified", expected "stop"',
      'args.method is "card", expected "gift_card"',
      'the call failed: Error (not_approved): Not approved yet.',
      'It was called 1 time(s).',
      'pay was called.',
      expect.stringMatching(/expected to find "receipt". Said: "I have put it on hold/),
      expect.stringMatching(/^Said: /),
      expect.stringMatching(/Announced: "Sarah has answered."/),
      'the screen shows ui://app/card.html (from check)',
      'the screen shows the result of check',
    ]);
  });

  it('checks the screen of a device that shows nothing or the default card', () => {
    expect(checkExpectations([{ screen: 'none' }], [], null, {})[0]!.ok).toBe(true);
    expect(checkExpectations([{ screen: 'default' }], [], { ...screen, card: undefined }, {})[0]!.ok).toBe(true);
    expect(checkExpectations([{ screen: 'default' }], [], null, {})[0]).toMatchObject({ ok: false, detail: 'the screen shows nothing' });
  });
});

describe('report', () => {
  it('prints steps, checks and a verdict', () => {
    const state: ScenarioRunState = {
      runId: 'r',
      scenario: { id: 'x', file: 'x.yaml', name: 'Order a pizza', devices: ['kitchen'], steps: [] },
      mode: 'scripted',
      status: 'failed',
      pacing: 'auto',
      waitingForNext: false,
      startedAt: at,
      steps: [
        { index: 0, label: 'kitchen hears: "Order"', kind: 'say', status: 'passed', durationMs: 12, checks: [{ ok: true, label: 'calls start_order' }] },
        { index: 1, label: 'phone waits for order.created', kind: 'wait_for', status: 'failed', durationMs: 5000, error: 'No "order.created" event reached phone within 5s.', checks: [{ ok: false, label: 'announces "pizza"', detail: 'expected to find "pizza"' }] },
        { index: 2, label: 'Pause 1s', kind: 'pause', status: 'skipped', checks: [] },
      ],
    };
    expect(formatReport(state)).toBe(
      [
        'Order a pizza  (scripted mode)',
        '  ✓ 1. kitchen hears: "Order" 12 ms',
        '      ✓ calls start_order',
        '  ✗ 2. phone waits for order.created 5000 ms',
        '      No "order.created" event reached phone within 5s.',
        '      ✗ announces "pizza"',
        '          expected to find "pizza"',
        '  - 3. Pause 1s',
        '  FAILED: 1 passed, 1 failed, 1 skipped',
      ].join('\n'),
    );
  });
});
