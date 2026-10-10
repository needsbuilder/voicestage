import { resolveConfig, type StageConfig } from '../src/core/config.js';
import { Stage, type StageOptions } from '../src/core/stage.js';
import type { ElicitationEntry, SpeechEntry, StageEvent, TimelineEntry, ToolEntry } from '../src/shared/types.js';
import { resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '..');

/** A stage on the built-in example server, with no model. */
export function exampleConfig(overrides: { devices?: unknown[]; announce?: unknown[]; protocol?: string } = {}): StageConfig {
  return resolveConfig(
    {
      name: 'Test stage',
      servers: {
        kitchen: {
          builtin: 'example',
          protocol: overrides.protocol ?? '2025-11-25',
          events: { announce: overrides.announce ?? [{ on: 'timer.done', devices: ['display'], say: 'Your {{timer.label}} timer is done.' }] },
        },
      },
      skills: { 'kitchen-helper': 'examples/skills/kitchen-helper' },
      devices: overrides.devices ?? [
        { id: 'display', name: 'Kitchen display', kind: 'display', person: 'Alex', servers: ['kitchen'], skills: ['kitchen-helper'] },
        { id: 'phone', name: 'Phone', kind: 'phone', person: 'Sam', servers: ['kitchen'] },
      ],
      scenarios: ['scenarios/example'],
    },
    { baseDir: ROOT, env: {} },
  );
}

export async function startStage(config: StageConfig, options: StageOptions = {}): Promise<{ stage: Stage; events: StageEvent[] }> {
  const stage = new Stage(config, { env: {}, ...options });
  const events: StageEvent[] = [];
  stage.subscribe((event) => events.push(event));
  await stage.start();
  await Promise.all([...stage.devices.values()].map((device) => device.eventsReady()));
  return { stage, events };
}

export const tools = (entries: TimelineEntry[]) => entries.filter((entry): entry is ToolEntry => entry.kind === 'tool');
export const speech = (entries: TimelineEntry[]) => entries.filter((entry): entry is SpeechEntry => entry.kind === 'speech');
export const questions = (entries: TimelineEntry[]) => entries.filter((entry): entry is ElicitationEntry => entry.kind === 'elicitation');
