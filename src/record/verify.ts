/**
 * Checks on a finished recording, made on the file itself, not on what the
 * recorder believes it wrote:
 *
 *   - both streams are there, with the size, frame rate and codecs asked for;
 *   - no two sentences are heard at once;
 *   - for every sentence whose caption changes on a device, the frame in which
 *     the caption changes and the sample at which the voice starts are found in
 *     the decoded video and audio, and compared.
 */
import { spawn } from 'node:child_process';
import { SAMPLE_RATE } from './speech.js';
import { overlappingSentences, type Rect, type TimelineItem } from './timeline.js';

function collect(command: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    const chunks: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    child.once('error', (error) => reject(new Error(`Could not run ${command}: ${error.message}`)));
    child.once('close', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`${command} stopped with code ${code}: ${stderr.trim()}`))));
  });
}

export interface StreamInfo {
  video?: { codec: string; width: number; height: number; fps: number; frames: number; duration: number; pixelFormat: string };
  audio?: { codec: string; sampleRate: number; channels: number; duration: number };
  duration: number;
}

export async function probe(file: string, ffprobe = 'ffprobe'): Promise<StreamInfo> {
  const out = await collect(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', '-count_packets', file]);
  const data = JSON.parse(out.toString()) as { streams: Array<Record<string, string | number>>; format: { duration?: string } };
  const info: StreamInfo = { duration: Number(data.format.duration ?? 0) };
  for (const stream of data.streams) {
    if (stream.codec_type === 'video') {
      const [numerator, denominator] = String(stream.avg_frame_rate ?? '0/1').split('/').map(Number);
      info.video = {
        codec: String(stream.codec_name),
        width: Number(stream.width),
        height: Number(stream.height),
        fps: denominator ? numerator! / denominator : 0,
        frames: Number(stream.nb_read_packets ?? stream.nb_frames ?? 0),
        duration: Number(stream.duration ?? 0),
        pixelFormat: String(stream.pix_fmt),
      };
    } else if (stream.codec_type === 'audio') {
      info.audio = { codec: String(stream.codec_name), sampleRate: Number(stream.sample_rate), channels: Number(stream.channels), duration: Number(stream.duration ?? 0) };
    }
  }
  return info;
}

/** The sound track of a file, decoded to mono 16-bit samples at 48 kHz. */
export async function decodeAudio(file: string, ffmpeg = 'ffmpeg'): Promise<Int16Array> {
  const raw = await collect(ffmpeg, ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', 'pipe:1']);
  return new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 2));
}

const ACTIVITY_WIDTH = 160;
const ACTIVITY_HEIGHT = 40;

/**
 * How much one region of the picture changes from each frame to the next:
 * the mean difference in brightness, per frame, of that region scaled down.
 * Entry `n` compares frame `n` with frame `n - 1`.
 */
export async function regionActivity(file: string, region: Rect, ffmpeg = 'ffmpeg'): Promise<Float32Array> {
  const crop = `crop=${Math.max(2, Math.round(region.width))}:${Math.max(2, Math.round(region.height))}:${Math.max(0, Math.round(region.x))}:${Math.max(0, Math.round(region.y))}`;
  const raw = await collect(ffmpeg, ['-v', 'error', '-i', file, '-an', '-vf', `${crop},scale=${ACTIVITY_WIDTH}:${ACTIVITY_HEIGHT}:flags=area,format=gray`, '-f', 'rawvideo', 'pipe:1']);
  const size = ACTIVITY_WIDTH * ACTIVITY_HEIGHT;
  const frames = Math.floor(raw.length / size);
  const activity = new Float32Array(frames);
  for (let frame = 1; frame < frames; frame += 1) {
    let sum = 0;
    const here = frame * size;
    const before = here - size;
    for (let pixel = 0; pixel < size; pixel += 1) sum += Math.abs(raw[here + pixel]! - raw[before + pixel]!);
    activity[frame] = sum / size;
  }
  return activity;
}

/** The first moment at or after `from` (seconds) where the track becomes audible, up to `until`. */
export function audioOnset(track: Int16Array, from: number, until: number, threshold = 500): number | undefined {
  const start = Math.max(0, Math.round(from * SAMPLE_RATE));
  const end = Math.min(track.length, Math.round(until * SAMPLE_RATE));
  for (let index = start; index < end; index += 1) {
    if (Math.abs(track[index]!) > threshold) return index / SAMPLE_RATE;
  }
  return undefined;
}

/** The first frame between `from` and `until` (seconds) in which the region changes noticeably, as a time in seconds. */
export function firstChange(activity: Float32Array, fps: number, from: number, until: number, threshold = 0.35): number | undefined {
  const start = Math.max(1, Math.ceil(from * fps));
  const end = Math.min(activity.length - 1, Math.floor(until * fps));
  for (let frame = start; frame <= end; frame += 1) {
    if (activity[frame]! > threshold) return frame / fps;
  }
  return undefined;
}

export interface SyncSample {
  text: string;
  device: string;
  /** Where the timeline says the sentence starts. */
  start: number;
  /** Where the voice is first heard in the file. */
  audio?: number;
  /** Where the caption is first seen to change in the file. */
  caption?: number;
  /** `audio - caption`, in milliseconds. Positive: the voice comes after the caption. */
  offsetMs?: number;
}

export interface VerifyReport {
  streams: StreamInfo;
  problems: string[];
  overlaps: Array<{ first: string; second: string; overlap: number }>;
  sync: { checked: number; maxOffsetMs: number; meanOffsetMs: number; toleranceMs: number; samples: SyncSample[] };
  ok: boolean;
}

export interface VerifyOptions {
  file: string;
  items: TimelineItem[];
  /** Where each device's captions are in the picture. */
  captions: Map<string, Rect>;
  expected: { width: number; height: number; fps: number; duration: number };
  toleranceMs?: number;
  /** Shortest silence between two sentences, in seconds: how far around a sentence's start to look. */
  window?: number;
  ffmpeg?: string;
  ffprobe?: string;
}

export async function verifyRecording(options: VerifyOptions): Promise<VerifyReport> {
  const toleranceMs = options.toleranceMs ?? 100;
  const problems: string[] = [];
  const streams = await probe(options.file, options.ffprobe);
  const { expected } = options;

  if (!streams.video) problems.push('The file has no video stream.');
  else {
    if (streams.video.codec !== 'h264') problems.push(`The video is ${streams.video.codec}, not H.264.`);
    if (streams.video.width !== expected.width || streams.video.height !== expected.height) problems.push(`The video is ${streams.video.width}x${streams.video.height}, not ${expected.width}x${expected.height}.`);
    if (Math.abs(streams.video.fps - expected.fps) > 0.01) problems.push(`The video has ${streams.video.fps} frames a second, not ${expected.fps}.`);
    if (Math.abs(streams.video.duration - expected.duration) > 0.05) problems.push(`The video lasts ${streams.video.duration} s, not ${expected.duration} s.`);
  }
  if (!streams.audio) problems.push('The file has no audio stream.');
  else {
    if (streams.audio.codec !== 'aac') problems.push(`The audio is ${streams.audio.codec}, not AAC.`);
    if (Math.abs(streams.audio.duration - expected.duration) > 0.12) problems.push(`The audio lasts ${streams.audio.duration} s and the video ${expected.duration} s.`);
  }

  const overlaps = overlappingSentences(options.items);
  for (const clash of overlaps) problems.push(`Two sentences are heard at once for ${clash.overlap} s: "${clash.first}" and "${clash.second}".`);

  const samples: SyncSample[] = [];
  if (streams.video && streams.audio) {
    const track = await decodeAudio(options.file, options.ffmpeg);
    const activity = new Map<string, Float32Array>();
    for (const [deviceId, region] of options.captions) activity.set(deviceId, await regionActivity(options.file, region, options.ffmpeg));
    const window = Math.min(0.3, Math.max(0.08, (options.window ?? 0.3) * 0.8));
    for (const item of options.items) {
      if (item.kind !== 'utterance') continue;
      for (const sentence of item.sentences) {
        const sample: SyncSample = { text: sentence.text, device: item.device, start: sentence.start };
        sample.audio = audioOnset(track, sentence.start - window, sentence.start + 0.4);
        const region = activity.get(item.device);
        if (sentence.caption && region) sample.caption = firstChange(region, expected.fps, sentence.start - window, sentence.start + window);
        if (sample.audio === undefined) problems.push(`No voice is heard where "${sentence.text}" should start (${sentence.start} s).`);
        if (sentence.caption && region && sample.caption === undefined) problems.push(`The caption on ${item.device} does not change where "${sentence.text}" starts (${sentence.start} s).`);
        if (sample.audio !== undefined && sample.caption !== undefined) {
          sample.offsetMs = Math.round((sample.audio - sample.caption) * 1000);
          if (Math.abs(sample.offsetMs) > toleranceMs) problems.push(`"${sentence.text}": the voice starts ${sample.offsetMs} ms from the caption (more than ${toleranceMs} ms).`);
        }
        samples.push(sample);
      }
    }
  }
  const offsets = samples.map((sample) => sample.offsetMs).filter((offset): offset is number => offset !== undefined);
  return {
    streams,
    problems,
    overlaps,
    sync: {
      checked: offsets.length,
      maxOffsetMs: offsets.reduce((max, offset) => Math.max(max, Math.abs(offset)), 0),
      meanOffsetMs: offsets.length ? Math.round(offsets.reduce((sum, offset) => sum + offset, 0) / offsets.length) : 0,
      toleranceMs,
      samples,
    },
    ok: problems.length === 0,
  };
}
