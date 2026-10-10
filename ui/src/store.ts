/**
 * The UI's state: the stage as the server last described it, plus the things
 * that only exist in the browser (captions, which device is listening, what is
 * open in the inspector).
 *
 * One server-sent events connection feeds it. Components read it with `useStage`.
 */
import { useSyncExternalStore } from 'react';
import type { DeviceSnapshot, ScenarioRunState, StageEvent, StageSnapshot, TimelineEntry } from '../../src/shared/types';
import { describeMicProblem, type MicProblem, type VoiceInfo } from '../../src/shared/voices';
import { api } from './api';
import { listen, microphonePermission, splitSentences, voice, watchMicrophone, type Listening, type SoundState, type VoicePrefs } from './voice';

export interface Caption {
  /**
   * What the person last said, or is saying. `opening`: the microphone is being
   * opened. `missed`: the device listened and heard nothing.
   */
  user?: { text: string; state: 'opening' | 'listening' | 'typing' | 'said' | 'missed' };
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
  /** Voices picked in the voice menu, by device id. They win over the configuration file. */
  voiceChoice: Record<string, { assistant?: string; person?: string }>;
}

export interface UiState {
  connected: boolean;
  everConnected: boolean;
  stage: StageSnapshot | null;
  captions: Record<string, Caption>;
  settings: Settings;
  listening: { deviceId: string; mode: 'talk' | 'wake' } | null;
  /** Why the microphone cannot be used, when it cannot. Stays until it works again. */
  mic: MicProblem | null;
  /** Every voice the browser offers. Empty until the browser has loaded its list. */
  voices: VoiceInfo[];
  /** Whether sound is coming out, and if not, why. */
  sound: SoundState;
  toast: string | null;
}

const SETTINGS_KEY = 'voicestage.settings';

function loadSettings(): Settings {
  const defaults: Settings = { voice: true, voicePeople: true, inspector: true, inspectorDevice: undefined, inspectorTab: 'timeline', voiceChoice: {} };
  try {
    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Partial<Settings>;
    const params = new URLSearchParams(location.search);
    const merged = { ...defaults, ...stored, voiceChoice: { ...stored.voiceChoice } };
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
  mic: null,
  voices: [],
  sound: 'ok',
  toast: null,
};
voice.enabled = state.settings.voice;
state.sound = voice.soundState;
state.voices = voice.voiceList();

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

/** Voice settings for a device's assistant, or for the person at it: the voice menu first, then the configuration. */
export function voicePrefs(device: DeviceSnapshot, role: 'assistant' | 'person'): VoicePrefs {
  const configured = role === 'assistant' ? device.voice : { lang: device.voice.lang, ...device.person.voice };
  const chosen = state.settings.voiceChoice[device.id]?.[role];
  return chosen ? { ...configured, name: chosen } : configured;
}

function voiceSlot(deviceId: string): { slot: number; slots: number } {
  return { slot: deviceIndex(deviceId), slots: state.stage?.devices.length ?? 1 };
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
        ...voiceSlot(event.deviceId),
        prefs: device ? voicePrefs(device, 'assistant') : undefined,
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
        const device = state.stage?.devices.find((candidate) => candidate.id === event.deviceId);
        voice.speak({ deviceId: event.deviceId, text: event.text, role: 'person', ...voiceSlot(event.deviceId), prefs: device ? voicePrefs(device, 'person') : undefined, onSentence: () => undefined, onDone: finish });
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
  // The voice list arrives a moment after the page loads, and sound can be refused until the first click.
  voice.subscribe(() => set({ voices: voice.voiceList(), sound: voice.soundState }));
  // Say so up front when the browser already blocks the microphone for this page.
  const permission = (current: PermissionState | undefined) => {
    if (current === 'denied') set({ mic: describeMicProblem('not-allowed') });
    else if (state.mic?.kind === 'blocked') set({ mic: null });
  };
  void microphonePermission(permission).then(permission);
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
  set({ sound: voice.soundState });
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
let stopMeter: (() => void) | undefined;

export function stopListening(deliver = true): void {
  if (deliver) listening?.stop();
  else listening?.abort();
}

function setMicLevel(level: number): void {
  document.documentElement.style.setProperty('--mic-level', level.toFixed(2));
}

/**
 * Start listening on a device. `talk` takes one request, however many
 * sentences it has, and ends when the person pauses or `stopListening` is
 * called. `wake` keeps listening for requests that start with the wake word.
 */
export function startListening(deviceId: string, mode: 'talk' | 'wake'): void {
  if (state.listening) stopListening(false);
  const device = state.stage?.devices.find((candidate) => candidate.id === deviceId);
  if (!device) return;
  // Starting to talk interrupts whatever the device was saying.
  voice.cancel(deviceId);
  let silent = false;
  const started = listen({
    lang: device.voice.lang ?? 'en-US',
    mode,
    wakeWord: device.wakeWord,
    onListening: () => {
      if (mode === 'talk' && state.captions[deviceId]?.user?.state === 'opening') setCaption(deviceId, { user: { text: '', state: 'listening' } });
      stopMeter?.();
      stopMeter = watchMicrophone({
        onLevel: setMicLevel,
        onSilent: () => {
          silent = true;
          set({ mic: describeMicProblem('silent') });
        },
      });
    },
    onInterim: (text) => setCaption(deviceId, { user: { text, state: 'listening' }, assistant: undefined }),
    onRequest: (text) => {
      if (state.mic) set({ mic: null });
      say(deviceId, text, 'voice');
    },
    onEnd: ({ nothingHeard, problem }) => {
      listening = undefined;
      stopMeter?.();
      stopMeter = undefined;
      const wasWake = state.listening?.mode === 'wake' && state.listening.deviceId === deviceId;
      set({ listening: null, ...(problem ? { mic: problem } : {}) });
      const caption = state.captions[deviceId]?.user;
      if (problem || silent) {
        // The reason is shown under the device until the microphone works again.
        if (caption && caption.state !== 'said') setCaption(deviceId, { user: undefined });
        return;
      }
      if (mode === 'talk' && nothingHeard) {
        setCaption(deviceId, { user: { text: "I didn't hear anything.", state: 'missed' } });
        window.setTimeout(() => state.captions[deviceId]?.user?.state === 'missed' && setCaption(deviceId, { user: undefined }), 4000);
        return;
      }
      if (caption?.state === 'listening' || caption?.state === 'opening') setCaption(deviceId, { user: undefined });
      // Browsers end continuous recognition after a quiet spell; wake mode starts it again.
      if (wasWake) window.setTimeout(() => !state.listening && startListening(deviceId, 'wake'), 250);
    },
  });
  if (!started) return;
  listening = started;
  set({ listening: { deviceId, mode } });
  if (mode === 'talk') setCaption(deviceId, { user: { text: '', state: 'opening' }, assistant: undefined });
}

/** Hide the microphone notice. It comes back if the microphone fails again. */
export function dismissMicProblem(): void {
  set({ mic: null });
}

export function stopWake(): void {
  set({ listening: null });
  stopListening(false);
}

/** Choose a voice for a device in the voice menu. An empty name goes back to the configured or automatic voice. */
export function chooseDeviceVoice(deviceId: string, role: 'assistant' | 'person', name: string): void {
  const current = state.settings.voiceChoice[deviceId] ?? {};
  updateSettings({ voiceChoice: { ...state.settings.voiceChoice, [deviceId]: { ...current, [role]: name || undefined } } });
}

/** Say a short sample with the voice a device (or the person at it) currently has. */
export function previewVoice(deviceId: string, role: 'assistant' | 'person'): void {
  const device = state.stage?.devices.find((candidate) => candidate.id === deviceId);
  if (!device) return;
  voice.cancel(`preview:${deviceId}`);
  const text = role === 'assistant' ? `This is the voice of the ${device.name}.` : `And this is ${device.person.name}.`;
  voice.speak({ deviceId: `preview:${deviceId}`, text, role, ...voiceSlot(deviceId), prefs: voicePrefs(device, role), onSentence: () => undefined, onDone: () => undefined });
}

export function runOf(stage: StageSnapshot | null): ScenarioRunState | null {
  return stage?.run ?? null;
}
