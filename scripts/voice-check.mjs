#!/usr/bin/env node
/**
 * Voice, checked for real: speech synthesis and speech recognition in a visible
 * Google Chrome window, driven by this script, against the built app.
 *
 *   npm run build && npm run voice:check
 *   node scripts/voice-check.mjs --only speech          # or: recognition, failures
 *   node scripts/voice-check.mjs --chrome "/path/to/Google Chrome"
 *
 * It makes sound (the assistant voices are played through the speakers) and
 * opens browser windows. It needs the installed Google Chrome, not a bundled
 * Chromium: Chromium has no key for the recognition service and fewer voices.
 *
 * How it tests without a person:
 *
 *   Speech out   A script injected before the app loads wraps
 *                `speechSynthesis.speak` and records every utterance's start,
 *                end and error, and every caption change, with timestamps. It
 *                reports through `console.log` only, because any call puppeteer
 *                makes into the page counts as a user gesture, and Chrome's
 *                refusal to speak before a gesture is one of the things checked.
 *
 *   Speech in    macOS `say` speaks the lines of the example scenarios into WAV
 *                files. In the page, `SpeechRecognition.start()` is given an
 *                audio track that plays such a file, instead of the microphone.
 *                Everything after the microphone is real: Chrome's recogniser,
 *                the recognition service, and the app. (Chrome's own
 *                `--use-file-for-fake-audio-capture` did not reach the
 *                recogniser when this was written, and a Chrome started by a
 *                script may be given silence by the operating system.)
 *
 * Chrome is started without puppeteer's default flags, which among other things
 * switch off background-tab throttling and would hide real behaviour.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import puppeteer from 'puppeteer-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values: flags } = parseArgs({ options: { chrome: { type: 'string' }, only: { type: 'string' }, config: { type: 'string' }, verbose: { type: 'boolean', default: false } } });
const CHROME = [flags.chrome, process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/opt/google/chrome/chrome'].find((path) => path && existsSync(path));
const only = flags.only ? new Set(flags.only.split(',')) : undefined;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// --- report -----------------------------------------------------------------------

const results = [];
function report(status, name, detail = '') {
  results.push({ status, name, detail });
  const mark = { PASS: '\u001b[32mPASS\u001b[0m', FAIL: '\u001b[31mFAIL\u001b[0m', INFO: '\u001b[36mINFO\u001b[0m', SKIP: '\u001b[33mSKIP\u001b[0m' }[status];
  console.log(`  ${mark}  ${name}${detail ? `\n        ${detail.replace(/\n/g, '\n        ')}` : ''}`);
}
const check = (ok, name, detail) => report(ok ? 'PASS' : 'FAIL', name, detail);

// --- the stage, in this process -------------------------------------------------------

async function startStage() {
  if (!existsSync(join(root, 'dist', 'cli.js')) || !existsSync(join(root, 'dist', 'ui', 'index.html'))) throw new Error('Build first: npm run build');
  const { loadConfigFile } = await import('../dist/core/config.js');
  const { Stage } = await import('../dist/core/stage.js');
  const { createStageApp, listen } = await import('../dist/server/app.js');
  const config = loadConfigFile(flags.config ?? join(root, 'voicestage.config.yaml'), {});
  const stage = new Stage(config, { env: {}, provider: 'scripted' });
  const running = await listen(createStageApp({ stage, uiDir: join(root, 'dist', 'ui') }), { port: 0 });
  await stage.start();
  const post = async (path, body = {}) => (await fetch(running.url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  const state = async () => (await fetch(`${running.url}/api/state`)).json();
  const until = async (what, test, ms = 60_000) => {
    const end = Date.now() + ms;
    for (;;) {
      const snapshot = await state();
      if (test(snapshot)) return snapshot;
      if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
      await sleep(150);
    }
  };
  return { url: running.url, origin: new URL(running.url).origin, post, state, until, close: async () => (await stage.close(), await running.close()) };
}

// --- Chrome ----------------------------------------------------------------------------

/** Runs in the page before the app: records speech synthesis and captions. Reports with console.log only. */
function instrument() {
  const synth = window.speechSynthesis;
  const send = (entry) => console.log('VOICELOG ' + JSON.stringify({ t: Math.round(performance.now()), hidden: document.hidden, ...entry }));
  if (window.top !== window) return;
  if (synth) {
    const speak = synth.speak.bind(synth);
    const cancel = synth.cancel.bind(synth);
    let count = 0;
    synth.speak = (utterance) => {
      const id = ++count;
      let boundaries = 0;
      send({ ev: 'speak', id, text: utterance.text, voice: utterance.voice ? utterance.voice.name : null, local: utterance.voice ? utterance.voice.localService : null, lang: utterance.lang, speakingBefore: synth.speaking, activated: navigator.userActivation ? navigator.userActivation.hasBeenActive : null });
      utterance.addEventListener('start', () => send({ ev: 'start', id }));
      utterance.addEventListener('boundary', () => (boundaries += 1));
      utterance.addEventListener('end', (event) => send({ ev: 'end', id, elapsed: Math.round(event.elapsedTime), boundaries }));
      utterance.addEventListener('error', (event) => send({ ev: 'error', id, error: event.error }));
      return speak(utterance);
    };
    synth.cancel = () => (send({ ev: 'cancel' }), cancel());
  }
  const last = new Map();
  const scan = () => {
    document.querySelectorAll('.device').forEach((device) => {
      const name = (device.getAttribute('aria-label') || '').split(',')[0];
      const assistant = device.querySelector('.captions__assistant');
      const user = device.querySelector('.captions__user');
      const now = JSON.stringify({ assistant: assistant ? assistant.textContent : null, speaking: assistant ? assistant.classList.contains('is-speaking') : false, user: user ? user.textContent : null, userState: user ? user.className.replace('captions__user captions__user--', '') : null });
      if (last.get(name) !== now) (last.set(name, now), send({ ev: 'caption', device: name, ...JSON.parse(now) }));
    });
  };
  const boot = () => (new MutationObserver(scan).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class'] }), scan());
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}

/**
 * Runs in the page before the app: stands in for the microphone. Recognition
 * (and the app's level meter) get an audio track that carries faint noise, as
 * an open microphone does, plus whatever WAV the test queues in `__micQueue`.
 */
function substituteMicrophone() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition || window.top !== window) return;
  let shared;
  const line = () => {
    if (shared) return shared;
    const context = new AudioContext();
    const out = context.createMediaStreamDestination();
    const noise = context.createBufferSource();
    const buffer = context.createBuffer(1, context.sampleRate, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let index = 0; index < data.length; index += 1) data[index] = (Math.random() * 2 - 1) * 0.0005;
    noise.buffer = buffer;
    noise.loop = true;
    noise.connect(out);
    noise.start();
    shared = { context, out };
    return shared;
  };
  const play = async (base64) => {
    const { context, out } = line();
    await context.resume();
    const audio = await context.decodeAudioData(Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)).buffer);
    const source = context.createBufferSource();
    source.buffer = audio;
    source.connect(out);
    source.start(context.currentTime + 0.5);
  };
  const start = Recognition.prototype.start;
  Recognition.prototype.start = function (track) {
    if (track) return start.call(this, track);
    const { context, out } = line();
    void context.resume();
    const queued = window.__micQueue;
    window.__micQueue = null;
    if (queued) void play(queued);
    return start.call(this, out.stream.getAudioTracks()[0]);
  };
  const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = (constraints) => (constraints && constraints.audio ? Promise.resolve(line().out.stream.clone()) : getUserMedia(constraints));
}

async function openChrome(url, { args = [], microphone = 'substitute', permission } = {}) {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: false,
    defaultViewport: null,
    // None of puppeteer's automation defaults: a person's Chrome has none of them.
    ignoreDefaultArgs: true,
    args: ['--no-first-run', '--no-default-browser-check', '--window-size=1500,950', ...args, 'about:blank'],
  });
  const page = (await browser.pages())[0] ?? (await browser.newPage());
  const log = [];
  page.on('console', (message) => {
    const text = message.text();
    if (text.startsWith('VOICELOG ')) log.push(JSON.parse(text.slice(9)));
  });
  page.on('pageerror', (error) => report('FAIL', 'page error', error.message));
  if (permission) await (await page.createCDPSession()).send('Browser.setPermission', { origin: new URL(url).origin, permission: { name: 'microphone' }, setting: permission });
  await page.evaluateOnNewDocument(instrument);
  if (microphone === 'substitute') await page.evaluateOnNewDocument(substituteMicrophone);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return { browser, page, log };
}

const speech = (log) => log.filter((entry) => entry.ev !== 'caption');
const describe = (entries) =>
  entries
    .map((entry) => (entry.ev === 'speak' ? `${entry.t} speak #${entry.id} [${entry.voice}] "${entry.text}"` : entry.ev === 'caption' ? `${entry.t} caption ${entry.device}: ${entry.speaking ? 'speaking' : 'shown'} ${JSON.stringify(entry.assistant)} / user ${JSON.stringify(entry.user)} (${entry.userState})` : `${entry.t} ${entry.ev}${entry.id ? ` #${entry.id}` : ''}${entry.error ? ` ${entry.error}` : ''}${entry.elapsed !== undefined ? ` after ${entry.elapsed} ms, ${entry.boundaries} word boundaries` : ''}`))
    .join('\n');
const noticeText = (page, kind) => page.evaluate((selector) => document.querySelector(selector)?.textContent ?? null, `.notice-line--${kind} span`);

// --- speech out ----------------------------------------------------------------------------

async function checkSpeech(stage) {
  console.log('\nSpeech out (speechSynthesis)');
  await stage.post('/api/reset');
  const { browser, page, log } = await openChrome(stage.url);
  try {
    await sleep(2500);

    // 1. Before any click or key press. Nothing has been evaluated in the page yet, so it has no user activation.
    let mark = log.length;
    await stage.post('/api/devices/display/say', { text: 'How do I make pancakes?' });
    await stage.until('the reply to be shown', (snapshot) => snapshot.devices[0].status === 'idle' && snapshot.devices[0].transcript.length >= 2);
    await sleep(600);
    const before = log.slice(mark);
    const refused = before.find((entry) => entry.ev === 'error');
    const firstSpeak = before.find((entry) => entry.ev === 'speak');
    report('INFO', 'before any click, Chrome answers speak() with', refused ? `error "${refused.error}" (user activation: ${firstSpeak?.activated})` : before.some((entry) => entry.ev === 'start') ? 'speech (this page already had a user gesture)' : 'nothing');
    const captions = before.filter((entry) => entry.ev === 'caption' && entry.assistant);
    check(captions.some((entry) => entry.speaking) && captions.at(-1)?.speaking === false, 'without sound, each line is still shown for as long as it would take to say', `${captions.length} caption changes over ${captions.length ? captions.at(-1).t - captions[0].t : 0} ms`);
    const waiting = await noticeText(page, 'sound');
    if (refused) check(Boolean(waiting && /click/i.test(waiting)), 'the page says that sound is waiting for a click', waiting ?? 'no notice was shown');

    // 2. A real click, then the same request.
    await page.mouse.click(70, 30); // on the product name: a click that does nothing else
    await sleep(200);
    check((await noticeText(page, 'sound')) === null, 'the notice goes away after a click');
    const voices = await page.evaluate(() => speechSynthesis.getVoices().map((voice) => ({ name: voice.name, lang: voice.lang, local: voice.localService, default: voice.default })));
    const english = voices.filter((voice) => voice.lang.toLowerCase().startsWith('en'));
    check(english.length > 0, `Chrome offers ${voices.length} voices, ${english.length} of them English (${english.filter((voice) => voice.local).length} on this computer)`, `system default: ${voices.find((voice) => voice.default)?.name ?? 'none'} (${voices.find((voice) => voice.default)?.lang ?? '-'})`);
    mark = log.length;
    await stage.post('/api/devices/display/say', { text: 'How do I make pancakes?' });
    await stage.until('the reply to be spoken', (snapshot) => snapshot.devices[0].status === 'idle' && snapshot.devices[0].transcript.length >= 4, 30_000);
    await sleep(500);
    const spoken = log.slice(mark);
    const speaks = spoken.filter((entry) => entry.ev === 'speak');
    const ended = speaks.filter((entry) => spoken.some((other) => other.ev === 'start' && other.id === entry.id) && spoken.some((other) => other.ev === 'end' && other.id === entry.id));
    check(speaks.length > 0 && ended.length === speaks.length, `after a click the reply is spoken: ${speaks.length} utterances, each with "start" and "end"`, flags.verbose ? describe(spoken) : speaks.map((entry) => `[${entry.voice}] "${entry.text}"`).join('\n'));
    report('INFO', 'voice chosen for the first device', `${speaks[0]?.voice} (${speaks[0]?.lang}, ${speaks[0]?.local ? 'runs on this computer' : 'needs the network'})`);
    const boundaries = spoken.filter((entry) => entry.ev === 'end').reduce((sum, entry) => sum + entry.boundaries, 0);
    report('INFO', 'word boundary events while speaking', `${boundaries} (the synthesiser reports these as it goes; they are the closest a script gets to hearing it)`);

    // 3. A played scenario: people's lines and the assistant's, a question, an announcement.
    await stage.post('/api/reset');
    await sleep(400);
    mark = log.length;
    await page.click('button.primary');
    const done = await stage.until('the scenario to finish', (snapshot) => snapshot.run && snapshot.run.status !== 'running', 120_000);
    await sleep(800);
    const played = log.slice(mark);
    const utterances = played.filter((entry) => entry.ev === 'speak');
    check(done.run.status === 'passed', `the scenario "${done.run.scenario.name}" plays to the end with sound on`, done.run.steps.map((step) => `${step.status} ${step.label}`).join('\n'));
    check(utterances.length > 0 && utterances.every((entry) => entry.speakingBefore === false), `no utterance starts while another is still being spoken (${utterances.length} utterances)`);
    const failed = played.filter((entry) => entry.ev === 'error');
    check(failed.length === 0 && utterances.every((entry) => played.some((other) => other.ev === 'end' && other.id === entry.id)), 'every utterance ends normally, none is cut off', failed.map((entry) => `#${entry.id} ${entry.error}`).join(', '));
    // Captions against audio: the caption with a sentence must appear when its utterance starts, and stop being "live" when the line ends.
    const assistantLines = utterances.filter((entry) => played.some((caption) => caption.ev === 'caption' && caption.assistant === entry.text));
    const drift = assistantLines.map((entry) => Math.abs((played.find((caption) => caption.ev === 'caption' && caption.assistant === entry.text && caption.speaking)?.t ?? Infinity) - entry.t));
    check(assistantLines.length > 0 && Math.max(...drift) <= 60, `captions change with the audio: at most ${Math.max(...drift)} ms between a caption and its utterance (${assistantLines.length} sentences)`);
    const personVoices = new Set(utterances.filter((entry) => !assistantLines.includes(entry)).map((entry) => entry.voice));
    const deviceVoices = new Set(assistantLines.map((entry) => entry.voice));
    check(personVoices.size > 0 && [...personVoices].every((name) => !deviceVoices.has(name)), `people and devices have different voices`, `devices: ${[...deviceVoices].join(', ')}; people: ${[...personVoices].join(', ')}`);
    check(utterances.some((entry) => /three seconds/i.test(entry.text)), "the person's answer to the server's question is spoken too");
    check(utterances.every((entry) => entry.local !== false), 'every voice used runs on this computer (no network round trip per line)');

    // 4. The tab goes to the background in the middle of a scenario.
    await stage.post('/api/reset');
    await sleep(400);
    mark = log.length;
    await page.click('button.primary');
    await sleep(3500);
    const other = await browser.newPage();
    await other.goto('about:blank');
    const hidden = await stage.until('the scenario to finish in the background', (snapshot) => snapshot.run && snapshot.run.status !== 'running', 120_000);
    const background = log.slice(mark).filter((entry) => entry.ev === 'speak' && entry.hidden);
    const backgroundEnded = background.filter((entry) => log.some((later) => later.ev === 'end' && later.id === entry.id));
    check(hidden.run.status === 'passed' && background.length > 0 && backgroundEnded.length === background.length, `with the tab in the background the scenario still finishes: ${background.length} utterances started and ended while hidden`);
    await other.close();
    await page.bringToFront();

    // 5. The person talks over the device.
    await stage.post('/api/reset');
    await sleep(400);
    mark = log.length;
    await page.type('.device--display .dock__talk input', 'How do I make pancakes?');
    await page.keyboard.press('Enter');
    await sleep(2400);
    await page.type('.device--display .dock__talk input', 'How do I make pancakes?');
    await page.keyboard.press('Enter');
    await stage.until('the second reply', (snapshot) => snapshot.devices[0].status === 'idle' && snapshot.devices[0].transcript.length >= 4, 30_000);
    await sleep(500);
    const interrupted = speech(log.slice(mark));
    const cancelAt = interrupted.findIndex((entry) => entry.ev === 'cancel');
    const after = interrupted.slice(cancelAt + 1).filter((entry) => entry.ev === 'speak');
    check(cancelAt >= 0 && after.length > 0 && after.every((entry) => interrupted.some((other) => other.ev === 'end' && other.id === entry.id)), 'typing a new request stops the device mid-sentence, and the new reply is spoken in full', flags.verbose ? describe(interrupted) : '');
  } finally {
    await browser.close();
  }
}

// --- speech in -----------------------------------------------------------------------------

const AUDIO = join(tmpdir(), 'voicestage-voice-check');

/** Speak a line with the macOS `say` command into a WAV file, and return it as base64. */
function wav(name, text, voiceName = 'Samantha') {
  mkdirSync(AUDIO, { recursive: true });
  const aiff = join(AUDIO, `${name}.aiff`);
  const file = join(AUDIO, `${name}.wav`);
  if (!existsSync(file)) {
    execFileSync('say', ['-v', voiceName, '-r', '165', '-o', aiff, text]);
    execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@48000', '-c', '1', aiff, file]);
  }
  return readFileSync(file).toString('base64');
}

const canSpeakFiles = () => {
  try {
    execFileSync('which', ['say', 'afconvert'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

async function sayIntoMic(page, base64, button = '.device--display .mic') {
  await page.evaluate((audio) => (window.__micQueue = audio), base64);
  await page.click(button);
}

async function checkRecognition(stage) {
  console.log('\nSpeech in (SpeechRecognition), microphone replaced by spoken WAV files');
  if (!canSpeakFiles()) return report('SKIP', 'recognition', 'needs the macOS "say" and "afconvert" commands to make the spoken lines');
  await stage.post('/api/reset');
  const { browser, page, log } = await openChrome(stage.url, { permission: 'granted' });
  try {
    await page.waitForSelector('.device--display .mic');
    const heard = async (deviceIndex, count) => (await stage.until('the request to be heard', (snapshot) => snapshot.devices[deviceIndex].timeline.filter((entry) => entry.kind === 'utterance' && entry.source === 'voice').length >= count, 25_000)).devices[deviceIndex].timeline.filter((entry) => entry.kind === 'utterance' && entry.source === 'voice').at(-1).text;
    const tools = (snapshot, deviceIndex) => snapshot.devices[deviceIndex].timeline.filter((entry) => entry.kind === 'tool').map((entry) => entry.name);

    // One short request, by tapping the microphone button.
    await sayIntoMic(page, wav('pancakes', 'How do I make pancakes?'));
    let text = await heard(0, 1);
    let snapshot = await stage.until('the recipe', (current) => tools(current, 0).includes('find_recipe'), 15_000).catch(() => stage.state());
    check(/pancake/i.test(text) && tools(snapshot, 0).includes('find_recipe'), 'a spoken request is recognised and answered', `said "How do I make pancakes?", heard "${text}", tools called: ${tools(snapshot, 0).join(', ') || 'none'}`);
    await stage.until('the device to finish', (current) => current.devices[0].status === 'idle', 20_000);

    // A request with a pause in it. In Chrome's single-phrase mode only the last phrase comes back.
    await sayIntoMic(page, wav('two-sentences', 'I am hungry. How do I make pancakes?', 'Daniel'));
    text = await heard(0, 2);
    check(/hungry/i.test(text) && /pancake/i.test(text), 'a request of two sentences arrives whole, not just its last phrase', `heard "${text}"`);
    await stage.until('the device to finish', (current) => current.devices[0].status === 'idle', 20_000);

    // A question from the server, answered by voice.
    await sayIntoMic(page, wav('timer', 'Set a timer for the pancakes.', 'Daniel'));
    await stage.until('the server to ask how long', (current) => Boolean(current.devices[0].elicitation), 25_000);
    await sleep(600);
    await sayIntoMic(page, wav('three-seconds', 'Three seconds.'));
    snapshot = await stage.until('the timer to start', (current) => current.devices[0].timeline.some((entry) => entry.kind === 'tool' && entry.name === 'start_timer' && entry.status === 'ok'), 25_000);
    const answer = snapshot.devices[0].timeline.find((entry) => entry.kind === 'elicitation');
    check(answer.status === 'accept' && answer.answeredBy === 'voice' && answer.content.duration === '3', "a server's question (form elicitation) is answered by voice", `heard "${answer.heard}", returned ${JSON.stringify(answer.content)}`);
    await stage.until('the device to finish', (current) => current.devices[0].status === 'idle', 20_000);

    // Wake word: hands-free, on the phone.
    await stage.post('/api/reset');
    await sleep(300);
    await page.evaluate((audio) => (window.__micQueue = audio), wav('wake', 'Computer, how do I make tomato soup?'));
    await page.click('.device--phone .dock__talk .ghost');
    text = await heard(1, 1).catch(() => '');
    snapshot = await stage.state();
    check(/tomato soup/i.test(text) && !/computer/i.test(text) && tools(snapshot, 1).includes('find_recipe'), 'with the wake word on, a request that starts with it is taken, without the word itself', `said "Computer, how do I make tomato soup?", heard "${text}"`);
    await page.click('.device--phone .dock__talk .ghost');

    // Silence: the microphone is open, nobody speaks.
    await stage.post('/api/reset');
    await sleep(300);
    const mark = log.length;
    await page.click('.device--display .mic');
    await sleep(1200);
    const listening = await page.evaluate(() => document.querySelector('.device--display .captions__user')?.textContent ?? '');
    await page.waitForFunction(() => /didn.t hear anything/i.test(document.querySelector('.device--display .captions')?.textContent ?? ''), { timeout: 15_000 }).catch(() => undefined);
    const missed = await page.evaluate(() => document.querySelector('.device--display .captions')?.textContent ?? '');
    const waited = log.slice(mark).filter((entry) => entry.ev === 'caption' && entry.device === 'Kitchen display');
    check(/listening/i.test(listening) && /didn.t hear anything/i.test(missed) && (await noticeText(page, 'mic')) === null, 'on silence the device says it heard nothing, and stops listening', `caption while open: "${listening}"; after ${waited.length ? Math.round((waited.at(-1).t - waited[0].t) / 100) / 10 : '?'} s: "${missed}"`);
  } finally {
    await browser.close();
  }
}

// --- when the microphone cannot be used ---------------------------------------------------------

async function typedStillWorks(stage, page) {
  await stage.post('/api/reset');
  await sleep(300);
  await page.type('.device--display .dock__talk input', 'How do I make pancakes?');
  await page.keyboard.press('Enter');
  const snapshot = await stage.until('the typed request to be answered', (current) => current.devices[0].timeline.some((entry) => entry.kind === 'tool' && entry.name === 'find_recipe'), 15_000).catch(() => undefined);
  return Boolean(snapshot);
}

async function checkFailures(stage) {
  console.log('\nWhen the microphone cannot be used');

  // The site is denied the microphone.
  {
    const { browser, page } = await openChrome(stage.url, { microphone: 'real', permission: 'denied' });
    try {
      await page.waitForSelector('.device--display .mic');
      await sleep(600);
      const upFront = await noticeText(page, 'mic');
      check(Boolean(upFront && /blocking the microphone/i.test(upFront)), 'a blocked microphone is explained as soon as the page opens', upFront ?? 'no notice');
      await page.click('.device--display .mic');
      await sleep(1000);
      const after = await noticeText(page, 'mic');
      const stillListening = await page.evaluate(() => document.querySelector('.device--display .mic')?.getAttribute('aria-pressed'));
      check(Boolean(after && /blocking the microphone/i.test(after)) && stillListening === 'false', 'pressing the microphone button then leaves the explanation up and does not pretend to listen', `Chrome reported "not-allowed"; notice: ${after}`);
      check(await typedStillWorks(stage, page), 'typing still works with the microphone blocked');
    } finally {
      await browser.close();
    }
  }

  // The recognition service cannot be reached: every host name but localhost fails to resolve.
  if (canSpeakFiles()) {
    const { browser, page } = await openChrome(stage.url, { permission: 'granted', args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost'] });
    try {
      await page.waitForSelector('.device--display .mic');
      await sayIntoMic(page, wav('pancakes', 'How do I make pancakes?'));
      await sleep(2500);
      const notice = await noticeText(page, 'mic');
      check(Boolean(notice && /could not reach its online service/i.test(notice)), 'an unreachable recognition service is explained', `Chrome reported "network"; notice: ${notice ?? 'none'}`);
      check(await typedStillWorks(stage, page), 'typing still works with the recognition service unreachable');
    } finally {
      await browser.close();
    }
  }

  // The real microphone, as this process gets it.
  {
    const { browser, page } = await openChrome(stage.url, { microphone: 'real', permission: 'granted', args: ['--use-fake-ui-for-media-stream'] });
    try {
      await page.waitForSelector('.device--display .mic');
      await page.click('.device--display .mic');
      await sleep(4200);
      const notice = await noticeText(page, 'mic');
      if (notice && /pure silence/i.test(notice)) {
        report('PASS', 'a microphone that delivers only silence is explained', `the operating system gave this Chrome samples that were all zero (on macOS this happens when the program that started Chrome may not use the microphone); notice: ${notice}`);
      } else {
        report('INFO', 'the real microphone delivers sound to this Chrome', notice ? `notice: ${notice}` : 'no problem reported; speak into it to try recognition by hand');
      }
      await page.click('.device--display .mic').catch(() => undefined);
    } finally {
      await browser.close();
    }
  }
}

// --- run -------------------------------------------------------------------------------------------

if (!CHROME) {
  console.error('Google Chrome was not found. Pass --chrome <path> or set CHROME_PATH.');
  process.exit(2);
}
console.log(`Voice check with ${execFileSync(CHROME, ['--version']).toString().trim()}`);
const stage = await startStage();
try {
  if (!only || only.has('speech')) await checkSpeech(stage);
  if (!only || only.has('recognition')) await checkRecognition(stage);
  if (!only || only.has('failures')) await checkFailures(stage);
} catch (error) {
  report('FAIL', 'the check itself stopped', error instanceof Error ? (error.stack ?? error.message) : String(error));
} finally {
  await stage.close().catch(() => undefined);
}
const count = (status) => results.filter((result) => result.status === status).length;
console.log(`\n${count('PASS')} passed, ${count('FAIL')} failed, ${count('INFO')} notes, ${count('SKIP')} skipped`);
process.exit(count('FAIL') > 0 ? 1 : 0);
