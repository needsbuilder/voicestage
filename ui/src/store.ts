/**
 * The UI's state: the stage as the server last described it, plus the things
 * that only exist in the browser (captions, which device is listening, what is
 * open in the inspector).
 *
 * One server-sent events connection feeds it. Components read it with `useStage`.
 */
import { useSyncExternalStore } from 'react';
import type { DeviceSnapshot, ScenarioRunState, StageEvent, StageSnapshot, TimelineEntry } from '../../src/shared/types';
import { api } from './api';
import { listen, splitSentences, voice, type Listening } from './voice';

export interface Caption {
  /** What the person last said, or is saying. */
  user?: { text: string; state: 'listening' | 'typing' | 'said' };
  /** The sentence the device is saying, or said last. */
  assistant?: { text: string; speaking: boolean };
}

export interface Settings {
  /** Speak aloud. When off, lines are shown for as long as they would take to say. */
  voice: boolean;
  /** In a played scenario, also voice the people's lines. */
  voicePeople: boolean;
  inspector: boolean;
  inspectorDevice: string | undefined;
  inspectorTab: 'timeline' | 'connections' | 'scenario';
}

export interface UiState {
  connected: boolean;
  everConnected: boolean;
  stage: StageSnapshot | null;
  captions: Record<string, Caption>;
  settings: Settings;
  listening: { deviceId: string; mode: 'talk' | 'wake' } | null;
  micError: string | null;
  toast: string | null;
}

const SETTINGS_KEY = 'voicestage.settings';

function loadSettings(): Settings {
  const defaults: Settings = { voice: true, voicePeople: true, inspector: true, inspectorDevice: undefined, inspectorTab: 'timeline' };
  try {
    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Partial<Settings>;
    const params = new URLSearchParams(location.search);
    const merged = { ...defaults, ...stored };
    // URL switches, handy for screenshots and recordings: ?inspector=0&voice=0&tab=scenario&device=phone
    if (params.has('inspector')) merged.inspector = params.get('inspector') !== '0';
    if (params.has('voice')) merged.voice = params.get('voice') !== '0';
    if (params.has('device')) merged.inspectorDevice = params.get('device') ?? undefined;
    const tab = params.get('tab');
    if (tab === 'timeline' || tab === 'connections' || tab === 'scenario') merged.inspectorTab = tab;
    return merged;
  } catch {
    return defaults;
  }
}

let state: UiState = {
  connected: false,
  everConnected: false,
  stage: null,
  captions: {},
  settings: loadSettings(),
  listening: null,
  micError: null,
  toast: null,
};
voice.enabled = state.settings.voice;

const subscribers = new Set<() => void>();

function set(next: Partial<UiState>): void {
  state = { ...state, ...next };
  for (const notify of subscribers) notify();
}

export function useStage<T>(selector: (state: UiState) => T): T {
  return useSyncExternalStore(
    (notify) => {
      subscribers.add(notify);
      return () => subscribers.delete(notify);
    },
    () => selector(state),
  );
}

export function getState(): UiState {
  return state;
}

function updateDevice(deviceId: string, change: (device: DeviceSnapshot) => DeviceSnapshot): void {
  if (!state.stage) return;
  set({ stage: { ...state.stage, devices: state.stage.devices.map((device) => (device.id === deviceId ? change(device) : device)) } });
}

function setCaption(deviceId: string, change: Partial<Caption>): void {
  set({ captions: { ...state.captions, [deviceId]: { ...state.captions[deviceId], ...change } } });
}

function deviceIndex(deviceId: string): number {
  return Math.max(0, state.stage?.devices.findIndex((device) => device.id === deviceId) ?? 0);
}

function captionsFrom(stage: StageSnapshot, existing: Record<string, Caption>): Record<string, Caption> {
  const captions: Record<string, Caption> = {};
  for (const device of stage.devices) {
    if (existing[device.id]) {
      captions[device.id] = existing[device.id]!;
      continue;
    }
    const lastUser = [...device.transcript].reverse().find((line) => line.role === 'user');
    const lastAssistant = device.transcript.at(-1)?.role === 'assistant' ? device.transcript.at(-1) : undefined;
    captions[device.id] = {
      user: lastUser ? { text: lastUser.text, state: 'said' } : undefined,
      // Captions show one sentence at a time; after a reload, show the last one.
      assistant: lastAssistant ? { text: splitSentences(lastAssistant.text).at(-1) ?? lastAssistant.text, speaking: false } : undefined,
    };
  }
  return captions;
}

function upsert(timeline: TimelineEntry[], entry: TimelineEntry): TimelineEntry[] {
  const index = timeline.findIndex((candidate) => candidate.id === entry.id);
  if (index < 0) return [...timeline, entry];
  const copy = timeline.slice();
  copy[index] = entry;
  return copy;
}

function apply(event: StageEvent): void {
  switch (event.type) {
    case 'snapshot': {
      const first = !state.stage;
      set({
        stage: event.stage,
        captions: captionsFrom(event.stage, first ? {} : state.captions),
        settings: state.settings.inspectorDevice && event.stage.devices.some((device) => device.id === state.settings.inspectorDevice) ? state.settings : { ...state.settings, inspectorDevice: event.stage.devices[0]?.id },
      });
      break;
    }
    case 'device':
      updateDevice(event.deviceId, (device) => ({ ...device, ...event.patch }));
      break;
    case 'transcript':
      updateDevice(event.deviceId, (device) => ({ ...device, transcript: [...device.transcript, event.line] }));
      // A new line from the person replaces whatever the device said before.
      if (event.line.role === 'user') setCaption(event.deviceId, { user: { text: event.line.text, state: 'said' }, assistant: undefined });
      break;
    case 'timeline':
      updateDevice(event.deviceId, (device) => ({ ...device, timeline: upsert(device.timeline, event.entry) }));
      break;
    case 'speech': {
      const device = state.stage?.devices.find((candidate) => candidate.id === event.deviceId);
      voice.speak({
        deviceId: event.deviceId,
        text: event.text,
        role: 'assistant',
        deviceIndex: deviceIndex(event.deviceId),
        prefs: device?.voice,
        onSentence: (sentence) => {
          const current = state.captions[event.deviceId]?.assistant;
          if (sentence !== null) setCaption(event.deviceId, { assistant: { text: sentence, speaking: true } });
          else if (current) setCaption(event.deviceId, { assistant: { ...current, speaking: false } });
        },
        onDone: () => void api.speechDone(event.deviceId, event.id),
      });
      break;
    }
    case 'cue': {
      // A scenario is about to speak a person's line: show it being said, then let the scenario go on.
      setCaption(event.deviceId, { user: { text: event.text, state: 'typing' }, assistant: undefined });
      const finish = () => {
        setCaption(event.deviceId, { user: { text: event.text, state: 'said' } });
        void api.cueDone(event.id);
      };
      if (state.settings.voicePeople && state.settings.voice) {
        voice.speak({ deviceId: event.deviceId, text: event.text, role: 'person', deviceIndex: deviceIndex(event.deviceId), onSentence: () => undefined, onDone: finish });
      } else {
        window.setTimeout(finish, Math.min(4500, 700 + event.text.length * 32));
      }
      break;
    }
    case 'reset':
      voice.cancel(event.deviceId);
      updateDevice(event.deviceId, (device) => ({ ...device, timeline: [], transcript: [], screen: null, notification: null, elicitation: null, progress: null, status: 'idle' }));
      setCaption(event.deviceId, { user: undefined, assistant: undefined });
      break;
    case 'scenario':
      if (state.stage) set({ stage: { ...state.stage, run: event.run } });
      break;
  }
}

let source: EventSource | undefined;

export function connect(): void {
  if (source) return;
  source = new EventSource('/api/stream');
  source.onopen = () => set({ connected: true, everConnected: true });
  source.onerror = () => set({ connected: false });
  source.onmessage = (message) => {
    try {
      apply(JSON.parse(message.data as string) as StageEvent);
    } catch (error) {
      console.error('Bad stage event', error);
    }
  };
}

// --- actions ------------------------------------------------------------------

export function updateSettings(change: Partial<Settings>): void {
  const settings = { ...state.settings, ...change };
  set({ settings });
  voice.enabled = settings.voice;
  if (!settings.voice) voice.cancel();
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Private mode: settings just do not persist.
  }
}

export function showToast(message: string | null): void {
  set({ toast: message });
  if (message) window.setTimeout(() => state.toast === message && set({ toast: null }), 6000);
}

export function say(deviceId: string, text: string, source: 'typed' | 'voice' = 'typed'): void {
  const clean = text.trim();
  if (!clean) return;
  // Starting to talk interrupts whatever the device was saying.
  voice.cancel(deviceId);
  api.say(deviceId, clean, source).catch((error: unknown) => showToast(error instanceof Error ? error.message : String(error)));
}

let listening: Listening | undefined;

export function stopListening(deliver = true): void {
  if (deliver) listening?.stop();
  else listening?.abort();
}

/** Start listening on a device. `talk` takes one phrase; `wake` keeps listening for the wake word. */
export function startListening(deviceId: string, mode: 'talk' | 'wake'): void {
  if (state.listening) stopListening(false);
  const device = state.stage?.devices.find((candidate) => candidate.id === deviceId);
  if (!device) return;
  voice.cancel(deviceId);
  const wake = device.wakeWord.toLowerCase();
  const started = listen({
    lang: device.voice.lang ?? 'en-US',
    continuous: mode === 'wake',
    onInterim: (text) => {
      if (mode === 'talk' || text.toLowerCase().includes(wake)) setCaption(deviceId, { user: { text, state: 'listening' }, assistant: undefined });
    },
    onFinal: (text) => {
      if (mode === 'talk') return say(deviceId, text, 'voice');
      // Wake mode: only phrases that contain the wake word count, and the word itself is dropped.
      const index = text.toLowerCase().indexOf(wake);
      if (index < 0) return;
      const request = text.slice(index + wake.length).replace(/^[\s,.!?]+/, '');
      if (request) say(deviceId, request, 'voice');
    },
    onEnd: (error) => {
      listening = undefined;
      const wasWake = state.listening?.mode === 'wake' && state.listening.deviceId === deviceId;
      set({ listening: null, micError: error ?? null });
      if (error) showToast(error);
      // Browsers end continuous recognition after a pause; wake mode starts it again.
      else if (wasWake && mode === 'wake') window.setTimeout(() => !state.listening && startListening(deviceId, 'wake'), 250);
    },
  });
  if (!started) return;
  listening = started;
  set({ listening: { deviceId, mode }, micError: null });
  if (mode === 'talk') setCaption(deviceId, { user: { text: '', state: 'listening' }, assistant: undefined });
}

export function stopWake(): void {
  set({ listening: null });
  stopListening(false);
}

export function runOf(stage: StageSnapshot | null): ScenarioRunState | null {
  return stage?.run ?? null;
}
