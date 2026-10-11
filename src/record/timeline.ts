/**
 * The timeline that goes with a recorded video: what is heard and what is seen,
 * with times in seconds from the first frame of the video file.
 *
 * It is built from three records, all stamped with the same wall clock:
 * what the page reported as it drew it (each sentence's caption, each card),
 * what the stage did (tool calls, notifications, questions, scenario steps),
 * and what the recorder itself did (button presses).
 */
import type { RecordingMark } from '../shared/recording.js';
import type { StageEvent } from '../shared/types.js';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TimelineDevice {
  id: string;
  name: string;
  kind: string;
  person: string;
  /** Where the device's caption strip is in the picture, in pixels. */
  captions?: Rect;
}

export interface Press {
  deviceId: string;
  label: string;
  /** When the pointer appeared, when the button went down, and when the pointer let go. Wall clock, milliseconds. */
  start: number;
  at: number;
  end: number;
  x: number;
  y: number;
}

export interface SentenceTiming {
  start: number;
  end: number;
  text: string;
  /** Whether the caption on the device changes when this sentence starts (a person's whole line is shown at once). */
  caption: boolean;
  clip: string;
}

interface Base {
  /** Seconds from the start of the video. */
  start: number;
  end: number;
  /** Device id. */
  device: string;
  /** The person or the device, by name. */
  who: string;
  /** What was said, or a short description of what happened. */
  text: string;
}

export type TimelineItem =
  | (Base & { kind: 'utterance'; role: 'person' | 'assistant'; voice: string; sentences: SentenceTiming[] })
  | (Base & { kind: 'card'; card: string; tool: string })
  | (Base & { kind: 'tool'; tool: string; origin: string; ok: boolean })
  | (Base & { kind: 'notification' })
  | (Base & { kind: 'question'; answer?: unknown; answeredBy?: string })
  | (Base & { kind: 'press'; label: string; at: number; x: number; y: number })
  | (Base & { kind: 'event'; name: string });

export interface StepTiming {
  index: number;
  label: string;
  device?: string;
  status: string;
  start?: number;
  end?: number;
}

export interface TimelineInput {
  /** Wall-clock time of the first frame of the video, in milliseconds. */
  origin: number;
  /** Length of the video, in seconds. */
  duration: number;
  devices: TimelineDevice[];
  marks: RecordingMark[];
  /** Stage events with the wall-clock time at which they were emitted. */
  stageEvents: Array<{ at: number; event: StageEvent }>;
  presses: Press[];
  /** The voice of each clip, by clip id. */
  voices: Map<string, string>;
}

const round = (seconds: number) => Math.round(seconds * 1000) / 1000;

export function buildTimeline(input: TimelineInput): { items: TimelineItem[]; steps: StepTiming[] } {
  const { origin, duration } = input;
  const seconds = (wall: number) => round(Math.max(0, Math.min(duration, (wall - origin) / 1000)));
  const device = (id: string) => input.devices.find((candidate) => candidate.id === id);
  const items: TimelineItem[] = [];

  // Speech: one utterance per line, with its sentences.
  const lines = new Map<number, Array<Extract<RecordingMark, { type: 'sentence' }>>>();
  for (const mark of input.marks) {
    if (mark.type !== 'sentence') continue;
    const line = lines.get(mark.lineId) ?? [];
    line.push(mark);
    lines.set(mark.lineId, line);
  }
  for (const sentences of lines.values()) {
    sentences.sort((a, b) => a.at - b.at);
    const first = sentences[0]!;
    const last = sentences.at(-1)!;
    const at = device(first.deviceId);
    items.push({
      kind: 'utterance',
      start: seconds(first.at),
      end: seconds(last.at + last.ms),
      device: first.deviceId,
      who: first.role === 'person' ? (at?.person ?? first.deviceId) : (at?.name ?? first.deviceId),
      role: first.role,
      voice: input.voices.get(first.clip) ?? '',
      text: first.line,
      sentences: sentences.map((sentence) => ({
        start: seconds(sentence.at),
        end: seconds(sentence.at + sentence.ms),
        text: sentence.text,
        caption: sentence.role === 'assistant' || sentence.index === 0,
        clip: sentence.clip,
      })),
    });
  }

  // Cards, as the page drew them. A card is on screen until the next one on that device.
  const cards = input.marks.filter((mark): mark is Extract<RecordingMark, { type: 'card' }> => mark.type === 'card').sort((a, b) => a.at - b.at);
  for (const [index, card] of cards.entries()) {
    const next = cards.slice(index + 1).find((candidate) => candidate.deviceId === card.deviceId);
    items.push({
      kind: 'card',
      start: seconds(card.at),
      end: next ? seconds(next.at) : round(duration),
      device: card.deviceId,
      who: device(card.deviceId)?.name ?? card.deviceId,
      card: card.card,
      tool: card.tool,
      text: card.card === 'default' ? `Shows the result of ${card.tool}` : `Shows the card ${card.card} (${card.tool})`,
    });
  }

  // What the stage did.
  const open = new Map<string, TimelineItem>();
  const notifications = new Map<string, TimelineItem>();
  const steps = new Map<number, StepTiming>();
  for (const { at, event } of input.stageEvents) {
    // What happened before the first frame is not in the video.
    if (at < origin) continue;
    if (event.type === 'timeline') {
      const entry = event.entry;
      const name = device(event.deviceId)?.name ?? event.deviceId;
      if (entry.kind === 'tool') {
        let item = open.get(entry.id);
        if (!item) {
          const by = entry.origin === 'card' ? `${device(event.deviceId)?.person ?? 'The person'}, on the card` : entry.origin === 'announcement' ? `${name}, for an announcement` : entry.origin === 'scenario' ? 'The scenario' : name;
          item = { kind: 'tool', start: seconds(at), end: seconds(at), device: event.deviceId, who: name, tool: entry.name, origin: entry.origin, ok: true, text: `${by} calls ${entry.name}` };
          open.set(entry.id, item);
          items.push(item);
        }
        if (entry.status !== 'running' && item.kind === 'tool') {
          item.end = seconds(at);
          item.ok = entry.status === 'ok';
        }
      } else if (entry.kind === 'elicitation') {
        let item = open.get(entry.id);
        if (!item) {
          item = { kind: 'question', start: seconds(at), end: round(duration), device: event.deviceId, who: name, text: entry.message };
          open.set(entry.id, item);
          items.push(item);
        }
        if (entry.status !== 'pending' && item.kind === 'question') {
          item.end = seconds(at);
          item.answer = entry.status === 'accept' ? entry.content : entry.status;
          item.answeredBy = entry.answeredBy;
        }
      } else if (entry.kind === 'event' && entry.matched && !open.has(entry.id)) {
        // Only the events a device acts on: those are the ones a viewer sees the result of.
        const item: TimelineItem = { kind: 'event', start: seconds(at), end: seconds(at), device: event.deviceId, who: name, name: entry.name, text: `${name} receives "${entry.name}" from ${entry.server} and will announce it` };
        open.set(entry.id, item);
        items.push(item);
      }
    } else if (event.type === 'device' && event.patch.notification !== undefined) {
      const notification = event.patch.notification;
      if (notification) {
        let item = notifications.get(notification.id);
        if (!item) {
          item = { kind: 'notification', start: seconds(at), end: round(duration), device: event.deviceId, who: device(event.deviceId)?.name ?? event.deviceId, text: notification.text };
          notifications.set(notification.id, item);
          items.push(item);
        }
        if (notification.state === 'done') item.end = seconds(at);
      }
    } else if (event.type === 'scenario' && event.run) {
      for (const step of event.run.steps) {
        const timing = steps.get(step.index) ?? { index: step.index, label: step.label, device: step.device, status: step.status };
        timing.status = step.status;
        if (step.status === 'running' && timing.start === undefined) timing.start = seconds(at);
        if ((step.status === 'passed' || step.status === 'failed') && timing.end === undefined) {
          timing.start ??= seconds(at);
          timing.end = seconds(at);
        }
        steps.set(step.index, timing);
      }
    }
  }

  for (const press of input.presses) {
    const at = device(press.deviceId);
    items.push({
      kind: 'press',
      start: seconds(press.start),
      at: seconds(press.at),
      end: seconds(press.end),
      device: press.deviceId,
      who: at?.person ?? press.deviceId,
      label: press.label,
      x: Math.round(press.x),
      y: Math.round(press.y),
      text: `${at?.person ?? 'The person'} presses "${press.label}" on ${at?.name ?? press.deviceId}`,
    });
  }

  items.sort((a, b) => a.start - b.start || a.end - b.end);
  return { items, steps: [...steps.values()].sort((a, b) => a.index - b.index) };
}

/** Sentences that are heard at the same time, which must never happen: pairs that overlap by more than a millisecond. */
export function overlappingSentences(items: TimelineItem[]): Array<{ first: string; second: string; overlap: number }> {
  const sentences = items.flatMap((item) => (item.kind === 'utterance' ? item.sentences : [])).sort((a, b) => a.start - b.start);
  const clashes: Array<{ first: string; second: string; overlap: number }> = [];
  for (let index = 1; index < sentences.length; index += 1) {
    const overlap = sentences[index - 1]!.end - sentences[index]!.start;
    if (overlap > 0.001) clashes.push({ first: sentences[index - 1]!.text, second: sentences[index]!.text, overlap: round(overlap) });
  }
  return clashes;
}
