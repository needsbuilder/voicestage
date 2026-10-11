/**
 * The picture of a recording.
 *
 * Chrome hands over a frame each time it draws the page, with the time it
 * drew it. A video file wants frames at a steady rate. `FrameClock` decides,
 * for every tick of that rate, which drawn frame was on screen, so a moment in
 * the video is the same moment on the wall clock, to within one frame. That is
 * what lets the sound track and the timeline be placed by the clock.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

/**
 * Turns frames with timestamps into frames at a fixed rate.
 *
 * Tick `k` is at `start + k / fps`. It shows the last frame drawn at or before
 * that moment. `push` returns how many ticks the *previous* frame fills, now
 * that the next one is known; `finish` does the same for the last frame.
 */
export class FrameClock {
  private ticks = 0;
  private started = false;

  constructor(
    /** Wall-clock time of tick 0, in milliseconds. */
    readonly start: number,
    readonly fps: number,
  ) {}

  /** How many ticks have been filled so far. */
  get frames(): number {
    return this.ticks;
  }

  private ticksBefore(time: number): number {
    // Ticks strictly before `time`, with a hair of tolerance for floating point.
    return Math.max(0, Math.ceil(((time - this.start) * this.fps) / 1000 - 1e-6));
  }

  /** A new frame was drawn at `time`. Returns how many ticks the frame before it should fill. */
  push(time: number): number {
    if (!this.started) {
      // The first frame stands in for everything from the start up to the next frame.
      this.started = true;
      return 0;
    }
    const upTo = this.ticksBefore(time);
    const count = Math.max(0, upTo - this.ticks);
    this.ticks += count;
    return count;
  }

  /** The recording ends at `time`. Returns how many ticks the last frame should fill (at least one). */
  finish(time: number): number {
    const upTo = Math.max(this.ticks + 1, this.ticksBefore(time));
    const count = upTo - this.ticks;
    this.ticks = upTo;
    return count;
  }
}

export class EncoderError extends Error {}

/** Writes PNG frames to ffmpeg as an H.264 video at a fixed frame rate. */
export class VideoEncoder {
  private readonly ffmpeg: ChildProcessWithoutNullStreams;
  private readonly finished: Promise<void>;
  private stderr = '';
  private failure: Error | undefined;
  private waiting: Promise<void> = Promise.resolve();

  constructor(options: { file: string; fps: number; width: number; height: number; ffmpeg?: string }) {
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'image2pipe',
      '-framerate',
      String(options.fps),
      '-c:v',
      'png',
      '-i',
      'pipe:0',
      '-an',
      // Screen pixels are full-range RGB; players expect BT.709 video levels.
      '-vf',
      `scale=${options.width}:${options.height}:flags=lanczos:out_color_matrix=bt709:out_range=tv,format=yuv420p`,
      '-c:v',
      'libx264',
      '-preset',
      'fast',
      '-crf',
      '17',
      '-r',
      String(options.fps),
      '-colorspace',
      'bt709',
      '-color_primaries',
      'bt709',
      '-color_trc',
      'bt709',
      '-color_range',
      'tv',
      options.file,
    ];
    this.ffmpeg = spawn(options.ffmpeg ?? 'ffmpeg', args);
    this.ffmpeg.stderr.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-4000);
    });
    this.ffmpeg.stdin.on('error', (error) => {
      this.failure ??= error;
    });
    this.finished = new Promise((resolve, reject) => {
      this.ffmpeg.once('error', (error) => reject(new EncoderError(`Could not run ffmpeg: ${error.message}`)));
      this.ffmpeg.once('close', (code) => (code === 0 ? resolve() : reject(new EncoderError(`ffmpeg stopped with code ${code}: ${this.stderr.trim() || 'no message'}`))));
    });
    this.finished.catch(() => undefined);
  }

  /** Write one frame `times` times. Writes are queued, and wait for ffmpeg when it falls behind. */
  write(png: Buffer, times: number): void {
    for (let count = 0; count < times; count += 1) {
      this.waiting = this.waiting.then(
        () =>
          new Promise<void>((resolve) => {
            if (this.failure || this.ffmpeg.stdin.destroyed) return resolve();
            if (this.ffmpeg.stdin.write(png)) resolve();
            else this.ffmpeg.stdin.once('drain', resolve);
          }),
      );
    }
  }

  /** No more frames. Resolves when the file is complete. */
  async end(): Promise<void> {
    await this.waiting;
    this.ffmpeg.stdin.end();
    await this.finished;
  }

  kill(): void {
    this.ffmpeg.kill('SIGKILL');
  }
}

/** Put the picture and the sound track into one MP4: the video as it is, the audio as AAC. */
export function mux(options: { video: string; audio: string; out: string; ffmpeg?: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', options.video, '-i', options.audio, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-movflags', '+faststart', options.out];
    const ffmpeg = spawn(options.ffmpeg ?? 'ffmpeg', args);
    let stderr = '';
    ffmpeg.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    ffmpeg.once('error', (error) => reject(new EncoderError(`Could not run ffmpeg: ${error.message}`)));
    ffmpeg.once('close', (code) => (code === 0 ? resolve() : reject(new EncoderError(`ffmpeg could not put picture and sound together (code ${code}): ${stderr.trim() || 'no message'}`))));
  });
}
