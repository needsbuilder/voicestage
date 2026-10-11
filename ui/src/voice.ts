/**
 * Speech in the browser: synthesis for what devices (and, in a played
 * scenario, people) say, and recognition for what you say into the microphone.
 *
 * Everything degrades to text, and says so. With synthesis switched off,
 * unavailable, or refused by the browser (Chrome refuses until the page has
 * been clicked once), lines are "spoken" silently for about as long as they
 * would take to say, so captions and pacing stay the same. When the microphone
 * cannot be used, the reason is reported in plain words.
 *
 * What is written here was checked against Google Chrome 154 on macOS with
 * scripts/voice-check.mjs; the comments say what was observed.
 */
import { splitSentences } from '../../src/shared/sentences';
import { afterWakeWord, chooseVoice, describeMicProblem, type MicProblem, type VoiceInfo } from '../../src/shared/voices';
import { recording } from './recording';

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
  /** Position of the device on the stage, and how many devices there are, so every voice on stage is different. */
  slot: number;
  slots: number;
  prefs?: VoicePrefs;
  /** Called with each sentence as it starts, and with `null` when the job is over. */
  onSentence(sentence: string | null): void;
  onDone(): void;
}

export { splitSentences };

/** About how long a sentence takes to say, in milliseconds. */
export function readingTime(text: string, rate = 1): number {
  return Math.max(900, (350 + text.length * 58) / rate);
}

const synth: SpeechSynthesis | undefined = typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : undefined;

/** Why sound is not coming out, when it is not. */
export type SoundState = 'ok' | 'off' | 'needs-click' | 'no-voices' | 'unsupported';

class VoiceEngine {
  enabled = true;
  private queue: SpeakJob[] = [];
  private active: SpeakJob | undefined;
  private voices: SpeechSynthesisVoice[] = [];
  private voicesLoaded = false;
  /** True when the browser refused to speak, which Chrome does until the page has been clicked or a key pressed. */
  private blocked = false;
  private timer: number | undefined;
  private generation = 0;
  /**
   * The utterance being spoken. Holding it here keeps it alive until its `end`
   * event: browsers have been known to collect an utterance that nothing else
   * refers to, and then never fire the event.
   */
  private current: SpeechSynthesisUtterance | undefined;
  private readonly listeners = new Set<() => void>();

  constructor() {
    if (!synth) return;
    const load = () => {
      const voices = synth.getVoices();
      if (voices.length === 0 && this.voicesLoaded) return;
      this.voices = voices;
      // Chrome returns an empty list at first and fills it in a moment later.
      if (voices.length > 0) this.voicesLoaded = true;
      this.notify();
    };
    load();
    synth.addEventListener?.('voiceschanged', load);
    // If no list has arrived after a while, there are no voices (a headless browser, a stripped-down system).
    window.setTimeout(() => {
      this.voicesLoaded = true;
      this.notify();
    }, 2500);
    const unblock = () => {
      if (!this.blocked) return;
      this.blocked = false;
      this.notify();
    };
    window.addEventListener('pointerdown', unblock, true);
    window.addEventListener('keydown', unblock, true);
  }

  /** Called whenever the voice list or the sound state changes. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  get soundState(): SoundState {
    // A recording renders the voices outside the browser; nothing is missing here.
    if (recording) return 'ok';
    if (!synth) return 'unsupported';
    if (!this.enabled) return 'off';
    if (this.voicesLoaded && this.voices.length === 0) return 'no-voices';
    if (this.blocked) return 'needs-click';
    return 'ok';
  }

  /** Every voice the browser offers, in the plain shape the chooser works on. */
  voiceList(): VoiceInfo[] {
    return this.voices.map((voice) => ({ name: voice.name, lang: voice.lang, localService: voice.localService, default: voice.default }));
  }

  /** The voice a job would be spoken with right now. */
  voiceFor(job: Pick<SpeakJob, 'role' | 'slot' | 'slots' | 'prefs'>): VoiceInfo | undefined {
    return chooseVoice(this.voiceList(), { role: job.role, slot: job.slot, slots: job.slots, lang: job.prefs?.lang, name: job.prefs?.name });
  }

  private pick(job: SpeakJob): SpeechSynthesisVoice | undefined {
    const chosen = this.voiceFor(job);
    return chosen ? this.voices.find((voice) => voice.name === chosen.name && voice.lang === chosen.lang) : undefined;
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
      this.current = undefined;
      synth?.cancel();
      this.active = undefined;
      active.onSentence(null);
      active.onDone();
      // Observed in Chrome: an utterance spoken straight after cancel() starts normally.
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
      this.current = undefined;
      job.onSentence(null);
      job.onDone();
      this.pump();
    };
    const silent = (sentence: string, after: () => void) => {
      this.timer = window.setTimeout(() => {
        if (generation === this.generation) after();
      }, readingTime(sentence, job.prefs?.rate ?? 1));
    };
    /**
     * While a scenario is recorded: the sentence is a rendered audio clip whose
     * exact length is known. Wait for the beat, put the caption up, report the
     * moment it was on screen, and hold it for as long as the clip lasts.
     */
    const recorded = async (sentence: string, position: number) => {
      const session = recording!;
      const request = { deviceId: job.deviceId, role: job.role, slot: job.slot, slots: job.slots, voice: job.prefs?.name, lang: job.prefs?.lang, rate: job.prefs?.rate, text: sentence };
      try {
        const clip = await session.prepare(request);
        if (generation !== this.generation) return;
        await session.turn(job.deviceId, job.role, position === 0);
        if (generation !== this.generation) return;
        job.onSentence(sentence);
        const at = await session.painted();
        if (generation !== this.generation) return;
        session.sentence({ at, clip: clip.id, ms: clip.ms, deviceId: job.deviceId, role: job.role, text: sentence, line: job.text, lineId: generation, index: position, of: sentences.length });
        this.timer = window.setTimeout(() => {
          if (generation === this.generation) next();
        }, Math.max(0, at + clip.ms - Date.now()));
      } catch (error) {
        console.error('Recording: could not render a line', error);
        silent(sentence, next);
      }
    };
    const next = () => {
      if (generation !== this.generation) return;
      const sentence = sentences[index];
      index += 1;
      if (sentence === undefined) return finish();
      if (recording) return void recorded(sentence, index - 1);
      job.onSentence(sentence);
      if (!synth || !this.enabled || this.blocked || (this.voicesLoaded && this.voices.length === 0)) return silent(sentence, next);

      // One utterance per sentence: each caption is on screen exactly while its sentence is heard.
      const utterance = new SpeechSynthesisUtterance(sentence);
      const voice = this.pick(job);
      if (voice) {
        utterance.voice = voice;
        utterance.lang = voice.lang;
      } else {
        // Without this the system default voice is used, which follows the system language, not the text.
        utterance.lang = job.prefs?.lang ?? 'en-US';
      }
      utterance.rate = job.prefs?.rate ?? (job.role === 'assistant' ? 1 : 1.04);
      utterance.pitch = job.prefs?.pitch ?? 1;
      this.current = utterance;
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
        // A safety net in case "end" never comes; a sentence normally ends well inside this.
        window.clearTimeout(this.timer);
        this.timer = window.setTimeout(() => settle(false), readingTime(sentence, utterance.rate) * 2.5 + 4000);
      };
      utterance.onend = () => settle(false);
      utterance.onerror = (event) => {
        // Chrome answers speak() with "not-allowed" at once when the page has had no click or key press.
        if (event.error === 'not-allowed' && !this.blocked) {
          this.blocked = true;
          this.notify();
        }
        settle(!started);
      };
      // No "start" and no error within a moment: treat it the same way, and show the line silently.
      this.timer = window.setTimeout(() => {
        if (started || settled) return;
        this.blocked = true;
        this.notify();
        synth.cancel();
        settle(true);
      }, 1800);
      synth.speak(utterance);
    };
    if (recording) {
      // Have every sentence of the line rendered while the first one waits its turn.
      for (const sentence of sentences) void recording.prepare({ deviceId: job.deviceId, role: job.role, slot: job.slot, slots: job.slots, voice: job.prefs?.name, lang: job.prefs?.lang, rate: job.prefs?.rate, text: sentence }).catch(() => undefined);
      return next();
    }
    // Chrome fills its voice list just after the page loads. A line that arrives before that waits briefly,
    // so that it is not read by the system default voice.
    if (synth && this.enabled && !this.voicesLoaded) {
      const started = Date.now();
      const wait = () => {
        if (generation !== this.generation) return;
        if (this.voicesLoaded || Date.now() - started > 1500) next();
        else this.timer = window.setTimeout(wait, 60);
      };
      wait();
    } else next();
  }
}

export const voice = new VoiceEngine();

// --- recognition --------------------------------------------------------------

interface RecognitionResultLike {
  isFinal: boolean;
  [index: number]: { transcript: string } | undefined;
}

interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: { resultIndex: number; results: ArrayLike<RecognitionResultLike> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  onaudiostart: (() => void) | null;
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
  /**
   * `talk`: one request. It ends when the person stops for a moment, or when
   * `stop()` is called, and everything said is delivered together.
   * `wake`: keeps listening; each phrase that contains the wake word is delivered.
   */
  mode: 'talk' | 'wake';
  wakeWord?: string;
  /** How long a pause ends a request in `talk` mode, in milliseconds. */
  endSilenceMs?: number;
  /** The microphone was opened: the person can start talking. */
  onListening?(): void;
  onInterim(text: string): void;
  onRequest(text: string): void;
  /** Recognition is over. `heard` says whether a request was delivered; `problem` says why not, when something is wrong. */
  onEnd(result: { heard: boolean; nothingHeard: boolean; problem?: MicProblem }): void;
}

export interface Listening {
  /** Stop and deliver what was heard so far. */
  stop(): void;
  /** Stop and throw away what was heard. */
  abort(): void;
}

/**
 * Listen through the browser's speech recognition.
 *
 * Recognition always runs in continuous mode. In Chrome's single-phrase mode a
 * request with a pause in it ("My bill came in the mail. It's $182.40. Please
 * pay it.") comes back as its last phrase only; in continuous mode every
 * phrase arrives as its own final result, and deciding when the person has
 * finished is done here.
 */
export function listen(options: ListenOptions): Listening | undefined {
  const Recognition = recognitionConstructor();
  if (!Recognition) {
    options.onEnd({ heard: false, nothingHeard: false, problem: describeMicProblem('unsupported') });
    return undefined;
  }
  const lang = options.lang ?? 'en-US';
  const recognition = new Recognition();
  recognition.lang = lang;
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;
  const finals: string[] = [];
  let interim = '';
  let problem: MicProblem | undefined;
  let noSpeech = false;
  let discarded = false;
  let delivered = false;
  let endTimer: number | undefined;
  let limit: number | undefined;
  const heard = () => [...finals, interim].join(' ').replace(/\s+/g, ' ').trim();

  recognition.onaudiostart = () => options.onListening?.();
  recognition.onresult = (event) => {
    interim = '';
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index]!;
      const transcript = (result[0]?.transcript ?? '').trim();
      if (!transcript) continue;
      if (!result.isFinal) interim = `${interim} ${transcript}`.trim();
      else if (options.mode === 'wake') {
        const request = afterWakeWord(transcript, options.wakeWord ?? '');
        if (request) options.onRequest(request);
      } else finals.push(transcript);
    }
    window.clearTimeout(endTimer);
    if (options.mode === 'wake') {
      // Only show what follows the wake word; the rest is not for the device.
      const request = afterWakeWord(interim, options.wakeWord ?? '');
      if (request !== undefined) options.onInterim(request);
      return;
    }
    options.onInterim(heard());
    // A final result with nothing new after it for a moment: the person has finished.
    if (finals.length > 0 && !interim) endTimer = window.setTimeout(() => recognition.stop(), options.endSilenceMs ?? 1300);
  };
  recognition.onerror = (event) => {
    if (event.error === 'aborted') return;
    // Chrome gives up with "no-speech" after about eight seconds of silence. That is not a fault.
    if (event.error === 'no-speech') noSpeech = true;
    else problem = describeMicProblem(event.error, lang);
  };
  recognition.onend = () => {
    window.clearTimeout(endTimer);
    window.clearTimeout(limit);
    const text = discarded || options.mode === 'wake' ? '' : heard();
    if (text && !delivered) {
      delivered = true;
      options.onRequest(text);
    }
    options.onEnd({ heard: delivered, nothingHeard: !delivered && !problem && !discarded && (noSpeech || options.mode === 'talk'), problem });
  };
  try {
    recognition.start();
  } catch (error) {
    options.onEnd({ heard: false, nothingHeard: false, problem: describeMicProblem(error instanceof Error ? error.name : 'failed', lang) });
    return undefined;
  }
  // Nobody talks to a voice assistant for a minute without a pause.
  if (options.mode === 'talk') limit = window.setTimeout(() => recognition.stop(), 60_000);
  return {
    stop: () => recognition.stop(),
    abort: () => {
      discarded = true;
      recognition.abort();
    },
  };
}

/**
 * Watches the microphone's level while the device listens. Speech recognition
 * gives a page no audio, so this opens the microphone a second time (only when
 * the page already has permission, so that it never causes a second prompt) to
 * answer two questions: is any sound arriving at all, and how loud is it.
 *
 * A microphone that is muted, or switched off for the browser by the operating
 * system, still "works" as far as the browser can tell: it delivers samples
 * that are all exactly zero. That case is reported through `onSilent`.
 */
export function watchMicrophone(handlers: { onLevel(level: number): void; onSilent(): void }): () => void {
  let stopped = false;
  let stream: MediaStream | undefined;
  let context: AudioContext | undefined;
  let timer: number | undefined;
  const stop = () => {
    stopped = true;
    window.clearInterval(timer);
    stream?.getTracks().forEach((track) => track.stop());
    void context?.close().catch(() => undefined);
    handlers.onLevel(0);
  };
  void (async () => {
    try {
      if (!navigator.mediaDevices?.getUserMedia || !navigator.permissions?.query) return;
      const permission = await navigator.permissions.query({ name: 'microphone' as PermissionName });
      if (permission.state !== 'granted' || stopped) return;
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      if (stopped) return stop();
      context = new AudioContext();
      await context.resume();
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      context.createMediaStreamSource(stream).connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      const began = Date.now();
      let anySignal = false;
      let warned = false;
      timer = window.setInterval(() => {
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) {
          sum += sample * sample;
          if (sample !== 0) anySignal = true;
        }
        handlers.onLevel(Math.min(1, Math.sqrt(sum / samples.length) * 6));
        // A real microphone is never perfectly silent: its noise floor alone gives non-zero samples.
        if (!anySignal && !warned && Date.now() - began > 2500) {
          warned = true;
          handlers.onSilent();
        }
      }, 100);
    } catch {
      // The meter is a nicety. Recognition reports its own errors.
    }
  })();
  return stop;
}

/** Whether the browser currently blocks the microphone for this page, and a way to hear about changes. */
export async function microphonePermission(onChange: (state: PermissionState) => void): Promise<PermissionState | undefined> {
  try {
    const status = await navigator.permissions.query({ name: 'microphone' as PermissionName });
    status.onchange = () => onChange(status.state);
    return status.state;
  } catch {
    return undefined;
  }
}
