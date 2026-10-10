/**
 * Choosing speech synthesis voices, and explaining microphone problems.
 *
 * Browsers hand a page whatever voices the operating system has. On a Mac that
 * is about forty English ones, most of them unusable for an assistant: novelty
 * voices ("Bad News", "Bells", "Zarvox"), and a system default that follows the
 * system language rather than the page (a Korean Mac defaults to a Korean
 * voice). So the choice is made here, by name, with rules that can be tested:
 *
 *   1. only voices for the wanted language
 *   2. voices that run on the device before voices that need the network
 *   3. known clear voices, in a fixed order, before unknown ones
 *   4. novelty voices never, unless asked for by name
 *
 * Each device on the stage gets a different voice, and the person at a device
 * gets one that no assistant uses, so a played scenario is easy to follow by ear.
 */

export interface VoiceInfo {
  name: string;
  lang: string;
  /** True when the voice is synthesised on the device. Remote voices need a network round trip per utterance. */
  localService: boolean;
  default?: boolean;
}

/** Voices that read clearly at a normal pace. Order is preference for an assistant. */
const CLEAR_VOICES = [
  // macOS and iOS
  'Ava', 'Samantha', 'Allison', 'Zoe', 'Susan', 'Joelle', 'Noelle', 'Evan', 'Nathan', 'Tom', 'Daniel', 'Kate', 'Serena', 'Oliver', 'Karen', 'Lee', 'Matilda', 'Moira', 'Tessa', 'Fiona', 'Stephanie', 'Jamie', 'Rishi', 'Veena', 'Isha',
  // Windows
  'Microsoft Aria', 'Microsoft Jenny', 'Microsoft Guy', 'Microsoft Zira', 'Microsoft David', 'Microsoft Mark', 'Microsoft Sonia', 'Microsoft Ryan',
  // Chrome's own, synthesised remotely
  'Google US English', 'Google UK English Female', 'Google UK English Male',
];

/** A person at a device should not sound like the device: prefer another accent first. */
const PERSON_ORDER = ['Moira', 'Tessa', 'Karen', 'Daniel', 'Kate', 'Serena', 'Fiona', 'Rishi', 'Lee', 'Matilda', 'Oliver', 'Microsoft Sonia', 'Microsoft Ryan', 'Google UK English Female', 'Google UK English Male'];

/**
 * Voices that exist for fun or for accessibility testing, and the synthetic
 * "Eloquence" family. Fine when someone picks one by name; wrong as a default.
 */
const NOVELTY = new Set([
  'albert', 'bad news', 'bahh', 'bells', 'boing', 'bubbles', 'cellos', 'wobble', 'deranged', 'good news', 'hysterical', 'jester', 'junior', 'kathy', 'organ', 'pipe organ', 'superstar', 'ralph', 'fred', 'trinoids', 'whisper', 'zarvox',
  'eddy', 'flo', 'grandma', 'grandpa', 'reed', 'rocko', 'sandy', 'shelley',
]);

/** "Samantha (Enhanced)" and "Eddy (English (UK))" are the voices "Samantha" and "Eddy". */
export function voiceBaseName(name: string): string {
  return name.replace(/\s*[(（].*$/, '').trim();
}

export function isNoveltyVoice(name: string): boolean {
  return NOVELTY.has(voiceBaseName(name).toLowerCase());
}

function matchesLanguage(voice: VoiceInfo, lang: string): boolean {
  return voice.lang.toLowerCase().replace('_', '-').startsWith(lang.toLowerCase().slice(0, 2));
}

function rank(voice: VoiceInfo, order: string[], lang: string): number {
  const base = voiceBaseName(voice.name);
  const index = order.indexOf(base);
  // Known voices first, in list order. An enhanced or premium download of a known voice
  // (a name with a suffix) goes just ahead of its plain version.
  const known = index >= 0 ? index * 2 + (voice.name === base ? 1 : 0) : 1000;
  const sameRegion = lang.length > 2 && voice.lang.toLowerCase().replace('_', '-') === lang.toLowerCase() ? 0 : 1;
  return (voice.localService ? 0 : 5000) + known * 2 + sameRegion;
}

/** The voices worth offering for a language, best first. Novelty voices are left out. */
export function rankVoices(voices: VoiceInfo[], lang = 'en-US', role: 'assistant' | 'person' = 'assistant'): VoiceInfo[] {
  const order = role === 'person' ? [...PERSON_ORDER, ...CLEAR_VOICES.filter((name) => !PERSON_ORDER.includes(name))] : CLEAR_VOICES;
  const seen = new Set<string>();
  return voices
    .filter((voice) => matchesLanguage(voice, lang) && !isNoveltyVoice(voice.name))
    .map((voice, position) => ({ voice, position, score: rank(voice, order, lang) }))
    .sort((a, b) => a.score - b.score || a.position - b.position)
    .map((entry) => entry.voice)
    .filter((voice) => (seen.has(voice.name) ? false : (seen.add(voice.name), true)));
}

export function findVoice(voices: VoiceInfo[], wanted: string | undefined, lang = 'en-US'): VoiceInfo | undefined {
  if (!wanted) return undefined;
  const name = wanted.toLowerCase();
  const pool = voices.filter((voice) => matchesLanguage(voice, lang));
  return pool.find((voice) => voice.name.toLowerCase() === name) ?? pool.find((voice) => voiceBaseName(voice.name).toLowerCase() === name) ?? pool.find((voice) => voice.name.toLowerCase().includes(name)) ?? voices.find((voice) => voice.name.toLowerCase() === name);
}

export interface VoiceRequest {
  role: 'assistant' | 'person';
  /** Position of the device on the stage: 0 for the first device, 1 for the second. */
  slot: number;
  /** How many devices there are, so people's voices avoid the assistants' voices. */
  slots: number;
  lang?: string;
  /** A voice asked for by name (configuration or the voice menu). Wins when it exists. */
  name?: string;
}

/** The voice a device's assistant, or the person at it, speaks with. `undefined` when the browser has none for the language. */
export function chooseVoice(voices: VoiceInfo[], request: VoiceRequest): VoiceInfo | undefined {
  const lang = request.lang ?? 'en-US';
  const named = findVoice(voices, request.name, lang);
  if (named) return named;
  const assistants = rankVoices(voices, lang, 'assistant');
  if (assistants.length === 0) return voices.find((voice) => matchesLanguage(voice, lang));
  if (request.role === 'assistant') return assistants[request.slot % assistants.length];
  const taken = new Set(Array.from({ length: Math.max(1, request.slots) }, (_unused, slot) => assistants[slot % assistants.length]!.name));
  const people = rankVoices(voices, lang, 'person').filter((voice) => !taken.has(voice.name));
  const pool = people.length > 0 ? people : rankVoices(voices, lang, 'person');
  return pool[request.slot % pool.length];
}

// --- microphone problems --------------------------------------------------------

export type MicProblemKind = 'unsupported' | 'blocked' | 'no-microphone' | 'service' | 'policy' | 'language' | 'silent' | 'failed';

export interface MicProblem {
  kind: MicProblemKind;
  /** The error name the browser reported, when there was one. */
  code?: string;
  /** One or two plain sentences: what is wrong, and what to do. */
  message: string;
}

const TYPE_INSTEAD = 'You can always type instead.';

/**
 * Chrome reports recognition failures as a bare error name with an empty
 * message. These are the words a person needs.
 */
export function describeMicProblem(code: string, lang = 'en-US'): MicProblem {
  switch (code) {
    case 'unsupported':
      return { kind: 'unsupported', code, message: `This browser has no speech recognition. Chrome, Edge and Safari do. ${TYPE_INSTEAD}` };
    case 'not-allowed':
      return { kind: 'blocked', code, message: `The browser is blocking the microphone for this page. Click the icon at the left of the address bar, allow the microphone, and try again. ${TYPE_INSTEAD}` };
    case 'service-not-allowed':
      return { kind: 'policy', code, message: `Speech recognition is switched off in this browser, by a setting or a policy. ${TYPE_INSTEAD}` };
    case 'audio-capture':
      return { kind: 'no-microphone', code, message: `No microphone was found. Connect one, or choose one in the browser's site settings. ${TYPE_INSTEAD}` };
    case 'network':
      return { kind: 'service', code, message: `Speech recognition could not reach its online service, so speech cannot be turned into text right now. Check the internet connection. ${TYPE_INSTEAD}` };
    case 'language-not-supported':
      return { kind: 'language', code, message: `This browser's speech recognition does not support ${lang}. ${TYPE_INSTEAD}` };
    case 'silent':
      return { kind: 'silent', code, message: `The microphone is sending pure silence. It may be muted, or switched off for this browser in the system's privacy settings. ${TYPE_INSTEAD}` };
    default:
      return { kind: 'failed', code, message: `Speech recognition stopped with the error "${code}". ${TYPE_INSTEAD}` };
  }
}

/**
 * Take the wake word off the front of what was heard. Returns the request that
 * follows it, or `undefined` when the wake word was not said.
 */
export function afterWakeWord(heard: string, wakeWord: string): string | undefined {
  const index = heard.toLowerCase().indexOf(wakeWord.toLowerCase());
  if (index < 0) return undefined;
  return heard.slice(index + wakeWord.length).replace(/^[\s,.!?:;-]+/, '');
}
