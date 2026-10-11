/**
 * The parts of recording that can be checked without a browser, a voice or a
 * video encoder: which frame fills which tick, where clips land in the sound
 * track, how the timeline is put together, when a line may start.
 */
import { describe, expect, it } from 'vitest';
import { applyGain, loudness, mixTrack, parseSayVoices, readWav, SAMPLE_RATE, trimSilence, writeWav } from '../src/record/speech.js';
import { buildTimeline, overlappingSentences, type TimelineInput } from '../src/record/timeline.js';
import { audioOnset, firstChange } from '../src/record/verify.js';
import { FrameClock } from '../src/record/video.js';
import { earliestStart, speakerKey, type RecordingMark } from '../src/shared/recording.js';
import { splitSentences } from '../src/shared/sentences.js';
import type { StageEvent, ToolEntry } from '../src/shared/types.js';
import { chooseVoice } from '../src/shared/voices.js';

describe('the system voices, as "say" lists them', () => {
  const listing = [
    'Albert              en_US    # Hello! My name is Albert.',
    'Bad News            en_US    # Hello! My name is Bad News.',
    'Daniel (영어(영국))     en_GB    # Hello! My name is Daniel.',
    'Daniel (영어(영국))     en_GB    # Hello! My name is Daniel.',
    'Eddy (독일어(독일))      de_DE    # Hallo! Ich heiße Eddy.',
    'Karen               en_AU    # Hello! My name is Karen.',
    'Moira (영어(아일랜드))    en_IE    # Hello! My name is Moira.',
    'Samantha (영어(미국))   en_US    # Hello! My name is Samantha.',
    'Tessa (영어(남아프리카))   en_ZA    # Hello! My name is Tessa.',
    '지안(프리미엄)            ko_KR    # 안녕하세요. 제 이름은 지안입니다.',
    '',
  ].join('\n');

  it('reads names with spaces and translated suffixes, and the language', () => {
    const voices = parseSayVoices(listing);
    expect(voices.map((voice) => `${voice.name}|${voice.lang}`)).toEqual([
      'Albert|en-US',
      'Bad News|en-US',
      'Daniel (영어(영국))|en-GB',
      'Eddy (독일어(독일))|de-DE',
      'Karen|en-AU',
      'Moira (영어(아일랜드))|en-IE',
      'Samantha (영어(미국))|en-US',
      'Tessa (영어(남아프리카))|en-ZA',
      '지안(프리미엄)|ko-KR',
    ]);
  });

  it('gives a recording the same cast as the browser: a voice per device, another for each person, no novelties', () => {
    const voices = parseSayVoices(listing);
    const pick = (role: 'assistant' | 'person', slot: number, name?: string) => chooseVoice(voices, { role, slot, slots: 2, name })!.name;
    expect(pick('assistant', 0)).toBe('Samantha (영어(미국))');
    expect(pick('assistant', 1)).toBe('Daniel (영어(영국))');
    expect(pick('person', 0)).toBe('Moira (영어(아일랜드))');
    expect(pick('person', 1)).toBe('Tessa (영어(남아프리카))');
    // A voice named in the configuration by its plain name is found under its listed one.
    expect(pick('person', 0, 'Karen')).toBe('Karen');
    expect(pick('assistant', 0, 'Moira')).toBe('Moira (영어(아일랜드))');
  });
});

describe('audio clips', () => {
  const tone = (samples: number, level: number) => Int16Array.from({ length: samples }, (_unused, index) => Math.round(Math.sin(index / 6) * level));

  it('writes and reads WAV files, also ones with other chunks before the samples', () => {
    const data = tone(480, 9000);
    const wav = writeWav(data);
    expect(readWav(wav)).toMatchObject({ sampleRate: SAMPLE_RATE, channels: 1 });
    expect([...readWav(wav).data]).toEqual([...data]);
    // "say" puts a filler chunk between the format and the samples.
    const filler = Buffer.concat([Buffer.from('FLLR', 'latin1'), Buffer.from([6, 0, 0, 0]), Buffer.alloc(6)]);
    const withFiller = Buffer.concat([wav.subarray(0, 36), filler, wav.subarray(36)]);
    expect([...readWav(withFiller).data]).toEqual([...data]);
    expect(() => readWav(Buffer.from('not a wav file at all'))).toThrow(/Not a WAV file/);
  });

  it('cuts the silence around a voice, so a clip lasts as long as it is heard', () => {
    const silence = new Int16Array(4800);
    const voiced = tone(9600, 8000);
    const clip = Int16Array.from([...silence, ...voiced, ...silence]);
    const trimmed = trimSilence(clip);
    // 200 ms of voice, with 8 ms kept before it and 40 ms after.
    expect(trimmed.length / SAMPLE_RATE).toBeGreaterThan(0.2);
    expect(trimmed.length / SAMPLE_RATE).toBeLessThan(0.26);
    expect(trimSilence(new Int16Array(1000)).length).toBe(0);
  });

  it('measures loudness on the audible part and applies a gain without overflowing', () => {
    expect(loudness(new Int16Array(100))).toBe(0);
    expect(loudness(tone(4800, 8000))).toBeGreaterThan(5000);
    expect(Math.max(...applyGain(tone(480, 20000), 4))).toBe(32767);
  });

  it('lays clips into the track at their times', () => {
    const track = mixTrack(
      [
        { at: 0.5, data: Int16Array.from([100, 200, 300]) },
        { at: 1, data: Int16Array.from([7]) },
        { at: 1.999, data: tone(4800, 5000) },
      ],
      2,
    );
    expect(track.length).toBe(2 * SAMPLE_RATE);
    expect([...track.subarray(24000, 24003)]).toEqual([100, 200, 300]);
    expect(track[48000]).toBe(7);
    expect(track[23999]).toBe(0);
    // Found again where it was put: this is how a finished file is checked.
    expect(audioOnset(track, 0.3, 0.9, 50)).toBeCloseTo(0.5, 4);
    expect(audioOnset(track, 0.6, 0.9, 50)).toBeUndefined();
  });
});

describe('frames at a steady rate from frames with timestamps', () => {
  it('shows, at every tick, the last frame drawn before it', () => {
    const clock = new FrameClock(1000, 30);
    // Frames drawn at 1000, 1010, 1040, 1300 ms; ticks are every 33.3 ms from 1000.
    expect(clock.push(1000)).toBe(0);
    expect(clock.push(1010)).toBe(1); // the first frame fills tick 0 (1000)
    expect(clock.push(1040)).toBe(1); // the frame of 1010 fills tick 1 (1033.3)
    expect(clock.push(1300)).toBe(7); // the frame of 1040 fills ticks 2..8 (1066.7 .. 1266.7)
    expect(clock.frames).toBe(9);
    expect(clock.finish(2000)).toBe(21); // the last frame fills ticks 9..29
    expect(clock.frames).toBe(30);
  });

  it('drops frames that arrive faster than the rate, and never ends with no frame', () => {
    const clock = new FrameClock(0, 30);
    clock.push(0);
    expect(clock.push(5)).toBe(1);
    expect(clock.push(10)).toBe(0);
    expect(clock.push(15)).toBe(0);
    expect(clock.finish(16)).toBe(1);
    const still = new FrameClock(0, 30);
    still.push(0);
    expect(still.finish(0)).toBe(1);
  });

  it('keeps a tick that falls exactly on a new frame for that frame', () => {
    const clock = new FrameClock(0, 10);
    clock.push(0);
    expect(clock.push(300)).toBe(3); // ticks 0, 100, 200; the tick at 300 belongs to the new frame
    expect(clock.finish(400)).toBe(1);
  });
});

describe('pauses a viewer can follow', () => {
  const settings = { beatMs: 600, gapMs: 180 };
  const margaret = speakerKey('kitchen', 'person');
  const display = speakerKey('kitchen', 'assistant');

  it('leaves a beat between two speakers and a short gap between sentences', () => {
    const state = { lastEnd: 10_000, lastSpeaker: margaret, lastCardAt: 0 };
    expect(earliestStart(state, display, true, settings)).toBe(10_600);
    expect(earliestStart(state, margaret, false, settings)).toBe(10_180);
    // The same speaker going on with a new line does not need a beat.
    expect(earliestStart(state, margaret, true, settings)).toBe(10_180);
  });

  it('gives a card that has just appeared a beat before anyone speaks over it', () => {
    const state = { lastEnd: 10_000, lastSpeaker: display, lastCardAt: 10_400 };
    expect(earliestStart(state, display, true, settings)).toBe(11_000);
    // In the middle of a line a card does not hold the next sentence back.
    expect(earliestStart(state, display, false, settings)).toBe(10_180);
  });

  it('cuts a line into the same sentences on the page and in the recorder', () => {
    expect(splitSentences("Con Edison is on my list. Because of the amount, Sarah gets a quick request to approve it. Nothing has been paid.")).toEqual([
      'Con Edison is on my list.',
      'Because of the amount, Sarah gets a quick request to approve it.',
      'Nothing has been paid.',
    ]);
    // Very short fragments stay with their neighbour, so a caption does not flash by.
    expect(splitSentences('Done. $182.40 was paid to Con Edison.')).toEqual(['Done. $182.40 was paid to Con Edison.']);
  });
});

describe('the timeline that goes with a video', () => {
  const origin = 1_000_000;
  const sentence = (at: number, ms: number, text: string, lineId: number, index: number, of: number, role: 'assistant' | 'person', deviceId = 'kitchen'): RecordingMark => ({
    type: 'sentence',
    at: origin + at,
    ms,
    clip: `clip-${lineId}-${index}`,
    deviceId,
    role,
    text,
    line: `line ${lineId}`,
    lineId,
    index,
    of,
  });
  const tool = (id: string, status: ToolEntry['status'], origin_: ToolEntry['origin'] = 'assistant'): StageEvent => ({
    type: 'timeline',
    deviceId: 'phone',
    entry: { id, seq: 1, at: '', kind: 'tool', server: 'shop', name: 'approve', arguments: {}, origin: origin_, status, progress: [] },
  });
  const input: TimelineInput = {
    origin,
    duration: 20,
    devices: [
      { id: 'kitchen', name: 'Kitchen display', kind: 'display', person: 'Margaret' },
      { id: 'phone', name: "Sarah's phone", kind: 'phone', person: 'Sarah' },
    ],
    marks: [
      sentence(1000, 2000, 'Pay my bill.', 1, 0, 2, 'person'),
      sentence(3180, 1000, 'With my card.', 1, 1, 2, 'person'),
      sentence(5000, 1500, 'It is on hold.', 2, 0, 1, 'assistant'),
      { type: 'card', at: origin + 4300, deviceId: 'kitchen', card: 'ui://shop/hold.html', tool: 'place_hold' },
      { type: 'card', at: origin + 9000, deviceId: 'kitchen', card: 'default', tool: 'pay' },
    ],
    stageEvents: [
      { at: origin - 500, event: tool('before', 'running') },
      { at: origin + 7000, event: tool('t1', 'running', 'card') },
      { at: origin + 7040, event: tool('t1', 'ok', 'card') },
      { at: origin + 7100, event: { type: 'device', deviceId: 'kitchen', patch: { notification: { id: 'n1', text: 'Sarah has answered.', at: '', state: 'pending' } } } },
      { at: origin + 9500, event: { type: 'device', deviceId: 'kitchen', patch: { notification: { id: 'n1', text: 'Sarah has answered.', at: '', state: 'done' } } } },
    ],
    presses: [{ deviceId: 'phone', label: 'Approve', start: origin + 6000, at: origin + 6900, end: origin + 7500, x: 1520.4, y: 457.2 }],
    voices: new Map([
      ['clip-1-0', 'Moira'],
      ['clip-2-0', 'Samantha'],
    ]),
  };

  it('gives every time in seconds from the first frame, and says who and what', () => {
    const { items } = buildTimeline(input);
    expect(items.map((item) => `${item.start} ${item.end} ${item.kind} ${item.who}: ${item.text}`)).toEqual([
      '1 4.18 utterance Margaret: line 1',
      '4.3 9 card Kitchen display: Shows the card ui://shop/hold.html (place_hold)',
      '5 6.5 utterance Kitchen display: line 2',
      '6 7.5 press Sarah: Sarah presses "Approve" on Sarah\'s phone',
      "7 7.04 tool Sarah's phone: Sarah, on the card calls approve",
      '7.1 9.5 notification Kitchen display: Sarah has answered.',
      '9 20 card Kitchen display: Shows the result of pay',
    ]);
    const [margaret] = items;
    expect(margaret).toMatchObject({ kind: 'utterance', role: 'person', voice: 'Moira' });
    // A person's whole line is on the screen from its first sentence; a device's caption changes with each one.
    expect(margaret!.kind === 'utterance' && margaret!.sentences).toEqual([
      { start: 1, end: 3, text: 'Pay my bill.', caption: true, clip: 'clip-1-0' },
      { start: 3.18, end: 4.18, text: 'With my card.', caption: false, clip: 'clip-1-1' },
    ]);
    expect(items.find((item) => item.kind === 'press')).toMatchObject({ at: 6.9, x: 1520, y: 457, label: 'Approve', device: 'phone' });
  });

  it('finds sentences that would be heard at once', () => {
    expect(overlappingSentences(buildTimeline(input).items)).toEqual([]);
    const clash = { ...input, marks: [...input.marks, sentence(5900, 800, 'Wait.', 3, 0, 1, 'person', 'phone')] };
    expect(overlappingSentences(buildTimeline(clash).items)).toEqual([{ first: 'It is on hold.', second: 'Wait.', overlap: 0.6 }]);
  });
});

describe('finding a caption change in the decoded picture', () => {
  it('reports the first frame in which the region changes, as a time', () => {
    const activity = new Float32Array(90);
    activity[45] = 3.2;
    activity[46] = 1.1;
    expect(firstChange(activity, 30, 1.2, 1.8)).toBeCloseTo(1.5, 5);
    expect(firstChange(activity, 30, 1.6, 2.5)).toBeUndefined();
  });
});
