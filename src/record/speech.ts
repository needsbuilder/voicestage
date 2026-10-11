/**
 * Voices for a recording: each sentence is rendered to an audio clip with the
 * macOS `say` command, with the same choice of voice the browser would make
 * (`src/shared/voices.ts`), and its real length is measured from the samples.
 *
 * Clips are 48 kHz, 16-bit, mono. Silence at both ends is cut, so that a clip
 * starts when the voice does and lasts exactly as long as it is heard. All
 * clips of one voice get the same gain, so sentences of a line match and no
 * voice is much louder than another.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Clip, ClipRequest } from '../shared/recording.js';
import { chooseVoice, voiceBaseName, type VoiceInfo } from '../shared/voices.js';

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
  text: string;
}

const CALIBRATION = 'The quick brown fox jumps over the lazy dog, and then sits down for tea.';
/** Every voice is brought to about this loudness (of 32767). */
const TARGET_LOUDNESS = 5200;
/** `say` speaks at about this many words a minute when not told otherwise. */
const WORDS_PER_MINUTE = 175;

/**
 * Renders sentences with `say`, once each. Rendered clips are also kept on disk
 * between runs, so a second take of the same scenario starts with every line ready.
 */
export class Speech {
  private voices: VoiceInfo[] | undefined;
  private readonly clips = new Map<string, Promise<RenderedClip>>();
  private readonly gains = new Map<string, Promise<number>>();
  private readonly cacheDir: string;

  constructor(options: { cacheDir?: string } = {}) {
    this.cacheDir = options.cacheDir ?? join(tmpdir(), 'voicestage-speech');
    mkdirSync(this.cacheDir, { recursive: true });
  }

  /** The voices `say` has, in the shape the voice chooser works on. */
  async voiceList(): Promise<VoiceInfo[]> {
    if (!this.voices) {
      const { stdout } = await run('say', ['-v', '?'], { maxBuffer: 4 * 1024 * 1024 }).catch((error: unknown) => {
        throw new SpeechError(`Could not list the system voices with "say": ${error instanceof Error ? error.message : String(error)}`);
      });
      this.voices = parseSayVoices(stdout);
      if (this.voices.length === 0) throw new SpeechError('The "say" command lists no voices.');
    }
    return this.voices;
  }

  /** The voice a sentence would be spoken with: the same rules as in the browser, applied to the system's voices. */
  async voiceFor(request: Pick<ClipRequest, 'role' | 'slot' | 'slots' | 'voice' | 'lang'>): Promise<VoiceInfo> {
    const voices = await this.voiceList();
    const voice = chooseVoice(voices, { role: request.role, slot: request.slot, slots: request.slots, lang: request.lang, name: request.voice });
    if (!voice) throw new SpeechError(`The system has no voice for ${request.lang ?? 'en-US'}. Add one in System Settings > Accessibility > Spoken Content.`);
    return voice;
  }

  private async say(voice: VoiceInfo, text: string, rate: number | undefined): Promise<Int16Array> {
    const key = createHash('sha1').update(JSON.stringify([voice.name, voice.lang, rate ?? 1, text])).digest('hex');
    const file = join(this.cacheDir, `${key}.wav`);
    if (!existsSync(file)) {
      const source = join(this.cacheDir, `${key}.txt`);
      writeFileSync(source, text);
      const args = ['-v', voice.name, '-f', source, '-o', file, '--file-format=WAVE', `--data-format=LEI16@${SAMPLE_RATE}`];
      if (rate !== undefined && rate !== 1) args.push('-r', String(Math.round(WORDS_PER_MINUTE * rate)));
      await run('say', args).catch((error: unknown) => {
        throw new SpeechError(`"say" could not render a line with the voice ${voice.name}: ${error instanceof Error ? error.message : String(error)}`);
      });
      if (!existsSync(file)) throw new SpeechError(`"say" produced no audio for the voice ${voice.name}.`);
    }
    const wav = readWav(readFileSync(file));
    if (wav.sampleRate !== SAMPLE_RATE || wav.channels !== 1) throw new SpeechError(`Expected ${SAMPLE_RATE} Hz mono from "say", got ${wav.sampleRate} Hz with ${wav.channels} channel(s).`);
    return wav.data;
  }

  /** One gain per voice, measured on a fixed sentence, so every clip of a voice is treated alike. */
  private gainFor(voice: VoiceInfo, rate: number | undefined): Promise<number> {
    const key = `${voice.name}|${voice.lang}`;
    let gain = this.gains.get(key);
    if (!gain) {
      gain = this.say(voice, CALIBRATION, rate).then((data) => {
        const level = loudness(data);
        return level === 0 ? 1 : Math.max(0.4, Math.min(3, TARGET_LOUDNESS / level));
      });
      this.gains.set(key, gain);
    }
    return gain;
  }

  /** Render one sentence. Asking again for the same sentence in the same voice returns the same clip. */
  render(request: ClipRequest): Promise<RenderedClip> {
    const key = JSON.stringify([request.role, request.slot, request.slots, request.voice ?? '', request.lang ?? '', request.rate ?? 1, request.text]);
    let clip = this.clips.get(key);
    if (!clip) {
      clip = (async () => {
        const voice = await this.voiceFor(request);
        const [raw, gain] = await Promise.all([this.say(voice, request.text, request.rate), this.gainFor(voice, undefined)]);
        const trimmed = trimSilence(raw);
        if (trimmed.length === 0) throw new SpeechError(`The voice ${voice.name} rendered "${request.text}" as silence.`);
        const peak = trimmed.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0);
        const data = applyGain(trimmed, Math.min(gain, 31_000 / Math.max(1, peak)));
        const id = createHash('sha1').update(key).digest('hex').slice(0, 12);
        return { id, ms: Math.round((data.length / SAMPLE_RATE) * 1000), voice: voiceBaseName(voice.name), data, text: request.text };
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
