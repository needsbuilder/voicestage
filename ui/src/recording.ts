/**
 * The page's side of recording a scenario to a video file. See
 * `src/shared/recording.ts` for how the page and the recorder work together.
 *
 * `recording` is `null` in ordinary use. The recorder (`voicestage record`)
 * puts its settings and two functions on `window` before the page loads.
 */
import { earliestStart, speakerKey, type Clip, type ClipRequest, type RecordingMark, type RecordingSettings } from '../../src/shared/recording';

interface RecorderWindow {
  __voicestageRecording?: RecordingSettings;
  __voicestagePrepare?: (request: ClipRequest) => Promise<Clip>;
  __voicestageMark?: (mark: RecordingMark) => unknown;
}

const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

class Recording {
  private readonly clips = new Map<string, Promise<Clip>>();
  private lastEnd = 0;
  private lastSpeaker: string | undefined;
  private lastCardAt = 0;

  constructor(
    private readonly settings: RecordingSettings,
    private readonly scope: RecorderWindow,
  ) {}

  /** Ask for a sentence's audio clip. Asking twice for the same sentence costs nothing. */
  prepare(request: ClipRequest): Promise<Clip> {
    const key = JSON.stringify(request);
    let clip = this.clips.get(key);
    if (!clip) {
      clip = this.scope.__voicestagePrepare!(request);
      this.clips.set(key, clip);
    }
    return clip;
  }

  /** Wait until this speaker may start: a beat after another speaker or a new card, a short gap between sentences. */
  async turn(deviceId: string, role: 'assistant' | 'person', first: boolean): Promise<void> {
    // A card may appear while this waits, which moves the start; so look again after each wait.
    for (;;) {
      const start = earliestStart({ lastEnd: this.lastEnd, lastSpeaker: this.lastSpeaker, lastCardAt: this.lastCardAt }, speakerKey(deviceId, role), first, this.settings);
      const now = Date.now();
      if (start <= now) return;
      await wait(start - now);
    }
  }

  /** Resolves once what was just put in the page has been drawn, with the time of that frame. */
  painted(): Promise<number> {
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(Date.now()))));
  }

  /** A sentence's caption is on screen now, and stays for `ms`. */
  sentence(mark: Omit<Extract<RecordingMark, { type: 'sentence' }>, 'type'>): void {
    this.lastEnd = mark.at + mark.ms;
    this.lastSpeaker = speakerKey(mark.deviceId, mark.role);
    this.mark({ type: 'sentence', ...mark });
  }

  /** A card (an MCP Apps card, or the default one) has just been drawn on a device. */
  cardShown(deviceId: string, card: string, tool: string): void {
    void this.painted().then((at) => {
      this.lastCardAt = at;
      this.mark({ type: 'card', at, deviceId, card, tool });
    });
  }

  /** Something a viewer should have a moment to take in has just happened (a button was pressed, say). */
  happened(): void {
    this.lastCardAt = Date.now();
  }

  mark(mark: RecordingMark): void {
    void this.scope.__voicestageMark?.(mark);
  }
}

const scope = (typeof window === 'undefined' ? {} : window) as RecorderWindow;

/** The recording in progress, or `null` when the page is simply being used. */
export const recording: Recording | null = scope.__voicestageRecording && scope.__voicestagePrepare ? new Recording(scope.__voicestageRecording, scope) : null;
if (recording) (scope as RecorderWindow & { __voicestageHappened?: () => void }).__voicestageHappened = () => recording.happened();

/** `?present=1`: the stage without the controls for driving it, for filming or recording. */
export const presenting = typeof location !== 'undefined' && new URLSearchParams(location.search).get('present') === '1';
