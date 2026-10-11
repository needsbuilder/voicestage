/**
 * Records a scenario to a video file with sound, with nobody at the keyboard.
 *
 * A stage is started in this process, a headless Chrome opens it, and the
 * scenario is played with the scripted provider. Chrome's screencast gives the
 * picture; the voices are rendered outside the browser, with `say` or with a
 * program named in the configuration (see `speech.ts` and `renderers.ts`),
 * because a capture of the screen cannot hear a browser speak. The page shows each
 * sentence for exactly as long as its clip lasts and reports when it did, so
 * the sound track is laid out by the same clock as the picture.
 *
 * Where a scenario has a person press a button on a card, the button is
 * really pressed: a pointer is drawn moving to it, and a mouse event is sent
 * to that point of the page, as from a hand.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { CDPSession, Frame, Page } from 'puppeteer-core';
import type { StageConfig } from '../core/config.js';
import type { Scenario } from '../core/scenario/schema.js';
import { Stage } from '../core/stage.js';
import { serveStage } from '../server/app.js';
import { compilePronunciations } from '../shared/pronounce.js';
import type { ClipRequest, RecordingMark, RecordingSettings } from '../shared/recording.js';
import { splitSentences } from '../shared/sentences.js';
import { PRODUCT_NAME, PRODUCT_VERSION, type ScenarioRunState, type StageEvent } from '../shared/types.js';
import { findChrome } from './chrome.js';
import { DEVICE_GEOMETRY, findButtonCall, pointerCall, POINTER_SCRIPT } from './in-page.js';
import { CommandRenderer, createRenderer, platformProblem, speakersWithoutVoice } from './renderers.js';
import { mixTrack, SAMPLE_RATE, Speech, writeWav, type RenderedClip, type VoiceRenderer } from './speech.js';
import { buildTimeline, type Press, type Rect, type TimelineDevice, type TimelineItem } from './timeline.js';
import { checksSection, verifyRecording, type VerifyReport } from './verify.js';
import { FrameClock, mux, VideoEncoder } from './video.js';

const run = promisify(execFile);
const sleep = (ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, Math.max(0, ms)));

export class RecordError extends Error {}

export interface RecordOptions {
  scenario: Scenario;
  config: StageConfig;
  /** Folder for the video and its timeline. Created if missing. */
  outDir: string;
  /** File name without extension. Defaults to the scenario file's name. */
  name?: string;
  /** Folder with the built UI (`dist/ui`). */
  uiDir: string;
  /** Shortest pause between two speakers, and after a card appears. Milliseconds. */
  beatMs?: number;
  /** Pause between sentences of one line. Milliseconds. */
  gapMs?: number;
  /** Stillness before the first step and after the last. Milliseconds. */
  leadMs?: number;
  tailMs?: number;
  width?: number;
  height?: number;
  fps?: number;
  /** Show the developer inspector next to the devices. */
  inspector?: boolean;
  /** Show the controls for driving the stage (the scenario player, the text boxes). Off by default: a recording shows the devices. */
  controls?: boolean;
  /** Path of a Chrome or Chromium to use. */
  chromePath?: string;
  /** Check the finished file (streams, overlaps, caption and voice in step). On by default. */
  verify?: boolean;
  log?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
}

export interface RecordResult {
  video: string;
  timeline: string;
  /** Length of the video in seconds. */
  duration: number;
  run: ScenarioRunState;
  report?: VerifyReport;
}

/** What a recording needs from the machine, checked before anything is started, with a plain reason when it is missing. */
export async function checkRecordingSupport(options: { chromePath?: string; env?: NodeJS.ProcessEnv; recording?: StageConfig['recording'] } = {}): Promise<{ chrome: string }> {
  const problem = platformProblem(process.platform, options.recording ?? { pronounce: {} });
  if (problem) throw new RecordError(problem);
  for (const tool of ['ffmpeg', 'ffprobe']) {
    await run(tool, ['-version']).catch(() => {
      throw new RecordError(`Recording needs ${tool}, which was not found. Install FFmpeg (for example "brew install ffmpeg") and try again.`);
    });
  }
  const { stdout } = await run('ffmpeg', ['-hide_banner', '-encoders']);
  if (!/\blibx264\b/.test(stdout)) throw new RecordError('This ffmpeg has no libx264 encoder, which recording uses for H.264. Install a full FFmpeg build.');
  const chrome = findChrome(options.chromePath, options.env ?? process.env);
  if (!chrome) throw new RecordError('Recording needs Google Chrome (or Chromium, or Edge). None was found; pass --chrome <path> or set CHROME_PATH.');
  return { chrome };
}

// --- finding and pressing a button --------------------------------------------------

interface Point {
  x: number;
  y: number;
}

/** Look for the button in a frame, then in the frames inside it. Coordinates come back in the outermost frame's own units. */
async function findInFrames(frame: Frame, label: string, depth = 0): Promise<(Point & { disabled: boolean }) | null> {
  const here = (await frame.evaluate(findButtonCall(label)).catch(() => null)) as (Point & { disabled: boolean }) | null;
  if (here) return here;
  if (depth >= 3) return null;
  for (const child of frame.childFrames()) {
    const element = await child.frameElement().catch(() => null);
    if (!element) continue;
    // Plain arrow functions with no helpers inside: these are sent to the page as their source.
    const offset = await element
      .evaluate((node) => {
        const box = node.getBoundingClientRect();
        return { x: box.x + node.clientLeft, y: box.y + node.clientTop };
      })
      .catch(() => null);
    const inside = offset ? await findInFrames(child, label, depth + 1) : null;
    if (inside && offset) return { x: offset.x + inside.x, y: offset.y + inside.y, disabled: inside.disabled };
  }
  return null;
}

/**
 * Where a button on a device's screen is, in page pixels. The card is in an
 * iframe that the stage scales with CSS `zoom`; a point inside it is that many
 * times closer to the iframe's corner on the page.
 */
async function locateButton(page: Page, deviceId: string, label: string, timeoutMs: number): Promise<Point> {
  const deadline = Date.now() + timeoutMs;
  const device = `[data-device="${deviceId.replace(/["\\]/g, '\\$&')}"]`;
  let seen = 'no card is on its screen';
  for (;;) {
    // Something the device itself is asking (to open a link, a question from a server) is drawn by the stage, over the card.
    const asked = (await page.evaluate(findButtonCall(label, `${device} .link-prompt, ${device} .question`))) as (Point & { disabled: boolean }) | null;
    if (asked && !asked.disabled) return { x: asked.x, y: asked.y };
    const iframe = await page.$(`${device} .app-card iframe`);
    if (iframe) {
      const outer = await iframe.contentFrame();
      const corner = await iframe.evaluate((node) => {
        const box = node.getBoundingClientRect();
        return { x: box.x, y: box.y, zoom: Number(getComputedStyle(node).zoom) || 1 };
      });
      const found = outer ? await findInFrames(outer, label) : null;
      if (found && !found.disabled) return { x: corner.x + found.x * corner.zoom, y: corner.y + found.y * corner.zoom };
      seen = found ? `the "${label}" button on its card is disabled` : `its card has no button labelled "${label}"`;
    } else {
      // Not an MCP Apps card: the default card is drawn by the stage itself.
      const found = (await page.evaluate(findButtonCall(label, `${device} .screen, ${device} .speaker__side`))) as (Point & { disabled: boolean }) | null;
      if (found && !found.disabled) return { x: found.x, y: found.y };
    }
    if (Date.now() > deadline) throw new RecordError(`Could not press "${label}" on ${deviceId}: ${seen}.`);
    await sleep(150);
  }
}

// --- the recording ----------------------------------------------------------------

export async function recordScenario(options: RecordOptions): Promise<RecordResult> {
  const log = options.log ?? (() => undefined);
  const { scenario, config } = options;
  const width = options.width ?? 1920;
  const height = options.height ?? 1080;
  const fps = options.fps ?? 30;
  const settings: RecordingSettings = { beatMs: options.beatMs ?? 600, gapMs: options.gapMs ?? 180 };
  const leadMs = options.leadMs ?? 1000;
  const tailMs = options.tailMs ?? 1500;
  if (!existsSync(join(options.uiDir, 'index.html'))) throw new RecordError('The UI has not been built yet. Run "npm run build" first.');

  const { chrome } = await checkRecordingSupport({ chromePath: options.chromePath, env: options.env, recording: config.recording });
  const unvoiced = speakersWithoutVoice(config, scenario);
  if (unvoiced.length > 0) {
    throw new RecordError(`The voices are rendered by a program (recording.voices.command), which has no list of voices to choose from, so every speaker needs a voice name in the configuration:\n${unvoiced.map((line) => `  - ${line}`).join('\n')}`);
  }
  const renderer = createRenderer(config.recording, options.env);
  const speech = new Speech({ renderer, pronounce: compilePronunciations(config.recording.pronounce) });
  await renderer.check();

  const outDir = resolve(options.outDir);
  mkdirSync(outDir, { recursive: true });
  const name = options.name ?? basename(scenario.file, extname(scenario.file));
  const videoFile = join(outDir, `${name}.mp4`);
  const timelineFile = join(outDir, `${name}.timeline.json`);
  const pictureFile = join(outDir, `.${name}.picture.mp4`);
  const soundFile = join(outDir, `.${name}.sound.wav`);

  // A recording never hurries a line along: the page reports when each one is over.
  const stage = new Stage(config, { provider: 'scripted', patience: 12, env: options.env, log });
  const running = await serveStage({ stage, uiDir: options.uiDir, log, port: 0 });
  const stageEvents: Array<{ at: number; event: StageEvent }> = [];
  const marks: RecordingMark[] = [];
  const presses: Press[] = [];
  const clips = new Map<string, RenderedClip>();
  let encoder: VideoEncoder | undefined;
  let browser: Awaited<ReturnType<typeof import('puppeteer-core').launch>> | undefined;

  try {
    await stage.start();
    const problems = [...stage.devices.values()].flatMap((device) =>
      device
        .snapshot()
        .servers.filter((server) => server.status !== 'connected')
        .map((server) => `${device.id} could not connect to "${server.id}" (${server.url}): ${server.error ?? server.status}`),
    );
    if (problems.length > 0) throw new RecordError(`The stage could not be set up:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
    await Promise.all([...stage.devices.values()].map((device) => device.eventsReady()));
    stage.subscribe((event) => {
      stageEvents.push({ at: Date.now(), event });
      // Start on a device's line the moment the stage decides to say it, before the page has even heard of it.
      if (event.type === 'speech') for (const sentence of splitSentences(event.text)) void prepareLine(event.deviceId, sentence);
    });

    // Have the people's lines ready before the camera rolls; the devices' lines are rendered as they come up.
    const snapshot = stage.snapshot();
    const requestFor = (deviceId: string, role: 'assistant' | 'person', text: string): ClipRequest | undefined => {
      const slot = snapshot.devices.findIndex((device) => device.id === deviceId);
      const device = snapshot.devices[slot];
      if (!device) return undefined;
      const prefs = role === 'assistant' ? device.voice : { lang: device.voice.lang, ...device.person.voice };
      return { deviceId, role, slot, slots: snapshot.devices.length, voice: prefs.name, lang: prefs.lang, rate: prefs.rate, text };
    };
    // A line that cannot be rendered would be a silent line in the video. Each reason is kept, and stops the recording.
    const unrendered = new Set<string>();
    const prepare = async (request: ClipRequest) => {
      try {
        const clip = await speech.render(request);
        clips.set(clip.id, clip);
        return clip;
      } catch (error) {
        unrendered.add(error instanceof Error ? error.message : String(error));
        throw error;
      }
    };
    const prepareLine = (deviceId: string, sentence: string) => {
      const request = requestFor(deviceId, 'assistant', sentence);
      return request ? prepare(request).catch(() => undefined) : undefined;
    };
    const ahead: Array<Promise<unknown>> = [];
    // One short clip per voice first: it sets each voice's loudness, and the first use of a voice is the slow one.
    // A person who says nothing in this scenario needs no voice.
    const speaking = new Set(scenario.steps.filter((step) => step.kind === 'say' && step.device).map((step) => step.device!));
    for (const device of snapshot.devices) {
      for (const role of ['assistant', 'person'] as const) {
        if (role === 'person' && !speaking.has(device.id)) continue;
        const request = requestFor(device.id, role, 'Ready.');
        if (request) ahead.push(speech.render(request));
      }
    }
    for (const step of scenario.steps) {
      if (step.kind !== 'say' || !step.device) continue;
      const answers = step.when_asked === undefined ? [] : Array.isArray(step.when_asked) ? step.when_asked : [step.when_asked];
      for (const line of [step.say!, ...answers.filter((answer): answer is string => typeof answer === 'string')]) {
        for (const sentence of splitSentences(line)) {
          const request = requestFor(step.device, 'person', sentence);
          if (request) ahead.push(prepare(request));
        }
      }
    }
    await Promise.all(ahead);
    log(`Voices are ready (${renderer.name}), and the people's lines are rendered.`);

    const puppeteer = await import('puppeteer-core');
    browser = await puppeteer.launch({
      executablePath: chrome,
      headless: true,
      args: [`--window-size=${width},${height}`, '--hide-scrollbars', '--force-device-scale-factor=1', '--mute-audio'],
      defaultViewport: { width, height, deviceScaleFactor: 1 },
    });
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(`if (window.top === window) window.__voicestageRecording = ${JSON.stringify(settings)};`);
    await page.exposeFunction('__voicestagePrepare', async (request: ClipRequest) => {
      const clip = await prepare(request);
      return { id: clip.id, ms: clip.ms, voice: clip.voice, renderer: clip.renderer };
    });
    await page.exposeFunction('__voicestageMark', (mark: RecordingMark) => {
      marks.push(mark);
    });
    page.on('pageerror', (error) => log(`page error: ${error instanceof Error ? error.message : String(error)}`));
    await page.goto(`${running.url}/?present=${options.controls ? 0 : 1}&inspector=${options.inspector ? 1 : 0}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-device]');
    await page.evaluate('document.fonts.ready.then(() => undefined)');
    await page.evaluate(POINTER_SCRIPT);
    await sleep(600);

    const geometry = (await page.evaluate(DEVICE_GEOMETRY)) as Array<{ id: string; captions: Rect | null }>;
    const devices: TimelineDevice[] = snapshot.devices.map((device) => ({ id: device.id, name: device.name, kind: device.kind, person: device.person.name, captions: geometry.find((candidate) => candidate.id === device.id)?.captions ?? undefined }));

    // --- picture ---
    const cdp: CDPSession = await page.createCDPSession();
    encoder = new VideoEncoder({ file: pictureFile, fps, width, height });
    const picture = encoder;
    let clock: FrameClock | undefined;
    let previous: Buffer | undefined;
    let firstFrame: (() => void) | undefined;
    const started = new Promise<void>((resolveStarted) => {
      firstFrame = resolveStarted;
    });
    cdp.on('Page.screencastFrame', (frame) => {
      void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => undefined);
      const time = frame.metadata.timestamp !== undefined ? frame.metadata.timestamp * 1000 : Date.now();
      const png = Buffer.from(frame.data, 'base64');
      if (!clock) {
        clock = new FrameClock(time, fps);
        clock.push(time);
        previous = png;
        firstFrame?.();
        return;
      }
      const fill = clock.push(time);
      if (fill > 0 && previous) picture.write(previous, fill);
      previous = png;
    });
    await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
    await Promise.race([started, sleep(5000)]);
    if (!clock) throw new RecordError('Chrome did not deliver any picture of the page.');
    // What the page and the stage report reaches the picture a little after the moment they report:
    // a frame of latency in the browser, and on average half a frame more, because the video has
    // fewer frames than the screen. So a moment on the clock is that much later in the video.
    // Measured on finished files, voice and caption are closest with this allowance.
    const pictureLagMs = Math.round(500 / fps) + 8;
    const origin = clock.start - pictureLagMs;
    log(`Recording "${scenario.name}" at ${width}x${height}, ${fps} frames a second.`);
    await sleep(leadMs);

    // --- pressing a button on a card, as a person would ---
    const lastSeen = () => marks.reduce((latest, mark) => Math.max(latest, mark.type === 'sentence' ? mark.at + mark.ms : mark.at), 0);
    const pressCard = async (deviceId: string, label: string) => {
      let target = await locateButton(page, deviceId, label, 12_000);
      // Let the viewer take in what was last said or shown before a hand comes in.
      await sleep(lastSeen() + settings.beatMs - Date.now());
      const from = { x: target.x + 70, y: target.y + 130 };
      const start = Date.now();
      await page.evaluate(pointerCall('show', from.x, from.y));
      await page.mouse.move(from.x, from.y);
      await sleep(260);
      await page.evaluate(pointerCall('move', target.x, target.y, 620));
      await sleep(660);
      target = await locateButton(page, deviceId, label, 2000);
      await page.mouse.move(target.x, target.y);
      await sleep(140);
      const at = Date.now();
      await page.evaluate(pointerCall('down', target.x, target.y));
      await page.mouse.down();
      await sleep(120);
      await page.mouse.up();
      await page.evaluate(pointerCall('up'));
      await page.evaluate('window.__voicestageHappened && window.__voicestageHappened()');
      const press: Press = { deviceId, label, start, at, end: Date.now() + 500, x: target.x, y: target.y };
      presses.push(press);
      setTimeout(() => void page.evaluate(pointerCall('hide')).catch(() => undefined), 500);
    };

    // --- play ---
    const played = await stage.play(scenario, { mode: 'scripted', paced: true, gapMs: 0, reset: false, beforeSay: (deviceId, text) => stage.cue(deviceId, text), pressCard, pressTimeoutMs: 20_000 });
    const state = await played.done;
    for (const step of state.steps) {
      log(`  ${step.status === 'passed' ? 'ok  ' : step.status === 'failed' ? 'FAIL' : '-   '} ${step.index + 1}. ${step.label}${step.error ? `: ${step.error}` : ''}`);
      for (const check of step.checks) if (!check.ok) log(`         ${check.label}: ${check.detail ?? 'not met'}`);
    }
    await sleep(tailMs);
    if (unrendered.size > 0) {
      throw new RecordError(`Nothing was written, because some lines could not be rendered and would have been silent:\n${[...unrendered].map((reason) => `  - ${reason}`).join('\n')}`);
    }

    // --- finish the picture ---
    const end = Date.now();
    await cdp.send('Page.stopScreencast').catch(() => undefined);
    if (previous) picture.write(previous, clock.finish(end));
    await picture.end();
    encoder = undefined;
    const frames = clock.frames;
    const duration = frames / fps;

    // --- the sound track: every clip where its caption went up ---
    const placed = marks
      .filter((mark): mark is Extract<RecordingMark, { type: 'sentence' }> => mark.type === 'sentence')
      .map((mark) => ({ at: (mark.at - origin) / 1000, data: clips.get(mark.clip)?.data }))
      .filter((clip): clip is { at: number; data: Int16Array } => clip.data !== undefined);
    writeFileSync(soundFile, writeWav(mixTrack(placed, duration)));
    await mux({ video: pictureFile, audio: soundFile, out: videoFile });

    // --- the timeline ---
    const { items, steps } = buildTimeline({ origin, duration, devices, marks, stageEvents, presses, clips });
    let report: VerifyReport | undefined;
    if (options.verify !== false) {
      const captions = new Map(devices.filter((device) => device.captions).map((device) => [device.id, device.captions as Rect]));
      report = await verifyRecording({ file: videoFile, items, captions, expected: { width, height, fps, duration }, window: Math.min(settings.gapMs, settings.beatMs) / 1000 });
    }
    writeFileSync(timelineFile, `${JSON.stringify(timelineDocument({ name, scenario, state, settings, leadMs, tailMs, width, height, fps, frames, duration, devices, items, steps, report, renderer, pronounce: config.recording.pronounce }), null, 2)}\n`);
    return { video: videoFile, timeline: timelineFile, duration, run: state, report };
  } finally {
    encoder?.kill();
    await browser?.close().catch(() => undefined);
    await stage.close().catch(() => undefined);
    await running.close().catch(() => undefined);
    for (const file of [pictureFile, soundFile]) rmSync(file, { force: true });
  }
}

function voiceOf(items: TimelineItem[], deviceId: string, role: 'assistant' | 'person'): string | undefined {
  for (const item of items) if (item.kind === 'utterance' && item.device === deviceId && item.role === role) return item.voice;
  return undefined;
}

function timelineDocument(input: {
  name: string;
  scenario: Scenario;
  state: ScenarioRunState;
  settings: RecordingSettings;
  leadMs: number;
  tailMs: number;
  width: number;
  height: number;
  fps: number;
  frames: number;
  duration: number;
  devices: TimelineDevice[];
  items: TimelineItem[];
  steps: ReturnType<typeof buildTimeline>['steps'];
  report?: VerifyReport;
  renderer: VoiceRenderer;
  pronounce: Record<string, string>;
}): Record<string, unknown> {
  const { report } = input;
  return {
    about: `Timeline of ${input.name}.mp4, recorded by ${PRODUCT_NAME} ${PRODUCT_VERSION}. Every time is in seconds from the first frame of the video.`,
    video: {
      file: `${input.name}.mp4`,
      width: input.width,
      height: input.height,
      fps: input.fps,
      frames: input.frames,
      duration: Math.round(input.duration * 1000) / 1000,
      audio: { codec: 'aac', sampleRate: SAMPLE_RATE, channels: 2 },
    },
    scenario: { name: input.scenario.name, file: input.scenario.file, mode: input.state.mode, status: input.state.status, steps: input.steps },
    settings: { beat: input.settings.beatMs / 1000, sentenceGap: input.settings.gapMs / 1000, lead: input.leadMs / 1000, tail: input.tailMs / 1000 },
    // What rendered the voices. `pronounce` is the other spellings the voice was given; captions and `text` below keep what was written.
    voices: {
      renderer: input.renderer.name,
      command: input.renderer instanceof CommandRenderer ? input.renderer.commandLine : undefined,
      pronounce: Object.keys(input.pronounce).length > 0 ? input.pronounce : undefined,
    },
    devices: input.devices.map((device) => ({
      id: device.id,
      name: device.name,
      kind: device.kind,
      person: device.person,
      voice: voiceOf(input.items, device.id, 'assistant'),
      personVoice: voiceOf(input.items, device.id, 'person'),
      captions: device.captions ? { x: Math.round(device.captions.x), y: Math.round(device.captions.y), width: Math.round(device.captions.width), height: Math.round(device.captions.height) } : undefined,
    })),
    // What is heard and what is seen, in order. `start` and `end` are seconds into the video.
    events: input.items,
    checks: report ? checksSection(report) : undefined,
  };
}
