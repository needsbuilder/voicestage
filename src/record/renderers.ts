/**
 * Who renders the voices of a recording.
 *
 * `SayRenderer` is the macOS `say` command. It has the system's list of
 * voices, so it chooses one for each speaker by the same rules as the browser.
 *
 * `CommandRenderer` is any program that writes a WAV file for a sentence
 * (`recording.voices.command`). It has no list to choose from: the voice of
 * each speaker is the name written in the configuration (`voice.name` on a
 * device, `person.voice.name` for the person at it), handed over as it is.
 */
import { execFile } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { promisify } from 'node:util';
import type { RecordingConfig, StageConfig } from '../core/config.js';
import type { Scenario } from '../core/scenario/schema.js';
import type { ClipRequest } from '../shared/recording.js';
import { fillCommand, placeholdersIn } from '../shared/voice-command.js';
import { chooseVoice, voiceBaseName, type VoiceInfo } from '../shared/voices.js';
import { parseSayVoices, SAMPLE_RATE, SpeechError, type RenderJob, type RendererVoice, type VoiceRenderer } from './speech.js';

const run = promisify(execFile);

/** `say` speaks at about this many words a minute when not told otherwise. */
const WORDS_PER_MINUTE = 175;

export class SayRenderer implements VoiceRenderer {
  readonly name = 'say';
  readonly cacheKey = ['say'];
  readonly parallel = Number.POSITIVE_INFINITY;
  private voices: VoiceInfo[] | undefined;

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

  async check(): Promise<void> {
    await this.voiceList();
  }

  /** The same rules as in the browser, applied to the system's voices. */
  async voiceFor(request: Pick<ClipRequest, 'role' | 'slot' | 'slots' | 'voice' | 'lang'>): Promise<RendererVoice> {
    const voices = await this.voiceList();
    const voice = chooseVoice(voices, { role: request.role, slot: request.slot, slots: request.slots, lang: request.lang, name: request.voice });
    if (!voice) throw new SpeechError(`The system has no voice for ${request.lang ?? 'en-US'}. Add one in System Settings > Accessibility > Spoken Content.`);
    return { id: voice.name, lang: voice.lang, label: voiceBaseName(voice.name) };
  }

  async render(job: RenderJob): Promise<void> {
    const source = `${job.out}.txt`;
    writeFileSync(source, job.text);
    const args = ['-v', job.voice.id, '-f', source, '-o', job.out, '--file-format=WAVE', `--data-format=LEI16@${SAMPLE_RATE}`];
    if (job.rate !== 1) args.push('-r', String(Math.round(WORDS_PER_MINUTE * job.rate)));
    try {
      await run('say', args);
    } catch (error) {
      throw new SpeechError(`"say" could not render a line with the voice ${job.voice.label}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      rmSync(source, { force: true });
    }
  }
}

/** A sentence of a first run may have to wait for the program to download what it needs. */
const COMMAND_TIMEOUT_MS = 10 * 60_000;

export class CommandRenderer implements VoiceRenderer {
  readonly name: string;
  readonly cacheKey: readonly string[];
  /**
   * A program that loads a speech model for every sentence is heavy, and a device's line is
   * rendered while the viewer waits for it. Two at a time keeps the wait for the first
   * sentence short; with Kokoro, more at once made every one of them slower to arrive.
   */
  readonly parallel = 2;
  private readonly command: string[];
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly wantsTextFile: boolean;

  constructor(options: { name: string; command: string[]; cwd: string; env?: NodeJS.ProcessEnv }) {
    this.name = options.name;
    this.command = options.command;
    this.cwd = options.cwd;
    this.env = options.env ?? process.env;
    this.cacheKey = ['command', options.name, ...options.command];
    this.wantsTextFile = placeholdersIn(options.command).has('text_file');
  }

  /** The command as it is written in the configuration. */
  get commandLine(): string {
    return this.command.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(' ');
  }

  async check(): Promise<void> {
    // Nothing to ask the program before it is used: the first sentences are rendered before the camera rolls, and say what is wrong.
  }

  async voiceFor(request: Pick<ClipRequest, 'deviceId' | 'role' | 'voice' | 'lang'>): Promise<RendererVoice> {
    if (!request.voice) {
      const [who, key] = request.role === 'assistant' ? [`the device "${request.deviceId}"`, 'voice.name'] : [`the person at the device "${request.deviceId}"`, 'person.voice.name'];
      throw new SpeechError(`No voice is set for ${who}. "${this.name}" has no list of voices to choose from: set ${key} on that device in the configuration.`);
    }
    return { id: request.voice, lang: request.lang, label: request.voice };
  }

  async render(job: RenderJob): Promise<void> {
    const textFile = `${job.out}.txt`;
    if (this.wantsTextFile) writeFileSync(textFile, job.text);
    const [program, ...args] = fillCommand(this.command, { text: job.text, text_file: textFile, voice: job.voice.id, rate: String(job.rate), lang: job.voice.lang ?? '', out: job.out });
    try {
      await run(program!, args, { cwd: this.cwd, env: this.env, timeout: COMMAND_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { stderr?: string; stdout?: string; killed?: boolean; signal?: string };
      const what = `"${job.text}" with the voice ${job.voice.label}`;
      if (failure.code === 'ENOENT') {
        throw new SpeechError(`The voice command could not be started: "${program}" was not found (started in ${this.cwd}). Check recording.voices.command in the configuration.`);
      }
      if (failure.killed) throw new SpeechError(`The voice command was stopped after ${COMMAND_TIMEOUT_MS / 60_000} minutes without finishing ${what}: ${this.commandLine}`);
      // The last lines the program printed are usually the reason.
      const said = `${failure.stderr ?? ''}`.trim() || `${failure.stdout ?? ''}`.trim();
      const tail = said.split('\n').slice(-6).join('\n    ');
      const ended = typeof failure.code === 'number' ? `stopped with code ${failure.code}` : failure.signal ? `was ended by ${failure.signal}` : `failed (${failure.message})`;
      throw new SpeechError(`The voice command ${ended} while rendering ${what}.${tail ? `\n    ${tail}` : ''}`);
    } finally {
      if (this.wantsTextFile) rmSync(textFile, { force: true });
    }
  }
}

/** The renderer a configuration asks for: its own program, or `say`. */
export function createRenderer(recording: RecordingConfig, env?: NodeJS.ProcessEnv): SayRenderer | CommandRenderer {
  return recording.voices ? new CommandRenderer({ ...recording.voices, env }) : new SayRenderer();
}

/** Why the voices cannot be rendered on this system, or `undefined` when they can. */
export function platformProblem(platform: string, recording: RecordingConfig): string | undefined {
  if (recording.voices || platform === 'darwin') return undefined;
  return (
    `Recording renders the voices with the macOS "say" command, and this is ${platform}. ` +
    'To render them with another program, set recording.voices.command in the configuration (see "Voices from another program" in the README; that way has not been tried outside macOS). ' +
    'Or play the scenario in the browser with ?present=1 and use a screen recorder.'
  );
}

/**
 * The speakers a program cannot render because the configuration names no
 * voice for them: every device, and every person who has a line in the scenario.
 */
export function speakersWithoutVoice(config: StageConfig, scenario: Scenario): string[] {
  if (!config.recording.voices) return [];
  const speaking = new Set(scenario.steps.filter((step) => step.kind === 'say' && step.device).map((step) => step.device!));
  const missing: string[] = [];
  for (const device of config.devices) {
    if (!device.voice.name) missing.push(`${device.name} ("${device.id}"): set voice.name`);
    if (speaking.has(device.id) && !device.person.voice?.name) missing.push(`${device.person.name}, at "${device.id}": set person.voice.name`);
  }
  return missing;
}
