import { describe, expect, it } from 'vitest';
import { afterWakeWord, chooseVoice, describeMicProblem, findVoice, isNoveltyVoice, rankVoices, voiceBaseName, type VoiceInfo } from '../src/shared/voices.js';

const local = (name: string, lang: string): VoiceInfo => ({ name, lang, localService: true });
const remote = (name: string, lang: string): VoiceInfo => ({ name, lang, localService: false });

/**
 * The English voices Google Chrome 154 listed on a Mac whose system language is
 * Korean (observed with scripts/voice-check.mjs), with the Korean system default.
 */
const MAC: VoiceInfo[] = [
  { name: '지안(프리미엄)', lang: 'ko-KR', localService: true, default: true },
  ...['Albert', 'Bad News', 'Bahh', 'Bells', 'Boing', 'Bubbles', 'Cellos'].map((name) => local(name, 'en-US')),
  local('Daniel', 'en-GB'),
  local('Eddy (영어(영국))', 'en-GB'),
  local('Eddy (영어(미국))', 'en-US'),
  local('Flo (영어(미국))', 'en-US'),
  ...['Fred', 'Good News', 'Jester', 'Junior'].map((name) => local(name, 'en-US')),
  local('Karen', 'en-AU'),
  local('Kathy', 'en-US'),
  local('Moira', 'en-IE'),
  local('Organ', 'en-US'),
  local('Ralph', 'en-US'),
  local('Rishi', 'en-IN'),
  local('Samantha', 'en-US'),
  local('Shelley (영어(미국))', 'en-US'),
  local('Superstar', 'en-US'),
  local('Tessa', 'en-ZA'),
  ...['Trinoids', 'Whisper', 'Wobble', 'Zarvox'].map((name) => local(name, 'en-US')),
  remote('Google US English', 'en-US'),
  remote('Google UK English Female', 'en-GB'),
  remote('Google UK English Male', 'en-GB'),
  remote('Google Deutsch', 'de-DE'),
];

describe('choosing voices', () => {
  it('ranks clear on-device voices first, remote voices last, and leaves novelty voices out', () => {
    expect(rankVoices(MAC, 'en-US').map((voice) => voice.name)).toEqual(['Samantha', 'Daniel', 'Karen', 'Moira', 'Tessa', 'Rishi', 'Google US English', 'Google UK English Female', 'Google UK English Male']);
    expect(isNoveltyVoice('Bad News')).toBe(true);
    expect(isNoveltyVoice('Eddy (영어(미국))')).toBe(true);
    expect(isNoveltyVoice('Samantha')).toBe(false);
    expect(voiceBaseName('Samantha (Enhanced)')).toBe('Samantha');
  });

  it('gives each device a different assistant voice, never the system default of another language', () => {
    const pick = (slot: number, slots = 2) => chooseVoice(MAC, { role: 'assistant', slot, slots })?.name;
    expect([pick(0), pick(1)]).toEqual(['Samantha', 'Daniel']);
    expect(pick(2, 3)).toBe('Karen');
  });

  it('gives each person a voice that no assistant on stage uses', () => {
    const pick = (slot: number, slots: number) => chooseVoice(MAC, { role: 'person', slot, slots })?.name;
    expect([pick(0, 2), pick(1, 2)]).toEqual(['Moira', 'Tessa']);
    // With three devices, Karen is an assistant's voice, so people skip it.
    expect([pick(0, 3), pick(1, 3), pick(2, 3)]).toEqual(['Moira', 'Tessa', 'Rishi']);
  });

  it('prefers an enhanced download of a known voice, and a voice asked for by name over everything', () => {
    const withEnhanced = [...MAC, local('Samantha (Enhanced)', 'en-US'), local('Ava (Premium)', 'en-US')];
    expect(rankVoices(withEnhanced, 'en-US').slice(0, 3).map((voice) => voice.name)).toEqual(['Ava (Premium)', 'Samantha (Enhanced)', 'Samantha']);
    expect(chooseVoice(MAC, { role: 'assistant', slot: 0, slots: 2, name: 'karen' })?.name).toBe('Karen');
    expect(chooseVoice(MAC, { role: 'assistant', slot: 0, slots: 2, name: 'Zarvox' })?.name).toBe('Zarvox');
    // A configured voice that this machine does not have falls back to the automatic choice.
    expect(chooseVoice(MAC, { role: 'assistant', slot: 1, slots: 2, name: 'Microsoft Aria' })?.name).toBe('Daniel');
    expect(findVoice(MAC, 'google us', 'en-US')?.name).toBe('Google US English');
  });

  it('uses remote voices only when nothing runs on the device, and copes with no voices at all', () => {
    const chromeOs = [remote('Google US English', 'en-US'), remote('Google UK English Female', 'en-GB'), remote('Google español', 'es-ES')];
    expect(chooseVoice(chromeOs, { role: 'assistant', slot: 0, slots: 2 })?.name).toBe('Google US English');
    expect(chooseVoice(chromeOs, { role: 'person', slot: 0, slots: 1 })?.name).toBe('Google UK English Female');
    expect(chooseVoice([], { role: 'assistant', slot: 0, slots: 2 })).toBeUndefined();
    // Only novelty voices for the language: better one of those than a voice for another language.
    expect(chooseVoice([local('Zarvox', 'en-US'), local('Anna', 'de-DE')], { role: 'assistant', slot: 0, slots: 1 })?.name).toBe('Zarvox');
    expect(chooseVoice(MAC, { role: 'assistant', slot: 0, slots: 1, lang: 'de-DE' })?.name).toBe('Google Deutsch');
  });
});

describe('microphone problems in plain words', () => {
  it('explains each error Chrome reports, and always offers typing', () => {
    const cases: Array<[string, string, RegExp]> = [
      ['not-allowed', 'blocked', /blocking the microphone for this page.*address bar/],
      ['service-not-allowed', 'policy', /switched off in this browser/],
      ['audio-capture', 'no-microphone', /No microphone was found/],
      ['network', 'service', /could not reach its online service/],
      ['language-not-supported', 'language', /does not support en-GB/],
      ['silent', 'silent', /sending pure silence.*privacy settings/],
      ['unsupported', 'unsupported', /has no speech recognition/],
      ['something-new', 'failed', /stopped with the error "something-new"/],
    ];
    for (const [code, kind, text] of cases) {
      const problem = describeMicProblem(code, 'en-GB');
      expect(problem).toMatchObject({ kind, code });
      expect(problem.message).toMatch(text);
      expect(problem.message).toMatch(/You can always type instead\.$/);
    }
  });
});

describe('wake word', () => {
  it('returns what follows the wake word, or nothing when it was not said', () => {
    expect(afterWakeWord('Computer, how do I make pancakes', 'computer')).toBe('how do I make pancakes');
    expect(afterWakeWord('hey computer set a timer', 'Computer')).toBe('set a timer');
    expect(afterWakeWord('computer', 'computer')).toBe('');
    expect(afterWakeWord('how do I make pancakes', 'computer')).toBeUndefined();
  });
});
