/**
 * Voices of a recording rendered by a program named in the configuration
 * (`recording.voices.command`), and other spellings for the voice
 * (`recording.pronounce`).
 *
 * No speech is synthesised here. The "voice" is a few lines of Node that
 * write a tone to a WAV file, as long as the sentence is, and note what they
 * were asked. The tests that hand over audio in another sample rate need
 * ffmpeg and are skipped where there is none.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfigFile, resolveConfig } from '../src/core/config.js';
import { loadScenarioFile } from '../src/core/scenario/schema.js';
import { CommandRenderer, createRenderer, platformProblem, SayRenderer, speakersWithoutVoice } from '../src/record/renderers.js';
import { loudness, SAMPLE_RATE, Speech, SpeechError, writeWav, type RenderJob, type VoiceRenderer } from '../src/record/speech.js';
import { buildTimeline } from '../src/record/timeline.js';
import { compilePronunciations, PronounceError, respell } from '../src/shared/pronounce.js';
import type { ClipRequest, RecordingMark } from '../src/shared/recording.js';
import { commandProblem, fillCommand, splitCommand } from '../src/shared/voice-command.js';
import { ROOT } from './helpers.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

/**
 * The stand-in for a speech program. The voice name chooses what it does:
 * a tone at 48 kHz mono (`tone`, `quiet`, `loud`), the same in other formats
 * (`tone24`, `stereo44`, `float24`), or one of the ways a program can let the
 * recorder down. 60 ms of tone for each character, between two stretches of silence.
 */
const FAKE_VOICE = String.raw`
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const started = Date.now();
const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const voice = flag('--voice');
const out = flag('--out');
const rate = Number(flag('--rate') ?? 1);
const text = flag('--text-file') ? readFileSync(flag('--text-file'), 'utf8') : flag('--text');
const note = (extra) => appendFileSync(process.env.FAKE_VOICE_LOG, JSON.stringify({ args, voice, rate: flag('--rate'), lang: flag('--lang'), text, cwd: process.cwd(), started, ...extra }) + '\n');

if (voice === 'broken') {
  note({});
  console.error('loading the model');
  console.error('the model file is damaged');
  process.exit(3);
}
if (voice === 'nothing') {
  note({});
  process.exit(0);
}
if (voice === 'garbage') {
  note({});
  writeFileSync(out, 'this is not audio');
  process.exit(0);
}

const formats = { tone24: [24000, 1, 16], stereo44: [44100, 2, 16], float24: [24000, 1, 32] };
const [sampleRate, channels, bits] = formats[voice] ?? [48000, 1, 16];
const level = voice === 'silent' ? 0 : voice === 'quiet' ? 0.05 : voice === 'loud' ? 0.9 : 0.3;
const edge = Math.round(sampleRate * 0.1);
const voiced = Math.round((sampleRate * 0.06 * text.length) / rate);
const frames = edge + voiced + edge;
const bytes = bits / 8;
const data = Buffer.alloc(frames * channels * bytes);
for (let frame = edge; frame < edge + voiced; frame += 1) {
  const sample = Math.sin((2 * Math.PI * 220 * frame) / sampleRate) * level;
  for (let channel = 0; channel < channels; channel += 1) {
    const at = (frame * channels + channel) * bytes;
    if (bits === 32) data.writeFloatLE(sample, at);
    else data.writeInt16LE(Math.round(sample * 32767), at);
  }
}
const header = Buffer.alloc(44);
header.write('RIFF', 0, 'latin1');
header.writeUInt32LE(36 + data.length, 4);
header.write('WAVEfmt ', 8, 'latin1');
header.writeUInt32LE(16, 16);
header.writeUInt16LE(bits === 32 ? 3 : 1, 20);
header.writeUInt16LE(channels, 22);
header.writeUInt32LE(sampleRate, 24);
header.writeUInt32LE(sampleRate * channels * bytes, 28);
header.writeUInt16LE(channels * bytes, 32);
header.writeUInt16LE(bits, 34);
header.write('data', 36, 'latin1');
header.writeUInt32LE(data.length, 40);
if (voice === 'slow') await new Promise((resolve) => setTimeout(resolve, 250));
writeFileSync(out, Buffer.concat([header, data]));
note({ ended: Date.now() });
`;

const work = mkdtempSync(join(tmpdir(), 'voicestage-voices-'));
const script = join(work, 'fake-voice.mjs');
writeFileSync(script, FAKE_VOICE);
afterAll(() => rmSync(work, { recursive: true, force: true }));

// A log of its own for every test, so that a program still finishing for one test is not counted in the next.
let log = '';
let tests = 0;
beforeEach(() => {
  tests += 1;
  log = join(work, `calls-${tests}.log`);
});

interface Call {
  args: string[];
  voice: string;
  rate: string;
  lang: string;
  text: string;
  cwd: string;
  started: number;
  ended?: number;
}

const calls = (): Call[] => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Call) : []);
const fresh = () => mkdtempSync(join(work, 'cache-'));

function fake(options: { name?: string; textFile?: boolean } = {}): CommandRenderer {
  const text = options.textFile ? ['--text-file', '{text_file}'] : ['--text', '{text}'];
  return new CommandRenderer({
    name: options.name ?? 'fake',
    command: [process.execPath, script, '--voice', '{voice}', '--rate', '{rate}', '--lang', '{lang}', '--out', '{out}', ...text],
    cwd: work,
    env: { ...process.env, FAKE_VOICE_LOG: log },
  });
}

const request = (text: string, voice = 'tone', more: Partial<ClipRequest> = {}): ClipRequest => ({ deviceId: 'kitchen', role: 'assistant', slot: 0, slots: 2, voice, text, ...more });

describe('the command line of a voice program', () => {
  it('is cut into arguments at spaces, and quotes keep words together', () => {
    expect(splitCommand('uv run -q tts.py --voice {voice}  --out {out} {text}')).toEqual(['uv', 'run', '-q', 'tts.py', '--voice', '{voice}', '--out', '{out}', '{text}']);
    expect(splitCommand(`"/Applications/My TTS/tts" --model 'big one.onnx' --note "" {out}`)).toEqual(['/Applications/My TTS/tts', '--model', 'big one.onnx', '--note', '', '{out}']);
    expect(() => splitCommand('tts "unclosed {out}')).toThrow(/never closed/);
  });

  it('gets each name in braces filled in inside its argument, so a sentence stays one argument', () => {
    const values = { text: `He said "pay $2,000; now" && left`, text_file: '/tmp/a.txt', voice: 'af_bella', rate: '0.92', lang: '', out: '/tmp/a.wav' };
    expect(fillCommand(['tts', '--voice={voice}', '{rate}', '--lang', '{lang}', '-o', '{out}', '{text}', '{text_file}', '{other}'], values)).toEqual(['tts', '--voice=af_bella', '0.92', '--lang', '', '-o', '/tmp/a.wav', `He said "pay $2,000; now" && left`, '/tmp/a.txt', '{other}']);
  });

  it('must say where to write and what to say', () => {
    expect(commandProblem(['tts', '{out}', '{text}'])).toBeUndefined();
    expect(commandProblem(['tts', '--file', '{text_file}', '{out}'])).toBeUndefined();
    expect(commandProblem(['tts', '{text}'])).toMatch(/no \{out\}/);
    expect(commandProblem(['tts', '{out}'])).toMatch(/neither \{text\} nor \{text_file\}/);
    expect(commandProblem([])).toMatch(/empty/);
  });
});

describe('the recording section of the configuration', () => {
  const base = { servers: { app: { url: 'http://localhost:3000/mcp' } }, devices: [{ id: 'display', servers: ['app'] }] };
  const load = (recording: unknown, devices: unknown[] = base.devices) => resolveConfig({ ...base, devices, recording }, { baseDir: '/stage', env: {} });

  it('is empty unless written: the system voices, and no other spellings', () => {
    expect(resolveConfig(base, { baseDir: '/stage', env: {} }).recording).toEqual({ pronounce: {} });
  });

  it('takes the voice program as one string or as a list, and starts it in the folder of the configuration', () => {
    expect(load({ voices: { command: 'tts --voice {voice} -o {out} {text}', name: 'my-tts' } }).recording.voices).toEqual({ name: 'my-tts', command: ['tts', '--voice', '{voice}', '-o', '{out}', '{text}'], cwd: '/stage' });
    expect(load({ voices: { command: ['/opt/my tts', '{out}', '{text_file}'] } }).recording.voices).toEqual({ name: 'command', command: ['/opt/my tts', '{out}', '{text_file}'], cwd: '/stage' });
  });

  it('keeps the voice name and rate of each device and each person for the program', () => {
    const config = load({ voices: { command: 'tts {voice} {rate} {out} {text}' } }, [{ id: 'kitchen', servers: ['app'], voice: { name: 'af_bella' }, person: { name: 'Margaret', voice: { name: 'bf_emma', rate: 0.92 } } }]);
    expect(config.devices[0]!.voice).toEqual({ name: 'af_bella' });
    expect(config.devices[0]!.person.voice).toEqual({ name: 'bf_emma', rate: 0.92 });
  });

  it('explains a command that cannot work, and an expression that does not compile', () => {
    expect(() => load({ voices: { command: 'tts {text}' } })).toThrow(/recording\.voices\.command cannot render a voice: it has no \{out\}/);
    expect(() => load({ voices: { command: 'tts "{out} {text}' } })).toThrow(/recording\.voices\.command: .*never closed/);
    expect(() => load({ voices: {} })).toThrow(ConfigError);
    expect(() => load({ pronounce: { '/(unclosed/': 'x' } })).toThrow(/recording\.pronounce: The pronounce entry \/\(unclosed\/ is not a valid regular expression/);
    expect(() => load({ voice: { command: 'tts {out} {text}' } })).toThrow(/voice/);
  });

  it('loads the Hold On example cast with Kokoro voices', () => {
    const config = loadConfigFile(join(ROOT, 'examples/holdon/voicestage.kokoro.config.yaml'), {});
    expect(config.recording.voices).toMatchObject({ name: 'kokoro', cwd: join(ROOT, 'examples/holdon') });
    expect(config.recording.voices!.command.slice(0, 4)).toEqual(['uv', 'run', '-q', '../../scripts/tts/kokoro.py']);
    // The program the command names is where the command says it is.
    expect(existsSync(join(config.recording.voices!.cwd, config.recording.voices!.command[3]!))).toBe(true);
    expect(config.devices.map((device) => [device.voice.name, device.person.voice?.name, device.person.voice?.rate])).toEqual([
      ['af_bella', 'bf_emma', 0.92],
      ['am_michael', 'af_sarah', undefined],
    ]);
    // Apart from the voices, it is the same stage as the one recorded with the system voices.
    const plain = loadConfigFile(join(ROOT, 'examples/holdon/voicestage.config.yaml'), {});
    const withoutVoices = (devices: typeof config.devices) => devices.map((device) => ({ ...device, voice: {}, person: { ...device.person, voice: undefined } }));
    expect(withoutVoices(config.devices)).toEqual(withoutVoices(plain.devices));
    for (const scenario of ['a-irs-gift-cards.yaml', 'b-utility-bill.yaml', 'c-contractor-deposit.yaml']) {
      expect(speakersWithoutVoice(config, loadScenarioFile(join(ROOT, 'examples/holdon/scenarios', scenario)))).toEqual([]);
    }
  });
});

describe('another spelling for the voice', () => {
  it('replaces whole words, with their capitals as written, the longest first, and once', () => {
    const rules = compilePronunciations({ IRS: 'I R S', Con: 'Kon', 'Con Edison': 'Con Eddison', I: 'eye', '$182.40': '182 dollars and 40 cents' });
    expect(respell('The IRS called. Firs and IRSA are not the IRS.', rules)).toBe('The I R S called. Firs and IRSA are not the I R S.');
    // "Con Edison" as a whole, not "Con" and then the rest; and the "I" in "I R S" is not respelled again.
    expect(respell('I pay Con Edison, said the IRS. Con!', rules)).toBe('eye pay Con Eddison, said the I R S. Kon!');
    expect(respell("It's $182.40. Not $182.405, not A$182.40.", rules)).toBe("It's 182 dollars and 40 cents. Not $182.405, not A$182.40.");
    expect(respell('the irs', rules)).toBe('the irs');
  });

  it('takes regular expressions between slashes, applied after the plain entries in the order written', () => {
    const rules = compilePronunciations({
      '/\\$([\\d,]+)\\.(\\d\\d)/': '$1 dollars and $2 cents',
      '/\\$([\\d,]+)/': '$1 dollars',
      '/colou?r/i': 'hue',
      'Con Edison': 'the electric company',
    });
    expect(respell('Pay $2,000 today, or $182.40 to Con Edison.', rules)).toBe('Pay 2,000 dollars today, or 182 dollars and 40 cents to the electric company.');
    expect(respell('Color, colour, COLOR.', rules)).toBe('hue, hue, hue.');
    expect(() => compilePronunciations({ '/[/': 'x' })).toThrow(PronounceError);
    expect(() => compilePronunciations({ '/a/z': 'x' })).toThrow(/not a valid regular expression/);
  });

  it('leaves the text alone when there is nothing to respell', () => {
    expect(respell('Nothing has been paid.', compilePronunciations(undefined))).toBe('Nothing has been paid.');
    expect(respell('Nothing has been paid.', undefined)).toBe('Nothing has been paid.');
  });

  it('gives the Hold On example the spellings its Kokoro voices need', () => {
    const rules = compilePronunciations(loadConfigFile(join(ROOT, 'examples/holdon/voicestage.kokoro.config.yaml'), {}).recording.pronounce);
    const spoken = (text: string) => respell(text, rules);
    expect(spoken("He says I'll be arrested unless I pay $2,000 in gift cards today.")).toBe("He says I'll be arrested unless I pay 2,000 dollars in gift cards today.");
    expect(spoken('The $2,000 payment to IRS will not be made.')).toBe('The 2,000 dollar payment to IRS will not be made.');
    expect(spoken("It's $182.40.")).toBe("It's 182 dollars and 40 cents.");
    expect(spoken("I've put the $182.40 payment to Con Edison on hold.")).toBe("I've put the 182 dollar and 40 cent payment to Con Edison on hold.");
    expect(spoken('Greenleaf Roofing wants a $1,500 deposit by check.')).toBe('Greenleaf Roofing wants a 1,500 dollar deposit by check.');
    expect(spoken('Done. $1,500 was paid to Greenleaf Roofing by a check.')).toBe('Done. 1,500 dollars was paid to Greenleaf Roofing by a check.');
    expect(spoken('The number on their official website is 800-829-1040.')).toBe('The number on their official website is 800, 8 2 9, 1 0 4 0.');
    expect(spoken('The confirmation code is SIM-3AD3FB8C.')).toBe('The confirmation code is SIM-, 3, A, D, 3, F, B, 8, C.');
    // Only a code after "SIM-" is spelled out.
    expect(spoken('SIMPLE: BAD CAFE 2026.')).toBe('SIMPLE: BAD CAFE 2026.');
  });
});

describe('sentences rendered by a program', () => {
  it('hands the program the sentence, the voice, the rate and where to write, and measures what comes back', async () => {
    const speech = new Speech({ renderer: fake(), cacheDir: fresh() });
    const text = `He said "pay $2,000; now" && left.`;
    const clip = await speech.render(request(text, 'tone', { rate: 0.92, lang: 'en-GB' }));
    expect(clip).toMatchObject({ voice: 'tone', renderer: 'fake', text });
    expect(clip.spoken).toBeUndefined();
    // 60 ms a character at a rate of 0.92, with the silence around it cut down to a few milliseconds.
    const voiced = (0.06 * text.length) / 0.92;
    expect(clip.ms / 1000).toBeGreaterThan(voiced);
    expect(clip.ms / 1000).toBeLessThan(voiced + 0.06);
    expect(Math.abs(clip.data.length / SAMPLE_RATE - clip.ms / 1000)).toBeLessThan(0.001);
    const asked = calls().find((call) => call.text === text)!;
    expect(asked).toMatchObject({ voice: 'tone', rate: '0.92', lang: 'en-GB', cwd: expect.stringContaining('voicestage-voices-') });
    // One argument, exactly as written: no shell has been at it.
    expect(asked.args).toContain(text);
    expect(await speech.clip(clip.id)).toBe(clip);
  });

  it('gives the sentence in a file when the command asks for {text_file}, and leaves nothing but clips behind', async () => {
    const cacheDir = fresh();
    const speech = new Speech({ renderer: fake({ textFile: true }), cacheDir });
    const clip = await speech.render(request('Nothing has been paid.'));
    expect(clip.ms).toBeGreaterThan(1200);
    const asked = calls().find((call) => call.text === 'Nothing has been paid.')!;
    expect(asked.args.join(' ')).not.toContain('Nothing has been paid.');
    expect(asked.rate).toBe('1');
    expect(asked.lang).toBe('');
    expect(readdirSync(cacheDir).every((name) => /^[0-9a-f]{40}\.wav$/.test(name))).toBe(true);
  });

  it('renders a sentence once, and keeps it for the next take', async () => {
    const cacheDir = fresh();
    const speech = new Speech({ renderer: fake(), cacheDir });
    const [first, again] = await Promise.all([speech.render(request('Sarah has answered.')), speech.render(request('Sarah has answered.'))]);
    expect(again).toBe(first);
    // Two runs of the program: the sentence, and the sentence that sets the voice's loudness.
    expect(calls()).toHaveLength(2);
    const nextTake = await new Speech({ renderer: fake(), cacheDir }).render(request('Sarah has answered.'));
    expect(calls()).toHaveLength(2);
    expect([...nextTake.data]).toEqual([...first.data]);
  });

  it('never mixes the clips of one renderer with those of another', async () => {
    const cacheDir = fresh();
    await new Speech({ renderer: fake({ name: 'one' }), cacheDir }).render(request('There is no rush.'));
    expect(calls()).toHaveLength(2);
    // The same voice name and sentence under another program's name: rendered again.
    await new Speech({ renderer: fake({ name: 'two' }), cacheDir }).render(request('There is no rush.'));
    expect(calls()).toHaveLength(4);
    // And a renderer that calls itself "say" does not find them either.
    const rendered: string[] = [];
    const say: VoiceRenderer = {
      name: 'say',
      cacheKey: new SayRenderer().cacheKey,
      parallel: 4,
      check: async () => undefined,
      voiceFor: async () => ({ id: 'tone', label: 'Tone' }),
      render: async (job: RenderJob) => {
        rendered.push(job.text);
        writeFileSync(job.out, writeWav(Int16Array.from({ length: 4800 }, (_unused, index) => Math.round(Math.sin(index / 5) * 9000))));
      },
    };
    const clip = await new Speech({ renderer: say, cacheDir }).render(request('There is no rush.'));
    expect(rendered).toContain('There is no rush.');
    expect(clip).toMatchObject({ renderer: 'say', voice: 'Tone', ms: 100 });
    expect(calls()).toHaveLength(4);
  });

  it('gives the voice the other spelling, and keeps the text as written for the caption', async () => {
    const speech = new Speech({ renderer: fake(), cacheDir: fresh(), pronounce: compilePronunciations({ IRS: 'I R S', '/\\$([\\d,]+)/': '$1 dollars' }) });
    const clip = await speech.render(request('The IRS wants $2,000.'));
    expect(clip.text).toBe('The IRS wants $2,000.');
    expect(clip.spoken).toBe('The I R S wants 2,000 dollars.');
    expect(calls().map((call) => call.text)).toContain('The I R S wants 2,000 dollars.');
    expect(calls().map((call) => call.text)).not.toContain('The IRS wants $2,000.');
    // The clip lasts as long as what was said, not as long as what was written.
    expect(clip.ms / 1000).toBeGreaterThan(0.06 * 'The I R S wants 2,000 dollars.'.length);
  });

  it('brings every voice to about the same loudness', async () => {
    const speech = new Speech({ renderer: fake(), cacheDir: fresh() });
    const quiet = await speech.render(request('Nothing has been paid.', 'quiet'));
    const loud = await speech.render(request('Nothing has been paid.', 'loud'));
    // The program writes them 18 times apart (about 1,150 and 20,800). The quiet one is raised and the loud one lowered.
    expect(loudness(quiet.data)).toBeGreaterThan(3000);
    expect(loudness(loud.data)).toBeLessThan(9000);
    expect(loudness(loud.data) / loudness(quiet.data)).toBeLessThan(3);
  });

  it('runs no more than two of the program at a time', async () => {
    const speech = new Speech({ renderer: fake(), cacheDir: fresh() });
    await Promise.all(['One.', 'Two.', 'Three.', 'Four.', 'Five.'].map((text) => speech.render(request(text, 'slow'))));
    const runs = calls().filter((call) => call.ended !== undefined);
    expect(runs).toHaveLength(6);
    const most = Math.max(...runs.map((run) => runs.filter((other) => other.started <= run.started && other.ended! > run.started).length));
    expect(most).toBeLessThanOrEqual(2);
  });

  it.skipIf(!hasFfmpeg)('accepts other sample rates, stereo and floating point, and converts them', async () => {
    const speech = new Speech({ renderer: fake(), cacheDir: fresh() });
    const text = 'Nothing has been paid.';
    for (const voice of ['tone24', 'stereo44', 'float24']) {
      const clip = await speech.render(request(text, voice));
      // The same length as the 48 kHz clip of that sentence, within a few milliseconds.
      expect(clip.ms / 1000, voice).toBeGreaterThan(0.06 * text.length - 0.005);
      expect(clip.ms / 1000, voice).toBeLessThan(0.06 * text.length + 0.07);
      expect(Math.abs(clip.data.length / SAMPLE_RATE - clip.ms / 1000), voice).toBeLessThan(0.001);
      expect(loudness(clip.data), voice).toBeGreaterThan(3000);
    }
  });
});

describe('a voice program that lets the recorder down', () => {
  const rejection = async (speech: Speech, clipRequest: ClipRequest): Promise<Error> => {
    const error = await speech.render(clipRequest).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(SpeechError);
    return error as Error;
  };

  it('is not there', async () => {
    const renderer = new CommandRenderer({ name: 'ghost', command: ['voicestage-no-such-program', '{out}', '{text}'], cwd: work });
    const error = await rejection(new Speech({ renderer, cacheDir: fresh() }), request('Hello.'));
    expect(error.message).toMatch(/could not be started: "voicestage-no-such-program" was not found/);
    expect(error.message).toMatch(/recording\.voices\.command/);
  });

  it('stops with an error: the code and its last words are passed on', async () => {
    const error = await rejection(new Speech({ renderer: fake(), cacheDir: fresh() }), request('Hello.', 'broken'));
    expect(error.message).toMatch(/stopped with code 3 while rendering ".+" with the voice broken/);
    expect(error.message).toMatch(/the model file is damaged/);
  });

  it('writes no file', async () => {
    const error = await rejection(new Speech({ renderer: fake(), cacheDir: fresh() }), request('Hello.', 'nothing'));
    expect(error.message).toMatch(/"fake" finished without writing any audio for ".+" with the voice nothing/);
  });

  it('writes silence', async () => {
    const error = await rejection(new Speech({ renderer: fake(), cacheDir: fresh() }), request('Hello.', 'silent'));
    expect(error.message).toMatch(/"fake" rendered "Hello\." with the voice silent as silence/);
  });

  it.skipIf(!hasFfmpeg)('writes something that is not audio', async () => {
    const cacheDir = fresh();
    const error = await rejection(new Speech({ renderer: fake(), cacheDir }), request('Hello.', 'garbage'));
    expect(error.message).toMatch(/What "fake" wrote for ".+" with the voice garbage could not be read as audio/);
    // Nothing of it is kept as a clip, so the next take asks the program again.
    expect(readdirSync(cacheDir).filter((name) => /^[0-9a-f]{40}\.wav$/.test(name))).toEqual([]);
  });

  it('is asked for a speaker who has no voice name', async () => {
    const speech = new Speech({ renderer: fake(), cacheDir: fresh() });
    expect((await rejection(speech, request('Hello.', '', { voice: undefined }))).message).toMatch(/No voice is set for the device "kitchen".*set voice\.name/);
    expect((await rejection(speech, request('Hello.', '', { voice: undefined, role: 'person' }))).message).toMatch(/No voice is set for the person at the device "kitchen".*set person\.voice\.name/);
    expect(calls()).toEqual([]);
  });
});

describe('before a recording starts', () => {
  const stage = (recording: unknown, voices: { kitchen?: string; margaret?: string; phone?: string; sarah?: string } = {}) =>
    resolveConfig(
      {
        servers: { app: { url: 'http://localhost:3000/mcp' } },
        devices: [
          { id: 'kitchen', name: 'Kitchen display', servers: ['app'], voice: { name: voices.kitchen }, person: { name: 'Margaret', voice: { name: voices.margaret } } },
          { id: 'phone', name: "Sarah's phone", kind: 'phone', servers: ['app'], voice: { name: voices.phone }, person: { name: 'Sarah', voice: { name: voices.sarah } } },
        ],
        recording,
      },
      { baseDir: '/stage', env: {} },
    );
  const command = { voices: { command: 'tts {voice} {out} {text}', name: 'my-tts' } };
  // In the first Hold On scenario Margaret and Sarah both speak; in the second Sarah only presses a button.
  const bothSpeak = loadScenarioFile(join(ROOT, 'examples/holdon/scenarios/a-irs-gift-cards.yaml'));
  const sarahIsSilent = loadScenarioFile(join(ROOT, 'examples/holdon/scenarios/b-utility-bill.yaml'));

  it('names every speaker a program has no voice for: each device, and each person with a line', () => {
    expect(speakersWithoutVoice(stage(command), bothSpeak)).toEqual([
      'Kitchen display ("kitchen"): set voice.name',
      'Margaret, at "kitchen": set person.voice.name',
      'Sarah\'s phone ("phone"): set voice.name',
      'Sarah, at "phone": set person.voice.name',
    ]);
    expect(speakersWithoutVoice(stage(command, { kitchen: 'a', margaret: 'b', phone: 'c' }), bothSpeak)).toEqual(['Sarah, at "phone": set person.voice.name']);
    expect(speakersWithoutVoice(stage(command, { kitchen: 'a', margaret: 'b', phone: 'c' }), sarahIsSilent)).toEqual([]);
    // The system voices are chosen from a list; nobody has to be named.
    expect(speakersWithoutVoice(stage(undefined), bothSpeak)).toEqual([]);
  });

  it('uses "say" unless the configuration names a program, and needs macOS only for "say"', () => {
    expect(createRenderer(stage(undefined).recording)).toBeInstanceOf(SayRenderer);
    const renderer = createRenderer(stage(command).recording);
    expect(renderer).toBeInstanceOf(CommandRenderer);
    expect(renderer.name).toBe('my-tts');
    expect((renderer as CommandRenderer).commandLine).toBe('tts {voice} {out} {text}');
    expect(renderer.cacheKey).not.toEqual(new SayRenderer().cacheKey);

    expect(platformProblem('darwin', stage(undefined).recording)).toBeUndefined();
    expect(platformProblem('linux', stage(command).recording)).toBeUndefined();
    const problem = platformProblem('linux', stage(undefined).recording)!;
    expect(problem).toMatch(/macOS "say" command, and this is linux/);
    expect(problem).toMatch(/recording\.voices\.command/);
    expect(problem).toMatch(/not been tried outside macOS/);
  });
});

describe('the timeline of a recording made with a voice program', () => {
  it('says which program and which voice produced each line, and what the voice was given', () => {
    const origin = 5_000_000;
    const sentence = (at: number, text: string, clip: string, lineId: number, index: number, role: 'assistant' | 'person'): RecordingMark => ({ type: 'sentence', at: origin + at, ms: 1000, clip, deviceId: 'kitchen', role, text, line: `line ${lineId}`, lineId, index, of: 2 });
    const { items } = buildTimeline({
      origin,
      duration: 10,
      devices: [{ id: 'kitchen', name: 'Kitchen display', kind: 'display', person: 'Margaret' }],
      marks: [sentence(1000, 'My bill came.', 'm1', 1, 0, 'person'), sentence(2200, "It's $182.40.", 'm2', 1, 1, 'person'), sentence(4000, 'It is on hold.', 'k1', 2, 0, 'assistant')],
      stageEvents: [],
      presses: [],
      clips: new Map([
        ['m1', { voice: 'bf_emma', renderer: 'kokoro' }],
        ['m2', { voice: 'bf_emma', renderer: 'kokoro', spoken: "It's 182 dollars and 40 cents." }],
        ['k1', { voice: 'af_bella', renderer: 'kokoro' }],
      ]),
    });
    expect(items.map((item) => item.kind === 'utterance' && [item.who, item.renderer, item.voice])).toEqual([
      ['Margaret', 'kokoro', 'bf_emma'],
      ['Kitchen display', 'kokoro', 'af_bella'],
    ]);
    const margaret = items[0]!;
    expect(margaret.kind === 'utterance' && margaret.sentences).toEqual([
      { start: 1, end: 2, text: 'My bill came.', caption: true, clip: 'm1' },
      { start: 2.2, end: 3.2, text: "It's $182.40.", caption: false, clip: 'm2', spoken: "It's 182 dollars and 40 cents." },
    ]);
  });
});
