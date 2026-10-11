/**
 * What the page and the recorder say to each other while a scenario is being
 * recorded to a video file (`voicestage record`).
 *
 * A screen capture cannot hear the browser speak, and a voice rendered
 * somewhere else never lasts exactly as long as the browser's. So while
 * recording, the page does not speak at all. For every sentence it asks the
 * recorder for an audio clip (`prepare`), is told how long that clip really
 * is, shows the caption for exactly that long, and reports the moment the
 * caption went up (`mark`). The recorder lays the clips into the sound track
 * at those moments.
 */

/** Put on `window.__voicestageRecording` by the recorder before the page loads. */
export interface RecordingSettings {
  /** Shortest pause between two speakers, and after a card appears before the next line. Milliseconds. */
  beatMs: number;
  /** Pause between two sentences of one line. Milliseconds. */
  gapMs: number;
}

/** One sentence to render. Everything the recorder needs to choose a voice the way the page would. */
export interface ClipRequest {
  deviceId: string;
  role: 'assistant' | 'person';
  /** Position of the device on the stage, and how many devices there are. */
  slot: number;
  slots: number;
  /** A voice asked for by name, in the configuration. */
  voice?: string;
  lang?: string;
  rate?: number;
  text: string;
}

export interface Clip {
  id: string;
  /** How long the rendered audio lasts, in milliseconds. */
  ms: number;
  /** The voice it was rendered with. */
  voice: string;
}

/** Things the page reports, each with the wall-clock time (`Date.now()`) at which it was on screen. */
export type RecordingMark =
  | {
      type: 'sentence';
      at: number;
      clip: string;
      ms: number;
      deviceId: string;
      role: 'assistant' | 'person';
      text: string;
      /** The whole line this sentence belongs to, and its place in it. */
      line: string;
      lineId: number;
      index: number;
      of: number;
    }
  | { type: 'card'; at: number; deviceId: string; card: string; tool: string };

/** The speaker of a line, for deciding whether a pause is a change of speaker. */
export function speakerKey(deviceId: string, role: 'assistant' | 'person'): string {
  return `${deviceId}/${role}`;
}

/**
 * When the next sentence may start.
 *
 * `first` is true for the first sentence of a line. A new speaker waits a beat
 * after the last one stopped; so does any line after a card has appeared, so
 * that a viewer can look at it. Sentences of one line follow each other after
 * a short gap.
 */
export function earliestStart(state: { lastEnd: number; lastSpeaker?: string; lastCardAt: number }, speaker: string, first: boolean, settings: RecordingSettings): number {
  if (!first) return state.lastEnd + settings.gapMs;
  const afterSpeech = state.lastEnd + (state.lastSpeaker === undefined || state.lastSpeaker === speaker ? settings.gapMs : settings.beatMs);
  return Math.max(afterSpeech, state.lastCardAt + settings.beatMs);
}
