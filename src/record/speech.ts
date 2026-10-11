/**
 * Voices for a recording: each sentence is rendered to an audio clip outside
 * the browser, and its real length is measured from the samples.
 *
 * Who renders is a `VoiceRenderer` (`renderers.ts`): the macOS `say` command,
 * with the same choice of voice the browser would make (`src/shared/voices.ts`),
 * or a program named in the configuration. Whatever it writes is treated the
 * same way from there on.
 *
 * Clips are 48 kHz, 16-bit, mono. Silence at both ends is cut, so that a clip
 * starts when the voice does and lasts exactly as long as it is heard. All
 * clips of one voice get the same gain, so sentences of a line match and no
 * voice is much louder than another.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { respell, type PronounceRules } from '../shared/pronounce.js';
import type { Clip, ClipRequest } from '../shared/recording.js';
import type { VoiceInfo } from '../shared/voices.js';

const run = promisify(execFile);

export const SAMPLE_RATE = 48_000;

export class SpeechError extends Error {}

/** Parse the output of `say -v '?'`: one voice per line, `Name   lang_REGION    # sample sentence`. */
export function parseSayVoices(listing: string): VoiceInfo[] {
  const voices: VoiceInfo[] = [];
  const seen = new Set<string>();
  for (const line of listing.split('\n')) {
    const match = /^(.+?)\s+([a-z]{2,3}_[A-Za-z0-9]+)\s+#/.exec(line);
    if (!match) continue;
    const name = match[1]!.trim();
    const lang = match[2]!.replace('_', '-');
    if (seen.has(`${name}|${lang}`)) continue;
    seen.add(`${name}|${lang}`);
    voices.push({ name, lang, localService: true });
  }
  return voices;
}

export interface Samples {
  /** Mono, 48 kHz. */
  data: Int16Array;
}

/** Read the samples of a 16-bit PCM WAV file, whatever other chunks it carries. */
export function readWav(buffer: Buffer): { sampleRate: number; channels: number; data: Int16Array } {
  if (buffer.toString('latin1', 0, 4) !== 'RIFF' || buffer.toString('latin1', 8, 12) !== 'WAVE') throw new SpeechError('Not a WAV file.');
  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  for (let offset = 12; offset + 8 <= buffer.length; ) {
    const id = buffer.toString('latin1', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      if (buffer.readUInt16LE(body) !== 1) throw new SpeechError('Only PCM WAV files are supported.');
      channels = buffer.readUInt16LE(body + 2);
      sampleRate = buffer.readUInt32LE(body + 4);
      bits = buffer.readUInt16LE(body + 14);
    } else if (id === 'data') {
      if (bits !== 16) throw new SpeechError(`Expected 16-bit samples, found ${bits}-bit.`);
      const length = Math.min(size, buffer.length - body) & ~1;
      const data = new Int16Array(length / 2);
      for (let index = 0; index < data.length; index += 1) data[index] = buffer.readInt16LE(body + index * 2);
      return { sampleRate, channels, data };
    }
    offset = body + size + (size % 2);
  }
  throw new SpeechError('The WAV file has no audio data.');
}

/** A 16-bit PCM WAV file with these samples. */
export function writeWav(data: Int16Array, sampleRate = SAMPLE_RATE, channels = 1): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + data.length * 2, 4);
  header.write('WAVEfmt ', 8, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(data.length * 2, 40);
  return Buffer.concat([header, Buffer.from(data.buffer, data.byteOffset, data.byteLength)]);
}

/** Cut the silence before the first and after the last audible sample, keeping a few milliseconds around them. */
export function trimSilence(data: Int16Array, sampleRate = SAMPLE_RATE, threshold = 260): Int16Array {
  let first = 0;
  while (first < data.length && Math.abs(data[first]!) <= threshold) first += 1;
  if (first === data.length) return new Int16Array(0);
  let last = data.length - 1;
  while (last > first && Math.abs(data[last]!) <= threshold) last -= 1;
  const start = Math.max(0, first - Math.round(sampleRate * 0.008));
  const end = Math.min(data.length, last + 1 + Math.round(sampleRate * 0.04));
  return data.slice(start, end);
}

/** Loudness of the audible part: the root mean square of the samples above a low floor. */
export function loudness(data: Int16Array): number {
  let sum = 0;
  let count = 0;
  for (const sample of data) {
    if (Math.abs(sample) < 200) continue;
    sum += sample * sample;
    count += 1;
  }
  return count === 0 ? 0 : Math.sqrt(sum / count);
}

export function applyGain(data: Int16Array, gain: number): Int16Array {
  const out = new Int16Array(data.length);
  for (let index = 0; index < data.length; index += 1) out[index] = Math.max(-32767, Math.min(32767, Math.round(data[index]! * gain)));
  return out;
}

/** Lay clips into one track. `at` is in seconds from the start of the track. Samples that meet are added. */
export function mixTrack(clips: Array<{ at: number; data: Int16Array }>, seconds: number, sampleRate = SAMPLE_RATE): Int16Array {
  const track = new Int16Array(Math.max(0, Math.round(seconds * sampleRate)));
  for (const clip of clips) {
    const offset = Math.round(clip.at * sampleRate);
    for (let index = 0; index < clip.data.length; index += 1) {
      const position = offset + index;
      if (position < 0 || position >= track.length) continue;
      track[position] = Math.max(-32767, Math.min(32767, track[position]! + clip.data[index]!));
    }
  }
  return track;
}

export interface RenderedClip extends Clip {
  data: Int16Array;
  /** The sentence as written, which is what the caption shows. */
  text: string;
  /** What the voice was given instead, when `recording.pronounce` changed it. */
  spoken?: string;
}

/** A voice as a renderer knows it. */
export interface RendererVoice {
  /** The name the renderer is asked for. */
  id: string;
  lang?: string;
  /** The name written into the timeline. */
  label: string;
}

export interface RenderJob {
  text: string;
  voice: RendererVoice;
  /** 1 is the voice's normal pace. */
  rate: number;
  /** Where the audio must be left: a WAV file. */
  out: string;
}

/** Something that turns a sentence into a WAV file. */
export interface VoiceRenderer {
  /** "say", or the name the configuration gives its program. Written into the timeline. */
  readonly name: string;
  /** Tells this renderer's clips from every other renderer's in the cache on disk. */
  readonly cacheKey: readonly string[];
  /** How many sentences may be rendered at once. */
  readonly parallel: number;
  /** Fails with a plain reason when the renderer cannot work on this machine. */
  check(): Promise<void>;
  /** The voice a sentence is spoken with. */
  voiceFor(request: Pick<ClipRequest, 'deviceId' | 'role' | 'slot' | 'slots' | 'voice' | 'lang'>): Promise<RendererVoice>;
  /** Render one sentence to `job.out`. Any sample rate and channel count will do. */
  render(job: RenderJob): Promise<void>;
}

const CALIBRATION = 'The quick brown fox jumps over the lazy dog, and then sits down for tea.';
/** Every voice is brought to about this loudness (of 32767). */
const TARGET_LOUDNESS = 5200;
/** Part of every cache key. Raise it when clips rendered by an older version must not be used again. */
const CACHE_FORMAT = 'clips-2';

export interface SpeechOptions {
  renderer: VoiceRenderer;
  /** Where rendered clips are kept between runs. */
  cacheDir?: string;
  /** Other spellings for the voice (`recording.pronounce`). */
  pronounce?: PronounceRules;
  ffmpeg?: string;
}

/**
 * Renders sentences, once each. Rendered clips are also kept on disk between
 * runs, so a second take of the same scenario starts with every line ready.
 */
export class Speech {
  readonly renderer: VoiceRenderer;
  private readonly clips = new Map<string, Promise<RenderedClip>>();
  private readonly gains = new Map<string, Promise<number>>();
  private readonly rendering = new Map<string, Promise<Int16Array>>();
  private readonly cacheDir: string;
  private readonly pronounce: PronounceRules | undefined;
  private readonly ffmpeg: string;
  private running = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(options: SpeechOptions) {
    this.renderer = options.renderer;
    this.pronounce = options.pronounce;
    this.ffmpeg = options.ffmpeg ?? 'ffmpeg';
    this.cacheDir = options.cacheDir ?? join(tmpdir(), 'voicestage-speech');
    mkdirSync(this.cacheDir, { recursive: true });
  }

  /** At most `renderer.parallel` renderings at a time; the rest wait their turn. */
  private async turn<T>(work: () => Promise<T>): Promise<T> {
    if (this.running >= this.renderer.parallel) await new Promise<void>((go) => this.waiting.push(go));
    else this.running += 1;
    try {
      return await work();
    } finally {
      // The place passes straight to whoever has waited longest, if anyone has.
      const next = this.waiting.shift();
      if (next) next();
      else this.running -= 1;
    }
  }

  /**
   * Bring what the renderer wrote to 48 kHz, mono, 16-bit, at `file`. A file
   * that is already that is taken as it is; anything else goes through ffmpeg.
   */
  private async normalise(written: string, file: string, describe: string): Promise<void> {
    let ready = false;
    try {
      const wav = readWav(readFileSync(written));
      ready = wav.sampleRate === SAMPLE_RATE && wav.channels === 1;
    } catch {
      // Not 16-bit PCM, or not a WAV file at all: ffmpeg decides which.
    }
    if (ready) {
      renameSync(written, file);
      return;
    }
    const converted = `${written}.48k.wav`;
    try {
      await run(this.ffmpeg, ['-v', 'error', '-y', '-i', written, '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-c:a', 'pcm_s16le', '-f', 'wav', converted]);
    } catch (error) {
      rmSync(converted, { force: true });
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new SpeechError(`${describe} is not 48 kHz mono 16-bit audio, and ffmpeg, which would convert it, was not found.`);
      const detail = String((error as { stderr?: string }).stderr ?? (error instanceof Error ? error.message : error)).trim();
      throw new SpeechError(`${describe} could not be read as audio: ${detail.split('\n').at(-1)}`);
    } finally {
      rmSync(written, { force: true });
    }
    renameSync(converted, file);
  }

  /** The samples of a sentence as the renderer made them, from the cache when it has been rendered before. */
  private raw(voice: RendererVoice, text: string, rate: number): Promise<Int16Array> {
    const key = createHash('sha1').update(JSON.stringify([CACHE_FORMAT, ...this.renderer.cacheKey, voice.id, voice.lang ?? '', rate, text])).digest('hex');
    let pending = this.rendering.get(key);
    if (!pending) {
      pending = (async () => {
        const file = join(this.cacheDir, `${key}.wav`);
        if (!existsSync(file)) {
          await this.turn(async () => {
            // Written under another name first: a rendering that is interrupted must not leave half a clip in the cache.
            const written = join(this.cacheDir, `${key}.${process.pid}.part.wav`);
            const describe = `What "${this.renderer.name}" wrote for "${text}" with the voice ${voice.label}`;
            rmSync(written, { force: true });
            await this.renderer.render({ text, voice, rate, out: written });
            if (!existsSync(written)) throw new SpeechError(`"${this.renderer.name}" finished without writing any audio for "${text}" with the voice ${voice.label}.`);
            await this.normalise(written, file, describe);
          });
        }
        const wav = readWav(readFileSync(file));
        if (wav.sampleRate !== SAMPLE_RATE || wav.channels !== 1) throw new SpeechError(`Expected ${SAMPLE_RATE} Hz mono in ${file}, found ${wav.sampleRate} Hz with ${wav.channels} channel(s).`);
        return wav.data;
      })();
      this.rendering.set(key, pending);
      pending.catch(() => this.rendering.delete(key));
    }
    return pending;
  }

  /** One gain per voice, measured on a fixed sentence, so every clip of a voice is treated alike. */
  private gainFor(voice: RendererVoice): Promise<number> {
    const key = `${voice.id}|${voice.lang ?? ''}`;
    let gain = this.gains.get(key);
    if (!gain) {
      gain = this.raw(voice, CALIBRATION, 1).then((data) => {
        const level = loudness(data);
        return level === 0 ? 1 : Math.max(0.4, Math.min(3, TARGET_LOUDNESS / level));
      });
      this.gains.set(key, gain);
      gain.catch(() => this.gains.delete(key));
    }
    return gain;
  }

  /** Render one sentence. Asking again for the same sentence in the same voice returns the same clip. */
  render(request: ClipRequest): Promise<RenderedClip> {
    const key = JSON.stringify([request.role, request.slot, request.slots, request.voice ?? '', request.lang ?? '', request.rate ?? 1, request.text]);
    let clip = this.clips.get(key);
    if (!clip) {
      clip = (async () => {
        const voice = await this.renderer.voiceFor(request);
        const spoken = respell(request.text, this.pronounce);
        const [raw, gain] = await Promise.all([this.raw(voice, spoken, request.rate ?? 1), this.gainFor(voice)]);
        const trimmed = trimSilence(raw);
        if (trimmed.length === 0) throw new SpeechError(`"${this.renderer.name}" rendered "${spoken}" with the voice ${voice.label} as silence.`);
        const peak = trimmed.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0);
        const data = applyGain(trimmed, Math.min(gain, 31_000 / Math.max(1, peak)));
        const id = createHash('sha1').update(key).digest('hex').slice(0, 12);
        return { id, ms: Math.round((data.length / SAMPLE_RATE) * 1000), voice: voice.label, renderer: this.renderer.name, data, text: request.text, spoken: spoken === request.text ? undefined : spoken };
      })();
      this.clips.set(key, clip);
      // A failure is reported to whoever asked; do not let it also surface as an unhandled rejection.
      clip.catch(() => undefined);
    }
    return clip;
  }

  /** A clip that has been rendered, by its id. */
  async clip(id: string): Promise<RenderedClip | undefined> {
    for (const pending of this.clips.values()) {
      const clip = await pending.catch(() => undefined);
      if (clip?.id === id) return clip;
    }
    return undefined;
  }
}
