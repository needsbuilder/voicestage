/**
 * Speech in the browser: synthesis for what devices (and, in a played
 * scenario, people) say, and recognition for what you say into the microphone.
 *
 * Everything degrades to text. With synthesis switched off, unavailable, or
 * blocked until the first click, lines are "spoken" silently for about as long
 * as they would take to say, so captions and pacing stay the same.
 */

export interface VoicePrefs {
  name?: string;
  lang?: string;
  rate?: number;
  pitch?: number;
}

export interface SpeakJob {
  /** Which queue slot this belongs to; only used for cancelling. */
  deviceId: string;
  text: string;
  /** `assistant` and `person` get different voices. */
  role: 'assistant' | 'person';
  /** Position of the device on the stage, so devices sound different from each other. */
  deviceIndex: number;
  prefs?: VoicePrefs;
  /** Called with each sentence as it starts, and with `null` when the job is over. */
  onSentence(sentence: string | null): void;
  onDone(): void;
}

export function splitSentences(text: string): string[] {
  const parts = text
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'“(])/);
  const sentences: string[] = [];
  for (const part of parts) {
    const previous = sentences.at(-1);
    // Keep very short fragments ("Done.") with their neighbour so captions do not flicker.
    if (previous !== undefined && (previous.length < 26 || part.length < 14) && previous.length + part.length < 84) sentences[sentences.length - 1] = `${previous} ${part}`;
    else sentences.push(part);
  }
  return sentences.filter(Boolean);
}

/** About how long a sentence takes to say, in milliseconds. */
export function readingTime(text: string, rate = 1): number {
  return Math.max(900, (350 + text.length * 58) / rate);
}

const synth: SpeechSynthesis | undefined = typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : undefined;

const PREFERRED_ASSISTANT = ['Samantha', 'Google US English', 'Microsoft Aria', 'Microsoft Jenny', 'Daniel', 'Google UK English Male', 'Alex', 'Karen'];
const PREFERRED_PERSON = ['Moira', 'Google UK English Female', 'Tessa', 'Microsoft Guy', 'Fiona', 'Victoria', 'Rishi'];

class VoiceEngine {
  enabled = true;
  private queue: SpeakJob[] = [];
  private active: SpeakJob | undefined;
  private voices: SpeechSynthesisVoice[] = [];
  /** True when the browser refused to speak, which it does until the page has been clicked. */
  private blocked = false;
  private timer: number | undefined;
  private generation = 0;

  constructor() {
    if (!synth) return;
    const load = () => {
      this.voices = synth.getVoices();
    };
    load();
    synth.addEventListener?.('voiceschanged', load);
    const unblock = () => {
      this.blocked = false;
    };
    window.addEventListener('pointerdown', unblock);
    window.addEventListener('keydown', unblock);
  }

  get available(): boolean {
    return Boolean(synth);
  }

  voiceNames(): string[] {
    return this.voices.filter((voice) => voice.lang.toLowerCase().startsWith('en')).map((voice) => voice.name);
  }

  private pick(job: SpeakJob): SpeechSynthesisVoice | undefined {
    const lang = (job.prefs?.lang ?? 'en').toLowerCase();
    const pool = this.voices.filter((voice) => voice.lang.toLowerCase().startsWith(lang.slice(0, 2)));
    if (pool.length === 0) return undefined;
    if (job.prefs?.name) {
      const wanted = job.prefs.name.toLowerCase();
      const named = pool.find((voice) => voice.name.toLowerCase() === wanted) ?? pool.find((voice) => voice.name.toLowerCase().includes(wanted));
      if (named) return named;
    }
    const preferred = job.role === 'assistant' ? PREFERRED_ASSISTANT : PREFERRED_PERSON;
    const ranked = preferred.map((name) => pool.find((voice) => voice.name === name || voice.name.startsWith(`${name} `))).filter((voice): voice is SpeechSynthesisVoice => Boolean(voice));
    const choices = ranked.length > 0 ? ranked : pool;
    return choices[job.deviceIndex % choices.length];
  }

  speak(job: SpeakJob): void {
    this.queue.push(job);
    this.pump();
  }

  /** Drop everything queued or being said for a device (or for all devices). */
  cancel(deviceId?: string): void {
    const dropped = this.queue.filter((job) => deviceId === undefined || job.deviceId === deviceId);
    this.queue = this.queue.filter((job) => !dropped.includes(job));
    for (const job of dropped) {
      job.onSentence(null);
      job.onDone();
    }
    const active = this.active;
    if (active && (deviceId === undefined || active.deviceId === deviceId)) {
      this.generation += 1;
      window.clearTimeout(this.timer);
      synth?.cancel();
      this.active = undefined;
      active.onSentence(null);
      active.onDone();
      this.pump();
    }
  }

  private pump(): void {
    if (this.active) return;
    const job = this.queue.shift();
    if (!job) return;
    this.active = job;
    const generation = (this.generation += 1);
    const sentences = splitSentences(job.text);
    let index = 0;

    const finish = () => {
      if (generation !== this.generation) return;
      this.active = undefined;
      job.onSentence(null);
      job.onDone();
      this.pump();
    };
    const silent = (sentence: string, after: () => void) => {
      this.timer = window.setTimeout(() => {
        if (generation === this.generation) after();
      }, readingTime(sentence, job.prefs?.rate ?? 1));
    };
    const next = () => {
      if (generation !== this.generation) return;
      const sentence = sentences[index];
      index += 1;
      if (sentence === undefined) return finish();
      job.onSentence(sentence);
      if (!synth || !this.enabled || this.blocked) return silent(sentence, next);

      const utterance = new SpeechSynthesisUtterance(sentence);
      const voice = this.pick(job);
      if (voice) {
        utterance.voice = voice;
        utterance.lang = voice.lang;
      } else utterance.lang = job.prefs?.lang ?? 'en-US';
      utterance.rate = job.prefs?.rate ?? (job.role === 'assistant' ? 1 : 1.04);
      utterance.pitch = job.prefs?.pitch ?? 1;
      let started = false;
      let settled = false;
      const settle = (fallback: boolean) => {
        if (settled || generation !== this.generation) return;
        settled = true;
        window.clearTimeout(this.timer);
        if (fallback) silent(sentence, next);
        else next();
      };
      utterance.onstart = () => {
        started = true;
        // Some engines never fire "end"; give the sentence a generous limit.
        window.clearTimeout(this.timer);
        this.timer = window.setTimeout(() => settle(false), readingTime(sentence, utterance.rate) * 2.5 + 4000);
      };
      utterance.onend = () => settle(false);
      utterance.onerror = (event) => {
        if (event.error === 'not-allowed') this.blocked = true;
        settle(!started);
      };
      // No "start" within a moment means the browser is not going to speak (no click on the page yet).
      this.timer = window.setTimeout(() => {
        if (started || settled) return;
        this.blocked = true;
        synth.cancel();
        settle(true);
      }, 1800);
      synth.speak(utterance);
    };
    next();
  }
}

export const voice = new VoiceEngine();

// --- recognition --------------------------------------------------------------

interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

function recognitionConstructor(): (new () => RecognitionLike) | undefined {
  if (typeof window === 'undefined') return undefined;
  const scope = window as unknown as { SpeechRecognition?: new () => RecognitionLike; webkitSpeechRecognition?: new () => RecognitionLike };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
}

export const recognitionAvailable = Boolean(recognitionConstructor());

export interface ListenOptions {
  lang?: string;
  /** Keep listening after each phrase (wake word mode). */
  continuous?: boolean;
  onInterim(text: string): void;
  /** A finished phrase. */
  onFinal(text: string): void;
  onEnd(error?: string): void;
}

export interface Listening {
  /** Stop and deliver what was heard so far. */
  stop(): void;
  /** Stop and throw away what was heard. */
  abort(): void;
}

const RECOGNITION_ERRORS: Record<string, string> = {
  'not-allowed': 'The browser is not allowed to use the microphone. Allow it for this page, or type instead.',
  'service-not-allowed': 'Speech recognition is switched off in this browser. Type instead.',
  'audio-capture': 'No microphone was found. Type instead.',
  network: 'Speech recognition could not reach its service. Type instead.',
};

export function listen(options: ListenOptions): Listening | undefined {
  const Recognition = recognitionConstructor();
  if (!Recognition) return undefined;
  const recognition = new Recognition();
  recognition.lang = options.lang ?? 'en-US';
  recognition.continuous = options.continuous ?? false;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;
  let finalText = '';
  let interim = '';
  let failure: string | undefined;
  let delivered = false;

  recognition.onresult = (event) => {
    interim = '';
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index]!;
      const transcript = result[0]?.transcript ?? '';
      if (result.isFinal) {
        if (options.continuous) options.onFinal(transcript.trim());
        else finalText += transcript;
      } else interim += transcript;
    }
    options.onInterim(`${finalText}${interim}`.trim());
  };
  recognition.onerror = (event) => {
    if (event.error === 'no-speech' || event.error === 'aborted') return;
    failure = RECOGNITION_ERRORS[event.error] ?? `Speech recognition failed (${event.error}). Type instead.`;
  };
  recognition.onend = () => {
    const heard = `${finalText}${interim}`.trim();
    if (!options.continuous && !delivered && heard) {
      delivered = true;
      options.onFinal(heard);
    }
    options.onEnd(failure);
  };
  try {
    recognition.start();
  } catch (error) {
    options.onEnd(error instanceof Error ? error.message : String(error));
    return undefined;
  }
  return {
    stop: () => recognition.stop(),
    abort: () => {
      delivered = true;
      recognition.abort();
    },
  };
}
